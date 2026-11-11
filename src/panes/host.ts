import { spawn, spawnSync } from "node:child_process";

export type HostKind = "herdr" | "tmux" | "ghostty" | "background";
export type PaneState = "alive" | "gone" | "unknown";

export interface CmdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type Cmd = (argv: string[], opts?: { cwd?: string }) => Promise<CmdResult>;

export interface SplitOptions {
  anchor?: string | null;
  direction?: "right" | "down";
  interactive?: boolean;
}

export interface PaneHost {
  readonly kind: HostKind;
  split(cmd: string, cwd: string, title: string, opts?: SplitOptions): Promise<{ id: string } | null>;
  read(id: string): Promise<string>;
  send(id: string, text: string): Promise<boolean>;
  focus(id: string): Promise<boolean>;
  close(id: string): Promise<boolean>;
  state(id: string): Promise<PaneState>;
  newTab(title: string, cwd: string): Promise<{ tabId: string; paneId: string } | null>;
  listTabs(): Promise<{ id: string; title: string }[]>;
}

export const processCmd: Cmd = (argv, opts) =>
  new Promise((resolve) => {
    const [bin, ...args] = argv as [string, ...string[]];
    const child = spawn(bin, args, { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });

export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function findPaneIds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => findPaneIds(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "pane_id" && typeof v === "string") out.push(v);
      else findPaneIds(v, out);
    }
  }
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function herdrHost(env: NodeJS.ProcessEnv, cmd: Cmd = processCmd): PaneHost {
  const bin = env.HERDR_BIN_PATH || "herdr";
  const origin = env.HERDR_PANE_ID ?? null;
  const call = (...args: string[]) => cmd([bin, ...args]);
  return {
    kind: "herdr",
    async split(command, cwd, title, opts) {
      const anchor = opts?.anchor ?? origin;
      const target = anchor ? ["--pane", anchor] : ["--current"];
      const made = await call("pane", "split", ...target, "--direction", opts?.direction ?? "right", "--cwd", cwd, "--no-focus");
      if (!made.ok) return null;
      const id = findPaneIds(parseJson(made.stdout)).find((p) => p !== anchor) ?? null;
      if (!id) return null;
      await call("pane", "rename", id, title);
      const ran = await call("pane", "run", id, `sh -c ${shq(command)}`);
      return ran.ok ? { id } : null;
    },
    async read(id) {
      const r = await call("pane", "read", id);
      return r.ok ? r.stdout : "";
    },
    async send(id, text) {
      return (await call("pane", "send-text", id, text)).ok && (await call("pane", "send-keys", id, "Enter")).ok;
    },
    async focus(id) {
      return (await call("pane", "focus", id)).ok;
    },
    async close(id) {
      return (await call("pane", "close", id)).ok;
    },
    async state(id) {
      const r = await call("pane", "read", id);
      if (r.ok) return "alive";
      return /not.?found|no such|unknown pane/i.test(r.stderr + r.stdout) ? "gone" : "unknown";
    },
    async newTab(title, cwd) {
      const r = await call("tab", "create", "--label", title, "--cwd", cwd, "--no-focus");
      if (!r.ok) return null;
      const json = parseJson(r.stdout) as any;
      const tabId = json?.result?.tab?.tab_id;
      const paneId = json?.result?.root_pane?.pane_id ?? findPaneIds(json)[0];
      return typeof tabId === "string" && typeof paneId === "string" ? { tabId, paneId } : null;
    },
    async listTabs() {
      const r = await call("tab", "list");
      const tabs = (parseJson(r.stdout) as any)?.result?.tabs;
      return Array.isArray(tabs) ? tabs.map((t: any) => ({ id: String(t.tab_id), title: String(t.label ?? "") })) : [];
    },
  };
}

export function tmuxHost(env: NodeJS.ProcessEnv, cmd: Cmd = processCmd): PaneHost {
  const origin = env.TMUX_PANE ?? null;
  const call = (...args: string[]) => cmd(["tmux", ...args]);
  return {
    kind: "tmux",
    async split(command, cwd, title, opts) {
      const anchor = opts?.anchor ?? origin;
      const r = await call("split-window", "-d", "-P", "-F", "#{pane_id}", opts?.direction === "down" ? "-v" : "-h", "-c", cwd, ...(anchor ? ["-t", anchor] : []), "sh", "-c", command);
      const id = r.stdout.trim();
      if (!r.ok || !id) return null;
      await call("select-pane", "-t", id, "-T", title);
      return { id };
    },
    async read(id) {
      const r = await call("capture-pane", "-p", "-t", id);
      return r.ok ? r.stdout : "";
    },
    async send(id, text) {
      return (await call("send-keys", "-t", id, "-l", text)).ok && (await call("send-keys", "-t", id, "Enter")).ok;
    },
    async focus(id) {
      return (await call("select-pane", "-t", id)).ok;
    },
    async close(id) {
      return (await call("kill-pane", "-t", id)).ok;
    },
    async state(id) {
      const r = await call("display-message", "-p", "-t", id, "#{pane_id}");
      return r.ok && r.stdout.trim() === id ? "alive" : "gone";
    },
    async newTab(title, cwd) {
      const r = await call("new-window", "-d", "-P", "-F", "#{window_id} #{pane_id}", "-n", title, "-c", cwd);
      const [tabId, paneId] = r.stdout.trim().split(/\s+/);
      return r.ok && tabId && paneId ? { tabId, paneId } : null;
    },
    async listTabs() {
      const r = await call("list-windows", "-F", "#{window_id}\t#{window_name}");
      return r.stdout.split("\n").filter(Boolean).map((l) => {
        const [id = "", title = ""] = l.split("\t");
        return { id, title };
      });
    },
  };
}

