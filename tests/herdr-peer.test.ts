import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { converseWithPeer, resolvePeerStage } from "../src/herdr/peer.js";
import type { HerdrClient } from "../src/herdr/client.js";
import { readHerdrObservedState, createHerdrClient, createProcessCommandAdapter, requiresTrustConfirmation, classifyHerdrCommandFailure } from "../src/herdr/client.js";
import { buildAgentCommand, buildInlineCommand, formatHerdrAgentName, nativeStageEffort, writeGridWorkers } from "../src/herdr/launcher.js";
import { createTestStateDir, assertNoRealHomeStateLeaks } from "./helpers.js";

let testEnv: { stateDir: string; cleanup: () => void };

beforeEach(() => {
  testEnv = createTestStateDir();
});

afterEach(() => {
  testEnv?.cleanup();
  assertNoRealHomeStateLeaks();
});

test("Kiro peers use an explicit native model and never invent scalar effort flags", async () => {
  const input = { source: "codex", target: "kiro", prompt: "Review a bounded task", model: "verified-kiro-model", crossHarness: "auto" };
  const peer = await resolvePeerStage(input);
  expect(buildAgentCommand(peer.client, peer.stage)).toEqual(["kiro-cli", "chat", "--trust-all-tools", "--agent", "ai-harness", "--model", "verified-kiro-model"]);
  expect(buildInlineCommand(peer.client, peer.stage, "task", true).slice(-2)).toEqual(["--no-interactive", "task"]);
  expect(nativeStageEffort("kiro", "high")).toBeUndefined();
  await expect(resolvePeerStage({ ...input, model: undefined })).rejects.toThrow("requires a verified model");
  await expect(resolvePeerStage({ ...input, effort: "high" })).rejects.toThrow("Explicit effort is unsupported");
});

test("AntiGravity preserves supported model and effort and long handles retain their unique suffix", async () => {
  const peer = await resolvePeerStage({ source: "codex", target: "antigravity", prompt: "Review design", model: "exact-agy-model", effort: "high" });
  const interactive = buildAgentCommand(peer.client, peer.stage);
  expect(interactive).toContain("exact-agy-model");
  expect(interactive.slice(-2)).toEqual(["--effort", "high"]);
  expect(buildInlineCommand(peer.client, peer.stage, "turn", true)).toContain("exact-agy-model");
  const name = formatHerdrAgentName("codex", "researcher", "very-long-model-name-that-exceeds-name-limit", "unique123");
  expect(name.length).toBeLessThanOrEqual(32);
  expect(name.endsWith("-unique123")).toBe(true);
  expect(name).not.toBe(formatHerdrAgentName("codex", "researcher", "very-long-model-name-that-exceeds-name-limit", "unique456"));
  expect(buildAgentCommand(peer.client, { ...peer.stage, effort: "xhigh" }).slice(-2)).toEqual(["--effort", "max"]);
  expect(nativeStageEffort("kimi", "high")).toBeUndefined();
});

test("idle snapshots do not claim task or turn completion", async () => {
  const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: "" });
  const herdr = {
    getAgent: async () => ok(JSON.stringify({ result: { agent: { pane_id: "idle-no-task", agent_status: "idle" } } })),
    readAgent: async () => ok("no task submitted"),
  } as unknown as HerdrClient;
  const read = JSON.parse(await converseWithPeer({ target: "idle-peer" }, herdr));
  expect(read.state).toBe("idle");
  expect(read.completed).toBeUndefined();
  expect(read.observedStateOnly).toBe(true);
});

test("native deadlines can exceed the adapter default", async () => {
  const run = createProcessCommandAdapter({ timeoutMs: 5 });
  const result = await run([process.execPath, "-e", "setTimeout(()=>console.log('finished'),50)", "--", "--timeout", "100"]);
  expect(result.ok).toBe(true);
  const timedOut = await run([process.execPath, "-e", "setTimeout(()=>console.log('finished'),50)"]);
  expect(timedOut.ok).toBe(false);
  expect(classifyHerdrCommandFailure(timedOut)).toBe("unknown");
});

