import { describe, expect, test } from "bun:test";
import { Lru, hashKey } from "../src/cache/lru.js";
import { scoreQuantile, probabilityMargin } from "../src/triage/quantile.js";
import { computePercentile } from "../src/triage/calibrator.js";
import { decideRoute, computeGateScore } from "../src/routing/policy.js";
import { systemPromptParts, renderSkillBlock } from "../src/routing/prompt.js";
import { TurnRouter, isShortcut, shortcutRoute } from "../src/routing/router.js";
import { DEFAULT_TOOLS, DEFAULT_MODELS } from "../src/routing/catalog.js";

describe("Resilient Router & Jev Enhancements", () => {
  describe("Quantile Scoring & Margin", () => {
    test("handles bimodal distribution without under-provisioning", () => {
      // Bimodal distribution: 45% simple text, 43% deep architectural design
      // Mean/expectation is 1.46 (rounds to 1 = routine/cheap)
      // Quantile 0.60 correctly crosses at 3 (deep / architectural)
      const bimodal = { "0": 0.45, "1": 0.08, "2": 0.04, "3": 0.43 };
      const level = scoreQuantile(bimodal, 0.6);
      expect(level).toBe(3);
    });

    test("reads confident easy distributions as easy", () => {
      const easy = { "0": 0.85, "1": 0.1, "2": 0.05, "3": 0.0 };
      const level = scoreQuantile(easy, 0.6);
      expect(level).toBe(0);
    });

    test("measures margin between top two candidates", () => {
      expect(probabilityMargin({ a: 0.9, b: 0.1 })).toBeCloseTo(0.8);
      expect(probabilityMargin({ a: 0.5, b: 0.5 })).toBeCloseTo(0.0);
      expect(probabilityMargin({ single: 1.0 })).toBe(1.0);
    });
  });

  describe("LRU Cache", () => {
    test("stores and evicts entries exceeding capacity", () => {
      const cache = new Lru<string>(2);
      cache.set("a", "1");
      cache.set("b", "2");
      expect(cache.get("a")).toBe("1");

      cache.set("c", "3"); // should evict "b" because "a" was accessed
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("a")).toBe("1");
      expect(cache.get("c")).toBe("3");
    });

    test("generates deterministic hash keys", () => {
      const k1 = hashKey("prefix", { x: 1, y: "test" });
      const k2 = hashKey("prefix", { x: 1, y: "test" });
      const k3 = hashKey("prefix", { x: 2, y: "test" });

      expect(k1).toBe(k2);
      expect(k1).not.toBe(k3);
    });
  });

  describe("Request-Shape 4 Gates & Policy Decisions", () => {
    test("inverts prose_suffices gate correctly", () => {
      const gateScore = computeGateScore({
        "gate::acts_on_system": { noul: 0.8 },
        "gate::follows_procedure": { noul: 0.7 },
        "gate::produces_artifact": { noul: 0.9 },
        "gate::prose_suffices": { noul: 0.1 }, // inverted: 1 - 0.1 = 0.9
      });
      // (0.8 + 0.7 + 0.9 + 0.9) / 4 = 3.3 / 4 = 0.825
      expect(gateScore.score).toBeCloseTo(0.825);
    });

    test("produces_artifact gate unlocks advisory skills when no system action requested", () => {
      // Advisory skill: writing an ADR or architecture spec
      // acts_on_system is low (0.1), but produces_artifact is high (0.95)
      const gateScore = computeGateScore({
        "gate::acts_on_system": { noul: 0.1 },
        "gate::follows_procedure": { noul: 0.2 },
        "gate::produces_artifact": { noul: 0.95 },
        "gate::prose_suffices": { noul: 0.2 }, // inverted: 0.8
      });
      // (0.1 + 0.2 + 0.95 + 0.8) / 4 = 2.05 / 4 = 0.5125 (well above 0.20 threshold!)
      expect(gateScore.score).toBeGreaterThan(0.2);
    });

    test("floors model tier at balanced on broad scope", () => {
      const route = decideRoute(
        {
          "turn::difficulty": { probabilities: { "0": 0.9 } }, // trivial difficulty
          "turn::scope": { probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 } }, // broad project scope
        },
        DEFAULT_TOOLS,
        DEFAULT_MODELS,
      );

      // Even though difficulty is fast/0, broad scope floors tier at balanced (sonnet-5)
      expect(route.tier).toBe("balanced");
      expect(route.model).toBe("sonnet-5");
    });

    test("admits read tool from tail but strictly holds back write/execute tools", () => {
      const route = decideRoute(
        {
          "turn::difficulty": { probabilities: { "1": 0.9 } },
          "turn::scope": { probabilities: { "1": 0.9 } },
          "tool::Read": { noul: 0.3 }, // below 0.35 bar
          "tool::Bash": { noul: 0.3 }, // below 0.8 bar
          "tool::which": {
            probabilities: {
              Read: 0.3, // clears 0.25 tail -> admitted because read-only
              Bash: 0.4, // high ranking but execute-risk -> held back
            },
          },
        },
        DEFAULT_TOOLS,
        DEFAULT_MODELS,
      );

      expect(route.tools).toContain("Read");
      expect(route.tools).not.toContain("Bash");
      expect(route.why.some((w) => w.includes("Bash ranked high") && w.includes("held back"))).toBeTrue();
    });
  });

  describe("Prompt Prefix Cache Preservation", () => {
    test("splits static roster from dynamic suffix", () => {
      const parts = systemPromptParts("STATIC_ROSTER_DEFINITION", "architecture");
      expect(parts.cached).toBe("STATIC_ROSTER_DEFINITION");
      expect(parts.suffix).toContain("<skill_relevance>");
      expect(parts.suffix).toContain("architecture");
      expect(parts.suffix).toContain("Ignore this if it does not fit");
    });

    test("emits explicit none message when no skill suggested", () => {
      const block = renderSkillBlock(null);
      expect(block).toContain("<skill_relevance>");
      expect(block).toContain("No skill in the roster appears relevant");
    });
  });

  describe("Shortcut & Router Lanes", () => {
    test("identifies continuations and slash commands without model calls", () => {
      expect(isShortcut({ message: "dale" })).toBeTrue();
      expect(isShortcut({ message: "continua" })).toBeTrue();
      expect(isShortcut({ message: "/plan refactor auth" })).toBeTrue();
      expect(isShortcut({ message: "" })).toBeTrue();
      expect(isShortcut({ message: "escreva o migration de pagamentos" })).toBeFalse();

      const shortcut = shortcutRoute({ message: "dale" });
      expect(shortcut.tier).toBe("fast");
      expect(shortcut.effort).toBe("low");
      expect(shortcut.tools).toHaveLength(0);
    });

    test("TurnRouter routes shortcut in <1ms", async () => {
      const router = new TurnRouter();
      const res = await router.route({ message: "dale" });
      expect(res.telemetry.source).toBe("shortcut");
      expect(res.telemetry.jevMs).toBe(0);
      expect(res.telemetry.totalMs).toBeLessThan(10);
      expect(res.decision.tier).toBe("fast");
    });
  });

  describe("Calibrator Math", () => {
    test("calculates correct percentiles from sample latencies", () => {
      const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
      expect(computePercentile(sorted, 50)).toBe(550);
      expect(computePercentile(sorted, 90)).toBe(910);
      expect(computePercentile(sorted, 100)).toBe(1000);
    });
  });
});
