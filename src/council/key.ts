import { execFile } from "node:child_process";

export const KEY_LOOKUP_TIMEOUT_MS = 5000;

export function resolveCouncilApiKey(timeoutMs: number = KEY_LOOKUP_TIMEOUT_MS): Promise<string | null> {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return Promise.resolve(fromEnv);
  return new Promise((resolve) => {
    try {
      const child = execFile("vault", ["get", "AI-Providers/TypeSafe"], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, stdout) => {
        const key = typeof stdout === "string" ? stdout.trim() : "";
        resolve(!error && key.length > 0 && !key.includes("Error") && !key.includes("vault:") ? key : null);
      });
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}
