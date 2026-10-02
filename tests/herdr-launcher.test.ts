import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolveHarnessRoot } from "../src/harness/bridge.js";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHerdrClient, readHerdrObservedState, type HerdrClient } from "../src/herdr/client.js";
import { buildAgentCommand, buildInlineCommand, launchStageInHerdr, parseHerdrPaneId, resolveAntigravityModel } from "../src/herdr/launcher.js";
import { converseWithPeer, resolvePeerStage } from "../src/herdr/peer.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";
import { createTestStateDir, assertNoRealHomeStateLeaks } from "./helpers.js";

const originalHerdrEnv = process.env.HERDR_ENV;
const stage: StageSpec = {
  role: "implementer",
  model: "gpt-5.6-luna",
  effort: "xhigh",
  extraFlags: [],
  description: "synthetic stage",
};

function commandResult(ok: boolean, stdout = "", stderr = ""): HerdrCommandResult {
  return { ok, code: ok ? 0 : 1, stdout, stderr };
}

function fakeHerdr(promptResult: HerdrCommandResult, completionResult = commandResult(true, "done")): HerdrClient & { promptCalls: number; closeCalls: number; waitCalls: number } {
  let promptCalls = 0;
  let closeCalls = 0;
  let waitCalls = 0;
  let lastPrompt = "";
  return {
    get promptCalls() { return promptCalls; },
    get closeCalls() { return closeCalls; },
    get waitCalls() { return waitCalls; },
    splitCurrent: async () => commandResult(true, JSON.stringify({ result: { pane: { pane_id: "pane-42" } } })),
    startAgent: async () => commandResult(true),
    prompt: async (input) => {
      promptCalls += 1;
      lastPrompt = input.text;
      return promptResult;
    },
    waitFor: async () => {
      waitCalls += 1;
      return completionResult;
    },
    readAgent: async () => commandResult(true, lastPrompt || "› \n> \n❯ task synthetic handoff ready"),
    readPane: async () => commandResult(true, lastPrompt || "› \n> \n❯ task synthetic handoff ready"),
    closePane: async () => {
      closeCalls += 1;
      return commandResult(true);
    },
    notify: async () => commandResult(true),
  };
}

let testEnv: { stateDir: string; cleanup: () => void };

beforeEach(() => {
  testEnv = createTestStateDir();
});

afterEach(() => {
  if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = originalHerdrEnv;
  testEnv?.cleanup();
  assertNoRealHomeStateLeaks();
});

