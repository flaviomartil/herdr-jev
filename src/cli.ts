#!/usr/bin/env bun
import { choice, noul, score } from "@typesafe-ai/sdk";
import { Command } from "commander";
import { triageTaskWithJev, resolveTypeSafeApiKey } from "./triage/client.js";
import { planExecution } from "./pipelines/planner.js";
import { startMcpServer } from "./mcp/server.js";
import {

  launchStageInHerdr,
  buildAgentCommand,
  shouldSplitSubagents,
  runAgentInline,
  resolveSplitLayout,
  nativeStageEffort,
  listAllGridWorkers,
  filterWorkerClosePlan,
  executeWorkerClose,
  type SplitDirectionOption,
} from "./herdr/launcher.js";
import {
  parseCrossHarnessConfig,
  resolveDelegatedClient,
  type CrossHarnessConfig,
} from "./delegation/cross-harness.js";
import { resolveStageSpec } from "./pipelines/matrix.js";
import { createHerdrClient, readHerdrObservedState } from "./herdr/client.js";
import { checkHarnessStatus, externalRun, readUsageQuota } from "./harness/bridge.js";
import { runPipeline, resumePipeline, projectRun } from "./orchestration/pipeline.js";
import { resolveHerdrContext } from "./herdr/context.js";
import { resolvePeerStage, converseWithPeer } from "./herdr/peer.js";
import {
  loadBaseCatalog,
  loadUserOverrides,
  saveUserOverride,
  loadQuotaRecords,
  markModelExhausted,
  resetQuotas,
  resolveActiveModel,
} from "./config/catalog.js";
import { processNewModel, getKnownModels } from "./discovery/model-detector.js";
import {
  detectInstalledHarnesses,
  recommendConfiguration,
  formatHarnessTable,
  writeAutoConfigEnv,
} from "./discovery/harness-detector.js";
import type { ClientKind, RoleKind } from "./types/index.js";
import { calibrateJevLatency } from "./triage/calibrator.js";
import { getGlobalJevClient } from "./triage/jev-client.js";
import { TurnRouter } from "./routing/router.js";
import { systemPromptParts } from "./routing/prompt.js";
import { readOverview } from "./herdr/overview.js";
import { buildAgentsView, formatAgentsTable } from "./herdr/agents.js";
import { assertRunId, formatRunHistory, listRunHistory } from "./orchestration/run-history.js";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore read errors
  }
}

// Automatically load from ~/.config/herdr/.env and repo .env
loadEnvFile(join(homedir(), ".config/herdr/.env"));
loadEnvFile(join(import.meta.dir, "../.env"));

const program = new Command();

program
  .name("herdr-jev")
  .description("Jev-driven multi-model triage and triad orchestration plugin for Herdr")
  .version("0.1.0");

program
  .command("overview")
  .description("Live project, branch, agent and quota overview without model calls")
  .option("--json", "Output compact JSON")
  .option("--attention", "Show only agents waiting for input")
  .option("--watch", "Refresh the dashboard every two seconds")
  .action(async (options: { json?: boolean; attention?: boolean; watch?: boolean }) => {
    if (options.watch && options.json) throw new Error("Use --watch or --json, not both");
    do {
      const agents = (await readOverview()).filter((agent) => !options.attention || agent.state === "blocked");
      if (options.json) { console.log(JSON.stringify(agents)); return; }
      if (options.watch) process.stdout.write("\x1b[H\x1b[J");
      const marks: Record<string, string> = { working: "●", blocked: "?", done: "✓", idle: "○", unknown: "·" };
      for (const project of new Set(agents.map((agent) => agent.project))) {
        console.log(project);
        for (const agent of agents.filter((item) => item.project === project)) {
          console.log(`  ${marks[agent.state] ?? "·"} ${agent.state} · ${agent.pane} · ${agent.branch ?? "—"}${agent.run ? ` · ${agent.run}` : ""}`);
          console.log(`    ${agent.model ?? agent.agent} · ${agent.weekly ?? "quota unknown"}${agent.context ? ` · ${agent.context}` : ""}${agent.parent ? ` · ${agent.role} ← ${agent.parent}` : ""}`);
        }
      }
      if (!agents.length) console.log("No matching agents.");
      if (options.watch) await Bun.sleep(2000);
    } while (options.watch);
  });

program
  .command("agents")
  .description("Show tracked swarm agents grouped by project with live state, git change counts, and run history")
  .option("--caller <pane>", "Caller pane ID")
  .option("--all", "Show agents for all callers")
  .option("--json", "Output compact JSON")
  .action(async (options: { caller?: string; all?: boolean; json?: boolean }) => {
    const callerPaneId = options.all ? undefined : (options.caller ?? process.env.HERDR_PANE_ID);
    const groups = await buildAgentsView(callerPaneId);
    if (options.json) {
      console.log(JSON.stringify(groups));
      return;
    }
    console.log(formatAgentsTable(groups));
  });

