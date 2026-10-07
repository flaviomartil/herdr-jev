import type { ClientKind, PipelinePlan, RoleKind, StageSpec, TriageDecision } from "../types/index.js";
import { resolveStageSpec } from "./matrix.js";
import { isModelExhausted } from "../config/catalog.js";
import { resolveHarnessDelegation, type DelegationInput } from "../harness/bridge.js";
import { availableDelegationClients, resolveDelegatedClient, parseCrossHarnessConfig, type CrossHarnessConfig } from "../delegation/cross-harness.js";

export function planExecution(
  task: string,
  client: ClientKind,
  triage: TriageDecision,
  options?: {
    forceTriad?: boolean;
    forceDirect?: boolean;
    requestDelegation?: boolean;
    crossHarness?: CrossHarnessConfig;
    delegation?: DelegationInput;
  },
): PipelinePlan {
  const isTriad = options?.forceTriad
    ? true
    : options?.forceDirect
      ? false
      : triage.recommendedPipeline === "triad";

  const crossHarness = options?.crossHarness ?? parseCrossHarnessConfig();

  const resolveStage = (role: RoleKind): StageSpec => {
    const target = resolveDelegatedClient(client, role, { config: crossHarness, triage });
    const spec = resolveStageSpec(target.client, role, target.delegated ? undefined : triage.effort);
    spec.client = target.client;
    if (target.delegated) {
      spec.description = `[CROSS-HARNESS: ${target.client.toUpperCase()}] ${spec.description}`;
    }
    return spec;
  };

  const stages = isTriad
    ? [resolveStage("advisor"), resolveStage("implementer"), resolveStage("reviewer")]
    : [resolveStage("implementer")];

  const wantsDelegation = !options?.forceDirect && (options?.requestDelegation === true || isTriad || triage.complexity === "moderate");
  let availableClients = availableDelegationClients(client, crossHarness);
  const attempts = availableClients.length + 1;
  let routing = { complexity: triage.complexity, effort: triage.effort, availableClients };
  let delegation = resolveHarnessDelegation(client, wantsDelegation, { ...options?.delegation, ...routing });
  for (let attempt = 1; attempt < attempts && delegation.mode === "delegate"; attempt++) {
    const peers: string[] = availableClients;
    const exhausted = [delegation.profile.executor, delegation.profile.reviewer].find((target) => target.client && peers.includes(target.client)
      && (isModelExhausted(target.client, target.model) || (target.cliModel !== undefined && isModelExhausted(target.client, target.cliModel))));
    if (!exhausted) break;
    availableClients = availableClients.filter((peer) => peer !== exhausted.client);
    routing = { complexity: triage.complexity, effort: triage.effort, availableClients };
    delegation = resolveHarnessDelegation(client, wantsDelegation, { ...options?.delegation, ...routing });
  }
  const executionStages: StageSpec[] = delegation.mode === "delegate"
    ? (["implementer", "reviewer"] as const).map((role) => {
      const target = role === "implementer" ? delegation.profile.executor : delegation.profile.reviewer;
      const stageClient = target.client ?? delegation.profile.client;
      return { role, client: stageClient, model: target.model, ...(target.cliModel ? { cliModel: target.cliModel } : {}), effort: target.effort ?? "standard",
        extraFlags: target.effort && stageClient === "codex" ? ["-c", `model_reasoning_effort="${target.effort}"`] : [],
        description: `AI Harness profile: ${delegation.profile.id}` };
    }) : [];

  return {
    task,
    client,
    triage,
    stages,
    spawnResearchSubagent: triage.needsResearch,
    autoImprovement: true,
    delegation,
    executionStages,
    routing,
  };
}