describe("Herdr launch acknowledgement", () => {
  it("reports spawn lineage without exposing the task or repeating dispatch", async () => {
    process.env.HERDR_ENV = "1";
    process.env.TYPESAFE_API_KEY = "";
    const herdr = fakeHerdr(commandResult(true));
    const agentName = `observed-peer-${process.pid}`;
    let reports = 0;
    herdr.reportSpawn = async (pane, tokens) => {
      reports++;
      expect(pane).toBe("pane-42");
      expect(tokens).toEqual({ jev_parent: "parent-1", jev_role: stage.role, jev_model: stage.model, jev_handle: agentName });
      return commandResult(false, "", "metadata unavailable");
    };
    const result = await launchStageInHerdr({ client: "codex", stage, handoffPrompt: "private task", sourcePaneId: "parent-1", agentName, herdr });
    expect(result.ok).toBe(true);
    expect(reports).toBe(1);
    expect(herdr.promptCalls).toBe(1);
  });

  it("cascaded codex peer from antigravity applies matrix effort and includes effort flag in launch command", async () => {
    process.env.HERDR_ENV = "1";
    const { client, stage: cascadedStage } = await resolvePeerStage({
      source: "antigravity",
      role: "implementer",
      prompt: "Implement caching layer",
    });
    expect(client).toBe("codex");
    expect(cascadedStage.model).toBe("gpt-5.6-luna");
    expect(cascadedStage.effort).toBe("xhigh");

    const herdr = fakeHerdr(commandResult(true));
    let agentArgs: string[] | undefined;
    herdr.startAgent = async (options) => {
      agentArgs = options.agentArgs;
      return commandResult(true);
    };

    const result = await launchStageInHerdr({
      client,
      stage: cascadedStage,
      handoffPrompt: "Implement caching layer",
      sourcePaneId: "agy-pane-1",
      herdr,
    });

    expect(result.ok).toBe(true);
    expect(result.commandText).toContain('model_reasoning_effort="xhigh"');
    expect(agentArgs).toBeDefined();
    expect(agentArgs).toContain('model_reasoning_effort="xhigh"');
  });

  it("preserves the stage effort in interactive and captured commands", () => {
    expect(buildAgentCommand("codex", stage)).toContain('model_reasoning_effort="xhigh"');
    expect(buildInlineCommand("codex", stage, "task", true)).toContain('model_reasoning_effort="xhigh"');
    expect(buildAgentCommand("claude", { ...stage, effort: "high" })).toEqual(["claude", "--model", stage.model, "--effort", "high", "--dangerously-skip-permissions"]);
  });

  it("reads tab root panes and rejects unrelated JSON instead of using it as a pane ID", () => {
    expect(parseHerdrPaneId(JSON.stringify({ result: { root_pane: { pane_id: "w1:p4" } } }))).toBe("w1:p4");
    expect(parseHerdrPaneId('{"result":{"type":"error"}}')).toBeUndefined();
  });

  it("creates a tab before starting an agent when requested", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    let tabs = 0;
    herdr.createTab = async () => { tabs++; return commandResult(true, JSON.stringify({ result: { root_pane: { pane_id: "w1:p5" } } })); };
    herdr.prompt = async (input) => {
      expect(input.wait).toBe(true);
      expect(input.waitForStart).toBe(true);
      return commandResult(true);
    };
    const result = await launchStageInHerdr({ client: "codex", stage, handoffPrompt: "task", herdr, layout: "tab" });
    expect(tabs).toBe(1);
    expect(result.paneId).toBe("w1:p5");
  });

  it("retains a named peer on retry and never resends its prompt", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    herdr.getAgent = async () => commandResult(true, JSON.stringify({ result: { agent: { pane_id: "existing-peer" } } }));
    herdr.createTab = async () => { throw new Error("Retry must not create a tab"); };
    const result = await launchStageInHerdr({ client: "codex", stage, handoffPrompt: "task", herdr,
      layout: "tab", agentName: "stable-retry-peer", reuseExisting: true });
    expect(result.ok).toBe(false);
    expect(result.paneId).toBe("existing-peer");
    expect(result.error).toContain("Existing peer retained");
    expect(herdr.promptCalls).toBe(0);
  });

  it("serializes concurrent spawn requests sharing a stable name", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let tabs = 0;
    let startedFlag = false;
    herdr.startAgent = async () => { startedFlag = true; return commandResult(true); };
    herdr.getAgent = async () => startedFlag ? commandResult(true, JSON.stringify({ result: { agent: { agent_status: "idle" } } })) : commandResult(false, JSON.stringify({ error: { code: "agent_not_found" } }));
    herdr.createTab = async () => { tabs++; started(); await pending; return commandResult(true, JSON.stringify({ result: { root_pane: { pane_id: "first-peer" } } })); };
    const input = { client: "codex", stage, handoffPrompt: "task", herdr, layout: "tab" as const, agentName: `named-${Date.now().toString(36)}`, reuseExisting: true };
    const first = launchStageInHerdr(input);
    await ready;
    try {
      const second = await launchStageInHerdr(input);
      expect(second.ok).toBe(false);
      expect(second.error).toContain("reserved");
      expect(tabs).toBe(1);
    } finally { finish(); await first; }
  });

  it("never repeats named pane creation when its first acknowledgement is uncertain", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    let tabs = 0;
    let startedFlag = false;
    herdr.startAgent = async () => { startedFlag = true; return commandResult(true); };
    herdr.getAgent = async () => startedFlag ? commandResult(true, JSON.stringify({ result: { agent: { agent_status: "idle" } } })) : commandResult(false, JSON.stringify({ error: { code: "agent_not_found" } }));
    herdr.createTab = async () => { tabs++; return commandResult(true, JSON.stringify({ result: {} })); };
    const input = { client: "codex", stage, handoffPrompt: "task", herdr, layout: "tab" as const,
      agentName: `uncertain-${Date.now().toString(36)}`, reuseExisting: true };
    expect((await launchStageInHerdr(input)).ackStatus).toBe("unknown");
    const retry = await launchStageInHerdr(input);
    expect(retry.ok).toBe(false);
    expect(retry.error).toContain("Named spawn already attempted");
    expect(tabs).toBe(1);
  });

  it("reserves the peer pane before startup so messages cannot precede its initial task", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    herdr.startAgent = async () => { started(); await pending; return commandResult(true); };
    herdr.getAgent = async () => commandResult(true, JSON.stringify({ result: { agent: { pane_id: "pane-42", agent_status: "idle" } } }));
    const first = launchStageInHerdr({ client: "codex", stage, handoffPrompt: "initial task", herdr });
    await ready;
    try {
      await expect(converseWithPeer({ target: "new-peer", text: "premature turn" }, herdr)).rejects.toThrow("reserved");
      expect(herdr.promptCalls).toBe(0);
    } finally { finish(); await first; }
    expect(herdr.promptCalls).toBe(1);
  });
  it("returns launch failure when prompt acknowledgement fails without relaunching or closing the pane", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(false, "", "prompt transport failed"));
    const result = await launchStageInHerdr({
      client: "cursor",
      stage,
      handoffPrompt: "synthetic handoff",
      herdr,
    });
    expect(result.ok).toBe(false);
    expect(result.paneId).toBe("pane-42");
    expect(result.error).toContain("Prompt dispatch failed");
    expect(result.ackStatus).toBe("unknown");
    expect(herdr.promptCalls).toBe(1);
    expect(herdr.closeCalls).toBe(0);
  });

  it("reports launch acknowledgement only after the prompt command succeeds", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    const result = await launchStageInHerdr({
      client: "cursor",
      stage,
      handoffPrompt: "synthetic handoff",
      herdr,
    });
    expect(result.ok).toBe(true);
    expect(result.paneCreated).toBe(true);
    expect(result.paneId).toBe("pane-42");
  });

  it("never sends work into a repository trust dialog", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    herdr.readAgent = async () => commandResult(true, "1. Trust and continue");
    const result = await launchStageInHerdr({ client: "codex", stage, handoffPrompt: "bounded task", herdr });
    expect(herdr.promptCalls).toBe(0);
    expect(result.ackStatus).toBe("blocked");
    expect(result.trustRequired).toBe(true);
    expect(result.error).toContain("trust confirmation");
  });

  it("keeps a detected agent when startup readiness is uncertain", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    herdr.startAgent = async () => commandResult(false, "", "agent_not_ready");
    const result = await launchStageInHerdr({ client: "codex", stage, handoffPrompt: "task", herdr });
    expect(result.ackStatus).toBe("unknown");
    expect(herdr.closeCalls).toBe(0);
    expect(herdr.promptCalls).toBe(0);
  });

  it("supervises the launched pane through done without converting it into work verification", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true), commandResult(true, JSON.stringify({ state: "done" })));
    const result = await launchStageInHerdr({
      client: "codex",
      stage,
      handoffPrompt: "synthetic handoff",
      herdr,
      waitForCompletion: true,
    });
    expect(result.ok).toBe(true);
    expect(result.ackStatus).toBe("acknowledged");
    expect(result.completionState).toBe("done");
    expect(result.completionObserved).toBe(true);
    expect(result.workEvidence).toBe("not_checked");
    expect(herdr.waitCalls).toBe(1);
  });

  it("keeps unknown and timeout completion separate from launch acknowledgement", async () => {
    process.env.HERDR_ENV = "1";
    const unknown = fakeHerdr(commandResult(true), commandResult(true, JSON.stringify({ state: "unknown" })));
    const unknownResult = await launchStageInHerdr({ client: "codex", stage, handoffPrompt: "synthetic handoff", herdr: unknown, waitForCompletion: true });
    expect(unknownResult.ok).toBe(true);
    expect(unknownResult.completionState).toBe("unknown");
    expect(unknownResult.completionObserved).toBe(true);

    const timeout = fakeHerdr(commandResult(true), commandResult(true, "timeout"));
    const timeoutResult = await launchStageInHerdr({ client: "codex", stage, handoffPrompt: "synthetic handoff", herdr: timeout, waitForCompletion: true });
    expect(timeoutResult.ok).toBe(true);
    expect(timeoutResult.completionState).toBe("timeout");
    expect(timeoutResult.completionObserved).toBe(false);
  });

  it("sets promptDelivered true when pane output contains prompt prefix", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    herdr.readAgent = async () => commandResult(true, "prefix of task running in terminal...");
    const result = await launchStageInHerdr({
      client: "cursor",
      stage,
      handoffPrompt: "prefix of task",
      herdr,
    });
    expect(result.ok).toBe(true);
    expect(result.ackStatus).toBe("acknowledged");
    expect(result.promptDelivered).toBe(true);
  });

  it("sets promptDelivered true when agent status left idle", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    herdr.readAgent = async () => commandResult(true, "unrelated banner");
    let getCalls = 0;
    herdr.getAgent = async () => {
      getCalls++;
      if (getCalls <= 1) return commandResult(true, JSON.stringify({ result: { agent: { agent_status: "idle" } } }));
      return commandResult(true, JSON.stringify({ result: { agent: { agent_status: "working" } } }));
    };
    const result = await launchStageInHerdr({
      client: "cursor",
      stage,
      handoffPrompt: "different prompt",
      herdr,
    });
    expect(result.ok).toBe(true);
    expect(result.ackStatus).toBe("acknowledged");
    expect(result.promptDelivered).toBe(true);
  });

  it("returns ackStatus unknown with promptPending true and hint when prompt not confirmed, never resending prompt", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(true));
    herdr.readAgent = async () => commandResult(true, "idle screen with banner");
    herdr.getAgent = async () => commandResult(true, JSON.stringify({ result: { agent: { agent_status: "idle" } } }));
    const result = await launchStageInHerdr({
      client: "cursor",
      stage,
      handoffPrompt: "expected prompt text",
      deliveryTimeoutMs: 10,
      herdr,
    });
    expect(result.ok).toBe(false);
    expect(result.ackStatus).toBe("unknown");
    expect(result.promptPending).toBe(true);
    expect(result.hint).toBe("prompt not observed; use peer-message");
    expect(herdr.promptCalls).toBe(1);
  });
});