test("a blocked submission cannot become a working launch acknowledgement", async () => {
  let command: readonly string[] = [];
  const client = createHerdrClient(async args => {
    command = args;
    return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ state: "blocked" }) };
  });
  const response = await client.prompt({ target: "peer", text: "task", wait: true, waitForStart: true });
  expect(command).toContain("blocked");
  expect(command).toContain("--timeout");
  expect(response.ok).toBe(false);
  expect(classifyHerdrCommandFailure(response)).toBe("unknown");
});

test("default explicit peer operation lets Jev choose another harness", async () => {
  const saved = process.env.HERDR_JEV_CROSS_HARNESS;
  delete process.env.HERDR_JEV_CROSS_HARNESS;
  try {
    const peer = await resolvePeerStage({ source: "codex", role: "advisor", prompt: "Give an opinion" });
    expect(peer.client).toBe("claude");
  } finally {
    if (saved === undefined) delete process.env.HERDR_JEV_CROSS_HARNESS;
    else process.env.HERDR_JEV_CROSS_HARNESS = saved;
  }
});

test("explicit targets honor configured restrictions without substitution", async () => {
  await expect(resolvePeerStage({ source: "codex", target: "claude", prompt: "Review", crossHarness: "disabled" })).rejects.toThrow("disallowed");
  await expect(resolvePeerStage({ source: "codex", target: "claude", prompt: "Review", crossHarness: "codex:antigravity" })).rejects.toThrow("disallowed");
  expect((await resolvePeerStage({ source: "codex", target: "claude", prompt: "Review", crossHarness: "codex:claude" })).client).toBe("claude");
});

test("peer names cannot override the actual observed state", () => {
  expect(readHerdrObservedState({ ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: { name: "timeout-worker", agent_status: "done" } } }) })).toBe("done");
});

test("ordinary trust questions do not impersonate current approval controls", () => {
  const result = (stdout: string) => ({ ok: true, code: 0, stderr: "", stdout });
  expect(requiresTrustConfirmation(result("User: Do you trust this design?\nAssistant: Yes, I trust the directory structure."))).toBe(false);
  expect(requiresTrustConfirmation(result("❯ No, exit\n  Yes, I trust this folder\nEnter to confirm · Esc to cancel"))).toBe(true);
  expect(requiresTrustConfirmation(result("❯ 1. Yes, I trust this folder\n2. No, exit\nEnter to confirm"))).toBe(true);
  expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: JSON.stringify({ error: { code: "agent_prompt_stalled" } }), stderr: "" })).toBe("unknown");
});

test("peer reply waits accept native idle without changing canonical completion waits", async () => {
  const commands: readonly string[][] = [];
  const client = createHerdrClient(async args => {
    (commands as string[][]).push([...args]);
    return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ state: "idle" }) };
  });
  expect((await client.prompt({ target: "peer", text: "turn", wait: true, waitForReply: true })).ok).toBe(true);
  expect(commands[0]).toContain("idle");
  expect((await client.waitFor({ target: "peer" })).ok).toBe(false);
  await client.readAgent!("peer");
  expect(commands.at(-1)).toContain("visible");
});

test("process exit releases a peer reservation", async () => {
  const pane = `crash-peer-${process.pid}`;
  const module = new URL("../src/herdr/peer.ts", import.meta.url).pathname;
  const code = `import {converseWithPeer} from ${JSON.stringify(module)};
const ok=stdout=>({ok:true,code:0,stdout,stderr:""});
await converseWithPeer({target:"crash-peer",text:"turn"},{getAgent:async()=>ok(JSON.stringify({result:{agent:{pane_id:${JSON.stringify(pane)},agent_status:"done"}}})),readAgent:async()=>ok("ready"),prompt:async()=>{console.log("reserved");await new Promise(()=>{});}});`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const ready = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain("reserved");
  } finally { child.kill("SIGKILL"); await child.exited; }
  await Bun.sleep(100);
  const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: "" });
  const herdr = { getAgent: async () => ok(JSON.stringify({ result: { agent: { pane_id: pane, agent_status: "done" } } })),
    readAgent: async () => ok("recovered") } as unknown as HerdrClient;
  expect(JSON.parse(await converseWithPeer({ target: "crash-peer" }, herdr)).output).toBe("recovered");
});

