import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHerdrContext } from "../src/herdr/context.js";

test("native agy caller kinds resolve to the registered AntiGravity harness", async () => {
  const context = await resolveHerdrContext({}, { env: { HERDR_ENV: "1", HERDR_PANE_ID: "agy-source" },
    runCommand: async () => ({ ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: {
      agent: "agy", pane_id: "agy-source", cwd: "/repository",
    } } }) }),
  });
  expect(context.client).toBe("antigravity");
});

test("invalid explicit source panes cannot fall back to another harness or cwd", async () => {
  await expect(resolveHerdrContext({}, { env: { HERDR_ENV: "1" } })).rejects.toThrow("Caller pane unavailable");
  await expect(resolveHerdrContext({ sourcePaneId: "missing" }, { env: { HERDR_ENV: "1" },
    runCommand: async () => ({ ok: false, code: 1, stdout: "", stderr: "missing pane" }),
  })).rejects.toThrow("Cannot resolve source pane");
});

test("source client overrides cannot impersonate another observed harness", async () => {
  await expect(resolveHerdrContext({ client: "claude" }, { env: { HERDR_ENV: "1", HERDR_PANE_ID: "codex-source" },
    runCommand: async () => ({ ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: {
      agent: "codex", pane_id: "codex-source", cwd: "/repository",
    } } }) }),
  })).rejects.toThrow("conflicts with observed");
});

test("source pane and fresh backend evidence supply exact models without inferring aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-context-"));
  const now = Date.now();
  try {
    writeFileSync(join(root, "models_cache.json"), JSON.stringify({ fetched_at: new Date(now).toISOString(), models: [
      { slug: "gpt-6.1-sol", visibility: "list" }, { slug: "gpt-6-luna", visibility: "list" }, { slug: "hidden", visibility: "hide" },
    ] }));
    const calls: readonly string[][] = [];
    const result = await resolveHerdrContext({}, { now, env: { HERDR_ENV: "1", HERDR_PANE_ID: "overlay",
      HERDR_JEV_SOURCE_PANE_ID: "w1:p1", CODEX_HOME: root }, runCommand: async (args) => {
      (calls as string[][]).push([...args]);
      return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: {
        agent: "codex", workspace_id: "w1", foreground_cwd: "/repository", tokens: { quota_model: "\u200b  gpt-6.1-sol" },
      } } }) };
    } });
    expect(calls[0]).toEqual(["herdr", "agent", "get", "w1:p1"]);
    expect(result).toMatchObject({ client: "codex", sourcePaneId: "w1:p1", cwd: "/repository",
      delegation: { model: "gpt-6.1-sol", availableModels: ["gpt-6.1-sol", "gpt-6-luna"] } });
    const unknown = await resolveHerdrContext({ client: "codex" }, { now, env: { CODEX_HOME: root } });
    expect(unknown.delegation.model).toBeUndefined();
    const stale = await resolveHerdrContext({ client: "codex" }, { now: now + 86_400_001, env: { CODEX_HOME: root } });
    expect(stale.delegation.availableModels).toBeUndefined();
    const explicitWorkers = await resolveHerdrContext({ availableModels: ["gpt-6-luna"] }, { now,
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "overlay", CODEX_HOME: root,
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w1:p1", focused_pane_cwd: "/repository" }) },
      runCommand: async (args) => {
        expect(args.at(-1)).toBe("w1:p1");
        return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: {
          agent: "codex", tokens: { quota_model: "gpt-6.1-sol" },
        } } }) };
      },
    });
    expect(explicitWorkers.delegation).toEqual({ model: "gpt-6.1-sol", availableModels: ["gpt-6-luna"] });
    expect(explicitWorkers.cwd).toBe("/repository");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit exact models and availability survive missing Herdr and cache", async () => {
  const result = await resolveHerdrContext({ client: "codex", model: "advisor", availableModels: ["executor", "reviewer"] }, { env: {} });
  expect(result.delegation).toEqual({ model: "advisor", availableModels: ["executor", "reviewer"] });
});

test("live exact advisors do not require a cache or membership in worker availability", async () => {
  const result = await resolveHerdrContext({ availableModels: ["executor", "reviewer"] }, {
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "source", CODEX_HOME: "/missing-cache" },
    runCommand: async () => ({ ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: {
      agent: { agent: "codex", tokens: { quota_model: "gpt-6.1-sol" } },
    } }) }),
  });
  expect(result.delegation).toEqual({ model: "gpt-6.1-sol", availableModels: ["executor", "reviewer"] });
});