describe("Herdr completion state gate", () => {
  it("reads the nested agent status from real Herdr agent-info payloads", () => {
    for (const state of ["idle", "working", "done", "blocked", "unknown"] as const) {
      const result = commandResult(true, JSON.stringify({
        id: "cli:agent:wait",
        result: {
          agent: {
            agent: "kimi",
            agent_status: state,
            cwd: "/fixture",
            pane_id: "wCF:p1",
          },
          type: "agent_info",
        },
      }));
      expect(readHerdrObservedState(result)).toBe(state);
    }
    expect(readHerdrObservedState(commandResult(true, "pending"))).toBe("pending");
    expect(readHerdrObservedState(commandResult(true, "timeout"))).toBe("timeout");
  });

  it("keeps every non-terminal nested status out of completion success", async () => {
    for (const state of ["idle", "working"] as const) {
      const client = createHerdrClient(async () => commandResult(true, JSON.stringify({ result: { agent: { agent_status: state } } })));
      expect((await client.waitFor({ target: "agent-1" })).ok).toBe(false);
    }
    for (const output of ["pending", "timeout"]) {
      const client = createHerdrClient(async () => commandResult(true, output));
      expect((await client.waitFor({ target: "agent-1" })).ok).toBe(false);
    }
    for (const state of ["done", "blocked", "unknown"] as const) {
      const client = createHerdrClient(async () => commandResult(true, JSON.stringify({ result: { agent: { agent_status: state } } })));
      expect((await client.waitFor({ target: "agent-1" })).ok).toBe(true);
    }
  });

  it("waits only for done, blocked, or unknown and never treats idle as success", async () => {
    const calls: string[][] = [];
    const client = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return commandResult(true, JSON.stringify({ state: "idle" }));
    });
    const result = await client.waitFor({ target: "agent-1" });
    expect(result.ok).toBe(false);
    expect(calls[0]).toEqual([
      process.env.HERDR_BIN_PATH || "herdr",
      "agent",
      "wait",
      "agent-1",
      "--until",
      "done",
      "--until",
      "blocked",
      "--until",
      "unknown",
    ]);
  });

  it("does not turn pending or timeout output into success", async () => {
    const client = createHerdrClient(async () => commandResult(true, "pending: timeout"));
    const result = await client.waitFor({ target: "agent-1" });
    expect(result.ok).toBe(false);
  });
});