program
  .command("status")
  .description("Show status of TypeSafe Jev, Herdr environment, and AI-Harness connection")
  .action(async () => {
    console.log("=== Herdr-Jev Status ===");
    const apiKey = resolveTypeSafeApiKey();
    console.log(`TypeSafe API Key: ${apiKey ? "Active (resolved from Vault/Env)" : "Not found (using deterministic fallback)"}`);

    const isHerdr = process.env.HERDR_ENV === "1";
    console.log(`Herdr Environment: ${isHerdr ? "Active (inside Herdr pane)" : "Standalone terminal (outside Herdr)"}`);

    const harness = checkHarnessStatus();
    console.log(`AI-Harness Core: ${harness.available ? `Connected (${harness.harnessPath})` : "Not detected"}`);

    const splitSubagents = shouldSplitSubagents();
    console.log(`Subagent Mode: ${splitSubagents ? "Split Pane (side-by-side in Herdr)" : "Inline Native Harness (live visible execution)"}`);

    const splitDir = (process.env.HERDR_JEV_SPLIT_DIRECTION || "auto").toLowerCase();
    console.log(`Split Direction: ${splitDir === "auto" ? "Auto (Jev role-based layout)" : splitDir.toUpperCase()}`);

    const crossConfig = parseCrossHarnessConfig();
    console.log(`Cross-Harness Delegation: ${crossConfig.mode === "disabled" ? "Disabled (self-only)" : crossConfig.mode === "auto" ? "Auto (Jev dynamic delegation)" : "Mapped (peering matrix)"}`);

    const activeQuotas = loadQuotaRecords();
    console.log(`Exhausted Quotas: ${activeQuotas.length === 0 ? "None recorded (availability unknown)" : activeQuotas.map((q) => `${q.client}:${q.model}`).join(", ")}`);
  });

program
  .command("detect")
  .description("Detect installed agent harnesses, probe model quotas, and optionally auto-configure environment")
  .option("-j, --json", "Output raw JSON")
  .option("-w, --write-env [path]", "Write or update .env file with recommended configuration (default: ./.env)")
  .option("-a, --auto-config", "Automatically configure .env based on detected healthy harnesses")
  .action(async (options: { json?: boolean; writeEnv?: boolean | string; autoConfig?: boolean }) => {
    const harnesses = await detectInstalledHarnesses();
    const recommendation = recommendConfiguration(harnesses);

    if (options.json) {
      console.log(JSON.stringify({ harnesses, recommendation }, null, 2));
      return;
    }

    console.log("\n=== Detected AI Harnesses & Model Quotas ===");
    console.log(formatHarnessTable(harnesses));
    console.log(`\nRecommendation: ${recommendation.summary}`);
    console.log(`  HERDR_JEV_CROSS_HARNESS="${recommendation.crossHarness}"`);
    console.log(`  HERDR_JEV_SPLIT_SUBAGENTS="${recommendation.splitSubagents}"`);
    console.log(`  HERDR_JEV_SPLIT_DIRECTION="${recommendation.splitDirection}"`);
    console.log(`  HERDR_JEV_ALLOW_ALIASES="${recommendation.allowAliases}"\n`);

    if (options.autoConfig || options.writeEnv) {
      const target = typeof options.writeEnv === "string" ? options.writeEnv : ".env";
      writeAutoConfigEnv(target, recommendation);
      console.log(`Successfully updated ${target} with recommended configuration.`);
    }
  });

program
  .command("triage <task>")
  .description("Classify task complexity, research requirement, and effort via TypeSafe Jev System One")
  .option("-j, --json", "Output raw JSON")
  .action(async (task: string, options: { json?: boolean }) => {
    const decision = await triageTaskWithJev(task);
    if (options.json) {
      console.log(JSON.stringify(decision, null, 2));
      return;
    }

    console.log("\n=== TypeSafe Jev Triage Result ===");
    console.log(`Task: "${task}"`);
    console.log(`Complexity: ${decision.complexity.toUpperCase()} (confidence: ${(decision.confidence * 100).toFixed(1)}%)`);
    console.log(`Needs Research Subagent: ${decision.needsResearch ? "YES (spawn research subagent)" : "NO (direct execution)"}`);
    console.log(`Reasoning Effort: ${decision.effort.toUpperCase()}`);
    console.log(`Recommended Pipeline: ${decision.recommendedPipeline === "triad" ? "TRIAD (Advisor -> Implementer -> Reviewer)" : "DIRECT (Implementer)"}`);
    console.log(`Latency: ${decision.latencyMs}ms\n`);
  });