test("waiting for a working peer happens before reading its terminal", async () => {
  let finished = false;
  const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: "" });
  const herdr = {
    getAgent: async () => ok(JSON.stringify({ result: { agent: { pane_id: "test-wait-peer", agent_status: "working" } } })),
    waitFor: async () => { finished = true; return ok("done"); },
    readAgent: async () => { expect(finished).toBe(true); return ok("completed response"); },
  } as unknown as HerdrClient;
  expect(JSON.parse(await converseWithPeer({ target: "waiting-peer", wait: true }, herdr)).output).toBe("completed response");
});

test("explicit peer preserves another harness, exact model and effort", async () => {
  const peer = await resolvePeerStage({ source: "codex", target: "claude", prompt: "Review architecture", model: "sonnet", effort: "high" });
  expect(peer.client).toBe("claude");
  expect(peer.stage.model).toBe("sonnet");
  expect(peer.stage.effort).toBe("high");
  await expect(resolvePeerStage({ source: "codex", target: "missing", prompt: "hello" })).rejects.toThrow("Unknown peer harness");
});

test("conversation reuses the peer handle and rejects overlapping turns", async () => {
  let state = "done";
  const messages: string[] = [];
  const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: "" });
  const herdr = {
    readAgent: async () => ok("response"),
    getAgent: async () => ok(JSON.stringify({ result: { agent: { pane_id: "test-peer", agent_status: state } } })),
    prompt: async (input: { target: string; text: string }) => { messages.push(`${input.target}:${input.text}`); return ok("done"); },
  } as unknown as HerdrClient;
  expect(JSON.parse(await converseWithPeer({ target: "peer-existing", text: "next turn", wait: true }, herdr))).toMatchObject({ output: "response", lineLimit: 2000 });
  expect(messages).toEqual(["peer-existing:next turn"]);
  state = "working";
  await expect(converseWithPeer({ target: "peer-existing", text: "overlap" }, herdr)).rejects.toThrow("working");
  expect(messages.length).toBe(1);
});

test("simultaneous turns through different handles reserve the same pane", async () => {
  let finish!: () => void;
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: "" });
  const herdr = {
    readAgent: async () => ok("response"),
    getAgent: async () => ok(JSON.stringify({ result: { agent: { pane_id: "test-concurrent-peer", agent_status: "done" } } })),
    prompt: async () => { started(); await pending; return ok(""); },
  } as unknown as HerdrClient;
  const first = converseWithPeer({ target: "named-peer", text: "one" }, herdr);
  await start;
  try {
    expect(JSON.parse(await converseWithPeer({ target: "test-concurrent-peer" }, herdr)).output).toBe("response");
    await expect(converseWithPeer({ target: "test-concurrent-peer", text: "two" }, herdr)).rejects.toThrow("reserved");
  }
  finally { finish(); await first; }
});

test("blocked and unknown replies are not reported as completed answers", async () => {
  const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: "" });
  for (const state of ["blocked", "unknown"]) {
    const herdr = {
      getAgent: async () => ok(JSON.stringify({ result: { agent: { pane_id: "test-reply-state", agent_status: "done" } } })),
      readAgent: async () => ok("response"),
      prompt: async () => ok(JSON.stringify({ state })),
      waitFor: async () => ok(JSON.stringify({ state })),
    } as unknown as HerdrClient;
    await expect(converseWithPeer({ target: "peer", text: "turn", wait: true }, herdr)).rejects.toThrow(state);
    await expect(converseWithPeer({ target: "peer", wait: true }, herdr)).rejects.toThrow(state);
  }
});

