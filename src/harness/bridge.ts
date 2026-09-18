import { existsSync, appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

export interface HarnessBridgeStatus {
  available: boolean;
  harnessPath: string;
}

export function resolveHarnessRoot(): string {
  if (process.env.AI_HARNESS_ROOT && existsSync(process.env.AI_HARNESS_ROOT)) {
    return process.env.AI_HARNESS_ROOT;
  }
  if (process.env.AI_HARNESS_CORE_PATH && existsSync(process.env.AI_HARNESS_CORE_PATH)) {
    return process.env.AI_HARNESS_CORE_PATH;
  }

  // 1. Resolve from ai-harness-hook or ai-harness binary realpath
  try {
    const hookBin = Bun.which("ai-harness-hook") || Bun.which("ai-harness");
    if (hookBin) {
      const real = realpathSync(hookBin);
      const root = resolve(dirname(real), "..");
      if (existsSync(join(root, "package.json"))) {
        return root;
      }
    }
  } catch {
    // Ignore resolution errors
  }

  // 2. Search standard workspace and home directories
  const home = process.env.HOME || homedir();
  const candidates = [
    join(process.cwd(), "../ai-harness-core"),
    join(home, "projects/personal/ai-harness-core"),
    join(home, "projects/ai-harness-core"),
    join(home, ".ai-harness"),
    join(home, ".local/share/ai-harness"),
  ];

  for (const cand of candidates) {
    if (cand && existsSync(cand) && existsSync(join(cand, "package.json"))) {
      return cand;
    }
  }

  return "";
}

export function checkHarnessStatus(): HarnessBridgeStatus {
  const root = resolveHarnessRoot();
  return {
    available: root.length > 0 && existsSync(join(root, "package.json")),
    harnessPath: root,
  };
}

export interface LearningRecord {
  timestamp: string;
  task: string;
  client: string;
  stages: string[];
  learnings: string[];
  status: "success" | "partial" | "failed";
}

export function recordAutoImprovement(record: LearningRecord): { recorded: boolean; path?: string } {
  const harnessRoot = resolveHarnessRoot();
  const timestamp = new Date().toISOString();

  // Try to append to auto-improvements.jsonl in AI Harness state directory or local repo
  const targetDir = harnessRoot ? join(harnessRoot, "state") : process.cwd();
  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    const logPath = join(targetDir, "auto-improvements.jsonl");
    const line = JSON.stringify({ ...record, timestamp }) + "\n";
    appendFileSync(logPath, line, "utf-8");
    return { recorded: true, path: logPath };
  } catch {
    return { recorded: false };
  }
}