test("falls back to focused_pane_id when configured pane cannot be resolved", async () => {
  const context = await resolveHerdrContext({}, {
    env: {
      HERDR_ENV: "1",
      HERDR_JEV_SOURCE_PANE_ID: "stale-pane",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "focused-pane", focused_pane_cwd: "/repository" }),
    },
    runCommand: async (args) => {
      if (args[1] === "agent" && args[2] === "get") {
        if (args[3] === "stale-pane") return { ok: false, code: 1, stdout: "", stderr: "not found" };
        if (args[3] === "focused-pane") {
          return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: { pane_id: "focused-pane", agent: "claude", cwd: "/repository" } } }) };
        }
      }
      return { ok: false, code: 1, stdout: "", stderr: "unknown" };
    },
  });
  expect(context.sourcePaneId).toBe("focused-pane");
  expect(context.client).toBe("claude");
});

test("falls back to pane current when configured and focused panes fail", async () => {
  const context = await resolveHerdrContext({}, {
    env: {
      HERDR_ENV: "1",
      HERDR_JEV_SOURCE_PANE_ID: "stale-pane",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "stale-focused", focused_pane_cwd: "/repository" }),
    },
    runCommand: async (args) => {
      if (args[1] === "agent" && args[2] === "get") {
        if (args[3] === "stale-pane" || args[3] === "stale-focused") return { ok: false, code: 1, stdout: "", stderr: "not found" };
        if (args[3] === "current-pane") {
          return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: { pane_id: "current-pane", agent: "codex", cwd: "/repository" } } }) };
        }
      }
      if (args[1] === "pane" && args[2] === "current") {
        return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { pane: { pane_id: "current-pane" } } }) };
      }
      return { ok: false, code: 1, stdout: "", stderr: "unknown" };
    },
  });
  expect(context.sourcePaneId).toBe("current-pane");
  expect(context.client).toBe("codex");
});

test("falls back to first pane matching client and cwd when other candidates fail", async () => {
  const cwd = process.cwd();
  const context = await resolveHerdrContext({ client: "codex" }, {
    env: {
      HERDR_ENV: "1",
      HERDR_JEV_SOURCE_PANE_ID: "stale-pane",
    },
    runCommand: async (args) => {
      if (args[1] === "agent" && args[2] === "get") {
        if (args[3] === "matched-pane") {
          return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: { pane_id: "matched-pane", agent: "codex", cwd } } }) };
        }
        return { ok: false, code: 1, stdout: "", stderr: "not found" };
      }
      if (args[1] === "pane" && args[2] === "current") return { ok: false, code: 1, stdout: "", stderr: "no current pane" };
      if (args[1] === "agent" && args[2] === "list") {
        return {
          ok: true, code: 0, stderr: "",
          stdout: JSON.stringify({
            result: {
              agents: [
                { pane_id: "other-pane", agent: "claude", cwd: "/different" },
                { pane_id: "matched-pane", agent: "codex", cwd },
              ],
            },
          }),
        };
      }
      return { ok: false, code: 1, stdout: "", stderr: "unknown" };
    },
  });
  expect(context.sourcePaneId).toBe("matched-pane");
  expect(context.client).toBe("codex");
});

test("throws and includes all tried ids when all candidates fail", async () => {
  await expect(resolveHerdrContext({}, {
    env: {
      HERDR_ENV: "1",
      HERDR_JEV_SOURCE_PANE_ID: "stale-configured",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "stale-focused" }),
    },
    runCommand: async (args) => {
      if (args[1] === "pane" && args[2] === "current") {
        return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { pane: { pane_id: "stale-current" } } }) };
      }
      if (args[1] === "agent" && args[2] === "list") {
        return {
          ok: true, code: 0, stderr: "",
          stdout: JSON.stringify({
            result: {
              agents: [{ pane_id: "stale-matched", agent: "claude", cwd: process.cwd() }],
            },
          }),
        };
      }
      return { ok: false, code: 1, stdout: "", stderr: "not found" };
    },
  })).rejects.toThrow("stale-configured, stale-focused, stale-current, stale-matched");
});

test("assistant.sh unsets stale HERDR_JEV_SOURCE_PANE_ID before running assistant", () => {
  const script = readFileSync(join(import.meta.dir, "../herdr-plugin/assistant.sh"), "utf8");
  expect(script).toContain("unset HERDR_JEV_SOURCE_PANE_ID");
});
