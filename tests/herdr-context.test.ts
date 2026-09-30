import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
