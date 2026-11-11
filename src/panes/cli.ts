import { readFileSync } from "node:fs";
import { redactSecrets } from "../herdr/pane-text.js";
import { eventsFile } from "./events.js";
import * as manager from "./manager.js";
import type { Ctx } from "./manager.js";
import { processCmd } from "./host.js";
import type { HostKind } from "./host.js";
import { parseChain } from "../failover/failover.js";
import { runWorkerFailover } from "../failover/worker.js";
import { runWorker } from "./worker-run.js";
import type { WorkerCli } from "./worker-run.js";

function flags(argv: string[]): { opts: Record<string, string | true>; rest: string[] } {
  const opts: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["yes", "stdin-prompt", "json", "background-only", "failover"].includes(key)) {
        opts[key] = next;
        i++;
      } else opts[key] = true;
    } else rest.push(a);
  }
  return { opts, rest };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: string | true | undefined): number | undefined => {
  const n = Number(str(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const CLIS = ["codex", "agy", "claude"];
const out = (value: unknown) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...tail] = argv;
  const { opts, rest } = flags(tail);
  if (command === "worker-run") {
    const cli = str(opts.cli);
    const required = ["model", "prompt-file", "run-id"].filter((k) => !str(opts[k]));
    if (!cli || !CLIS.includes(cli) || required.length > 0) {
      process.stderr.write(`worker-run: --cli codex|agy|claude ${required.map((k) => `--${k}`).join(" ")} required\n`);
      return 2;
    }
    const timeout = num(opts.timeout);
    const inactivity = num(opts.inactivity);
    const run = opts.failover === true || str(opts.chain)
      ? (o: Parameters<typeof runWorker>[0]) => runWorkerFailover({ ...o, chain: parseChain(str(opts.chain)), maxAttempts: num(opts["attempts-left"]), setTitle: (t) => process.stdout.write(`\x1b]2;${t}\x07`) })
      : runWorker;
    return run({
      runId: str(opts["run-id"])!, cli: cli as WorkerCli, model: str(opts.model)!, effort: str(opts.effort),
      promptFile: str(opts["prompt-file"])!, cwd: str(opts.cwd), env,
      ...(timeout ? { timeoutMs: timeout * 1000 } : {}), ...(inactivity ? { inactivityMs: inactivity * 1000 } : {}),
    });
  }
  if (command !== "panes") {
    process.stderr.write("usage: herdr-jev worker-run ... | herdr-jev panes <start|pump|status|list|focus|close|restart|send|tab|layout|abort|watch>\n");
    return 2;
  }
  const [sub, ...args] = rest;
  const ctx: Ctx = { env, cmd: processCmd, max: num(opts.max) };
  const cwd = str(opts.cwd) ?? process.cwd();
  try {
    switch (sub) {
      case "start": {
        const cli = str(opts.cli);
        if (!cli || !CLIS.includes(cli) || !str(opts.model) || !str(opts.run)) {
          out({ error: "start needs --run --cli --model and a prompt" });
          return 2;
        }
        const prompt = opts["stdin-prompt"] ? readFileSync(0, "utf8") : undefined;
        const started = await manager.start(ctx, {
          runId: str(opts.run)!, name: str(opts.name), cli: cli as WorkerCli, model: str(opts.model)!, effort: str(opts.effort),
          prompt, promptFile: str(opts["prompt-file"]), cwd, host: str(opts.host) as HostKind | undefined, tab: str(opts.tab),
          session: str(opts.session), lingerSec: num(opts.linger), timeoutSec: num(opts.timeout), inactivitySec: num(opts.inactivity),
          failover: opts.failover === true, chain: str(opts.chain), attemptsLeft: num(opts["attempts-left"]),
        });
        out({ ...started, eventsFile: eventsFile(started.runId, env) });
        return 0;
      }
      case "watch-open": {
        const result = await manager.openWatch(ctx, str(opts.run) ?? "", str(opts.name) ?? "agent", cwd);
        out(result);
        return result.ok ? 0 : 1;
      }
      case "event": {
        const type = str(opts.type) ?? "";
        const line = str(opts.line) === undefined ? undefined : redactSecrets(str(opts.line)!).slice(0, 4000);
        const outcome = str(opts.outcome);
        manager.recordEvent(ctx, str(opts.run) ?? "", type, {
          ...(type === "out" ? { line: line ?? "" } : {}),
          ...(type === "exit" ? { code: outcome === "done" ? 0 : 1, outcome: outcome ?? "failed", tail: line ?? "" } : {}),
          ...(type === "start" ? { pid: 0, pgid: 0, agent: "claude-subagent" } : {}),
        });
        out({ ok: true });
        return 0;
      }
      case "pump":
        out({ started: await manager.pump(ctx) });
        return 0;
      case "status":
        out({ runs: manager.status(ctx, (str(opts.runs) ?? "").split(",").filter(Boolean)) });
        return 0;
      case "list":
        out({ entries: manager.list(ctx) });
        return 0;
      case "focus":
      case "close":
      case "restart":
      case "send": {
        const name = args[0];
        if (!name) {
          out(`${sub} needs a run or name`);
          return 2;
        }
        const result = sub === "focus" ? await manager.focus(ctx, name)
          : sub === "send" ? await manager.send(ctx, name, args.slice(1).join(" "))
          : sub === "close" ? await manager.close(ctx, name, opts.yes === true)
          : await manager.restart(ctx, name, opts.yes === true);
        out(result);
        return result.ok ? 0 : 1;
      }
      case "tab": {
        const feature = args.join(" ").trim();
        if (!feature) {
          out("tab needs a feature name");
          return 2;
        }
        const result = await manager.newTab(ctx, feature, cwd);
        out(result);
        return result.ok ? 0 : 1;
      }
      case "layout": {
        const result = args[0] === "save" ? await manager.layoutSave(ctx, cwd) : args[0] === "restore" ? await manager.layoutRestore(ctx, cwd) : { ok: false, message: "layout save|restore" };
        out(result);
        return result.ok ? 0 : 1;
      }
      case "detach":
        out({ detached: await manager.detach(ctx, str(opts.session)) });
        return 0;
      case "abort":
        out({ aborted: await manager.abort(ctx, { session: str(opts.session), backgroundOnly: opts["background-only"] === true }) });
        return 0;
      case "watch":
        if (!args[0]) return 2;
        return manager.watch(args[0], env);
      default:
        out("unknown panes subcommand");
        return 2;
    }
  } catch (error) {
    out({ error: error instanceof Error ? error.message : String(error) });
    return 1;
  }
}
