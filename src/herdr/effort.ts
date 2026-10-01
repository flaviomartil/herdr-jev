import { stripVTControlCharacters } from "node:util";
import { createProcessCommandAdapter, type RunCommand } from "./client.js";
import { reserveHerdrHandle } from "./reservation.js";

const levels = ["low", "medium", "high", "xhigh"] as const;

export function codexEffortScreen(raw: string) {
  const lines = stripVTControlCharacters(raw).replace(/\r/g, "").split("\n");
  const index = lines.map(line => /^\s*›/.test(line)).lastIndexOf(true);
  if (index < 0) throw new Error("Codex composer unavailable; no keys sent");
  if (lines[index].replace(/^\s*›/, "").trim() || lines.slice(index + 1).some(line => /\bPlan mode\b/.test(line))) {
    throw new Error("Codex input busy or in plan mode; no keys sent");
  }
  const footer = lines.slice(index + 1).join("\n");
  const match = footer.match(/\b(gpt-[\w.-]+)\s+(low|medium|high|xhigh)\b/i);
  if (!match) throw new Error("Codex model and effort footer unavailable; no keys sent");
  if (footer.slice(0, match.index).trim()) throw new Error("Codex wrapped input or unknown footer; no keys sent");
  return { model: match[1].toLowerCase(), effort: match[2].toLowerCase() };
}

export async function changeEffort(pane: string, level: string, run: RunCommand = createProcessCommandAdapter(), reserve = reserveHerdrHandle) {
  if (!/^[a-zA-Z0-9:_-]+$/.test(pane) || !levels.includes(level as any)) throw new Error("Use a pane id and low|medium|high|xhigh");
  if ((process.env.CODEX_THREAD_ID || process.env.CLAUDECODE) && pane !== process.env.HERDR_PANE_ID) {
    throw new Error("An agent may only change its own pane effort");
  }
  const release = await reserve(`peer:${pane}`);
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  const call = async (...args: string[]) => {
    const result = await run([herdr, ...args]);
    if (!result.ok) throw new Error(result.stderr || "Effort acknowledgement unknown; inspect before retrying");
    return result.stdout;
  };
  try {
    const readAgent = async () => JSON.parse(await call("agent", "get", pane)).result?.agent;
    const agent = await readAgent();
    if (agent?.agent !== "codex" || agent.pane_id !== pane || !["idle", "done"].includes(agent.agent_status)) {
      throw new Error("Live effort requires an idle Codex pane; other clients and working turns remain unchanged");
    }
    const before = codexEffortScreen(await call("agent", "read", pane, "--source", "visible", "--lines", "60", "--ansi"));
    const current = await readAgent();
    if (current?.terminal_id !== agent.terminal_id || current?.agent !== "codex"
      || !["idle", "done"].includes(current?.agent_status)
      || current?.agent_session?.value !== agent.agent_session?.value) throw new Error("Codex pane identity changed");
    const second = codexEffortScreen(await call("agent", "read", pane, "--source", "visible", "--lines", "60", "--ansi"));
    if (second.model !== before.model || second.effort !== before.effort) throw new Error("Codex effort changed before dispatch");
    const steps = levels.indexOf(level as any) - levels.indexOf(before.effort as any);
    if (!steps) return { status: "unchanged", pane, model: before.model, effort: level };
    await call("agent", "send-keys", pane, ...Array.from({ length: Math.abs(steps) }, () => steps > 0 ? "alt+." : "alt+,"));
    for (let attempt = 0; attempt < 10; attempt++) {
      await Bun.sleep(100);
      const observed = await readAgent();
      if (observed?.terminal_id !== agent.terminal_id || observed?.agent_session?.value !== agent.agent_session?.value) {
        throw new Error("Codex pane changed after effort dispatch; outcome unknown");
      }
      const after = codexEffortScreen(await call("agent", "read", pane, "--source", "visible", "--lines", "60", "--ansi"));
      if (after.model !== before.model) throw new Error("Model changed during effort dispatch; outcome unknown");
      if (after.effort === level) return { status: "applied", pane, model: before.model, from: before.effort, effort: level, effective: "next-turn" };
    }
    throw new Error("Effort not confirmed; no retry or new pane was dispatched");
  } finally { await release(); }
}