test("broadcast fan-out sends sequentially to tracked grid workers and prunes dead panes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-fanout-"));
  const savedStateDir = process.env.HERDR_JEV_STATE_DIR;
  process.env.HERDR_JEV_STATE_DIR = dir;
  try {
    const callerPane = "caller-pane";
    writeGridWorkers(callerPane, ["worker-1", "worker-2", "worker-dead", callerPane]);

    const prompted: Array<{ target: string; text: string; wait?: boolean; waitForStart?: boolean; waitForReply?: boolean }> = [];
    const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: "" });
    const herdr = {
      paneLayout: async () => ok(JSON.stringify({
        panes: [{ id: callerPane }, { id: "worker-1" }, { id: "worker-2" }]
      })),
      getAgent: async (target: string) => {
        if (target === "worker-1") return ok(JSON.stringify({ result: { agent: { name: "agent-alpha", pane_id: "worker-1", agent_status: "idle" } } }));
        if (target === "worker-2") return ok(JSON.stringify({ result: { agent: { name: "agent-beta", pane_id: "worker-2", agent_status: "done" } } }));
        if (target === "agent-alpha") return ok(JSON.stringify({ result: { agent: { name: "agent-alpha", pane_id: "worker-1", agent_status: "idle" } } }));
        if (target === "agent-beta") return ok(JSON.stringify({ result: { agent: { name: "agent-beta", pane_id: "worker-2", agent_status: "done" } } }));
        return { ok: false, code: 1, stdout: "", stderr: "not found" };
      },
      readAgent: async () => ok("snapshot output"),
      prompt: async (input: any) => {
        prompted.push(input);
        return ok(JSON.stringify({ state: "working" }));
      },
    } as unknown as HerdrClient;

    const result = await converseWithPeer({ all: true, text: "broadcast update", callerPaneId: callerPane }, herdr);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual([
      { agent: "agent-alpha", paneId: "worker-1", acknowledged: true, state: "working" },
      { agent: "agent-beta", paneId: "worker-2", acknowledged: true, state: "working" },
    ]);
    expect(prompted.length).toBe(2);
    expect(prompted[0].target).toBe("agent-alpha");
    expect(prompted[0].text).toBe("broadcast update");
    expect(prompted[1].target).toBe("agent-beta");
    expect(prompted[1].text).toBe("broadcast update");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (savedStateDir === undefined) delete process.env.HERDR_JEV_STATE_DIR;
    else process.env.HERDR_JEV_STATE_DIR = savedStateDir;
  }
});

test("broadcast honors --wait waiting on each peer with shared timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-wait-"));
  const savedStateDir = process.env.HERDR_JEV_STATE_DIR;
  process.env.HERDR_JEV_STATE_DIR = dir;
  try {
    const callerPane = "caller-pane";
    writeGridWorkers(callerPane, ["worker-1", "worker-2"]);

    const prompted: Array<{ target: string; wait?: boolean; waitForReply?: boolean; timeoutMs?: number }> = [];
    const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: "" });
    const herdr = {
      getAgent: async (target: string) => {
        if (target === "worker-1") return ok(JSON.stringify({ result: { agent: { name: "agent-1", pane_id: "worker-1", agent_status: "idle" } } }));
        if (target === "worker-2") return ok(JSON.stringify({ result: { agent: { name: "agent-2", pane_id: "worker-2", agent_status: "idle" } } }));
        if (target === "agent-1") return ok(JSON.stringify({ result: { agent: { name: "agent-1", pane_id: "worker-1", agent_status: "idle" } } }));
        if (target === "agent-2") return ok(JSON.stringify({ result: { agent: { name: "agent-2", pane_id: "worker-2", agent_status: "idle" } } }));
        return { ok: false, code: 1, stdout: "", stderr: "not found" };
      },
      readAgent: async () => ok("worker output"),
      prompt: async (input: any) => {
        prompted.push(input);
        return ok(JSON.stringify({ state: "done" }));
      },
    } as unknown as HerdrClient;

    const result = await converseWithPeer({ all: true, text: "run task", wait: true, timeoutMs: 50000, callerPaneId: callerPane }, herdr);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual([
      { agent: "agent-1", paneId: "worker-1", acknowledged: true, state: "done" },
      { agent: "agent-2", paneId: "worker-2", acknowledged: true, state: "done" },
    ]);
    expect(prompted[0].waitForReply).toBe(true);
    expect(prompted[0].timeoutMs).toBeLessThanOrEqual(50000);
    expect(prompted[1].waitForReply).toBe(true);
    expect(prompted[1].timeoutMs).toBeLessThanOrEqual(50000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (savedStateDir === undefined) delete process.env.HERDR_JEV_STATE_DIR;
    else process.env.HERDR_JEV_STATE_DIR = savedStateDir;
  }
});

