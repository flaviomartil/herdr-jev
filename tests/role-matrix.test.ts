import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetHarnessCaches } from "../src/harness/bridge.js";
import { resolveRoleMatrix } from "../src/pipelines/roles.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
import { createTempHome } from "./helpers.js";

let harness: FakeHarness | undefined;

beforeEach(() => {
  resetHarnessCaches();
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  resetHarnessCaches();
});

describe("role matrix", () => {
  it("maps every role to its catalog model, CLI id, effort and read-only flag", async () => {
    harness = createFakeHarness("contract");
    const matrix = await resolveRoleMatrix("claude");
    expect(matrix).toEqual({
      client: "claude",
      roles: {
        advisor: { model: "fable-5", cliModel: "claude-fable-5-1", effort: "high", readonly: false, fallbackActive: false },
        implementer: { model: "sonnet-5", cliModel: "claude-sonnet-5-5", effort: "high", readonly: false, fallbackActive: false },
        reviewer: { model: "opus-5", cliModel: "claude-opus-5-5", effort: "xhigh", readonly: true, fallbackActive: false },
        researcher: { model: "sonnet-5", cliModel: "claude-sonnet-5-5", effort: "standard", readonly: true, fallbackActive: false },
        reader: { model: "claude-haiku-4-5-20251001", cliModel: "claude-haiku-4-5-20251001", effort: "standard", readonly: true, fallbackActive: false },
      },
    });
    const readerCall = harness.callsFor("model-resolve").find((argv) => argv.includes("claude-haiku-4-5-20251001"))!;
    expect(readerCall[readerCall.indexOf("--role") + 1]).toBe("researcher");
  });

  it("reports a per-role error and null cliModel when the harness fails, without throwing", async () => {
    harness = createFakeHarness("contract", { FAKE_FAIL_MODEL_RESOLVE: "1" });
    const matrix = await resolveRoleMatrix("claude");
    for (const entry of Object.values(matrix.roles)) {
      expect(entry.cliModel).toBeNull();
      expect(typeof entry.error).toBe("string");
      expect(entry.model.length).toBeGreaterThan(0);
    }
  });

  it("prints the matrix as JSON from models list --json", async () => {
    harness = createFakeHarness("contract");
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "models", "list", "--json", "--client", "claude"], {
      cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, HOME: createTempHome() }, stdout: "pipe", stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.client).toBe("claude");
    expect(Object.keys(parsed.roles)).toEqual(["advisor", "implementer", "reviewer", "researcher", "reader"]);
    expect(parsed.roles.reader.cliModel).toBe("claude-haiku-4-5-20251001");
  });
});
