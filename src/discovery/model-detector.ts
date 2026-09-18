import { execSync } from "node:child_process";
import { classifyModelWithJev, type ModelClassificationResult } from "../triage/model-classifier.js";
import { loadBaseCatalog, loadUserOverrides, integrateDiscoveredModel } from "../config/catalog.js";
import type { ClientKind } from "../types/index.js";

export interface DiscoveredModelIntegration {
  modelName: string;
  client: ClientKind;
  classification: ModelClassificationResult;
  isNew: boolean;
  assignedRole: string;
  promotedToPrimary: boolean;
}

export function getKnownModels(client: ClientKind): Set<string> {
  const catalog = loadBaseCatalog();
  const known = new Set<string>();

  const roles = catalog.clients[client];
  if (roles) {
    for (const def of Object.values(roles)) {
      known.add(def.model);
      if (def.fallbackChain) {
        def.fallbackChain.forEach((m) => known.add(m));
      }
    }
  }

  const overrides = loadUserOverrides();
  for (const [key, model] of Object.entries(overrides)) {
    if (key.startsWith(`${client}.`)) {
      known.add(model);
    }
  }

  return known;
}

export async function processNewModel(
  client: ClientKind,
  modelName: string,
): Promise<DiscoveredModelIntegration> {
  const known = getKnownModels(client);
  const isNew = !known.has(modelName);

  const classification = await classifyModelWithJev(client, modelName);

  if (isNew) {
    integrateDiscoveredModel({
      client,
      modelName,
      role: classification.role,
      effort: classification.effort,
      replacePrimary: classification.replacePrimary,
    });
  }

  return {
    modelName,
    client,
    classification,
    isNew,
    assignedRole: classification.role,
    promotedToPrimary: classification.replacePrimary,
  };
}
