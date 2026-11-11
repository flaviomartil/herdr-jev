import { runWorkerDetailed } from "../panes/worker-run.js";
import type { WorkerOptions } from "../panes/worker-run.js";
import { appendEvent } from "../panes/events.js";
import { Health } from "./health.js";
import { runChain } from "./failover.js";
import type { Target } from "./failover.js";

export interface FailoverWorkerOptions extends WorkerOptions {
  chain?: Target[];
  health?: Health;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  setTitle?: (title: string) => void;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export async function runWorkerFailover(opts: FailoverWorkerOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const echo = opts.echo ?? ((line: string) => process.stdout.write(`${line}\n`));
  const health = opts.health ?? new Health({ env });
  const primary: Target = { cli: opts.cli, model: opts.model, ...(opts.effort ? { effort: opts.effort } : {}) };
  const chain = [primary, ...(opts.chain ?? []).filter((t) => t.cli !== primary.cli || t.model !== primary.model)];
  let lastOutput = "";
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const s of signals) process.on(s, onSignal);
  try {
    const code = await runChain(chain, {
      health,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? realSleep,
      random: opts.random,
      signal: controller.signal,
      echo,
      setTitle: opts.setTitle,
      emit: (event) => appendEvent(opts.runId, event, env),
      runAttempt: async (target) => {
        const report = await runWorkerDetailed({ ...opts, cli: target.cli, model: target.model, effort: target.effort ?? opts.effort, finalExit: false });
        lastOutput = report.output;
        return report;
      },
    });
    const tail = code === 0 ? "" : lastOutput.slice(-4000) || `failover ended with ${code}`;
    appendEvent(opts.runId, { type: "exit", code, outcome: code === 0 ? "done" : code === 124 ? "timeout" : code === 130 ? "interrupted" : "failed", tail }, env);
    return code;
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }
}