program
  .command("plan <task>")
  .description("Generate multi-model execution plan for target client")
  .option("-c, --client <client>", "Target client; defaults to the source pane's agent")
  .option("--source-pane <id>", "Advisor pane supplying exact session context")
  .option("-t, --triad", "Force full triad pipeline")
  .option("--model <id>", "Exact current advisor model ID")
  .option("--available-models <ids>", "Verified available exact model IDs, comma-separated")
  .option("--cross-harness <mode>", "Cross-harness delegation mode: disabled, auto, or peer mapping")
  .option("-j, --json", "Output raw JSON")
  .action(async (task: string, options: { client?: string; sourcePane?: string; triad?: boolean; crossHarness?: string; json?: boolean; model?: string; availableModels?: string }) => {
    const context = await resolveHerdrContext({ client: options.client, model: options.model,
      availableModels: options.availableModels?.split(",").filter(Boolean), sourcePaneId: options.sourcePane });
    const client = context.client as ClientKind;
    const triage = await triageTaskWithJev(task);
    const crossConfig = options.crossHarness ? parseCrossHarnessConfig(options.crossHarness) : undefined;
    const plan = planExecution(task, client, triage, { forceTriad: options.triad, crossHarness: crossConfig,
      delegation: context.delegation, requestDelegation: true });

    if (options.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    console.log("\n=== Execution Plan ===");
    console.log(`Root Client: ${plan.client.toUpperCase()}`);
    console.log(`Triage: ${plan.triage.complexity.toUpperCase()} (effort: ${plan.triage.effort}, research: ${plan.spawnResearchSubagent})`);
    console.log(`Harness: ${JSON.stringify(plan.delegation)}`);
    console.log(`Executable stages: ${plan.executionStages?.map((stage) => `${stage.role}:${stage.model}`).join(", ") || "direct in current session"}`);
    console.log(`Advisory stages (${plan.stages.length}, not launch authorization):`);
    plan.stages.forEach((stage, idx) => {
      const stageClient = (stage.client ?? plan.client).toUpperCase();
      console.log(`  [Stage ${idx + 1}] ${stage.role.toUpperCase()}: ${stageClient}/${stage.model} (${stage.description})`);
    });
    console.log(`Research Subagent: ${plan.spawnResearchSubagent ? "Enabled" : "Disabled"}`);
    console.log(`Auto-Improvement Hook: ${plan.autoImprovement ? "Enabled" : "Disabled"}\n`);
  });

program
  .command("route <task>")
  .description("Triage task and launch the routed agent or triad in Herdr panes")
  .option("-c, --client <client>", "Target client; defaults to the source pane's agent")
  .option("--source-pane <id>", "Advisor pane supplying exact session context")
  .option("--tab", "Launch the implementer in a new tab instead of splitting")
  .option("--cwd <path>", "Repository for the launched worker; defaults to caller context")
  .option("-t, --triad", "Force full triad pipeline")
  .option("--model <id>", "Exact current advisor model ID")
  .option("--available-models <ids>", "Verified available exact model IDs, comma-separated")
  .option("--timeout-ms <ms>", "Bounded stage observation deadline", "900000")
  .option("--verify-command-json <path>", "JSON argv file for deterministic checks before independent review")
  .option("--split", "Force execution in a split pane side-by-side")
  .option("--no-split", "Execute subagents inline without splitting pane")
  .option("--wait", "Supervise launched panes until a terminal protocol state")
  .option("-d, --direction <direction>", "Split layout: auto (grid), grid, right, or down", "auto")
  .option("--cross-harness <mode>", "Cross-harness delegation mode: disabled, auto, or peer mapping")
  .action(async (task: string, options: { client?: string; triad?: boolean; split?: boolean; tab?: boolean; sourcePane?: string; cwd?: string; wait?: boolean; direction?: string; crossHarness?: string; model?: string; availableModels?: string; timeoutMs: string; verifyCommandJson?: string }) => {
    const context = await resolveHerdrContext({ client: options.client, model: options.model,
      availableModels: options.availableModels?.split(",").filter(Boolean), sourcePaneId: options.sourcePane });
    const client = context.client as ClientKind;
    if (options.split === false) throw new Error("Use --tab or --split for supervised routing; subagent --no-split supports inline execution.");
    if (options.tab && options.split) throw new Error("Choose --tab or --split, not both.");
    console.log(`\n[herdr-jev] Triaging task: "${task}"...`);

    const triage = await triageTaskWithJev(task);
    console.log(`[herdr-jev] Decision: ${triage.complexity.toUpperCase()} (effort: ${triage.effort}, research: ${triage.needsResearch}) in ${triage.latencyMs}ms`);

    const crossConfig = options.crossHarness ? parseCrossHarnessConfig(options.crossHarness) : undefined;
    const plan = planExecution(task, client, triage, { forceTriad: options.triad, crossHarness: crossConfig,
      delegation: context.delegation, requestDelegation: true });
    const result = await runPipeline(plan, {
      delegation: context.delegation,
      layout: options.tab ? "tab" : "split", sourcePaneId: context.sourcePaneId, workspaceId: context.workspaceId, cwd: options.cwd ?? context.cwd,
      wait: options.wait, timeoutMs: Number(options.timeoutMs), direction: options.direction as SplitDirectionOption,
      verifyCommandJson: options.verifyCommandJson,
    });
    console.log(JSON.stringify(result, null, 2));
    if ("error" in result || ("mode" in result && result.mode === "direct") ||
      ("run" in result && result.run.stages.some((stage: any) => ["failed", "unknown", "blocked"].includes(stage.state)))) process.exitCode = 1;
  });

program
  .command("context")
  .description("Resolve the source pane and repository without launching agents")
  .option("--json", "Output JSON context")
  .action(async () => console.log(JSON.stringify(await resolveHerdrContext({}))));

program
  .command("run-status <id>")
  .description("Reconcile deadlines and refresh the sanitized Dagr projection without redispatch")
  .action((id: string) => console.log(JSON.stringify({ run: externalRun("status", { id }), projection: projectRun(id) }, null, 2)));

program
  .command("run-resume <id>")
  .description("Observe the existing attempt and continue verified dependencies without redispatching uncertain work")
  .option("--timeout-ms <ms>", "Deadline for a newly claimed stage", "900000")
  .option("--verify-command-json <path>", "Deterministic check argv file")
  .option("--cwd <path>", "Original worker repository")
  .action(async (id: string, options: { timeoutMs: string; verifyCommandJson?: string; cwd?: string }) => {
    const result = await resumePipeline(id, { delegation: {}, wait: true,
      timeoutMs: Number(options.timeoutMs), verifyCommandJson: options.verifyCommandJson, cwd: options.cwd });
    console.log(JSON.stringify(result, null, 2));
    if ("error" in result || result.run.stages.some((stage: any) => ["failed", "unknown", "blocked"].includes(stage.state))) process.exitCode = 1;
  });

const runsCommand = program.command("runs").description("Inspect and retry recorded runs");

runsCommand
  .command("list")
  .description("List recorded runs newest first")
  .option("--limit <n>", "Maximum number of runs", "20")
  .option("--json", "Output JSON")
  .action((options: { limit: string; json?: boolean }) => {
    const runs = listRunHistory(undefined, Number(options.limit));
    if (options.json) console.log(JSON.stringify(runs, null, 2));
    else for (const run of runs) console.log(formatRunHistory(run));
  });

runsCommand
  .command("get <id>")
  .description("Alias of run-status")
  .action((id: string) => {
    assertRunId(id);
    console.log(JSON.stringify({ run: externalRun("status", { id }), projection: projectRun(id) }, null, 2));
  });

runsCommand
  .command("retry <id>")
  .description("Retry failed, unknown, and blocked stages")
  .option("--from-failed", "Retry only failed, unknown, and blocked stages")
  .option("--timeout-ms <ms>", "Deadline for a newly claimed stage", "900000")
  .option("--verify-command-json <path>", "Deterministic check argv file")
  .option("--cwd <path>", "Original worker repository")
  .action(async (id: string, options: { fromFailed?: boolean; timeoutMs: string; verifyCommandJson?: string; cwd?: string }) => {
    assertRunId(id);
    if (!options.fromFailed) throw new Error("from_failed_required");
    const result = await resumePipeline(id, { delegation: {}, wait: true, fromFailed: true,
      timeoutMs: Number(options.timeoutMs), verifyCommandJson: options.verifyCommandJson, cwd: options.cwd });
    console.log(JSON.stringify(result, null, 2));
    if ("error" in result || result.run.stages.some((stage: any) => ["failed", "unknown", "blocked"].includes(stage.state))) process.exitCode = 1;
  });

program
  .command("subagent <prompt>")
  .description("Spawn an autonomous subagent in a split pane or inline native harness")
  .option("-c, --client <client>", "Source harness; defaults to the caller agent")
  .option("-t, --target <target>", "Explicit target peer client to delegate to")
  .option("-r, --role <role>", "Subagent role (researcher, implementer, reviewer, advisor)", "researcher")
  .option("--split", "Force execution in a split pane side-by-side")
  .option("--tab", "Open a persistent peer conversation in a new tab")
  .option("--name <handle>", "Stable peer name; retries retain an existing peer without respawning")
  .option("--model <id>", "Exact peer model ID")
  .option("--effort <effort>", "Peer effort: standard, high, xhigh; defaults to Jev triage")
  .option("--source-pane <id>", "Caller pane")
  .option("--cwd <path>", "Peer repository")
  .option("--no-split", "Execute subagent inline in current terminal without splitting pane")
  .option("-d, --direction <direction>", "Split layout: auto (grid), grid, right, or down", "auto")
  .option("--cross-harness <mode>", "Cross-harness delegation mode: disabled, auto, or peer mapping")
  .option("-p, --print", "Run non-interactively in inline mode (print output directly)")
  .action(async (promptText: string, options: { client?: string; target?: string; role: string; split?: boolean; tab?: boolean; name?: string; model?: string; effort?: string; sourcePane?: string; cwd?: string; direction?: string; crossHarness?: string; print?: boolean }) => {
    const context = await resolveHerdrContext({ client: options.client, sourcePaneId: options.sourcePane });
    const sourceClient = context.client as ClientKind;
    const role = (options.role || "researcher") as RoleKind;
    const { client: effectiveClient, stage, triage } = await resolvePeerStage({ prompt: promptText, source: sourceClient,
      target: options.target, role, model: options.model, effort: options.effort, crossHarness: options.crossHarness });
    const isHerdr = process.env.HERDR_ENV === "1";
    if (options.tab && options.split !== undefined) throw new Error("Choose --tab or --split/--no-split");
    if (options.tab && !isHerdr) throw new Error("A peer tab requires Herdr");
    const splitMode = options.tab || shouldSplitSubagents(options.split);
    if (options.name && (!isHerdr || !splitMode)) throw new Error("Stable peer names require a Herdr tab or split");

    if (splitMode) {
      if (!isHerdr) {
        console.log("\n[herdr-jev] Split pane requested, but HERDR_ENV != 1 (not inside a Herdr pane).");
        console.log(`[herdr-jev] Executing subagent (${effectiveClient}/${stage.model}) in native harness mode...\n`);
        const inlineResult = runAgentInline({
          client: effectiveClient,
          stage,
          promptText,
          nonInteractive: options.print ?? false,
        });
        if (!inlineResult.ok) {
          console.error(`[herdr-jev] Inline execution failed: ${inlineResult.error || `exit code ${inlineResult.exitCode}`}`);
          process.exit(inlineResult.exitCode || 1);
        }
        return;
      }

      const herdr = createHerdrClient();
      const dir = resolveSplitLayout(role, undefined, options.direction);
      console.log(`\n[herdr-jev] Opening ${options.tab ? "tab" : `split (${dir})`} for ${role} peer (${effectiveClient}/${stage.model}, Jev effort: ${stage.effort})...`);
      const result = await launchStageInHerdr({
        client: effectiveClient,
        stage,
        handoffPrompt: promptText,
        direction: (options.direction as SplitDirectionOption) || "auto",
        herdr,
        triage, layout: options.tab ? "tab" : "split", sourcePaneId: context.sourcePaneId,
        agentName: options.name, reuseExisting: !!options.name,
        workspaceId: context.workspaceId, cwd: options.cwd ?? context.cwd,
      });

      if (!result.ok) {
        console.error(`[herdr-jev] Failed to spawn subagent: ${result.error}`);
        console.log(JSON.stringify(result));
        process.exitCode = 1;
        return;
      }

      console.log(`[herdr-jev] Subagent active in pane ${result.paneId} (${result.agentName})`);
      console.log(JSON.stringify({ ...result, client: effectiveClient, model: stage.model, effort: nativeStageEffort(effectiveClient, stage.effort) ?? null,
        recommendedEffort: stage.effort, effortApplied: nativeStageEffort(effectiveClient, stage.effort) !== undefined }));
      await herdr.notify("Herdr-Jev", `Subagent spawned in pane ${result.paneId}`, "done");
      return;
    }

    // Inline native harness mode (splitMode === false)
    console.log(`\n[herdr-jev] Running ${role} subagent (${effectiveClient}/${stage.model}) in native harness mode...`);
    const inlineResult = runAgentInline({
      client: effectiveClient,
      stage,
      promptText,
      nonInteractive: options.print ?? false,
    });

    if (!inlineResult.ok) {
      console.error(`[herdr-jev] Inline subagent failed: ${inlineResult.error || `exit code ${inlineResult.exitCode}`}`);
      process.exit(inlineResult.exitCode || 1);
    }
  });

program.command("peer-message [agent] [text]")
  .description("Send the next turn to an existing peer without spawning another agent")
  .option("--all", "Broadcast to all tracked grid workers")
  .option("--exclude <handles>", "Comma-separated list of peer handles to exclude")
  .option("--wait", "Wait for the peer response")
  .option("--lines <n>", "Terminal snapshot line limit", "2000")
  .option("--timeout-ms <ms>", "Peer wait deadline", "900000")
  .action(async (agentOrText: string | undefined, maybeText: string | undefined, options: { all?: boolean; exclude?: string; wait?: boolean; lines: string; timeoutMs: string }) => {
    if (options.all) {
      if (maybeText !== undefined) throw new Error("Cannot specify both <agent> and --all");
      if (!agentOrText?.trim()) throw new Error("A nonempty message is required");
      const result = await converseWithPeer({
        all: true,
        text: agentOrText,
        exclude: options.exclude,
        wait: options.wait,
        lines: Number(options.lines),
        timeoutMs: Number(options.timeoutMs),
      });
      console.log(result);
      try {
        const items = JSON.parse(result);
        if (Array.isArray(items) && items.some((item: any) => !item.acknowledged)) {
          process.exitCode = 1;
        }
      } catch {}
      return;
    }
    if (!agentOrText || !maybeText) throw new Error("Peer agent handle and message text are required");
    console.log(await converseWithPeer({
      target: agentOrText,
      text: maybeText,
      wait: options.wait,
      lines: Number(options.lines),
      timeoutMs: Number(options.timeoutMs),
    }));
  });

program.command("peer-read <agent>")
  .description("Read the existing peer conversation")
  .option("--wait", "Wait for completion before reading")
  .option("--lines <n>", "Terminal snapshot line limit", "2000")
  .option("--timeout-ms <ms>", "Peer wait deadline", "900000")
  .action(async (agent: string, options: { wait?: boolean; lines: string; timeoutMs: string }) => console.log(await converseWithPeer({ target: agent, wait: options.wait, lines: Number(options.lines), timeoutMs: Number(options.timeoutMs) })));

// Models Subcommand
const modelsCommand = program.command("models").description("Manage client models and fallback cascades");

modelsCommand
  .command("list")
  .description("List all configured models, active overrides, and fallback cascades per client")
  .action(() => {
    const catalog = loadBaseCatalog();
    const userOverrides = loadUserOverrides();
    console.log("\n=== Herdr-Jev Model Matrix & Fallback Chains ===");

    for (const [clientKey, roles] of Object.entries(catalog.clients)) {
      console.log(`\nClient: [${clientKey.toUpperCase()}]`);
      for (const [roleKey, def] of Object.entries(roles)) {
        const overrideKey = `${clientKey}.${roleKey}`;
        const active = resolveActiveModel(clientKey as ClientKind, roleKey as RoleKind);
        const overrideMsg = userOverrides[overrideKey] ? ` (Override: ${userOverrides[overrideKey]})` : "";
        const fallbackMsg = active.usedFallback ? ` [FALLBACK ACTIVE -> ${active.model}]` : "";

        console.log(`  ${roleKey.padEnd(12)}: Active=${active.model}${overrideMsg}${fallbackMsg}`);
        console.log(`    Cascade   : ${def.fallbackChain ? def.fallbackChain.join(" -> ") : def.model}`);
        console.log(`    Default   : ${def.model} (effort: ${def.defaultEffort})`);
      }
    }
    console.log();
  });

modelsCommand
  .command("set <key> <model>")
  .description("Set a custom model override (e.g. claude.advisor fable-6 or codex.advisor lamodelonueva)")
  .action((key: string, model: string) => {
    if (!key.includes(".")) {
      console.error("Invalid key format. Use <client>.<role> (e.g. claude.advisor or codex.implementer)");
      process.exit(1);
    }
    saveUserOverride(key, model);
    console.log(`Override saved: ${key} = ${model}`);
    console.log("This model will take precedence over default models unless quota is exhausted.");
  });

modelsCommand
  .command("classify <client> <modelName>")
  .description("Evaluate and auto-classify a newly discovered model via TypeSafe Jev System One")
  .action(async (client: string, modelName: string) => {
    console.log(`\n[herdr-jev] Evaluating model "${modelName}" for client "${client}" with TypeSafe Jev...`);
    const result = await processNewModel(client as ClientKind, modelName);

    console.log("\n=== Jev Model Classification Result ===");
    console.log(`Model: ${result.modelName}`);
    console.log(`Client: ${result.client.toUpperCase()}`);
    console.log(`Optimal Role: ${result.classification.role.toUpperCase()}`);
    console.log(`Capability Tier: ${result.classification.tier.toUpperCase()}`);
    console.log(`Recommended Effort: ${result.classification.effort.toUpperCase()}`);
    console.log(`Promoted to Primary: ${result.promotedToPrimary ? "YES (new default in role)" : "NO (added to fallback chain)"}`);
    console.log(`Confidence: ${(result.classification.confidence * 100).toFixed(1)}%`);
    console.log(`Rationale: ${result.classification.rationale}`);
    console.log(`Latency: ${result.classification.latencyMs}ms\n`);
  });

modelsCommand
  .command("scan [client]")
  .description("Scan known vs new models and list registered cascade chains")
  .action((client?: string) => {
    const targetClients: ClientKind[] = client ? [client as ClientKind] : ["claude", "codex", "antigravity"];
    console.log("\n=== Herdr-Jev Registered Model Discovery ===");
    for (const c of targetClients) {
      const known = getKnownModels(c);
      console.log(`Client: [${c.toUpperCase()}] (${known.size} registered models)`);
      console.log(`  Models: ${Array.from(known).join(", ")}`);
    }
    console.log("\nTo evaluate and register a newly released model automatically, run:");
    console.log("  herdr-jev models classify <client> <model_name>\n");
  });


// Quota Subcommand
const quotaCommand = program.command("quota").description("Manage model quota status and circuit breakers");

quotaCommand
  .command("status")
  .description("List currently exhausted models and expiration times")
  .action(() => {
    const records = loadQuotaRecords();
    console.log("\n=== Model Quota Status ===");
    console.log(JSON.stringify(readUsageQuota(), null, 2));
    if (records.length === 0) {
      console.log("No manual circuit breakers. Provider availability is unknown without fresh scoped observations.");
      return;
    }
    records.forEach((r) => {
      const remainingMin = Math.max(0, Math.round((new Date(r.expiresAt).getTime() - Date.now()) / 60000));
      console.log(`  [EXHAUSTED] Client=${r.client}, Model=${r.model}, ExpiresIn=${remainingMin} min (${r.expiresAt})`);
    });
    console.log();
  });

quotaCommand
  .command("exhaust <client> <model>")
  .description("Mark a model as quota exhausted (triggers automatic fallback cascade)")
  .option("-m, --minutes <minutes>", "Duration in minutes until quota reset", "120")
  .action((client: string, model: string, options: { minutes: string }) => {
    const minutes = parseInt(options.minutes, 10) || 120;
    markModelExhausted(client, model, minutes);
    console.log(`Model marked as quota exhausted: ${client}/${model} for ${minutes} minutes.`);
    console.log("Future tasks will automatically cascade to the next model in the fallback chain.");
  });

quotaCommand
  .command("reset [client]")
  .description("Reset quota status for a specific client or all clients")
  .action((client?: string) => {
    resetQuotas(client);
    console.log(`Quota circuit breaker reset for: ${client || "ALL clients"}.`);
  });

program
  .command("mcp")
  .description("Start the Herdr-Jev MCP stdio server for in-prompt subagent spawning and clink tool execution")
  .action(() => {
    startMcpServer();
  });

program
  .command("prewarm")
  .description("Prewarm TypeSafe Jev TLS connection and socket pool before real turns")
  .action(async () => {
    console.log("\n[herdr-jev] Prewarming connection pool to api.typesafe.ai (2 warmup queries)...");
    const client = getGlobalJevClient();
    const success = await client.prewarm();
    if (success) {
      console.log("[herdr-jev] Connection prewarmed successfully. TLS socket pool active.\n");
    } else {
      console.log("[herdr-jev] Prewarm skipped or offline (safe fallback mode active).\n");
    }
  });

program
  .command("calibrate")
  .description("Measure network latency to api.typesafe.ai and calibrate deadline for this machine")
  .option("-s, --samples <samples>", "Number of latency probe samples", "25")
  .option("--spacing <ms>", "Spacing between samples in milliseconds", "150")
  .option("--margin <margin>", "Safety multiplier margin on p98", "1.25")
  .option("--ceiling <ms>", "Maximum allowable deadline in ms", "1500")
  .option("-w, --write-env [path]", "Write HERDR_JEV_DEADLINE_MS to .env")
  .action(async (options: { samples: string; spacing: string; margin: string; ceiling: string; writeEnv?: boolean | string }) => {
    const samples = parseInt(options.samples, 10) || 25;
    const spacingMs = parseInt(options.spacing, 10) || 150;
    const margin = parseFloat(options.margin) || 1.25;
    const ceilingMs = parseInt(options.ceiling, 10) || 1500;
    const shouldWrite = Boolean(options.writeEnv);
    const envPath = typeof options.writeEnv === "string" ? options.writeEnv : ".env";

    console.log(`\n=== Calibrating TypeSafe Jev Latency (${samples} samples, spacing: ${spacingMs}ms, margin: ${margin}x) ===`);
    process.stdout.write("Probing: ");

    try {
      const result = await calibrateJevLatency(
        { samples, spacingMs, margin, ceilingMs, writeEnv: shouldWrite, envPath },
        (step, total, ms) => {
          process.stdout.write(`.`);
        },
      );
      process.stdout.write("\n\n");

      console.log("=== Calibration Results ===");
      console.log(`Samples: ${result.samplesCount}`);
      console.log(`Min    : ${result.minMs}ms`);
      console.log(`p50    : ${result.p50Ms}ms`);
      console.log(`p90    : ${result.p90Ms}ms`);
      console.log(`p95    : ${result.p95Ms}ms`);
      console.log(`p98    : ${result.p98Ms}ms`);
      console.log(`Max    : ${result.maxMs}ms`);
      console.log(`Mean   : ${result.meanMs}ms`);
      console.log(`\nRecommended Deadline: ${result.recommendedDeadlineMs}ms (margin: ${margin}x on p98)`);

      if (result.ceilingExceeded) {
        console.warn(`WARNING: Raw recommended deadline exceeded ceiling of ${ceilingMs}ms; capped at ceiling.`);
      }

      if (shouldWrite) {
        console.log(`Updated ${envPath} with HERDR_JEV_DEADLINE_MS="${result.recommendedDeadlineMs}".`);
      } else {
        console.log(`Tip: Run with -w to automatically record HERDR_JEV_DEADLINE_MS in .env`);
      }
      console.log();
    } catch (err) {
      console.error(`\nCalibration failed: ${String(err)}`);
    }
  });

program
  .command("route-turn <turn>")
  .description("Route turn in ~350ms: pick model tier, effort, safe tools, and gated skill preserving prefix cache")
  .option("-j, --json", "Output raw JSON")
  .option("--prompt", "Show generated system prompt suffix (<skill_relevance>)")
  .option("--cold", "Skip connection prewarming (fresh TLS handshake)")
  .option("--deadline <ms>", "Override deadline in milliseconds")
  .action(async (turn: string, options: { json?: boolean; prompt?: boolean; cold?: boolean; deadline?: string }) => {
    const deadlineMs = options.deadline ? parseInt(options.deadline, 10) : undefined;
    const router = new TurnRouter({
      jevOptions: deadlineMs ? { deadlineMs } : undefined,
    });

    if (!options.cold) {
      await router.prewarm();
    }

    const result = await router.route({ message: turn });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("\n=== Jev Turn Route Decision ===");
    console.log(`Turn   : "${turn}"`);
    console.log(`Source : ${result.telemetry.source.toUpperCase()} (${result.telemetry.totalMs.toFixed(1)}ms total, ${result.telemetry.jevMs.toFixed(1)}ms Jev)`);
    console.log(`Tier   : ${result.decision.tier.toUpperCase()} -> Model: ${result.decision.model}`);
    console.log(`Effort : ${result.decision.effort.toUpperCase()}`);
    console.log(`Tools  : [${result.decision.tools.join(", ") || "none"}]`);
    console.log(`Skill  : ${result.decision.skill ?? "none"} (gate: ${result.decision.gateScore.toFixed(2)})`);
    console.log(`Why    :`);
    result.decision.why.forEach((w) => console.log(`  - ${w}`));

    if (options.prompt) {
      const parts = systemPromptParts("SYSTEM_PROMPT_PREFIX_ROSTER", result.decision.skill);
      console.log(`\n=== Prompt Cache-Friendly Suffix ===`);
      console.log(parts.suffix);
    }
    console.log();
  });

const workers = program
  .command("workers")
  .description("Inspect and clean up tracked grid worker panes");

workers
  .command("list")
  .description("List tracked grid workers per caller pane with live agent status")
  .option("-j, --json", "Output raw JSON")
  .action(async (options: { json?: boolean }) => {
    const tracked = listAllGridWorkers();
    const client = createHerdrClient();
    const results: Array<{ callerPaneId: string; workerPaneId: string; status: string }> = [];
    for (const item of tracked) {
      const res = await client.getAgent?.(item.workerPaneId);
      const status = res && res.ok ? (readHerdrObservedState(res) ?? "unknown") : "unknown";
      results.push({ callerPaneId: item.callerPaneId, workerPaneId: item.workerPaneId, status });
    }

    if (options.json) {
      console.log(JSON.stringify(results));
      return;
    }

    if (results.length === 0) {
      console.log("No tracked grid workers.");
      return;
    }

    const grouped = new Map<string, Array<{ paneId: string; status: string }>>();
    for (const r of results) {
      const list = grouped.get(r.callerPaneId) ?? [];
      list.push({ paneId: r.workerPaneId, status: r.status });
      grouped.set(r.callerPaneId, list);
    }

    for (const [caller, list] of grouped) {
      console.log(`${caller}:`);
      for (const w of list) {
        console.log(`  ${w.paneId}: ${w.status}`);
      }
    }
  });

workers
  .command("close")
  .description("Close tracked worker panes whose status is idle or done")
  .option("--pane <id>", "Specific worker pane to close")
  .option("--all-idle", "Close all idle or done tracked workers")
  .option("--yes", "Execute the close plan")
  .action(async (options: { pane?: string; allIdle?: boolean; yes?: boolean }) => {
    const tracked = listAllGridWorkers();
    const client = createHerdrClient();
    const candidateIds = options.pane ? [options.pane] : tracked.map((t) => t.workerPaneId);
    const statuses: Record<string, string> = {};
    for (const paneId of new Set(candidateIds)) {
      const res = await client.getAgent?.(paneId);
      statuses[paneId] = res && res.ok ? (readHerdrObservedState(res) ?? "unknown") : "unknown";
    }

    const plan = filterWorkerClosePlan(tracked, statuses, options);

    if (!options.yes) {
      if (plan.length === 0) {
        console.log("Plan: no worker panes to close.");
        return;
      }
      console.log(`Plan: close ${plan.length} worker pane${plan.length === 1 ? "" : "s"}:`);
      for (const item of plan) {
        console.log(`  ${item.paneId} (${item.status}, caller: ${item.callerPaneId})`);
      }
      return;
    }

    if (plan.length === 0) {
      console.log("No matching idle or done worker panes to close.");
      return;
    }

    await executeWorkerClose(client, plan);
    for (const item of plan) {
      console.log(`Closed ${item.paneId} (${item.status})`);
    }
  });

program.command("classify-pane")
  .description("Classify pane text using Jev")
  .option("--json", "Output raw JSON")
  .action(async (options: { json?: boolean }) => {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const data = JSON.parse(input);
    const client = getGlobalJevClient();
    const result = await client.ask(
      { paneText: data.paneText, agent: data.agent, status: data.status },
      {
        state: choice("Given paneText, the recent terminal output of a coding agent, which state is the agent in now? blocked means waiting for a human approval, answer or stuck on an error; working means actively running tools or producing output; idle means at an empty prompt with nothing pending; done means it reported completion; unknown otherwise", {
          blocked: "waiting for a human approval, answer or stuck on an error",
          working: "actively running tools or producing output",
          idle: "at an empty prompt with nothing pending",
          done: "reported completion",
          unknown: "otherwise"
        }),
        attention: score("Based on the paneText, what is the level of attention required?", ["none: nothing needed", "soon: will need input shortly or finished and awaits review", "now: blocked on a human right now"]),
        blockedReason: choice("If blocked, what is the reason?", {
          approval: "waiting for human approval to proceed",
          question: "waiting for human answer to a question",
          error: "stuck on an error",
          none: "not blocked"
        })
      }
    );
    if (options.json) {
      console.log(JSON.stringify(result));
    }
  });

program.parse(process.argv);