test("broadcast excludes specified handles by name and paneId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-exclude-"));
  const savedStateDir = process.env.HERDR_JEV_STATE_DIR;
  process.env.HERDR_JEV_STATE_DIR = dir;
  try {
    const callerPane = "caller-pane";
    writeGridWorkers(callerPane, ["worker-1", "worker-2", "worker-3"]);

    const prompted: string[] = [];
    const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: "" });
    const herdr = {
      getAgent: async (target: string) => {
        if (target === "worker-1" || target === "agent-1") return ok(JSON.stringify({ result: { agent: { name: "agent-1", pane_id: "worker-1", agent_status: "idle" } } }));
        if (target === "worker-2" || target === "agent-2") return ok(JSON.stringify({ result: { agent: { name: "agent-2", pane_id: "worker-2", agent_status: "idle" } } }));
        if (target === "worker-3" || target === "agent-3") return ok(JSON.stringify({ result: { agent: { name: "agent-3", pane_id: "worker-3", agent_status: "idle" } } }));
        return { ok: false, code: 1, stdout: "", stderr: "not found" };
      },
      readAgent: async () => ok("output"),
      prompt: async (input: any) => {
        prompted.push(input.target);
        return ok(JSON.stringify({ state: "working" }));
      },
    } as unknown as HerdrClient;

    const result = await converseWithPeer({ all: true, text: "msg", exclude: "agent-2, worker-3", callerPaneId: callerPane }, herdr);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual([
      { agent: "agent-1", paneId: "worker-1", acknowledged: true, state: "working" },
    ]);
    expect(prompted).toEqual(["agent-1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (savedStateDir === undefined) delete process.env.HERDR_JEV_STATE_DIR;
    else process.env.HERDR_JEV_STATE_DIR = savedStateDir;
  }
});

test("broadcast collects per-peer results on partial failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-partial-fail-"));
  const savedStateDir = process.env.HERDR_JEV_STATE_DIR;
  process.env.HERDR_JEV_STATE_DIR = dir;
  try {
    const callerPane = "caller-pane";
    writeGridWorkers(callerPane, ["worker-1", "worker-2", "worker-3"]);

    const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: "" });
    const herdr = {
      getAgent: async (target: string) => {
        if (target === "worker-1" || target === "agent-1") return ok(JSON.stringify({ result: { agent: { name: "agent-1", pane_id: "worker-1", agent_status: "idle" } } }));
        if (target === "worker-2" || target === "agent-2") return ok(JSON.stringify({ result: { agent: { name: "agent-2", pane_id: "worker-2", agent_status: "working" } } }));
        if (target === "worker-3" || target === "agent-3") return ok(JSON.stringify({ result: { agent: { name: "agent-3", pane_id: "worker-3", agent_status: "idle" } } }));
        return { ok: false, code: 1, stdout: "", stderr: "not found" };
      },
      readAgent: async () => ok("output"),
      prompt: async (input: any) => {
        if (input.target === "agent-3" || input.target === "worker-3") {
          return { ok: false, code: 1, stdout: "", stderr: "connection lost" };
        }
        return ok(JSON.stringify({ state: "working" }));
      },
    } as unknown as HerdrClient;

    const result = await converseWithPeer({ all: true, text: "batch command", callerPaneId: callerPane }, herdr);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual([
      { agent: "agent-1", paneId: "worker-1", acknowledged: true, state: "working" },
      { agent: "agent-2", paneId: "worker-2", acknowledged: false, state: "working" },
      { agent: "agent-3", paneId: "worker-3", acknowledged: false, state: "idle" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (savedStateDir === undefined) delete process.env.HERDR_JEV_STATE_DIR;
    else process.env.HERDR_JEV_STATE_DIR = savedStateDir;
  }
});

