import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { triageTaskWithJev } from "../triage/client.js";
import { detectInstalledHarnesses } from "../discovery/harness-detector.js";
import { parseCrossHarnessConfig } from "../delegation/cross-harness.js";
import { isModelExhausted } from "../config/catalog.js";
import { harnessCommand, harnessModelCatalog, type HarnessDecision } from "../harness/bridge.js";
import { detectVerifyCommand } from "../harness/review.js";
import { defaultRun } from "../harness/prove.js";
import { resolveHerdrContext } from "../herdr/context.js";
import { buildInlineCommand } from "../herdr/launcher.js";
import { createHerdrClient, isTestSafeBinary } from "../herdr/client.js";
import { isTestGuardActive, resolveStateDir } from "../herdr/state-dir.js";
import { planExecution } from "../pipelines/planner.js";
import { runPipeline } from "./pipeline.js";
import type { ClientKind, PipelinePlan, StageSpec } from "../types/index.js";

export interface ModRequest {
  task: string;
  session: string;
  turn: string;
  model?: string;
  cwd: string;
  shadow?: boolean;
  consultReviewed?: boolean;
  consultReport?: string;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const decisionKey = (decision: HarnessDecision | undefined) => decision?.mode === "delegate"
  ? JSON.stringify([decision.profile.id, decision.profile.client, decision.profile.advisor, decision.profile.route,
    ...[decision.profile.executor, decision.profile.reviewer, decision.consult].map((stage) => stage ? [stage.client, stage.model, stage.cliModel, stage.effort] : null)])
  : decision?.mode;

export async function probeModStage(stage: StageSpec): Promise<boolean> {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-jev-probe-"));
  try {
    const client = stage.client ?? "claude";
    const argv = buildInlineCommand(client, { ...stage, role: "reviewer" }, "Reply exactly HERDR_JEV_READY. Do not use tools or modify files.", true);
    if (client === "codex") argv.push("--skip-git-repo-check", "--ephemeral");
    argv[0] = Bun.which(argv[0]) ?? argv[0];
    if (isTestGuardActive() && !isTestSafeBinary(argv[0])) return false;
    const env: NodeJS.ProcessEnv = { ...process.env, HERDR_JEV_MOD_WORKER: "1" };
    delete env.HERDR_ENV;
    delete env.HERDR_PANE_ID;
    delete env.HERDR_PLUGIN_CONTEXT_JSON;
    const result = await defaultRun(argv, { cwd, timeoutMs: 60_000, env });
    return result.exitCode === 0 && !result.timedOut && !result.aborted && /^HERDR_JEV_READY\s*$/m.test(result.output);
  } catch { return false; }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}

export async function dispatchModTask(input: ModRequest, deps: {
  context?: typeof resolveHerdrContext;
  triage?: typeof triageTaskWithJev;
  detect?: typeof detectInstalledHarnesses;
  catalog?: typeof harnessModelCatalog;
  plan?: typeof planExecution;
  command?: typeof harnessCommand;
  probe?: typeof probeModStage;
  pipeline?: typeof runPipeline;
} = {}) {
  if (input.consultReport !== undefined && (!input.consultReviewed || typeof input.consultReport !== "string" || Buffer.byteLength(input.consultReport) > 16_384)) throw new Error("invalid_consult_report");
  if (typeof input.task !== "string" || !input.task.trim() || Buffer.byteLength(input.task) > 16_384 || ![input.session, input.turn].every((id) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id))) throw new Error("invalid_mod_request");
  const scopeCheckTask = input.task.replace(/\b(?:(?:do not|don['’]?t|never)\s+(?:edit|modify|change|touch)|(?:n[aã]o|nunca)\s+(?:altere|modifique|edite))\s+(?:"[\w./\\-]+\.[a-z0-9]+"|'[\w./\\-]+\.[a-z0-9]+'|[\w./\\-]+\.[a-z0-9]+)(?=\s*(?:[.;]|$))/gi, "");
  if (/^\s*(?:how|what|why|where|when|como|por que|o que)\b/i.test(input.task)) return { mode: "direct", reason: "read_only_task" };
  if (/\b(?:(?:do not|don['’]?t|never)\s+(?:make|apply|perform|introduce)|without\s+(?:making|applying|performing|introducing))\s+(?:(?:any|further)\s+)?(?:changes|edits|modifications|writes)\b|\b(?:n[aã]o|nunca)\s+(?:fa[cç]a|realize|aplique)\s+(?:quaisquer\s+)?(?:altera[cç][oõ]es|modifica[cç][oõ]es|escritas)\b/i.test(scopeCheckTask)) return { mode: "direct", reason: "user_requested_direct" };
  if (/\b(?:(?:do not|don['’]?t|never)\s+(?:delegate|spawn|launch|start|edit|modify|write|change|create|touch|run|execute|test)|no\s+(?:delegation|agents?|subagents?|workers?|writes?|edits?|changes?|modifications?)|(?:n[aã]o|nunca)\s+(?:delegue|delegar|crie|inicie|lance|altere|modifique|escreva|edite|rode|execute|teste)|sem\s+(?:delega[cç][aã]o|agentes?|altera[cç][oõ]es)|without\s+(?:using\s+(?:any\s+)?(?:agents?|subagents?|workers?)|delegating|delegation|spawning|launching|starting|editing|writing|modifying|changing|touching|running|executing|testing))\b/i.test(scopeCheckTask)) return { mode: "direct", reason: "user_requested_direct" };
  if (/\b(?:(?:do not|don['’]?t|never)\s+(?:use|employ)\s+(?:any\s+)?(?:agents?|subagents?|workers?)|(?:n[aã]o|nunca)\s+(?:use|utilize)\s+(?:agentes?|subagentes?))\b/i.test(input.task)) return { mode: "direct", reason: "user_requested_direct" };
  const intent = input.task.replace(/"[^"]*"|`[^`]*`|“[^”]*”|(?:^|[\s(])'[^'\n]*'|‘[^’]*’/g, " ");
  const writing = /\b(?:implement|build|add|create|fix|change|modify|refactor|update|implemente|implementar|construa|adicione|crie|corrija|altere|modifique|refatore|atualize)\b/i.exec(intent);
  if (/\b(?:in|using|em|no)\s+(?:read[ -]only|(?:somente|apenas|s[oó])\s+leitura)\s+(?:mode|modo)\b/i.test(input.task)) return { mode: "direct", reason: "user_requested_direct" };
  if (/(?:^|[.!?;,])\s*(?:(?:but|mas)\s+)?(?:(?:(?:this|the)\s+)?(?:session|task|request|work)\s+(?:is|must\s+(?:be|remain))\s+)?read[ -]only(?:\s+(?:session|task|request|work))?\s*(?:[.!?;,]|$)|(?:^|[.!?;,])\s*(?:(?:but|mas)\s+)?(?:(?:esta|essa|a)\s+(?:sess[aã]o|tarefa|solicita[cç][aã]o)\s+(?:[ée]|deve\s+(?:ser|permanecer))\s+)?(?:somente|apenas|s[oó])\s+leitura\s*(?:[.!?;,]|$)/i.test(input.task)
    || /\b(?:read[ -]only|(?:somente|apenas|s[oó])\s+leitura)\b/i.test(input.task) && (!writing || /^\s*(?:read[ -]only|(?:somente|apenas|s[oó])\s+leitura)\s*[:.;]/i.test(input.task))) return { mode: "direct", reason: "user_requested_direct" };
  const reading = /\b(?:review|audit|inspect|check|verify|test|assess|investigate|diagnose|debug|scan|summari[sz]e|analy[sz]e|explain|describe|show|teach|evaluate|revise|revis[aã]o|audite|auditoria|inspecione|cheque|verifique|teste|investigue|diagnostique|resuma|analise|explique|descreva|descrever|mostre|ensine|avalie|(?:find|spot|identify|locate|detect|encontre|identifique|localize|detecte|procure)\s+(?:bugs?|issues?|errors?|defects?|risks?|problemas?|erros?|falhas?|riscos?))\b/i.exec(intent);
  const repair = /(?:\b(?:and|then|e|depois)|[.,;:])\s+(?:fix|implement|corrija|implemente)\b(?!\s+(?:for|of|de|para)\b)/i.exec(intent);
  const repairRequested = repair !== null
    && ["investigate", "diagnose", "debug", "investigue", "diagnostique"].includes(reading?.[0].toLowerCase() ?? "")
    && !/\b(?:guide|tutorial|article|documentation|description|manual|reference|example|instructions|guia|artigo|documenta[cç][aã]o|descri[cç][aã]o|exemplo|instru[cç][oõ]es)\b.*\b(?:how|como)\b/is.test(intent.slice(0, repair.index))
    && (!/\b(?:how|como)\s+(?!to\b)/i.test(intent.slice(0, repair.index)) || /^[.;:]/.test(repair[0]));
  const action = repairRequested ? reading : writing;
  if (reading && (!writing || reading.index < writing.index && !repairRequested)
    || action && !/^\s*(?:(?:(?:can|could|would|will)\s+you|(?:i|we)\s+(?:want|need)\s+(?:you\s+)?to|(?:quero|preciso)(?:\s+que\s+voc[eê])?)\s+)?(?:(?:please|por\s+favor)[,\s]+)?$/i.test(intent.slice(0, action.index))) return { mode: "direct", reason: "read_only_task" };
  if (!writing || /\b(?:we (?:agreed|discussed)|as (?:agreed|discussed)|previous (?:plan|message)|the plan|o plano|combinamos|conversamos|conforme (?:combinado|discutido)|mensagem anterior)\b/i.test(input.task)) return { mode: "direct", reason: "task_brief_required" };
  const context = await (deps.context ?? resolveHerdrContext)({ client: "claude", model: input.model });
  if (context.client !== "claude" || process.env.HERDR_JEV_MOD_WORKER === "1" || /^jev-(?:impl|review)-/.test(context.sourceAgentName ?? "")) {
    return { mode: "direct", reason: "child_role" };
  }
  const cwd = realpathSync(input.cwd);
  const triage = await (deps.triage ?? triageTaskWithJev)(input.task);
  const substantive = triage.complexity === "moderate" || triage.complexity === "architectural";
  const configured = parseCrossHarnessConfig(process.env.HERDR_JEV_CROSS_HARNESS ?? "auto");
  const detected = substantive && input.model ? await (deps.detect ?? detectInstalledHarnesses)() : [];
  const catalog = substantive && input.model ? (deps.catalog ?? harnessModelCatalog)() : null;
  const healthy = new Set(detected.filter((client) => client.installed && client.healthy).map((client) => client.client as string));
  const crossHarness = { ...configured, allowedPeers: { ...configured.allowedPeers,
    claude: (configured.allowedPeers.claude ?? ["claude"]).filter((client) => healthy.has(client)) } };
  const availableModels: string[] = catalog?.ok ? Object.entries(catalog.value.clients).flatMap(([client, entry]: [string, any]) =>
    healthy.has(client) ? entry.models.filter((model: any) => !isModelExhausted(client, model.id) && !isModelExhausted(client, model.cli_id)).map((model: any) => model.cli_id as string) : []) : [];
  const model = input.model;
  const verified = new Set<string>();
  const failed = new Set<string>();
  let unavailable = false;
  let plan: PipelinePlan;
  for (;;) {
    plan = (deps.plan ?? planExecution)(input.task, "claude", triage, { forceDirect: !substantive, requestDelegation: substantive,
      crossHarness, delegation: { model, availableModels, role: "advisor" } });
    if (plan.consultStage?.client && plan.consultStage.client !== "claude") return { mode: "direct", reason: "consult_adapter_unavailable" };
    if (plan.delegation?.mode !== "delegate" || input.shadow || process.env.HERDR_ENV !== "1") break;
    const stages = [...(plan.executionStages ?? []), ...(plan.consultStage ? [plan.consultStage] : [])];
    const target = stages.find((stage) => !verified.has(`${stage.client}/${stage.cliModel ?? stage.model}/${stage.effort}`));
    if (!target) break;
    const key = `${target.client}/${target.cliModel ?? target.model}/${target.effort}`;
    if (failed.has(key)) { unavailable = true; break; }
    if (await (deps.probe ?? probeModStage)(target)) {
      verified.add(`${target.client}/${target.cliModel ?? target.model}/${target.effort}`);
      continue;
    }
    const names = new Set([target.model, target.cliModel]);
    failed.add(key);
    if (target.client && target.client !== "claude") crossHarness.allowedPeers.claude = crossHarness.allowedPeers.claude.filter((client) => client !== target.client);
    for (let index = availableModels.length - 1; index >= 0; index--) if (names.has(availableModels[index])) availableModels.splice(index, 1);
  }
  const command = deps.command ?? harnessCommand;
  const observation = command<{ id: string; decision: HarnessDecision; activation: "active" | "shadow" }>(["mod-delegation", "--request-json", JSON.stringify({
    session: input.session, turn: input.turn, client: "claude", role: "advisor", model,
    work: substantive ? "substantive" : "simple", availableModels,
    complexity: triage.complexity, effort: triage.effort, availableClients: plan.routing?.availableClients,
    objectiveDigest: digest(input.task), repositoryDigest: digest(cwd),
    shadow: input.shadow === true || process.env.HERDR_ENV !== "1",
  })]);
  if (observation.decision.mode === "direct") return { mode: "direct", reason: observation.decision.reason, id: observation.id };
  if (unavailable) return { mode: "direct", reason: "models_unavailable", id: observation.id };
  if (decisionKey(observation.decision) !== decisionKey(plan.delegation)) {
    return { mode: "direct", reason: "decision_changed", id: observation.id };
  }
  if (input.shadow) return { mode: "shadow", id: observation.id, stages: plan.executionStages };
  if (process.env.HERDR_ENV !== "1") return { mode: "direct", reason: "herdr_unavailable", id: observation.id };
  if (observation.activation === "shadow") return { mode: "shadow", id: observation.id, stages: plan.executionStages };
  if (plan.consultStage && !input.consultReviewed) return { mode: "consult", id: observation.id, target: plan.consultStage };
  const result = await (deps.pipeline ?? runPipeline)(plan, { delegation: { model, availableModels, role: "advisor" },
    crossHarness, dispatchId: observation.id, dispatchSession: input.session, dispatchTurn: input.turn, layout: "tab", cwd, sourcePaneId: context.sourcePaneId,
    workspaceId: context.workspaceId, timeoutMs: 900_000, consultReport: input.consultReport });
  return { mode: "delegate", id: observation.id, ...result };
}

export function modVerifyCommand(cwd: string, runId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("invalid_run_id");
  const checks = detectVerifyCommand(cwd) ?? ["git", "diff", "--check", "HEAD"];
  const path = join(resolveStateDir(), runId, "mod-checks.json");
  writeFileSync(path, JSON.stringify(checks), { mode: 0o600 });
  return path;
}

export async function closeVerifiedModWorker(run: { stages: { role: string; state: string; agent?: string; pane?: string; token?: string }[] }, herdr = createHerdrClient()): Promise<void> {
  if (process.env.HERDR_ENV !== "1" || run.stages.length !== 2 || !run.stages.every(stage => stage.state === "verified")) return;
  const stage = run.stages.find(stage => stage.role === "implementer");
  if (!stage?.pane || !stage.agent || !/^[a-f0-9-]{36}$/.test(stage.token ?? "")
    || stage.agent !== `jev-impl-${stage.token!.slice(0, 12)}` || !herdr.getAgent) return;
  try {
    const status = await herdr.getAgent(stage.agent);
    if (!status.ok) return;
    const agent = JSON.parse(status.stdout).result?.agent;
    if (agent?.name !== stage.agent || agent?.pane_id !== stage.pane || !["done", "idle"].includes(agent.agent_status)) return;
    await herdr.closePane(stage.pane);
  } catch {}
}
