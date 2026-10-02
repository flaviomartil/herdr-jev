import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeRecorder(dir: string, name: string): { bin: string; log: string } {
  const bin = join(dir, name);
  const log = join(dir, `${name}.jsonl`);
  writeFileSync(bin, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("recorded");
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { bin, log };
}

export function readJsonLines(path: string): string[][] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

export function writeHerdrFake(dir: string): { bin: string; log: string } {
  const bin = join(dir, "herdr");
  const log = join(dir, "herdr.jsonl");
  const marker = join(dir, "prompted");
  writeFileSync(bin, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const prompted = existsSync(${JSON.stringify(marker)});
const [group, action] = args;
if (group === "pane" && action === "layout") {
  console.log(JSON.stringify({ result: { layout: { area: { x: 0, y: 0, width: 200, height: 50 }, panes: [{ pane_id: "caller-1", rect: { x: 0, y: 0, width: 200, height: 50 } }, { pane_id: "pane-42", rect: { x: 100, y: 0, width: 100, height: 50 } }] } } }));
} else if (group === "pane" && action === "split") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "pane-42" } } }));
} else if (group === "pane" && action === "close") {
  if (process.env.FAKE_HERDR_CLOSE === "fail") { console.error("pane busy"); process.exit(1); }
  if (process.env.FAKE_HERDR_CLOSE === "gone") { console.log(JSON.stringify({ error: { code: "pane_not_found" } })); process.exit(1); }
} else if (group === "agent" && action === "get") {
  const target = args[2];
  if (target === "caller-1") console.log(JSON.stringify({ result: { agent: { name: "caller", agent: "claude", pane_id: "caller-1", agent_status: "idle", cwd: ${JSON.stringify(dir)} } } }));
  else console.log(JSON.stringify({ result: { agent: { name: target, agent: "claude", pane_id: "pane-42", agent_status: "idle" } } }));
} else if (group === "agent" && action === "read") {
  console.log(prompted ? readFileSync(${JSON.stringify(marker)}, "utf8") : "❯ ");
} else if (group === "agent" && action === "prompt") {
  writeFileSync(${JSON.stringify(marker)}, args[3]);
  console.log(JSON.stringify({ result: { agent: { agent_status: "working" } } }));
}
process.exit(0);
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { bin, log };
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function mcpSession(requests: Array<{ method: string; params?: unknown }>): string {
  return requests.map((request, index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request })).join("\n") + "\n";
}

export function mcpText(stdout: string, id: number): string {
  const line = stdout.trim().split("\n").map((entry) => JSON.parse(entry)).find((entry) => entry.id === id);
  return line?.result?.content?.[0]?.text ?? "";
}
