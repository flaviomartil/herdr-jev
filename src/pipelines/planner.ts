import type { ClientKind, PipelinePlan, RoleKind, StageSpec, TriageDecision } from "../types/index.js";
import { resolveStageSpec } from "./matrix.js";
import { resolveHarnessDelegation, type DelegationInput } from "../harness/bridge.js";
import { resolveDelegatedClient, parseCrossHarnessConfig, type CrossHarnessConfig } from "../delegation/cross-harness.js";

export function planExecution(
  task: string,
  client: ClientKind,
  triage: TriageDecision,
  options?: {
    forceTriad?: boolean;
    forceDirect?: boolean;
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
    const spec = resolveStageSpec(target.client, role, triage.effort);
    spec.client = target.client;
    if (target.delegated) {
      spec.description = `[CROSS-HARNESS: ${target.client.toUpperCase()}] ${spec.description}`;
    }
    return spec;
  };

  const stages = isTriad
    ? [resolveStage("advisor"), resolveStage("implementer"), resolveStage("reviewer")]
    : [resolveStage("implementer")];

  const delegation = resolveHarnessDelegation(client, !options?.forceDirect && (isTriad || triage.complexity === "moderate"), options?.delegation);
  const executionStages: StageSpec[] = delegation.mode === "delegate"
    ? (["implementer", "reviewer"] as const).map((role) => {
      const target = role === "implementer" ? delegation.profile.executor : delegation.profile.reviewer;
      return { role, client: delegation.profile.client, model: target.model, effort: target.effort ?? "standard",
        extraFlags: target.effort && client === "codex" ? ["-c", `model_reasoning_effort="${target.effort}"`] : [],
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
  };
}
