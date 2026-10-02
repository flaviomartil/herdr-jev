import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harnessModelResolve, parseModelResolution, resetHarnessCaches } from "../src/harness/bridge.js";
import { buildAgentCommand, buildInlineCommand, launchStageInHerdr, runAgentCaptured } from "../src/herdr/launcher.js";
import { autoTrustEnabled } from "../src/herdr/trust.js";
import type { HerdrClient } from "../src/herdr/client.js";
import type { ClientKind, HerdrCommandResult, RoleKind, StageSpec } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness, type FakeHarnessMode } from "./fake-harness.js";
import { mcpSession, mcpText, readJsonLines, writeHerdrFake, writeRecorder } from "./launch-support.js";

const CLAUDE_BYPASS = "--dangerously-skip-permissions";
const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_READONLY = ["--tools", "Read,Glob,Grep"];
const CODEX_READONLY = ["--sandbox", "read-only"];
const BYPASS_FLAGS = [CLAUDE_BYPASS, CODEX_BYPASS, "--yolo", "--trust-all-tools"];

function stage(role: RoleKind, model: string, extraFlags: string[] = [], extra: Partial<StageSpec> = {}): StageSpec {
  return { role, model, effort: "high", extraFlags, description: "synthetic", ...extra };
}

let harness: FakeHarness | undefined;
let sandbox: string;

function install(mode: FakeHarnessMode = "contract", env: Record<string, string> = {}) {
  harness = createFakeHarness(mode, env);
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "launch-reviewer-")));
  delete process.env.HERDR_JEV_BYPASS;
  resetHarnessCaches();
});

afterEach(() => {
  setSystemTime();
  harness?.restore();
  harness = undefined;
  rmSync(sandbox, { recursive: true, force: true });
  resetHarnessCaches();
});

function expectReadOnly(argv: string[], readonly: string[]) {
  for (const flag of BYPASS_FLAGS) expect(argv).not.toContain(flag);
  const at = argv.findIndex((arg, index) => arg === readonly[0] && argv[index + 1] === readonly[1]);
  expect(at).toBeGreaterThan(-1);
}