const osa = (script: string) => ["osascript", "-e", script];
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function ghosttyHost(cmd: Cmd = processCmd): PaneHost {
  const front = 'focused terminal of selected tab of front window';
  const byId = (id: string, body: string) =>
    osa(`tell application "Ghostty"\nset t to first terminal whose id is "${esc(id)}"\n${body}\nend tell`);
  return {
    kind: "ghostty",
    async split(command, _cwd, _title, opts) {
      const dir = opts?.direction ?? "right";
      const anchor = opts?.anchor ? `first terminal whose id is "${esc(opts.anchor)}"` : front;
      const r = await cmd(osa(`tell application "Ghostty"\nset t2 to split (${anchor}) direction ${dir}\ninput text "${esc(`sh -c ${shq(command)}`)}\\n" to t2\nreturn id of t2\nend tell`));
      const id = r.stdout.trim();
      return r.ok && id ? { id } : null;
    },
    async read() {
      return "";
    },
    async send(id, text) {
      return (await cmd(byId(id, `input text "${esc(text)}\\n" to t`))).ok;
    },
    async focus(id) {
      return (await cmd(byId(id, "focus t"))).ok;
    },
    async close(id) {
      return (await cmd(byId(id, "close t"))).ok;
    },
    async state(id) {
      const r = await cmd(byId(id, "return id of t"));
      return r.ok ? "alive" : "gone";
    },
    async newTab() {
      return null;
    },
    async listTabs() {
      return [];
    },
  };
}

export function backgroundHost(env: NodeJS.ProcessEnv = process.env): PaneHost {
  return {
    kind: "background",
    async split(command, cwd) {
      const child = spawn("sh", ["-c", command], { cwd, detached: true, stdio: "ignore", env });
      child.on("error", () => undefined);
      child.unref();
      return child.pid ? { id: `bg:${child.pid}` } : null;
    },
    async read() {
      return "";
    },
    async send() {
      return false;
    },
    async focus() {
      return false;
    },
    async close(id) {
      const pid = Number(id.slice(3));
      if (!Number.isInteger(pid) || pid <= 1) return false;
      try {
        process.kill(-pid, "SIGTERM");
        return true;
      } catch {
        return false;
      }
    },
    async state(id) {
      const pid = Number(id.slice(3));
      if (!Number.isInteger(pid) || pid <= 1) return "gone";
      try {
        process.kill(pid, 0);
        return "alive";
      } catch {
        return "gone";
      }
    },
    async newTab() {
      return null;
    },
    async listTabs() {
      return [];
    },
  };
}

export interface DetectDeps {
  platform?: NodeJS.Platform;
  hasBin?: (name: string) => boolean;
}

export function detectHost(env: NodeJS.ProcessEnv = process.env, deps: DetectDeps = {}): HostKind {
  const forced = env.HERDR_JEV_PANE_HOST;
  if (forced === "herdr" || forced === "tmux" || forced === "ghostty" || forced === "background") return forced;
  const platform = deps.platform ?? process.platform;
  const hasBin = deps.hasBin ?? ((n: string) => spawnSync("sh", ["-c", `command -v ${n}`], { stdio: "ignore" }).status === 0);
  if (env.HERDR_PANE_ID) return "herdr";
  if (env.TMUX) return "tmux";
  if (platform === "darwin" && env.TERM_PROGRAM === "ghostty" && hasBin("osascript")) return "ghostty";
  return "background";
}

export function createHost(kind: HostKind, env: NodeJS.ProcessEnv = process.env, cmd: Cmd = processCmd): PaneHost {
  if (kind === "herdr") return herdrHost(env, cmd);
  if (kind === "tmux") return tmuxHost(env, cmd);
  if (kind === "ghostty") return ghosttyHost(cmd);
  return backgroundHost(env);
}
