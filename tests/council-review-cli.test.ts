import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { privatePath } from "./council-helpers.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
import { createTestStateDir } from "./helpers.js";

setDefaultTimeout(120_000);

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const j = (...parts: string[]) => parts.join("");
const TOKEN = j("gh", "p_", "Zk3Qp9Lm2Xv7Rt5Yb8Nc1Hd4Gf6Js0WqAaUu");
const FALLBACK_SECRET = "Sup3rSecretPw99";

let testEnv: { stateDir: string; cleanup: () => void };
let harness: FakeHarness | undefined;
let repo: string;
let scratch: string;
let priv: ReturnType<typeof privatePath>;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function write(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function seed() {
  git(repo, "init", "-q", "-b", "main");
  write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
  write("src/a.ts", "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  write("src/c.ts", "export const c = 1;\n");
}

let lastBehaviours: Parameters<typeof privatePath>[1] = {};

function useMembers(behaviours: Parameters<typeof privatePath>[1] = {}) {
  lastBehaviours = behaviours;
  priv = privatePath(scratch, behaviours);
}

function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  return { ...process.env, PATH: priv.path, HOME: home, HERDR_ENV: "0", TYPESAFE_API_KEY: "", ...extra };
}

function reviewArgs(args: string[], session = `s-${Math.random().toString(36).slice(2, 8)}`): string[] {
  return [CLI, "review", "--client", "codex", "--scopes", "core=src", "--session", session, ...args];
}

function cli(args: string[], extra: Record<string, string> = {}, session?: string) {
  const started = performance.now();
  const run = spawnSync(process.execPath, reviewArgs(args, session), { encoding: "utf8", env: cliEnv(extra), cwd: repo, timeout: 100_000 });
  return { status: run.status, stdout: run.stdout, ms: performance.now() - started };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stubbornPid(): number | null {
  if (!harness) return null;
  const file = join(harness.dir, "stubborn.pid");
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
}

async function until(check: () => boolean, label: string, limitMs = 60_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

beforeEach(() => {
  testEnv = createTestStateDir();
  repo = realpathSync(mkdtempSync(join(tmpdir(), "council-cli-repo-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "council-cli-scratch-")));
  harness = createFakeHarness("contract", { FAKE_PROFILE: "1" });
  useMembers();
  seed();
});

afterEach(() => {
  const pid = stubbornPid();
  if (pid) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  harness?.restore();
  harness = undefined;
  expect(priv.reached()).toEqual([]);
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  testEnv.cleanup();
});

const NO_FINDINGS = { codex: "echo NO_FINDINGS", kimi: "echo NO_FINDINGS", agy: `echo '{"result":"NO_FINDINGS"}'` };

describe("review --council through the CLI", () => {
  it("keeps the review status and exit code the same with and without --council", () => {
    const plain = cli(["--json"], {}, "same");
    const withCouncil = cli(["--json", "--council"], {}, "same");
    expect(plain.status).toBe(0);
    expect(withCouncil.status).toBe(plain.status);
    const { council, ...rest } = JSON.parse(withCouncil.stdout);
    expect(rest).toEqual(JSON.parse(plain.stdout));
    expect(rest.status).toBe("ready");
    expect(council.ran).toBe(false);
  });

  it("runs the members in parallel with the review and reports them under a separate heading", () => {
    useMembers(NO_FINDINGS);
    const env = { HERDR_JEV_CROSS_HARNESS: "1" };
    const json = cli(["--json", "--council"], env);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.status).toBe("ready");
    expect(parsed.council.ran).toBe(true);
    expect(parsed.council.run.members.map((m: { member: string; status: string }) => [m.member, m.status])).toEqual([["codex", "skipped"], ["kimi", "done"], ["antigravity", "done"]]);
    const text = cli(["--council"], env);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("Council (consultative only");
  });

  it("does not fail the review when a council member fails", () => {
    useMembers({ ...NO_FINDINGS, kimi: "echo boom >&2; exit 3" });
    const run = cli(["--json", "--council-members", "kimi,antigravity,codex"], { HERDR_JEV_CROSS_HARNESS: "1" });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ready");
    expect(parsed.council.run.members.find((m: { member: string }) => m.member === "kimi").status).toBe("failed");
  });

  it("drops a requested member the cross-harness configuration excludes and says so", () => {
    useMembers(NO_FINDINGS);
    const run = cli(["--json", "--council-members", "kimi,antigravity"], { HERDR_JEV_CROSS_HARNESS: '{"codex":["kimi"]}' });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.council.notes).toEqual(["requested member antigravity was dropped: client codex cannot use it under the cross-harness configuration"]);
    expect(parsed.council.ran).toBe(false);
  });

  it("prints member findings redacted in the JSON report", () => {
    const finding = JSON.stringify({ path: "src/a.ts", line: 1, severity: "high", title: `leaks ${TOKEN}`, detail: `const password = process.env.DB_PASSWORD || "${FALLBACK_SECRET}"` });
    useMembers({ kimi: `echo '${finding}'`, agy: `echo '{"result":"NO_FINDINGS"}'`, codex: "echo NO_FINDINGS" });
    const run = cli(["--json", "--council"], { HERDR_JEV_CROSS_HARNESS: "1" });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(TOKEN);
    expect(run.stdout).not.toContain(FALLBACK_SECRET);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.council.run.members.flatMap((m: { findings: unknown[] }) => m.findings)).toHaveLength(1);
    const text = cli(["--council"], { HERDR_JEV_CROSS_HARNESS: "1" });
    expect(text.stdout).not.toContain(TOKEN);
    expect(text.stdout).not.toContain(FALLBACK_SECRET);
  });

  it("aborts the council when the review fails and exits promptly", () => {
    useMembers({ kimi: "exec sleep 120", agy: "exec sleep 120", codex: "exec sleep 120" });
    const run = spawnSync(process.execPath, [CLI, "review", "--client", "codex", "--scopes", "core=missing-dir", "--session", "abort-1", "--json", "--council"], { encoding: "utf8", env: cliEnv({ HERDR_JEV_CROSS_HARNESS: "1" }), cwd: repo, timeout: 40_000 });
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).error).toContain("invalid_scopes");
    const left = join(testEnv.stateDir, "council");
    expect(existsSync(left) ? readdirSync(left).filter((entry) => !entry.endsWith(".lock")) : []).toEqual([]);
  });

  it("prints the review at once when the council outlasts --council-wait, and says why", () => {
    useMembers({ ...NO_FINDINGS, kimi: "exec sleep 120", agy: "exec sleep 120" });
    const run = cli(["--council", "--council-wait", "500", "--council-timeout", "100000"], { HERDR_JEV_CROSS_HARNESS: "1" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Council did not run: cancelled (review finished first)");
    expect(run.ms).toBeLessThan(30_000);
    const json = cli(["--json", "--council", "--council-wait", "500"], { HERDR_JEV_CROSS_HARNESS: "1" });
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.status).toBe("ready");
    expect(parsed.council.run.note).toBe("cancelled (review finished first)");
  });

  it("passes --council-timeout to every member", () => {
    useMembers({ ...NO_FINDINGS, kimi: "exec sleep 120", agy: "exec sleep 120" });
    const run = cli(["--json", "--council", "--council-timeout", "1000"], { HERDR_JEV_CROSS_HARNESS: "1" });
    expect(run.status).toBe(0);
    const members = JSON.parse(run.stdout).council.run.members;
    expect(members.filter((m: { status: string }) => m.status === "failed").map((m: { reason: string }) => m.reason)).toEqual(["timed out after 1s", "timed out after 1s"]);
  });

  it("refuses an invalid --council-wait as a note without touching the review", () => {
    const run = cli(["--json", "--council", "--council-wait", "soon"], { HERDR_JEV_CROSS_HARNESS: "1" });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ready");
    expect(parsed.council.run.note).toContain("invalid council wait");
  });
});

describe("an interrupted review keeps its exit code and report with --council", () => {
  type Judge = "FAKE_HANG" | "FAKE_STUBBORN_CHILD";

  function judgePid(kind: Judge): number | null {
    const file = join(harness!.dir, kind === "FAKE_HANG" ? "grandchild.pid" : "stubborn.pid");
    return existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
  }

  async function interrupt(kind: Judge, args: string[], signal: NodeJS.Signals, session: string) {
    harness?.restore();
    harness = createFakeHarness("contract", { FAKE_PROFILE: "1", [kind]: "review-judge" });
    useMembers(lastBehaviours);
    const child = spawn(process.execPath, reviewArgs(["--json", ...args], session), { cwd: repo, env: cliEnv({ HERDR_JEV_CROSS_HARNESS: "1" }), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    const closed = new Promise<{ code: number | null; signal: string | null }>((done) => child.on("close", (code, sig) => done({ code, signal: sig })));
    try {
      await until(() => judgePid(kind) !== null, "the judge to start");
      const member = judgePid(kind)!;
      await new Promise((done) => setTimeout(done, 300));
      child.kill(signal);
      const result = await closed;
      try { process.kill(member, "SIGKILL"); } catch {}
      return { ...result, stdout };
    } finally {
      child.kill("SIGKILL");
    }
  }

  for (const kind of ["FAKE_HANG", "FAKE_STUBBORN_CHILD"] as const) {
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      it(`${signal} exits ${code} and prints what the plain path prints (${kind})`, async () => {
        useMembers({ kimi: "exec sleep 120", agy: "exec sleep 120", codex: "exec sleep 120" });
        const plain = await interrupt(kind, [], signal, "intr");
        expect(plain.code).toBe(code);
        const withCouncil = await interrupt(kind, ["--council"], signal, "intr");
        expect(withCouncil.code).toBe(code);
        expect(withCouncil.stdout).toBe(plain.stdout);
      }, 120_000);
    }
  }
});

describe("the council state directory", () => {
  it("is refused when it lies inside the reviewed repository and is not ignored", () => {
    useMembers(NO_FINDINGS);
    const run = cli(["--json", "--council"], { HERDR_JEV_CROSS_HARNESS: "1", HERDR_JEV_STATE_DIR: join(repo, ".state") });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).council.run.note).toContain("state_dir_inside_repo");
  });
});
