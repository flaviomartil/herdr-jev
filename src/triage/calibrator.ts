import { noul } from "@typesafe-ai/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ResilientJevClient } from "./jev-client.js";

export interface CalibrationOptions {
  samples?: number;
  spacingMs?: number;
  coverage?: number; // default 98 percentile
  margin?: number; // default 1.25 multiplier
  ceilingMs?: number; // max deadline threshold, default 1500ms
  writeEnv?: boolean;
  envPath?: string;
}

export interface CalibrationResult {
  samplesCount: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p98Ms: number;
  recommendedDeadlineMs: number;
  ceilingExceeded: boolean;
  latencies: number[];
}

export function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

export async function calibrateJevLatency(
  options: CalibrationOptions = {},
  onProgress?: (step: number, total: number, ms: number) => void,
): Promise<CalibrationResult> {
  const samples = options.samples ?? 25;
  const spacingMs = options.spacingMs ?? 150;
  const margin = options.margin ?? 1.25;
  const ceilingMs = options.ceilingMs ?? 1500;

  const client = new ResilientJevClient({ deadlineMs: 30_000 });

  // 1. Connection Prewarming (2 calls discarded)
  await client.prewarm();

  const testPayload = {
    state: "latency calibration measurement from local development environment",
    questions: {
      ping: noul("Is this a connection latency calibration probe?"),
    },
  };

  const latencies: number[] = [];

  for (let i = 0; i < samples; i++) {
    const res = await client.ask(testPayload.state, testPayload.questions);
    latencies.push(res.jevMs);
    onProgress?.(i + 1, samples, res.jevMs);
    if (spacingMs > 0 && i < samples - 1) {
      await new Promise((r) => setTimeout(r, spacingMs));
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const meanMs = Math.round(sum / sorted.length);
  const minMs = Math.round(sorted[0]);
  const maxMs = Math.round(sorted[sorted.length - 1]);

  const p50Ms = computePercentile(sorted, 50);
  const p90Ms = computePercentile(sorted, 90);
  const p95Ms = computePercentile(sorted, 95);
  const p98Ms = computePercentile(sorted, 98);

  const rawRecommended = Math.ceil(p98Ms * margin);
  const recommendedDeadlineMs = Math.min(rawRecommended, ceilingMs);
  const ceilingExceeded = rawRecommended > ceilingMs;

  if (options.writeEnv) {
    const envPath = options.envPath ?? ".env";
    updateEnvFile(envPath, "HERDR_JEV_DEADLINE_MS", String(recommendedDeadlineMs));
  }

  return {
    samplesCount: samples,
    minMs,
    maxMs,
    meanMs,
    p50Ms,
    p90Ms,
    p95Ms,
    p98Ms,
    recommendedDeadlineMs,
    ceilingExceeded,
    latencies,
  };
}

function updateEnvFile(filePath: string, key: string, value: string): void {
  let content = "";
  if (existsSync(filePath)) {
    content = readFileSync(filePath, "utf-8");
  }

  const regex = new RegExp(`^${key}=.*$`, "m");
  const newLine = `${key}="${value}"`;

  if (regex.test(content)) {
    content = content.replace(regex, newLine);
  } else {
    content = content ? `${content.trimEnd()}\n${newLine}\n` : `${newLine}\n`;
  }

  writeFileSync(filePath, content, "utf-8");
}