test("mutual exclusivity of target and --all", async () => {
  await expect(converseWithPeer({ target: "some-agent", all: true, text: "msg" })).rejects.toThrow("mutually exclusive");
  await expect(converseWithPeer({ all: true, text: "" })).rejects.toThrow("nonempty message");
});

test("peer-message CLI enforces mutual exclusivity of <agent> and --all", async () => {
  const cliPath = join(import.meta.dir, "../src/cli.ts");
  const child = Bun.spawn([process.execPath, "run", cliPath, "peer-message", "worker-1", "hello", "--all"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect(exitCode).toBe(1);
  expect(stderr).toContain("Cannot specify both <agent> and --all");
});

test("peer-message CLI exits code 1 if any worker send was not acknowledged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-cli-fail-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const mockHerdr = join(binDir, "herdr");
  writeFileSync(mockHerdr, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "agent" && args[1] === "get") {
  const target = args[2];
  if (target === "w1") {
    console.log(JSON.stringify({ result: { agent: { name: "w1", pane_id: "w1", agent_status: "idle" } } }));
    process.exit(0);
  }
  if (target === "w2") {
    console.log(JSON.stringify({ result: { agent: { name: "w2", pane_id: "w2", agent_status: "working" } } }));
    process.exit(0);
  }
}
if (args[0] === "agent" && args[1] === "read") {
  console.log("ok");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "prompt") {
  console.log(JSON.stringify({ state: "working" }));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });

  const callerPane = "caller-pane";
  const stateDir = join(dir, "state");
  const gridDir = join(stateDir, "grid");
  mkdirSync(gridDir, { recursive: true });
  writeFileSync(join(gridDir, `${callerPane}.json`), JSON.stringify({ workerPaneIds: ["w1", "w2"] }));

  const cliPath = join(import.meta.dir, "../src/cli.ts");
  const child = Bun.spawn([process.execPath, "run", cliPath, "peer-message", "--all", "hello"], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HERDR_BIN_PATH: mockHerdr,
      HERDR_JEV_STATE_DIR: stateDir,
      HERDR_PANE_ID: callerPane,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  expect(exitCode).toBe(1);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed).toEqual([
    { agent: "w1", paneId: "w1", acknowledged: true, state: "working" },
    { agent: "w2", paneId: "w2", acknowledged: false, state: "working" },
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("peer-message CLI exits code 0 when all workers acknowledge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-cli-ok-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const mockHerdr = join(binDir, "herdr");
  writeFileSync(mockHerdr, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "agent" && args[1] === "get") {
  console.log(JSON.stringify({ result: { agent: { name: args[2], pane_id: args[2], agent_status: "idle" } } }));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "read") {
  console.log("ok");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "prompt") {
  console.log(JSON.stringify({ state: "working" }));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });

  const callerPane = "caller-pane";
  const stateDir = join(dir, "state");
  const gridDir = join(stateDir, "grid");
  mkdirSync(gridDir, { recursive: true });
  writeFileSync(join(gridDir, `${callerPane}.json`), JSON.stringify({ workerPaneIds: ["w1", "w2"] }));

  const cliPath = join(import.meta.dir, "../src/cli.ts");
  const child = Bun.spawn([process.execPath, "run", cliPath, "peer-message", "--all", "hello"], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HERDR_BIN_PATH: mockHerdr,
      HERDR_JEV_STATE_DIR: stateDir,
      HERDR_PANE_ID: callerPane,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed).toEqual([
    { agent: "w1", paneId: "w1", acknowledged: true, state: "working" },
    { agent: "w2", paneId: "w2", acknowledged: true, state: "working" },
  ]);
  rmSync(dir, { recursive: true, force: true });
});