describe("a reviewer is read-only on every command builder", () => {
  it("applies the read-only arguments to the pane command, the interactive command and the captured command", () => {
    for (const [client, model, readonly] of [["claude", "sonnet-5", CLAUDE_READONLY], ["codex", "gpt-5.6-sol", CODEX_READONLY]] as const) {
      expectReadOnly(buildAgentCommand(client, stage("reviewer", model)), [...readonly]);
      expectReadOnly(buildInlineCommand(client, stage("reviewer", model), "review", false), [...readonly]);
      expectReadOnly(buildInlineCommand(client, stage("reviewer", model), "review", true), [...readonly]);
    }
  });

  it("keeps the read-only arguments after the prompt so a variadic option cannot swallow it", () => {
    const interactive = buildInlineCommand("claude", stage("reviewer", "sonnet-5"), "review the diff", false);
    expect(interactive.slice(-3)).toEqual(["review the diff", ...CLAUDE_READONLY]);
  });

  it("leaves other roles untouched", () => {
    const argv = buildAgentCommand("claude", stage("implementer", "sonnet-5"));
    expect(argv).toContain(CLAUDE_BYPASS);
    expect(argv).not.toContain("--tools");
  });

  it("strips every bypass flag a reviewer stage carries in extraFlags", () => {
    const hostile = [CLAUDE_BYPASS, CODEX_BYPASS, "--yolo", "-y", "--full-auto", "--allow-dangerously-skip-permissions", "--trust-all-tools",
      "--permission-mode", "bypassPermissions", "--tools", "Bash,Edit", "--allowedTools", "Bash", "--sandbox", "danger-full-access", "-s", "danger-full-access",
      "--ask-for-approval", "never", "--sandbox=danger-full-access", "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "--keep-me"];
    for (const [client, model, readonly] of [["claude", "sonnet-5", CLAUDE_READONLY], ["codex", "gpt-5.6-sol", CODEX_READONLY], ["kimi", "kimi-model", []], ["kiro", "kiro-model", []]] as const) {
      for (const argv of [buildAgentCommand(client, stage("reviewer", model, hostile)), buildInlineCommand(client, stage("reviewer", model, hostile), "review", true)]) {
        for (const flag of [...BYPASS_FLAGS, "-y", "--full-auto", "--allow-dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--allowedTools", "Bash",
          "danger-full-access", "-s", "--ask-for-approval", "never", "--sandbox=danger-full-access", 'sandbox_mode="danger-full-access"', 'approval_policy="never"']) {
          expect(argv).not.toContain(flag);
        }
        if (!(client === "kimi" && argv.includes("-p"))) expect(argv).toContain("--keep-me");
        if (readonly.length) expect(argv.slice(-2)).toEqual([...readonly]);
        expect(argv).not.toContain("Bash,Edit");
      }
    }
  });

  it("never gives a Kiro reviewer --trust-all-tools while other roles keep it", () => {
    expect(buildAgentCommand("kiro", stage("reviewer", "kiro-model"))).not.toContain("--trust-all-tools");
    expect(buildInlineCommand("kiro", stage("reviewer", "kiro-model"), "review", true)).not.toContain("--trust-all-tools");
    expect(buildAgentCommand("kiro", stage("implementer", "kiro-model"))).toContain("--trust-all-tools");
    expect(buildInlineCommand("kiro", stage("researcher", "kiro-model"), "go", true)).toContain("--trust-all-tools");
  });

  it("takes the read-only arguments of a reviewer from the harness answer", () => {
    install("contract", { FAKE_READONLY_CODEX: "--sandbox read-only --harness-readonly" });
    expect(buildAgentCommand("codex", stage("reviewer", "gpt-5.6-sol")).slice(-3)).toEqual(["--sandbox", "read-only", "--harness-readonly"]);
  });
});

function cliEnv(extra: Record<string, string> = {}) {
  const claude = writeRecorder(sandbox, "claude-fake");
  const codex = writeRecorder(sandbox, "codex-fake");
  const herdr = writeHerdrFake(sandbox);
  const stateDir = join(sandbox, "state");
  const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: herdr.bin, HERDR_JEV_SOURCE_PANE_ID: "caller-1", HERDR_JEV_STATE_DIR: stateDir,
    HERDR_JEV_TEST_GUARD: "1", HOME: sandbox, TYPESAFE_API_KEY: "", HERDR_JEV_READY_TIMEOUT_MS: "3000", HERDR_JEV_CROSS_HARNESS: "disabled",
    HERDR_JEV_CONFIG_DIR: join(sandbox, "config"), HERDR_JEV_ALLOW_ALIASES: "1", HERDR_JEV_BIN_CLAUDE: claude.bin, HERDR_JEV_BIN_CODEX: codex.bin,
    HERDR_JEV_SPLIT_SUBAGENTS: "", ...extra };
  return { env, claude, codex, herdr };
}

const cli = resolve(import.meta.dir, "../src/cli.ts");

function run(args: string[], env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: sandbox, timeout: 60_000 });
}

function startArgs(log: string): string[] {
  const start = readJsonLines(log).find((argv) => argv[0] === "agent" && argv[1] === "start")!;
  return start.slice(start.indexOf("--") + 1);
}

