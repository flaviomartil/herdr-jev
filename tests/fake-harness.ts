import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetHarnessCaches } from "../src/harness/bridge.js";

export type FakeHarnessMode = "contract" | "unknown" | "legacy";

export interface FakeHarness {
  dir: string;
  bin: string;
  root: string;
  log: string;
  calls: () => string[][];
  callsFor: (command: string) => string[][];
  rawLog: () => string;
  restore: () => void;
}

const SCRIPT = `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const dir = process.env.FAKE_HARNESS_DIR;
const mode = process.env.FAKE_HARNESS_MODE || "contract";
const command = argv[0];
const options = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { options[argv[i]] = argv[i + 1]; i++; }
}
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify(argv) + "\\n");

function fail(code, status = 1) {
  process.stderr.write(JSON.stringify({ error: code }) + "\\n");
  process.exit(status);
}
function out(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
function load() {
  try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); } catch { return { runs: [], reviews: {} }; }
}
function save(state) {
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

const CLAUDE_IDS = ["claude-fable-5-1", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"];
const CLAUDE_ALIASES = { "fable-5": "claude-fable-5-1", "sonnet-5": "claude-sonnet-5-5", "claude-sonnet-5": "claude-sonnet-5-5", "opus-5": "claude-opus-5-5" };
const CATALOG = {
  claude: { bypass_args: ["--dangerously-skip-permissions"], readonly_args: ["--tools", "Read,Glob,Grep"] },
  codex: { bypass_args: ["--dangerously-bypass-approvals-and-sandbox"], readonly_args: ["--sandbox", "read-only"] },
  antigravity: { bypass_args: ["--dangerously-skip-permissions"], readonly_args: [] },
  kiro: { bypass_args: ["--trust-all-tools"], readonly_args: [] },
  kimi: { bypass_args: ["--yolo"], readonly_args: [] },
};

function agy(model, effort) {
  const e = effort || "standard";
  if (model === "gemini-3-8-flash" || model === "gemini-3.8-flash") return { known: true, model: "gemini-3-8-flash", cli: "gemini-3.8-flash-" + (e === "standard" ? "medium" : "high") };
  if (model === "gemini-3-8-pro" || model === "gemini-3.1-pro") return { known: true, model: "gemini-3-8-pro", cli: "gemini-3.1-pro-" + (e === "standard" ? "low" : "high") };
  if (model === "claude-opus-4-6") return { known: true, model, cli: e === "standard" ? "claude-opus-4-6" : "claude-opus-4-6-thinking" };
  if (model === "claude-sonnet-4-6") return { known: true, model, cli: model };
  if (/^gemini-3\\.(1-pro|8-flash)-(low|medium|high)$/.test(model)) return { known: true, model: model.includes("pro") ? "gemini-3-8-pro" : "gemini-3-8-flash", cli: model };
  return { known: false, model, cli: model };
}

function resolveModel() {
  const client = options["--client"];
  const input = options["--model"];
  const effort = options["--effort"] || null;
  const entry = CATALOG[client];
  if (!entry) fail("invalid_client");
  let known = false;
  let model = input;
  let cli = input;
  let effortArgs = [];
  const level = effort === "standard" ? "medium" : effort;
  if (client === "claude") {
    const id = CLAUDE_IDS.includes(input) ? input : CLAUDE_ALIASES[input];
    if (id) { known = true; model = id; cli = id; }
    effortArgs = level ? ["--effort", level] : [];
  } else if (client === "codex") {
    if (input.startsWith("gpt-")) { known = true; }
    effortArgs = level ? ["-c", 'model_reasoning_effort="' + level + '"'] : [];
  } else if (client === "antigravity") {
    const r = agy(input, effort);
    known = r.known; model = r.model; cli = r.cli;
  }
  const override = (prefix, fallback) => { const value = process.env[prefix + client.toUpperCase()]; return value === "none" ? [] : value ? value.split(" ") : fallback; };
  const answer = { client, known, model, cliModel: cli, effort: level || null, effortArgs, bypassArgs: override("FAKE_BYPASS_", entry.bypass_args), readonlyArgs: override("FAKE_READONLY_", entry.readonly_args) };
  for (const field of (process.env.FAKE_OMIT_FIELDS || "").split(",")) delete answer[field];
  out(answer);
}

function reviewStatus(reviewDir) {
  const names = JSON.parse(readFileSync(join(reviewDir, "scopes.json"), "utf8"));
  const verify = JSON.parse(readFileSync(join(reviewDir, "verify.json"), "utf8"));
  const scopes = names.map((name) => {
    try { return JSON.parse(readFileSync(join(reviewDir, "verdict-" + name + ".json"), "utf8")); } catch { return { name, verdict: "pending", findings: "" }; }
  });
  const status = verify.status === "changes_required" || scopes.some((item) => item.verdict === "CHANGES_REQUIRED") ? "changes_required"
    : scopes.every((item) => item.verdict === "APPROVE") ? "ready" : "pending_review";
  return { status, scopes };
}

function legacyAllowed() {
  return ["delegation-plan", "review-status", "review-verify", "review-judge", "external-run"].includes(command);
}

if (mode === "unknown" && !["delegation-plan", "usage-record"].includes(command)) fail("unknown_command");
if (mode === "legacy" && !legacyAllowed() && !["usage-record"].includes(command)) fail("unknown_command");

if (command === "model-resolve") resolveModel();
else if (command === "model-catalog") {
  const clients = {};
  for (const [name, entry] of Object.entries(CATALOG)) {
    if (options["--client"] && options["--client"] !== name) continue;
    clients[name] = { ...entry, models: [] };
  }
  out({ clients });
} else if (command === "policy-check") {
  const roots = (process.env.FAKE_TRUST_ROOTS || "").split(":").filter(Boolean);
  const path = resolve(options["--path"]);
  if (!existsSync(path)) out({ trusted: false, reason: "path_missing" });
  else if (roots.some((root) => path === root || path.startsWith(root + "/"))) out({ trusted: true, reason: "under_trust_root" });
  else out({ trusted: false, reason: "not_under_trust_root" });
} else if (command === "delegation-plan") {
  if (process.env.FAKE_PROFILE === "1") {
    out({ mode: "delegate", profile: { id: "fake-profile", client: options["--client"], advisor: "advisor-model",
      executor: { model: "gpt-5.6-luna", cliModel: "gpt-5.6-luna-cli", effort: "high" }, reviewer: { model: "gpt-5.6-sol", cliModel: "gpt-5.6-sol-cli", effort: "xhigh" } } });
  } else out({ mode: "direct", reason: "no_profile" });
} else if (command === "external-run") {
  if (mode === "legacy" || !["worker-create", "worker-settle", "list"].includes(options["--action"])) fail("invalid_external_action");
  const request = JSON.parse(options["--request-json"]);
  const state = load();
  if (options["--action"] === "worker-create") {
    const run = { id: "00000000-0000-4000-8000-" + String(state.runs.length + 1).padStart(12, "0"), kind: "worker", client: request.client,
      cwd: request.cwd, createdAt: new Date(Date.UTC(2026, 9, 1, 12, state.runs.length)).toISOString(), objectiveDigest: request.objectiveDigest,
      branch: request.branch, forkSha: request.forkSha,
      stages: [{ role: request.role, state: "working", model: request.model, pane: request.pane, agent: request.handle }] };
    state.runs.push(run); save(state); out(run);
  } else if (options["--action"] === "worker-settle") {
    const run = state.runs.find((item) => item.id === request.id);
    if (!run) fail("unknown_run");
    run.stages[0].state = request.state; run.head = request.head; save(state); out(run);
  } else {
    const kind = request.kind || "all";
    const items = state.runs.filter((run) => kind === "all" || run.kind === kind).slice().reverse().slice(0, request.limit || 20);
    out(items.concat(kind === "all" || kind === "pipeline" ? (state.pipelines || []) : []));
  }
} else if (command === "review-verify" || command === "review-judge") {
  const reviewDir = join(dir, "reviews", [options["--client"], options["--session"]].join("_").replace(/[^A-Za-z0-9_.-]/g, "_"));
  mkdirSync(reviewDir, { recursive: true });
  const commandJson = JSON.parse(readFileSync(options["--command-json"], "utf8"));
  appendFileSync(join(dir, "commands.jsonl"), JSON.stringify({ command, scope: options["--scope"] || null, argv: commandJson }) + "\\n");
  if (command === "review-verify") {
    if (options["--scopes"] !== undefined && mode === "legacy") fail("unknown_option:--scopes");
    const names = options["--scopes"] ? options["--scopes"].split(",") : ["default"];
    writeFileSync(join(reviewDir, "scopes.json"), JSON.stringify(names));
    const status = process.env.FAKE_VERIFY_FAIL === "1" ? "changes_required" : "pending_review";
    writeFileSync(join(reviewDir, "verify.json"), JSON.stringify({ status }));
    out({ key: "k", revision: 1, status });
    process.exit(status === "changes_required" ? 1 : 0);
  } else {
    if (options["--scope"] !== undefined && mode === "legacy") fail("unknown_option:--scope");
    if (options["--timeout-ms"] !== undefined && mode === "legacy") fail("unknown_option:--timeout-ms");
    const name = options["--scope"] || "default";
    const names = JSON.parse(readFileSync(join(reviewDir, "scopes.json"), "utf8"));
    if (!names.includes(name)) fail("unknown_scope");
    const verdicts = Object.fromEntries((process.env.FAKE_VERDICTS || "").split(",").filter(Boolean).map((pair) => pair.split("=")));
    let verdict = verdicts[name] || "APPROVE";
    let reason;
    const counter = join(reviewDir, "attempts-" + name);
    const attempts = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    writeFileSync(counter, String(attempts + 1));
    const flaky = (process.env.FAKE_TIMEOUT || "").split(",").filter(Boolean).find((entry) => entry.split(":")[0] === name);
    if (flaky && attempts < Number(flaky.split(":")[1] || 1)) { verdict = "pending"; reason = "timeout"; }
    writeFileSync(join(reviewDir, "verdict-" + name + ".json"), JSON.stringify({ name, verdict, reason, findings: "findings for " + name + ": " + verdict + "\\nREVIEW_GATE_VERDICT: " + verdict }));
    const status = reviewStatus(reviewDir).status;
    out({ key: "k", revision: 1, status });
    process.exit(status === "changes_required" ? 1 : 0);
  }
} else if (command === "review-findings" || command === "review-status") {
  const reviewDir = join(dir, "reviews", [options["--client"], options["--session"]].join("_").replace(/[^A-Za-z0-9_.-]/g, "_"));
  if (!existsSync(join(reviewDir, "scopes.json"))) fail("review_not_found");
  const review = reviewStatus(reviewDir);
  if (command === "review-findings") out({ snapshot: "snap", status: review.status, scopes: review.scopes });
  else out({ key: "k", revision: 1, status: review.status, scopes: review.scopes.map((item) => ({ name: item.name, verdict: item.verdict })) });
} else if (command === "usage-record") {
  out({ recorded: true });
} else fail("unknown_command");
`;

export function createFakeHarness(mode: FakeHarnessMode = "contract", extraEnv: Record<string, string> = {}): FakeHarness {
  const dir = mkdtempSync(join(tmpdir(), "fake-harness-"));
  const bin = join(dir, "bin");
  const root = join(dir, "root");
  mkdirSync(bin);
  mkdirSync(root);
  const script = join(bin, "ai-harness");
  writeFileSync(script, SCRIPT, { mode: 0o755 });
  chmodSync(script, 0o755);
  const log = join(dir, "calls.jsonl");
  writeFileSync(log, "");
  const previous = new Map<string, string | undefined>();
  const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH ?? ""}`, AI_HARNESS_ROOT: root, FAKE_HARNESS_DIR: dir, FAKE_HARNESS_MODE: mode, ...extraEnv };
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  resetHarnessCaches();
  const rawLog = () => readFileSync(log, "utf8");
  const calls = () => rawLog().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return {
    dir, bin, root, log, rawLog, calls,
    callsFor: (command) => calls().filter((argv) => argv[0] === command),
    restore: () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetHarnessCaches();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function fakeHarnessCommands(harness: FakeHarness): Array<{ command: string; scope: string | null; argv: string[] }> {
  const path = join(harness.dir, "commands.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