describe("canonical route execution", () => {
  it("does not launch research or implementation without the actual model and canonical profile", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-route-direct-"));
    try {
      const result = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "route", "investigar a documentação", "--client", "codex", "--wait"], {
        encoding: "utf8", env: { ...process.env, AI_HARNESS_ROOT: root, HERDR_ENV: "0", HOME: root, TYPESAFE_API_KEY: "" }, timeout: 60_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('"mode": "direct"');
      expect(existsSync(join(root, "state", "auto-improvements.jsonl"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("records one real Harness attempt and never starts review from a pane done observation alone", () => {
    const harnessRoot = resolveHarnessRoot();
    if (!existsSync(join(harnessRoot, "src/control-plane/external-runs.ts"))) return;
    const root = mkdtempSync(join(tmpdir(), "herdr-route-ledger-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const harness = join(bin, "ai-harness");
    const herdr = join(bin, "herdr");
    const log = join(root, "calls.jsonl");
    const repo = join(root, "repo");
    mkdirSync(repo);
    for (const argv of [["init"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "fixture"]]) {
      expect(spawnSync("git", argv, { cwd: repo }).status).toBe(0);
    }
    const verify = join(root, "verify.json");
    writeFileSync(verify, JSON.stringify([process.execPath, "-e", "process.exit(0)"]));
    const reviewer = join(bin, "codex");
    writeFileSync(reviewer, `#!${process.execPath}\nconsole.log("REVIEW_GATE_VERDICT: APPROVE");\n`, { mode: 0o700 });
    const profile = { id: "fixture", client: "codex", advisor: "advisor", executor: { model: "executor" }, reviewer: { model: "reviewer" } };
    writeFileSync(harness, `#!${process.execPath}
import * as runs from ${JSON.stringify(join(harnessRoot, "src/control-plane/external-runs.ts"))};
import {resolveDelegation} from ${JSON.stringify(join(harnessRoot, "src/control-plane/delegation.ts"))};
import {runReviewCommand} from ${JSON.stringify(join(harnessRoot, "src/control-plane/review.ts"))};
import {readFileSync} from "node:fs";
const args=process.argv.slice(2);
const option=(key)=>args[args.indexOf(key)+1];
const control={root:${JSON.stringify(root)},harness:{paths:{state:${JSON.stringify(join(root,"state"))}},clients:{codex:{enabled:true}},delegation:{profiles:[${JSON.stringify(profile)}]}}};
if(args[0].startsWith("review-")) {
console.log(JSON.stringify(await runReviewCommand(control,{client:option("--client"),session:option("--session"),cwd:option("--cwd")},args[0]==="review-verify"?"verify":"judge",JSON.parse(readFileSync(option("--command-json"),"utf8")))));
} else if(args[0]==="delegation-plan") {
console.log(JSON.stringify(resolveDelegation(control.harness.delegation,{client:option("--client"),model:option("--model"),role:"advisor",work:"substantive",availableModels:option("--available-models").split(",")})));
} else {
const input=JSON.parse(option("--request-json"));
const action=option("--action");
let result;
if(action==="create") result=runs.createExternalRun(control,input,input.cwd,input.objectiveDigest);
if(action==="claim") result=runs.claimExternalStage(control,input.id,input.stage,input.timeoutMs);
if(action==="observe") result=runs.observeExternalStage(control,input.id,input.stage,input.token,input.pane,input.timeoutMs);
if(action==="ack") result=runs.acknowledgeExternalStage(control,input.id,input.stage,input.token,input.pane,input.promptPending,input.promptAcknowledged);
if(action==="prompt-claim") result=runs.claimExternalPrompt(control,input.id,input.stage,input.token);
if(action==="settle") result=runs.settleExternalStage(control,input.id,input.stage,input.token,input.state,input.handoff);
if(action==="status") result=runs.inspectExternalRun(control,input.id);
if(action==="verify") result=runs.verifyExternalStage(control,input.id,input.stage);
if(action==="handoff") result=runs.boundedHandoff(input.path);
if(action==="project") result=runs.projectExternalRun(runs.inspectExternalRun(control,input.id));
console.log(JSON.stringify(result));
}`, { mode: 0o700 });
    writeFileSync(herdr, `#!${process.execPath}
import {appendFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)},JSON.stringify(args.slice(0,2))+"\\n");
if(args[0]==="pane") console.log(JSON.stringify({result:{pane:{pane_id:"pane-1"}}}));
if(args[1]==="prompt" || args[1]==="start") {
const text=args.join(" ");
const match=text.match(/to (\\/[^:]+\\/implementer\\.md):/);
if(match) writeFileSync(match[1],"Changed fixture. Checks pending.");
}
if(args[1]==="wait") console.log(JSON.stringify({state:"done"}));
if(args[1]==="get") console.log(JSON.stringify({result:{agent:{name:args[2],agent:"codex",pane_id:"pane-1",agent_status:"done"}}}));
if(args[1]==="read") console.log(process.env.TRUST_BLOCKED==="1"?"1. Trust and continue":"Ask Codex to do anything");
`, { mode: 0o700 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_") && key !== "AI_HARNESS_TEST_GUARD"));
    Object.assign(env, { PATH: bin + ":" + process.env.PATH, AI_HARNESS_ROOT: root,
      HERDR_BIN_PATH: herdr, HERDR_ENV: "1", HERDR_JEV_SOURCE_PANE_ID: "pane-1", HOME: root, TYPESAFE_API_KEY: "",
      HERDR_JEV_ALLOW_ALIASES: "1", HERDR_JEV_BIN_CODEX: reviewer, TRUST_BLOCKED: "1" });
    try {
      const result = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "route", "architecture fixture", "--client", "codex", "--triad", "--model", "advisor", "--available-models", "executor,reviewer", "--wait"], {
        encoding: "utf8", env, cwd: repo, timeout: 60_000,
      });
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{\n')));
      expect(parsed.error).toContain("trust confirmation");
      expect(parsed.run.stages.map((stage: any) => stage.state)).toEqual(["blocked", "queued"]);
      env.TRUST_BLOCKED = "0";
      env.HERDR_JEV_SOURCE_PANE_ID = "closed-caller";
      const resumed = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "run-resume", parsed.run.id, "--cwd", repo], { encoding: "utf8", env, cwd: root, timeout: 60_000 });
      expect(resumed.status).toBe(0);
      expect(JSON.parse(resumed.stdout).run.stages[0].state).toBe("reported");
      env.HERDR_JEV_SOURCE_PANE_ID = "pane-1";
      const verified = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "run-resume", parsed.run.id, "--verify-command-json", verify], { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
      expect(verified.status).toBe(0);
      expect(JSON.parse(verified.stdout).error).toBeUndefined();
      expect(JSON.parse(verified.stdout).run.stages.map((stage: any) => stage.state)).toEqual(["verified", "verified"]);
      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.filter((args) => args[1] === "start")).toHaveLength(1);
      expect(calls.filter((args) => args[1] === "wait")).toHaveLength(1);
      expect(calls.filter((args) => args[1] === "prompt")).toHaveLength(1);
      expect(existsSync(join(root, "state", "auto-improvements.jsonl"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("Antigravity model and effort resolution", () => {
  it("maps gemini-3-8-flash with high effort to gemini-3.8-flash-high with no --effort", () => {
    expect(resolveAntigravityModel("gemini-3-8-flash", "high")).toBe("gemini-3.8-flash-high");
    const cmd = buildAgentCommand("antigravity", {
      role: "implementer",
      model: "gemini-3-8-flash",
      effort: "high",
      extraFlags: [],
      description: "implementer",
    });
    expect(cmd).toEqual(["agy", "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"]);
    expect(cmd).not.toContain("--effort");
  });

  it("maps gemini-3-8-pro with xhigh effort to gemini-3.1-pro-high with no --effort", () => {
    expect(resolveAntigravityModel("gemini-3-8-pro", "xhigh")).toBe("gemini-3.1-pro-high");
    expect(resolveAntigravityModel("gemini-3-8-pro", "standard")).toBe("gemini-3.1-pro-low");
    const cmd = buildAgentCommand("antigravity", {
      role: "reviewer",
      model: "gemini-3-8-pro",
      effort: "xhigh",
      extraFlags: [],
      description: "reviewer",
    });
    expect(cmd).toEqual(["agy", "--model", "gemini-3.1-pro-high"]);
    expect(cmd).not.toContain("--effort");
  });

  it("maps claude-opus-4-6 with xhigh effort to claude-opus-4-6-thinking and standard to claude-opus-4-6", () => {
    expect(resolveAntigravityModel("claude-opus-4-6", "xhigh")).toBe("claude-opus-4-6-thinking");
    expect(resolveAntigravityModel("claude-opus-4-6", "high")).toBe("claude-opus-4-6-thinking");
    expect(resolveAntigravityModel("claude-opus-4-6", "standard")).toBe("claude-opus-4-6");
    const cmd = buildAgentCommand("antigravity", {
      role: "advisor",
      model: "claude-opus-4-6",
      effort: "xhigh",
      extraFlags: [],
      description: "advisor",
    });
    expect(cmd).toEqual(["agy", "--model", "claude-opus-4-6-thinking", "--dangerously-skip-permissions"]);
    expect(cmd).not.toContain("--effort");
  });

  it("passes through explicit model gemini-3.1-pro-high unchanged with no --effort", () => {
    expect(resolveAntigravityModel("gemini-3.1-pro-high", "high")).toBe("gemini-3.1-pro-high");
    const cmd = buildAgentCommand("antigravity", {
      role: "implementer",
      model: "gemini-3.1-pro-high",
      effort: "high",
      extraFlags: [],
      description: "implementer",
    });
    expect(cmd).toEqual(["agy", "--model", "gemini-3.1-pro-high", "--dangerously-skip-permissions"]);
    expect(cmd).not.toContain("--effort");
  });

  it("preserves claude-sonnet-4-6 and gpt-oss as is and never emits --effort", () => {
    expect(resolveAntigravityModel("claude-sonnet-4-6", "high")).toBe("claude-sonnet-4-6");
    expect(resolveAntigravityModel("gpt-oss-120b-medium", "standard")).toBe("gpt-oss-120b-medium");
    const cmd = buildAgentCommand("antigravity", {
      role: "implementer",
      model: "claude-sonnet-4-6",
      effort: "high",
      extraFlags: ["--effort", "high"],
      description: "implementer",
    });
    expect(cmd).toEqual(["agy", "--model", "claude-sonnet-4-6", "--dangerously-skip-permissions"]);
    expect(cmd).not.toContain("--effort");
  });

  it("builds inline commands without --effort for antigravity", () => {
    const stage: StageSpec = {
      role: "implementer",
      model: "gemini-3-8-flash",
      effort: "high",
      extraFlags: ["--effort", "high"],
      description: "implementer",
    };
    expect(buildInlineCommand("antigravity", stage, "task", false)).toEqual(["agy", "-i", "task", "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"]);
    expect(buildInlineCommand("antigravity", stage, "task", true)).toEqual(["agy", "-p", "task", "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"]);
  });
});