describe("reviewer launches through the real entry points", () => {
  it("subagent --role reviewer in a split starts the agent read-only", () => {
    const { env, herdr } = cliEnv();
    const spawned = run(["subagent", "review the change", "--target", "claude", "--model", "sonnet-5", "--role", "reviewer", "--effort", "high", "--cwd", sandbox], env);
    expect(spawned.status).toBe(0);
    expect(startArgs(herdr.log)).toEqual(["--model", "claude-sonnet-5-5", "--effort", "high", ...CLAUDE_READONLY]);
  });

  it("subagent --role implementer in the same split still gets the bypass flag", () => {
    const { env, herdr } = cliEnv();
    const spawned = run(["subagent", "implement the change", "--target", "claude", "--model", "sonnet-5", "--role", "implementer", "--effort", "high", "--cwd", sandbox], env);
    expect(spawned.status).toBe(0);
    expect(startArgs(herdr.log)).toEqual(["--model", "claude-sonnet-5-5", "--effort", "high", CLAUDE_BYPASS]);
  });

  it("subagent --role reviewer inline runs the harness client read-only", () => {
    const { env, claude } = cliEnv();
    const spawned = run(["subagent", "review the change", "--target", "claude", "--model", "sonnet-5", "--role", "reviewer", "--effort", "high", "--no-split", "--print", "--cwd", sandbox], env);
    expect(spawned.status).toBe(0);
    const [argv] = readJsonLines(claude.log);
    expect(argv).toEqual(["-p", "review the change", "--model", "claude-sonnet-5-5", "--effort", "high", ...CLAUDE_READONLY]);
  });

  it("herdr_spawn_subagent with the reviewer role is read-only in a split and when captured", () => {
    const { env, claude, herdr } = cliEnv();
    const split = spawnSync(process.execPath, [cli, "mcp"], { encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: sandbox, timeout: 60_000,
      input: mcpSession([{ method: "tools/call", params: { name: "herdr_spawn_subagent", arguments: { prompt: "review the change", role: "reviewer", target: "claude", model: "sonnet-5", effort: "high", layout: "split", cwd: sandbox } } }]) });
    expect(split.status).toBe(0);
    expect(mcpText(split.stdout, 1)).toContain('"ok":true');
    expect(startArgs(herdr.log)).toEqual(["--model", "claude-sonnet-5-5", "--effort", "high", ...CLAUDE_READONLY]);

    const captured = spawnSync(process.execPath, [cli, "mcp"], { encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: sandbox, timeout: 60_000,
      input: mcpSession([{ method: "tools/call", params: { name: "herdr_spawn_subagent", arguments: { prompt: "review the change", role: "reviewer", target: "claude", model: "sonnet-5", effort: "high", layout: "captured", cwd: sandbox } } }]) });
    expect(captured.status).toBe(0);
    const [argv] = readJsonLines(claude.log);
    expectReadOnly(argv!, CLAUDE_READONLY);
  });

  it("herdr_consensus asks every client in read-only mode", () => {
    const { env, claude, codex } = cliEnv();
    const consensus = spawnSync(process.execPath, [cli, "mcp"], { encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: sandbox, timeout: 60_000,
      input: mcpSession([{ method: "tools/call", params: { name: "herdr_consensus", arguments: { question: "is it safe?", clients: ["claude", "codex"] } } }]) });
    expect(consensus.status).toBe(0);
    expectReadOnly(readJsonLines(claude.log)[0]!, CLAUDE_READONLY);
    expectReadOnly(readJsonLines(codex.log)[0]!, CODEX_READONLY);
  });

  it("herdr_clink keeps the implementer defaults, proving the reviewer difference is the role", () => {
    const { env, claude } = cliEnv();
    spawnSync(process.execPath, [cli, "mcp"], { encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: sandbox, timeout: 60_000,
      input: mcpSession([{ method: "tools/call", params: { name: "herdr_clink", arguments: { client: "claude", prompt: "go" } } }]) });
    expect(readJsonLines(claude.log)[0]).toContain(CLAUDE_BYPASS);
  });
});

