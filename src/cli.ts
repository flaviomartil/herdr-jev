#!/usr/bin/env bun
import { Command } from "commander";
import { triageTaskWithJev, resolveTypeSafeApiKey } from "./triage/client.js";
import { planExecution } from "./pipelines/planner.js";
import { startMcpServer } from "./mcp/server.js";
import {

  launchStageInHerdr,
  buildAgentCommand,
  shouldSplitSubagents,
  runAgentInline,
  resolveSplitDirection,
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
  .option("-c, --client <client>", "Target client: claude, codex, antigravity, cursor, opencode", "claude")
  .option("-t, --triad", "Force full triad pipeline")
  .option("--model <id>", "Exact current advisor model ID")
  .option("--available-models <ids>", "Verified available exact model IDs, comma-separated")
  .option("--cross-harness <mode>", "Cross-harness delegation mode: disabled, auto, or peer mapping")
  .option("-j, --json", "Output raw JSON")
  .action(async (task: string, options: { client: string; triad?: boolean; crossHarness?: string; json?: boolean; model?: string; availableModels?: string }) => {
    const client = (options.client || "claude") as ClientKind;
    const triage = await triageTaskWithJev(task);
    const crossConfig = options.crossHarness ? parseCrossHarnessConfig(options.crossHarness) : undefined;
    const plan = planExecution(task, client, triage, { forceTriad: options.triad, crossHarness: crossConfig,
      delegation: { model: options.model, availableModels: options.availableModels?.split(",").filter(Boolean) } });

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
  .option("-c, --client <client>", "Target client: claude, codex, antigravity, cursor, opencode", "claude")
  .option("-t, --triad", "Force full triad pipeline")
  .option("--model <id>", "Exact current advisor model ID")
  .option("--available-models <ids>", "Verified available exact model IDs, comma-separated")
  .option("--timeout-ms <ms>", "Bounded stage observation deadline", "900000")
  .option("--verify-command-json <path>", "JSON argv file for deterministic checks before independent review")
  .option("--split", "Force execution in a split pane side-by-side")
  .option("--no-split", "Execute subagents inline without splitting pane")
  .option("--wait", "Supervise launched panes until a terminal protocol state")
  .option("-d, --direction <direction>", "Split direction: auto (Jev decides), right, or down", "auto")
  .option("--cross-harness <mode>", "Cross-harness delegation mode: disabled, auto, or peer mapping")
  .action(async (task: string, options: { client: string; triad?: boolean; split?: boolean; wait?: boolean; direction?: string; crossHarness?: string; model?: string; availableModels?: string; timeoutMs: string; verifyCommandJson?: string }) => {
    const client = (options.client || "claude") as ClientKind;
    console.log(`\n[herdr-jev] Triaging task: "${task}"...`);

    const triage = await triageTaskWithJev(task);
    console.log(`[herdr-jev] Decision: ${triage.complexity.toUpperCase()} (effort: ${triage.effort}, research: ${triage.needsResearch}) in ${triage.latencyMs}ms`);

    const crossConfig = options.crossHarness ? parseCrossHarnessConfig(options.crossHarness) : undefined;
    const plan = planExecution(task, client, triage, { forceTriad: options.triad, crossHarness: crossConfig,
      delegation: { model: options.model, availableModels: options.availableModels?.split(",").filter(Boolean) } });
    const result = await runPipeline(plan, {
      delegation: { model: options.model, availableModels: options.availableModels?.split(",").filter(Boolean) },
      wait: options.wait, timeoutMs: Number(options.timeoutMs), direction: options.direction as SplitDirectionOption,
      verifyCommandJson: options.verifyCommandJson,
    });
    console.log(JSON.stringify(result, null, 2));
    if ("error" in result) process.exitCode = 1;
  });

program
  .command("run-status <id>")
  .description("Reconcile deadlines and refresh the sanitized Dagr projection without redispatch")
  .action((id: string) => console.log(JSON.stringify({ run: externalRun("status", { id }), projection: projectRun(id) }, null, 2)));

program
  .command("run-resume <id>")
  .description("Observe the existing attempt and continue verified dependencies without redispatching uncertain work")
  .option("--timeout-ms <ms>", "Deadline for a newly claimed stage", "900000")
  .option("--verify-command-json <path>", "Deterministic check argv file")
  .action(async (id: string, options: { timeoutMs: string; verifyCommandJson?: string }) => {
    const result = await resumePipeline(id, { delegation: {}, wait: true,
      timeoutMs: Number(options.timeoutMs), verifyCommandJson: options.verifyCommandJson });
    console.log(JSON.stringify(result, null, 2));
    if ("error" in result) process.exitCode = 1;
  });

program
  .command("subagent <prompt>")
  .description("Spawn an autonomous subagent in a split pane or inline native harness")
  .option("-c, --client <client>", "Source host harness (claude, codex, antigravity, cursor, opencode)", "claude")
  .option("-t, --target <target>", "Explicit target peer client to delegate to")
  .option("-r, --role <role>", "Subagent role (researcher, implementer, reviewer, advisor)", "researcher")
  .option("--split", "Force execution in a split pane side-by-side")
  .option("--no-split", "Execute subagent inline in current terminal without splitting pane")
  .option("-d, --direction <direction>", "Split direction: auto (Jev decides), right, or down", "auto")
  .option("--cross-harness <mode>", "Cross-harness delegation mode: disabled, auto, or peer mapping")
  .option("-p, --print", "Run non-interactively in inline mode (print output directly)")
  .action(async (promptText: string, options: { client: string; target?: string; role: string; split?: boolean; direction?: string; crossHarness?: string; print?: boolean }) => {
    const sourceClient = (options.client || "claude") as ClientKind;
    const role = (options.role || "researcher") as RoleKind;
    const crossConfig = options.crossHarness ? parseCrossHarnessConfig(options.crossHarness) : undefined;
    const delegated = resolveDelegatedClient(sourceClient, role, {
      explicitTarget: options.target ? (options.target.toLowerCase() as ClientKind) : undefined,
      config: crossConfig,
    });
    const effectiveClient = delegated.client;
    const isHerdr = process.env.HERDR_ENV === "1";
    const stage = resolveStageSpec(effectiveClient, role, "standard");
    stage.client = effectiveClient;
    const splitMode = shouldSplitSubagents(options.split);

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
      const dir = resolveSplitDirection(role, undefined, options.direction);
      console.log(`\n[herdr-jev] Splitting pane (${dir}) and spawning ${role} subagent (${effectiveClient}/${stage.model})...`);
      const result = await launchStageInHerdr({
        client: effectiveClient,
        stage,
        handoffPrompt: promptText,
        direction: (options.direction as SplitDirectionOption) || "auto",
        herdr,
      });

      if (!result.ok) {
        console.error(`[herdr-jev] Failed to spawn subagent: ${result.error}`);
        return;
      }

      console.log(`[herdr-jev] Subagent active in pane ${result.paneId} (${result.agentName})`);
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

program.parse(process.argv);
