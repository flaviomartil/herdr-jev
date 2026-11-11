import { Health } from "./health.js";
import type { LockReason } from "./health.js";

const REASONS = ["quota", "overload", "auth", "model_gone", "proxy_down"];

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): number {
  const [sub, ...rest] = argv;
  const health = new Health({ env });
  const key = flag(rest, "key");
  if (sub === "gc") {
    health.gc();
    write(JSON.stringify({ ok: true }));
    return 0;
  }
  if (!key || !key.includes("/")) {
    write(JSON.stringify({ error: "health needs --key cli/model" }));
    return 2;
  }
  const [cli, ...model] = key.split("/");
  if (sub === "check") {
    const lock = health.lockoutFor(cli!, model.join("/"));
    write(JSON.stringify(lock ? { locked: true, reason: lock.reason, until: lock.until ?? null } : { locked: false }));
    return 0;
  }
  if (sub === "lock") {
    const reason = flag(rest, "reason") ?? "quota";
    if (!REASONS.includes(reason)) {
      write(JSON.stringify({ error: `reason must be one of ${REASONS.join(", ")}` }));
      return 2;
    }
    const until = Number(flag(rest, "until"));
    health.lock(key, reason as LockReason, Number.isFinite(until) && until > 0 ? until : undefined);
    write(JSON.stringify({ ok: true }));
    return 0;
  }
  if (sub === "clear") {
    health.clearLockout(key);
    write(JSON.stringify({ ok: true }));
    return 0;
  }
  write(JSON.stringify({ error: "usage: herdr-jev health <check|lock|clear|gc> --key cli/model [--reason r] [--until ms]" }));
  return 2;
}
