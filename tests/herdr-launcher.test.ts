import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolveHarnessRoot } from "../src/harness/bridge.js";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHerdrClient, readHerdrObservedState, type HerdrClient } from "../src/herdr/client.js";
import { launchStageInHerdr } from "../src/herdr/launcher.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";

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
  return {
    get promptCalls() { return promptCalls; },
    get closeCalls() { return closeCalls; },
    get waitCalls() { return waitCalls; },
    splitCurrent: async () => commandResult(true, JSON.stringify({ result: { pane: { pane_id: "pane-42" } } })),
    startAgent: async () => commandResult(true),
    prompt: async () => {
      promptCalls += 1;
      return promptResult;
    },
    waitFor: async () => {
      waitCalls += 1;
      return completionResult;
    },
    closePane: async () => {
      closeCalls += 1;
      return commandResult(true);
    },
    notify: async () => commandResult(true),
  };
}

afterEach(() => {
  if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = originalHerdrEnv;
});

describe("Herdr launch acknowledgement", () => {
  it("returns launch failure when prompt acknowledgement fails without relaunching or closing the pane", async () => {
    process.env.HERDR_ENV = "1";
    const herdr = fakeHerdr(commandResult(false, "", "prompt transport failed"));
    const result = await launchStageInHerdr({
      client: "codex",
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
      client: "codex",
      stage,
      handoffPrompt: "synthetic handoff",
      herdr,
    });
    expect(result.ok).toBe(true);
    expect(result.paneCreated).toBe(true);
    expect(result.paneId).toBe("pane-42");
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
        encoding: "utf8", env: { ...process.env, AI_HARNESS_ROOT: root, HERDR_ENV: "1", HOME: root, TYPESAFE_API_KEY: "" }, timeout: 60_000,
      });
      expect(result.status).toBe(0);
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
    for (const argv of [["init"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]]) {
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
if(action==="ack") result=runs.acknowledgeExternalStage(control,input.id,input.stage,input.token,input.pane);
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
if(args[1]==="prompt") {
const text=args.join(" ");
const match=text.match(/to (\\/[^:]+\\/implementer\\.md):/);
if(match) writeFileSync(match[1],"Changed fixture. Checks pending.");
}
if(args[1]==="wait") console.log(JSON.stringify({state:"done"}));
`, { mode: 0o700 });
    const env = { ...process.env, PATH: bin + ":" + process.env.PATH, AI_HARNESS_ROOT: root,
      HERDR_BIN_PATH: herdr, HERDR_ENV: "1", HOME: root, TYPESAFE_API_KEY: "",
      HERDR_JEV_ALLOW_ALIASES: "1", HERDR_JEV_BIN_CODEX: reviewer };
    try {
      const result = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "route", "architecture fixture", "--client", "codex", "--triad", "--model", "advisor", "--available-models", "executor,reviewer", "--wait"], {
        encoding: "utf8", env, cwd: repo, timeout: 60_000,
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{\n')));
      expect(parsed.error).toBeUndefined();
      expect(parsed.run.stages.map((stage: any) => stage.state)).toEqual(["reported", "queued"]);
      const resumed = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "run-resume", parsed.run.id], { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
      expect(resumed.status).toBe(0);
      expect(JSON.parse(resumed.stdout).run.stages[0].state).toBe("reported");
      const verified = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "run-resume", parsed.run.id, "--verify-command-json", verify], { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
      expect(verified.status).toBe(0);
      expect(JSON.parse(verified.stdout).error).toBeUndefined();
      expect(JSON.parse(verified.stdout).run.stages.map((stage: any) => stage.state)).toEqual(["verified", "verified"]);
      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.filter((args) => args[1] === "start")).toHaveLength(1);
      expect(calls.filter((args) => args[1] === "wait")).toHaveLength(1);
      expect(existsSync(join(root, "state", "auto-improvements.jsonl"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
