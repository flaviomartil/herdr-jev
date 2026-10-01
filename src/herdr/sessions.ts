import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { checkHarnessStatus } from "../harness/bridge.js";
import { createProcessCommandAdapter, type RunCommand } from "./client.js";

export async function historyCommand(args: string[], run: RunCommand = createProcessCommandAdapter()) {
  const harness = checkHarnessStatus();
  if (!harness.available || !harness.harnessPath) throw new Error("AI Harness history unavailable");
  const result = await run([Bun.which("ai-harness") || join(harness.harnessPath, "bin/ai-harness"), "sessions", ...args, "--json"]);
  if (!result.ok) throw new Error(result.stderr || "History command failed");
  return JSON.parse(result.stdout);
}

export function sessionRow(session: any): string {
  if (!/^[a-zA-Z0-9:_-]+$/.test(session.key)) throw new Error("Invalid session key");
  const clean = (value: string) => String(value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ");
  return [session.key, session.client, session.title, session.cwd].map(clean).join("\t");
}

export async function previewSession(key: string) {
  const { session, messages, annotations } = await historyCommand(["show", "--session", key, "--no-index", "--limit", "12", "--budget", "16384"]);
  const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, ch => ch === "\n" || ch === "\t" ? ch : " ");
  return clean([`${session.client} · ${session.title}`, session.cwd,
    ...messages.filter((message: any) => message.kind === "text" || message.kind === "message").slice(-6)
      .map((message: any) => `${message.role}: ${message.text.slice(0,2000)}`),
    ...annotations.slice(-4).map((note: any) => `${note.kind}: ${note.text.slice(0,1000)}`)].join("\n\n"));
}

export async function openSession(session: any, run: RunCommand = createProcessCommandAdapter()) {
  sessionRow(session);
  if (!["claude", "codex", "kimi", "opencode"].includes(session.client) || !isAbsolute(session.cwd)) throw new Error("Unsupported session destination");
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  const snapshot = await run([herdr, "api", "snapshot"]);
  if (!snapshot.ok) throw new Error("Live sessions unavailable; resume was not dispatched");
  const agents = JSON.parse(snapshot.stdout).result?.snapshot?.agents;
  if (!Array.isArray(agents)) throw new Error("Invalid live sessions snapshot");
  const matches = agents.filter((agent: any) => agent.agent === session.client && agent.agent_session?.kind === "id"
    && agent.agent_session.value === session.native_id);
  if (matches.length > 1) throw new Error("Session is live in multiple panes; select it explicitly");
  if (!matches.length && agents.some((agent: any) => agent.agent === session.client
    && (agent.foreground_cwd || agent.cwd) === session.cwd && agent.agent_session?.kind !== "id")) {
    throw new Error("A live pane in this repository has no native session identity; select it explicitly before resuming");
  }
  const result = matches.length
    ? await run([herdr, "agent", "focus", matches[0].pane_id])
    : await run([herdr, "plugin", "pane", "open", "--plugin", "herdr-jev", "--entrypoint", "session-resume",
      "--placement", "tab", "--cwd", session.cwd, "--env", `HERDR_JEV_RESUME_CLIENT=${session.client}`,
      "--env", `HERDR_JEV_RESUME_SESSION=${session.key}`, "--focus"]);
  if (!result.ok) throw new Error(result.stderr || "Session dispatch unresolved; inspect panes before retrying");
  return { status: matches.length ? "focused" : "dispatched", session: session.key };
}

export async function sessionPicker(options: { project?: string; search?: string; pending?: boolean; all?: boolean }) {
  const filter = options.all ? [] : ["--project", options.project || process.cwd()];
  if (!options.pending) await historyCommand(["index", "--limit", "100"]);
  const data = await historyCommand(options.pending
    ? ["work-list", ...filter]
    : ["list", "--no-index", ...filter, ...(options.search ? ["--search", options.search] : [])]);
  const sessions = options.pending ? data.items.filter((item: any) => item.sessions.length)
    .map((item: any) => ({ ...item.sessions[0], title: item.title, work: item.id })) : data.sessions;
  if (!sessions.length) return { status: "empty" };
  const rows = sessions.map((session: any) => {
    const row = sessionRow(session);
    if (!options.pending) return row;
    if (!/^[a-zA-Z0-9:_-]+$/.test(session.work)) throw new Error("Invalid pending item id");
    return `${session.work}\t${row.split("\t").slice(1).join("\t")}\t${session.key}`;
  });
  const cli = join(import.meta.dir, "../../bin/herdr-jev.js");
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const picked = spawnSync("fzf", ["--delimiter", "\t", "--with-nth", "2..", "--no-multi",
    "--header", options.pending ? "Enter: source session · Ctrl-D: mark pending item done" : "Enter: focus or resume session",
    ...(options.pending ? ["--expect", "ctrl-d"] : []),
    "--preview", `${quote(process.execPath)} ${quote(cli)} sessions preview ${options.pending ? "{5}" : "{1}"}`],
    { input: rows.join("\n"), encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
  if ([1,130].includes(picked.status ?? -1)) return { status: "cancelled" };
  if (picked.error || picked.status !== 0) throw new Error("Session picker unavailable; install fzf or use --json");
  const output = picked.stdout.trim().split("\n");
  const done = options.pending && output[0] === "ctrl-d";
  const key = output.at(-1)?.split("\t")[0];
  const selected = sessions.find((session: any) => (options.pending ? session.work : session.key) === key);
  if (!selected) throw new Error("Invalid selected session");
  if (done) return historyCommand(["work-state", "--work", selected.work, "--status", "done"]);
  return openSession(selected);
}
