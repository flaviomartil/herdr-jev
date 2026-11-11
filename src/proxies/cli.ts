import { check, defaultDeps, status } from "./monitor.js";
import type { Deps } from "./monitor.js";
import { loadRegistry, registryPath } from "./registry.js";
import type { Proxy } from "./registry.js";

export async function main(
  argv: string[],
  io: { out: (s: string) => void; err: (s: string) => void; deps?: Deps; load?: () => Proxy[] } = {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  },
): Promise<number> {
  const [, sub, ...flags] = argv;
  const json = flags.includes("--json");
  const repair = flags.includes("--repair");
  if (sub !== "status" && sub !== "check") {
    io.err("usage: herdr-jev proxies <status|check> [--repair] [--json]");
    return 2;
  }
  let proxies: Proxy[];
  try {
    proxies = (io.load ?? (() => loadRegistry()))();
  } catch (e) {
    io.err(`proxies: cannot read ${registryPath()}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const deps = io.deps ?? defaultDeps();
  if (sub === "status") {
    const rows = await status(proxies, deps);
    if (json) io.out(JSON.stringify({ proxies: rows }));
    else for (const r of rows) io.out(`${r.id}\t${r.healthy ? "up" : "down"}\t${r.activeState ?? "-"}`);
    return rows.every((r) => r.healthy) ? 0 : 1;
  }
  const results = await check(proxies, deps, repair);
  if (json) io.out(JSON.stringify({ results }));
  else {
    for (const r of results) {
      io.out(`${r.id}\t${r.healthy ? "up" : "down"}\t${r.action}${r.restarted ? ` restarted${r.recovered ? " ok" : " still down"}` : ""}\t${r.reason}`);
      if (r.command) io.out(`  run: ${r.command}`);
    }
  }
  return results.every((r) => r.healthy) ? 0 : 1;
}