describe("an explicit empty bypassArgs from the harness is respected", () => {
  it("distinguishes an absent field from an empty list in the parsed answer", () => {
    const base = { client: "claude", cliModel: "claude-x", known: true };
    expect(parseModelResolution({ ...base, bypassArgs: [] })!.bypassArgs).toEqual([]);
    expect(parseModelResolution(base)!.bypassArgs).toBeNull();
    expect(parseModelResolution({ ...base, bypassArgs: null })!.bypassArgs).toBeNull();
    expect(parseModelResolution({ ...base, bypassArgs: "--x" })).toBeNull();
    expect(parseModelResolution({ ...base, bypassArgs: ["--x"] })!.bypassArgs).toEqual(["--x"]);
  });

  it("launches without any bypass flag when the harness answers an empty list", () => {
    install("contract", { FAKE_BYPASS_CLAUDE: "none", FAKE_BYPASS_CODEX: "none", FAKE_BYPASS_KIMI: "none" });
    expect(harnessModelResolve({ client: "claude", model: "sonnet-5", effort: "high", role: "implementer" })!.bypassArgs).toEqual([]);
    expect(buildAgentCommand("claude", stage("implementer", "sonnet-5"))).toEqual(["claude", "--model", "claude-sonnet-5-5", "--effort", "high"]);
    expect(buildAgentCommand("codex", stage("implementer", "gpt-5.6-luna"))).toEqual(["codex", "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="high"']);
    expect(buildInlineCommand("claude", stage("implementer", "sonnet-5"), "task", true)).not.toContain(CLAUDE_BYPASS);
    expect(buildAgentCommand("kimi", stage("implementer", "kimi-model"))).toEqual(["kimi", "-m", "kimi-model"]);
  });

  it("falls back to the built-in flags when the harness leaves the field out", () => {
    install("contract", { FAKE_OMIT_FIELDS: "bypassArgs" });
    expect(harnessModelResolve({ client: "claude", model: "sonnet-5", effort: "high", role: "implementer" })!.bypassArgs).toBeNull();
    expect(buildAgentCommand("claude", stage("implementer", "sonnet-5"))).toEqual(["claude", "--model", "claude-sonnet-5-5", "--effort", "high", CLAUDE_BYPASS]);
  });

  it("falls back to the built-in flags when the harness is old or unavailable", () => {
    install("unknown");
    expect(buildAgentCommand("codex", stage("implementer", "gpt-5.6-luna"))).toContain(CODEX_BYPASS);
    harness!.restore();
    harness = undefined;
    resetHarnessCaches();
    expect(buildAgentCommand("codex", stage("implementer", "gpt-5.6-luna"))).toContain(CODEX_BYPASS);
  });

  it("starts the worker pane with no bypass flag through subagent when the harness says none", () => {
    install("contract", { FAKE_BYPASS_CLAUDE: "none" });
    const { env, herdr } = cliEnv();
    const spawned = run(["subagent", "implement the change", "--target", "claude", "--model", "sonnet-5", "--role", "implementer", "--effort", "high", "--cwd", sandbox], env);
    expect(spawned.status).toBe(0);
    expect(startArgs(herdr.log)).toEqual(["--model", "claude-sonnet-5-5", "--effort", "high"]);
  });
});

describe("a prompt or agent name starting with a dash is never an option", () => {
  it("prefixes a space in every inline command", () => {
    for (const client of ["claude", "codex", "antigravity", "cursor", "opencode", "kimi", "kiro"] as ClientKind[]) {
      for (const nonInteractive of [false, true]) {
        const argv = buildInlineCommand(client, stage("implementer", "model-x"), "--settings=evil", nonInteractive);
        expect(argv).toContain(" --settings=evil");
        expect(argv).not.toContain("--settings=evil");
      }
    }
    expect(buildInlineCommand("claude", stage("implementer", "sonnet-5"), "plain", true)).toContain("plain");
  });

  it("delivers a dash prompt to the captured agent as a positional value", () => {
    const { env, claude } = cliEnv();
    spawnSync(process.execPath, [cli, "mcp"], { encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: sandbox, timeout: 60_000,
      input: mcpSession([{ method: "tools/call", params: { name: "herdr_clink", arguments: { client: "claude", prompt: "- first bullet\n- second bullet" } } }]) });
    const argv = readJsonLines(claude.log)[0]!;
    expect(argv).toContain(" - first bullet\n- second bullet");
    expect(argv.some((arg) => arg.startsWith("- first"))).toBe(false);
  });

  it("rejects an agent name that could be read as an option before any Herdr call", async () => {
    const calls: string[] = [];
    const ok = (stdout = ""): HerdrCommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
    const herdr = new Proxy({} as HerdrClient, { get: (_target, name) => async () => { calls.push(String(name)); return ok(); } });
    const previous = process.env.HERDR_ENV;
    process.env.HERDR_ENV = "1";
    try {
      for (const agentName of ["-evil", "--kind", "bad name", "x;y", ""]) {
        if (agentName === "") continue;
        const result = await launchStageInHerdr({ client: "claude", stage: stage("implementer", "sonnet-5"), handoffPrompt: "task", herdr, agentName, layout: "tab" });
        expect(result.ok).toBe(false);
        expect(result.ackStatus).toBe("rejected");
        expect(result.error).toContain("Invalid agent name");
      }
      expect(calls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = previous;
    }
  });

  it("rejects --name starting with a dash from the command line without opening a pane", () => {
    const { env, herdr } = cliEnv();
    const spawned = run(["subagent", "task", "--target", "claude", "--model", "sonnet-5", "--effort", "high", "--cwd", sandbox, "--name=-evil"], env);
    expect(spawned.status).toBe(1);
    expect(spawned.stderr + spawned.stdout).toContain("Invalid agent name");
    expect(readJsonLines(herdr.log).filter((argv) => argv[1] === "split" || argv[1] === "start")).toEqual([]);
  });
});

describe("kimi uses the resolved model", () => {
  it("passes the resolved CLI id in the pane, interactive and print commands", () => {
    const planned = stage("implementer", "kimi-model", [], { cliModel: "kimi-resolved-id" });
    expect(buildAgentCommand("kimi", planned)).toEqual(["kimi", "-m", "kimi-resolved-id", "--yolo"]);
    expect(buildInlineCommand("kimi", planned, "task", false)).toEqual(["kimi", "-m", "kimi-resolved-id", "--yolo", "task"]);
    expect(buildInlineCommand("kimi", planned, "task", true)).toEqual(["kimi", "-m", "kimi-resolved-id", "-p", "task"]);
  });
});

describe("results do not carry the prompt", () => {
  it("redacts the prompt from the command text of captured runs", () => {
    const claude = writeRecorder(sandbox, "claude-fake");
    const saved = { aliases: process.env.HERDR_JEV_ALLOW_ALIASES, bin: process.env.HERDR_JEV_BIN_CLAUDE };
    process.env.HERDR_JEV_ALLOW_ALIASES = "1";
    process.env.HERDR_JEV_BIN_CLAUDE = claude.bin;
    try {
      const result = runAgentCaptured({ client: "claude", stage: stage("implementer", "sonnet-5"), promptText: "PRIVATE-PROMPT-TEXT", cwd: sandbox });
      expect(result.ok).toBe(true);
      expect(result.commandText).not.toContain("PRIVATE-PROMPT-TEXT");
      expect(result.commandText).toContain("<prompt>");
      expect(readJsonLines(claude.log)[0]).toContain("PRIVATE-PROMPT-TEXT");
    } finally {
      if (saved.aliases === undefined) delete process.env.HERDR_JEV_ALLOW_ALIASES;
      else process.env.HERDR_JEV_ALLOW_ALIASES = saved.aliases;
      if (saved.bin === undefined) delete process.env.HERDR_JEV_BIN_CLAUDE;
      else process.env.HERDR_JEV_BIN_CLAUDE = saved.bin;
    }
  });
});

describe("automatic trust toggle", () => {
  it("is on when unset or explicitly truthy and off for anything else", () => {
    for (const value of [undefined, "", "1", "true", "on", "yes", " TRUE "]) expect(autoTrustEnabled(value === undefined ? {} : { HERDR_JEV_AUTO_TRUST: value })).toBe(true);
    for (const value of ["0", "false", "off", "no", "disabled", "none", "2", "maybe"]) expect(autoTrustEnabled({ HERDR_JEV_AUTO_TRUST: value })).toBe(false);
  });
});

describe("a failed model resolution is not pinned for the whole process", () => {
  it("probes again once the failure window has passed", () => {
    install("unknown");
    const input = { client: "claude", model: "fable-5", effort: "high", role: "implementer" as const };
    expect(harnessModelResolve(input)).toBeNull();
    process.env.FAKE_HARNESS_MODE = "contract";
    expect(harnessModelResolve(input)).toBeNull();
    expect(harness!.callsFor("model-resolve")).toHaveLength(1);
    setSystemTime(new Date(Date.now() + 31_000));
    expect(harnessModelResolve(input)?.known).toBe(true);
    expect(harness!.callsFor("model-resolve")).toHaveLength(2);
    setSystemTime(new Date(Date.now() + 3_600_000));
    expect(harnessModelResolve(input)?.known).toBe(true);
    expect(harness!.callsFor("model-resolve")).toHaveLength(2);
  });
});
