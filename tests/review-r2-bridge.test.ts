import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { reviewExcludedEnv } from "../src/config/env-file.js";
import { harnessProbe, harnessProbeAsync, hasExhaustedUsageQuota, readUsageQuota, resolveHarnessDelegation } from "../src/harness/bridge.js";
import { MAX_CONCURRENT_JUDGES, detectVerifyCommand, formatReviewReport, listChangedFiles, parseScopes, assignScopes, runReview, type ReviewReport } from "../src/harness/review.js";
import { createFakeHarness, fakeHarnessCommands, fakeJudgeEvents, type FakeHarness, type FakeHarnessMode } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTempHome, createTestStateDir } from "./helpers.js";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

let testEnv: { stateDir: string; cleanup: () => void };
let harness: FakeHarness | undefined;
let repo: string;
let scratch: string;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function write(path: string, content: string, base = repo) {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), content);
}

function seed() {
  git(repo, "init", "-q", "-b", "main");
  write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
  write("src/a.ts", "export const a = 1;\n");
  write("docs/x.md", "doc\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  write("src/a.ts", "export const a = 2;\n");
  write("src/b.ts", "export const b = 1;\n");
}

function install(mode: FakeHarnessMode = "contract", env: Record<string, string> = {}) {
  harness = createFakeHarness(mode, { FAKE_PROFILE: "1", ...env });
}

function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: createTempHome(), HERDR_ENV: "0", TYPESAFE_API_KEY: "", ...extra };
}

function reviewRoot(): string {
  return join(testEnv.stateDir, "review");
}

function reviewEntries(): string[] {
  return existsSync(reviewRoot()) ? readdirSync(reviewRoot()) : [];
}

async function until(check: () => boolean, label: string, limitMs = 60_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function grandchild(): number | null {
  if (!harness) return null;
  const file = join(harness!.dir, "grandchild.pid");
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
}

function stopGrandchild() {
  const pid = grandchild();
  if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
}

beforeEach(() => {
  testEnv = createTestStateDir();
  repo = realpathSync(mkdtempSync(join(tmpdir(), "review-r2-repo-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "review-r2-scratch-")));
  seed();
});

afterEach(() => {
  stopGrandchild();
  harness?.restore();
  harness = undefined;
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

function unrelatedBranch(name: string) {
  git(repo, "checkout", "-q", "--orphan", name);
  git(repo, "rm", "-rfq", "--cached", ".");
  write("other.txt", "unrelated\n");
  git(repo, "add", "other.txt");
  git(repo, "commit", "-q", "-m", "unrelated");
  git(repo, "checkout", "-q", "-f", "feature");
}

describe("blocking 1 and 2: a failed git call is an explicit error", () => {
  it("refuses --base with no merge base instead of reviewing only the working tree", async () => {
    install();
    unrelatedBranch("unrelated");
    expect(() => listChangedFiles(repo, "unrelated")).toThrow("no_merge_base");
    await expect(runReview({ cwd: repo, client: "codex", base: "unrelated" })).rejects.toThrow("no_merge_base");
    expect(harness!.callsFor("review-verify")).toHaveLength(0);
  });

  it("refuses an unrelated HEAD when the default branch exists instead of diffing against HEAD under the default branch label", () => {
    unrelatedBranch("solo");
    git(repo, "checkout", "-q", "solo");
    expect(() => listChangedFiles(repo)).toThrow("no_merge_base");
  });

  it("refuses a directory that is not a repository", async () => {
    install();
    expect(() => listChangedFiles(scratch)).toThrow("not_a_git_repository");
    await expect(runReview({ cwd: scratch, client: "codex" })).rejects.toThrow("not_a_git_repository");
    expect(harness!.callsFor("review-verify")).toHaveLength(0);
  });

  it("reports a repository without commits as a git failure and never as an empty change set", async () => {
    const empty = join(scratch, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    write("a.ts", "x\n", empty);
    expect(() => listChangedFiles(empty)).toThrow("git_failed");
    install();
    await expect(runReview({ cwd: empty, client: "codex" })).rejects.toThrow("git_failed");
  });

  it("the CLI exits 1 with the error code for a non-repository, a missing merge base and an empty repository", () => {
    install();
    unrelatedBranch("unrelated");
    const run = (args: string[], cwd: string) => spawnSync(process.execPath, [CLI, "review", "--client", "codex", "--json", ...args], { encoding: "utf8", cwd, env: cliEnv(), timeout: 120_000 });
    const notRepo = run(["--cwd", scratch], repo);
    expect(notRepo.status).toBe(1);
    expect(JSON.parse(notRepo.stdout).error).toContain("not_a_git_repository");
    const noBase = run(["--base", "unrelated"], repo);
    expect(noBase.status).toBe(1);
    expect(JSON.parse(noBase.stdout).error).toContain("no_merge_base");
    const empty = join(scratch, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    const noCommits = run([], empty);
    expect(noCommits.status).toBe(1);
    expect(JSON.parse(noCommits.stdout).error).toContain("git_failed");
  });
});

describe("blocking 3: signals and exit stop the harness process groups and remove the command files", () => {
  const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    it(`${signal} on the CLI kills the detached judge group and leaves no command files`, async () => {
      install("contract", { FAKE_HANG: "review-judge" });
      const child = spawn(process.execPath, [CLI, "review", "--client", "codex", "--json", "--scopes", "core=src", "--session", `sig-${signal}`], { cwd: repo, env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
      const closed = new Promise<{ code: number | null; signal: string | null }>((done) => child.on("close", (code, sig) => done({ code, signal: sig })));
      try {
        await until(() => grandchild() !== null, "the judge to hang");
        const hung = grandchild()!;
        expect(alive(hung)).toBe(true);
        expect(reviewEntries().length).toBe(1);
        child.kill(signal);
        const result = await closed;
        expect(result.code).toBe(exitCodes[signal]);
        await until(() => !alive(hung), "the judge group to die", 15_000);
        expect(reviewEntries()).toEqual([]);
      } finally {
        child.kill("SIGKILL");
      }
    }, 120_000);
  }

  it("process.exit during a review kills the judge group and removes the command files", async () => {
    install("contract", { FAKE_HANG: "review-judge" });
    const script = `import { existsSync } from "node:fs";
import { runReview } from ${JSON.stringify(resolve(import.meta.dir, "../src/harness/review.ts"))};
runReview({ cwd: process.argv[1], client: "codex", session: "exit-1", scopes: "core=src" }).catch(() => {});
setInterval(() => { if (existsSync(process.env.FAKE_HARNESS_DIR + "/grandchild.pid")) process.exit(7); }, 25);`;
    const child = spawn(process.execPath, ["-e", script, repo], { cwd: repo, env: cliEnv(), stdio: ["ignore", "ignore", "inherit"] });
    const closed = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
    try {
      expect(await closed).toBe(7);
      const hung = grandchild()!;
      await until(() => !alive(hung), "the judge group to die", 15_000);
      expect(reviewEntries()).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  }, 120_000);
});

describe("blocking 4: a degraded quota path is cached and stops at the first unsupported or timed-out call", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const quotaFile = (windows: unknown[]) => {
    const path = join(scratch, `quota-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({ fetched_at_unix: Math.floor(Date.now() / 1000), account_id: "acct", windows }));
    return path;
  };
  const windows = [{ remaining_percent: 0, resets_at: future }, { remaining_percent: 30, resets_at: future }, { remaining_percent: 60, resets_at: future }];

  it("asks an unsupported harness once, keeps the local answers and reuses them for a short while", () => {
    install("unknown");
    const path = quotaFile(windows);
    const now = spyOn(Date, "now");
    try {
      const start = Date.now();
      now.mockReturnValue(start);
      const first = readUsageQuota(path) as any[];
      expect(first).toHaveLength(3);
      for (const observation of first) expect(observation.source).toBe("local_fallback");
      expect(hasExhaustedUsageQuota("codex", first)).toBe(true);
      expect(harness!.callsFor("quota-normalize")).toHaveLength(1);
      now.mockReturnValue(start + 20_000);
      expect(readUsageQuota(path)).toEqual(first);
      expect(harness!.callsFor("quota-normalize")).toHaveLength(1);
      now.mockReturnValue(start + 61_000);
      readUsageQuota(path);
      expect(harness!.callsFor("quota-normalize")).toHaveLength(2);
    } finally { now.mockRestore(); }
  });

  it("stops after the first timed-out call and does not ask again while the degraded answer is cached", () => {
    install("contract", { FAKE_HANG: "quota-normalize" });
    const path = quotaFile(windows);
    const first = readUsageQuota(path, 800) as any[];
    expect(first).toHaveLength(3);
    for (const observation of first) expect(observation.source).toBe("local_fallback");
    expect(harness!.callsFor("quota-normalize")).toHaveLength(1);
    expect(readUsageQuota(path, 800)).toEqual(first);
    expect(harness!.callsFor("quota-normalize")).toHaveLength(1);
  }, 60_000);
});

describe("non-blocking probe findings", () => {
  it("11: a synchronous probe timeout reports harness_command_timeout like the asynchronous one", () => {
    install("contract", { FAKE_HANG: "model-catalog" });
    expect(harnessProbe(["model-catalog"], { timeout: 800 })).toMatchObject({ ok: false, error: "harness_command_timeout" });
  }, 60_000);

  it("12: a harness binary that cannot be started yields a failed probe", async () => {
    install();
    writeFileSync(join(harness!.bin, "ai-harness"), "#!/nonexistent/interpreter\n", { mode: 0o755 });
    chmodSync(join(harness!.bin, "ai-harness"), 0o755);
    expect(await harnessProbeAsync(["model-catalog"], { timeout: 10_000 })).toMatchObject({ ok: false, error: "harness_command_failed" });
  });

  it("13: a multi-megabyte NDJSON stderr is scanned in linear time and still finds the error code", async () => {
    install();
    const script = `#!${process.execPath}\nprocess.stderr.write('{"error":"real_code"}\\n' + '{}\\n'.repeat(300000));\nprocess.exitCode = 1;\n`;
    writeFileSync(join(harness!.bin, "ai-harness"), script, { mode: 0o755 });
    chmodSync(join(harness!.bin, "ai-harness"), 0o755);
    expect(harnessProbe(["model-catalog"])).toMatchObject({ ok: false, error: "real_code" });
    expect(await harnessProbeAsync(["model-catalog"], { timeout: 50_000 })).toMatchObject({ ok: false, error: "real_code" });
  }, 120_000);

  it("13: a pretty-printed error object after warnings is still decoded", () => {
    install();
    const script = `#!${process.execPath}\nprocess.stderr.write('warning: x\\n{\\n  "error": "pretty_code"\\n}\\n');\nprocess.exitCode = 1;\n`;
    writeFileSync(join(harness!.bin, "ai-harness"), script, { mode: 0o755 });
    chmodSync(join(harness!.bin, "ai-harness"), 0o755);
    expect(harnessProbe(["model-catalog"])).toMatchObject({ ok: false, error: "pretty_code" });
  });

  it("10: an effort outside the known levels invalidates the delegation plan", () => {
    const plan = (effort: string) => JSON.stringify({ mode: "delegate", profile: { id: "p", client: "codex", advisor: "a",
      executor: { model: "m1", effort: "high" }, reviewer: { model: "m2", effort } } });
    install("contract", { FAKE_DELEGATION_RAW: plan("turbo") });
    expect(resolveHarnessDelegation("codex", true)).toEqual({ mode: "direct", reason: "invalid_delegation_plan" });
    harness!.restore();
    install("contract", { FAKE_DELEGATION_RAW: plan("xhigh") });
    expect(resolveHarnessDelegation("codex", true).mode).toBe("delegate");
  });
});

describe("5: at most four judges run at once", () => {
  it("queues the remaining judges and keeps four in flight", async () => {
    const gate = join(scratch, "judge-gate");
    install("contract", { FAKE_JUDGE_GATE: gate });
    const scopes = Array.from({ length: 8 }, (_, index) => `s${index + 1}=src`).join(";");
    const running = runReview({ cwd: repo, client: "codex", session: "limit-1", scopes });
    const started = () => fakeJudgeEvents(harness!).filter((event) => event.event === "start").length;
    await until(() => started() === MAX_CONCURRENT_JUDGES, "four judges to start");
    await new Promise((done) => setTimeout(done, 300));
    expect(started()).toBe(MAX_CONCURRENT_JUDGES);
    writeFileSync(gate, "");
    const report = await running;
    expect(report.status).toBe("ready");
    expect(report.judges).toHaveLength(8);
    const events = fakeJudgeEvents(harness!);
    expect(events.filter((event) => event.event === "start")).toHaveLength(8);
    const ordered = events.map((event, order) => ({ ...event, order })).sort((a, b) => a.at - b.at || (a.event === "end" ? -1 : 1) - (b.event === "end" ? -1 : 1) || a.order - b.order);
    let inFlight = 0;
    let peak = 0;
    for (const event of ordered) {
      inFlight += event.event === "start" ? 1 : -1;
      peak = Math.max(peak, inFlight);
    }
    expect(MAX_CONCURRENT_JUDGES).toBe(4);
    expect(peak).toBe(MAX_CONCURRENT_JUDGES);
  }, 120_000);
});

describe("6 and 17: the printed report", () => {
  const dirty = (text: string) => `${ESC}[31m${text}${ESC}]0;title${BEL}${ESC}[2J`;
  const base: ReviewReport = { session: "s", client: "codex", cwd: "/r", base: "main", scopes: [{ name: "a", fileCount: 1 }], judges: [], status: null };

  it("6: strips terminal sequences from every harness-sourced field", () => {
    const text = formatReviewReport({
      ...base,
      verify: { status: null, error: dirty("verify-error") },
      judges: [{ scope: "a", status: null, error: dirty("judge-error") }, { scope: "b", status: dirty("judge-status") }],
      status: dirty("final-status"),
      error: dirty("report-error"),
      findings: { scopes: [{ name: "a", verdict: dirty("verdict"), reason: dirty("reason"), findings: dirty("detail") }] },
    });
    expect(text.includes(ESC)).toBe(false);
    expect(text.includes(BEL)).toBe(false);
    for (const word of ["verify-error", "judge-error", "judge-status", "final-status", "report-error", "verdict", "reason", "detail"]) expect(text).toContain(word);
  });

  it("17: reports a failed check only when the harness says the check failed", () => {
    const none = (status: string) => formatReviewReport({ ...base, verify: { status, command: ["bun", "test"] }, status });
    expect(none("changes_required")).toContain("The check command failed");
    expect(none("ready")).not.toContain("The check command failed");
    expect(none("unexpected_status")).not.toContain("The check command failed");
    expect(none("unexpected_status")).toContain("Verify: unexpected_status");
  });
});

describe("7 and uncovered 4: paths and working directory", () => {
  it("runs the verification from the repository root when the working directory is a subdirectory", async () => {
    install();
    const report = await runReview({ cwd: join(repo, "src"), client: "codex", session: "sub-1", scopes: "core=src" });
    expect(report.error).toBeUndefined();
    expect(report.status).toBe("ready");
    expect(report.cwd).toBe(repo);
    for (const argv of [...harness!.callsFor("review-verify"), ...harness!.callsFor("review-judge"), ...harness!.callsFor("review-findings")]) {
      expect(argv[argv.indexOf("--cwd") + 1]).toBe(repo);
    }
  });

  it("the CLI uses the repository root for --cwd on a subdirectory and for a subdirectory working directory", () => {
    install();
    const viaOption = spawnSync(process.execPath, [CLI, "review", "--client", "codex", "--json", "--cwd", join(repo, "src"), "--scopes", "core=src", "--session", "sub-opt"], { encoding: "utf8", cwd: scratch, env: cliEnv(), timeout: 120_000 });
    expect(viaOption.status).toBe(0);
    expect(JSON.parse(viaOption.stdout)).toMatchObject({ status: "ready", cwd: repo });
    const viaCwd = spawnSync(process.execPath, [CLI, "review", "--client", "codex", "--json", "--scopes", "core=src", "--session", "sub-cwd"], { encoding: "utf8", cwd: join(repo, "src"), env: cliEnv(), timeout: 120_000 });
    expect(viaCwd.status).toBe(0);
    expect(JSON.parse(viaCwd.stdout)).toMatchObject({ status: "ready", cwd: repo });
    for (const argv of harness!.callsFor("review-verify")) expect(argv[argv.indexOf("--cwd") + 1]).toBe(repo);
  });
});

describe("uncovered 7: only HERDR_JEV variables from the env files are hidden", () => {
  it("keeps every other key", () => {
    expect(reviewExcludedEnv(["HERDR_JEV_A", "HTTPS_PROXY", "PROVIDER_CREDENTIAL", "AI_HARNESS_ROOT", "HERDR_JEV_B"])).toEqual(["HERDR_JEV_A", "HERDR_JEV_B"]);
  });

  it("the CLI hides the HERDR_JEV file variable from the verification and judges and keeps the proxy variable", () => {
    install("contract", { FAKE_ENV_PROBE: "HERDR_JEV_PROBE_FROM_FILE,PROXY_PROBE_FROM_FILE" });
    const home = createTempHome();
    mkdirSync(join(home, ".config/herdr"), { recursive: true });
    writeFileSync(join(home, ".config/herdr/.env"), "HERDR_JEV_PROBE_FROM_FILE=from-file\nPROXY_PROBE_FROM_FILE=proxy-value\n");
    const result = spawnSync(process.execPath, [CLI, "review", "--client", "codex", "--json", "--scopes", "core=src", "--session", "env-r2"], { encoding: "utf8", cwd: repo, env: cliEnv({ HOME: home }), timeout: 120_000 });
    expect(JSON.parse(result.stdout).status).toBe("ready");
    const entries = fakeHarnessCommands(harness!);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(entry.env.HERDR_JEV_PROBE_FROM_FILE).toBeNull();
      expect(entry.env.PROXY_PROBE_FROM_FILE).toBe("proxy-value");
    }
  });
});

describe("14: the verify command keeps the arguments of the repository test script", () => {
  const at = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(scratch, "pm-"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return detectVerifyCommand(dir);
  };
  const manifest = (script: string) => JSON.stringify({ scripts: { test: script } });

  it("passes the script arguments to bun test and falls back to the script runner for anything shell-like", () => {
    expect(at({ "package.json": manifest("bun test --timeout 20000 src") })).toEqual(["bun", "test", "--timeout", "20000", "src"]);
    expect(at({ "package.json": manifest("bun test") })).toEqual(["bun", "test"]);
    expect(at({ "package.json": manifest("bun test && echo done"), "bun.lock": "" })).toEqual(["bun", "run", "test"]);
    expect(at({ "package.json": manifest("bun test $FILES") })).toEqual(["npm", "test"]);
    expect(at({ "package.json": manifest("bun test --coverage"), "package-lock.json": "{}" })).toEqual(["npm", "test"]);
  });
});

describe("15: the sensitive file guard covers staged and modified files", () => {
  it("flags a staged .env and a modified tracked key but not source files named like secrets", () => {
    write(".env", "TOKEN=placeholder\n");
    git(repo, "add", "-f", ".env");
    write("src/secrets.ts", "export const secrets = [];\n");
    write("src/credentials.py", "x = 1\n");
    expect(listChangedFiles(repo).sensitive).toEqual([".env"]);
  });

  it("flags untracked data files named like secrets", () => {
    write("config/secrets.json", "{}\n");
    write("deploy/credentials", "x\n");
    expect(listChangedFiles(repo).sensitive).toEqual(["config/secrets.json", "deploy/credentials"]);
  });

  it("flags a tracked key that is modified in the working tree but not one older than the base or deleted", () => {
    write("keys/server.pem", "first\n");
    git(repo, "add", "-f", "-A");
    git(repo, "commit", "-q", "-m", "key");
    expect(listChangedFiles(repo, "HEAD").sensitive).toEqual([]);
    write("keys/server.pem", "second\n");
    expect(listChangedFiles(repo, "HEAD").sensitive).toEqual(["keys/server.pem"]);
    rmSync(join(repo, "keys/server.pem"));
    expect(listChangedFiles(repo, "HEAD").sensitive).toEqual([]);
  });

  it("the review refuses a staged secret before any harness call", async () => {
    install();
    write(".env", "TOKEN=placeholder\n");
    git(repo, "add", "-f", ".env");
    await expect(runReview({ cwd: repo, client: "codex" })).rejects.toThrow('sensitive_uncommitted_files: ".env"');
    expect(harness!.callsFor("review-verify")).toHaveLength(0);
  });
});

describe("16: two runs with the same session keep separate command directories", () => {
  it("never share or remove each other's command files", async () => {
    const gate = join(scratch, "gate");
    install("contract", { FAKE_JUDGE_GATE: gate });
    const first = runReview({ cwd: repo, client: "codex", session: "same", scopes: "core=src" });
    const second = runReview({ cwd: repo, client: "codex", session: "same", scopes: "core=src" });
    try {
      await until(() => fakeJudgeEvents(harness!).filter((event) => event.event === "start").length >= 2, "both judges to start");
      const entries = reviewEntries();
      expect(entries).toHaveLength(2);
      expect(new Set(entries).size).toBe(2);
      for (const entry of entries) {
        expect(entry.startsWith("same-")).toBe(true);
        expect(existsSync(join(reviewRoot(), entry, "judge-0.json"))).toBe(true);
      }
    } finally {
      writeFileSync(gate, "open");
    }
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    expect(reviewEntries()).toEqual([]);
  }, 120_000);
});

describe("18: scope paths", () => {
  it("a scope of . covers every changed file", () => {
    expect(parseScopes("all=.,./")).toEqual([{ name: "all", paths: [".", "."] }]);
    expect(parseScopes("a=./src/./x/")).toEqual([{ name: "a", paths: ["src/x"] }]);
    expect(assignScopes(parseScopes("all=."), ["a.ts", "src/b.ts"])).toEqual([{ name: "all", files: ["a.ts", "src/b.ts"], changed: ["a.ts", "src/b.ts"] }]);
  });

  it("the review judges the whole change under a scope of . and refuses a declared path that does not exist", async () => {
    install();
    const report = await runReview({ cwd: repo, client: "codex", session: "dot-1", scopes: "all=." });
    expect(report.status).toBe("ready");
    expect(report.scopes).toEqual([{ name: "all", fileCount: 2 }]);
    await expect(runReview({ cwd: repo, client: "codex", session: "dot-2", scopes: "core=src;lib=missing/dir" })).rejects.toThrow('invalid_scopes: "missing/dir" not found');
    await expect(runReview({ cwd: repo, client: "codex", session: "dot-3", scopes: "core=src;docs=docs" })).resolves.toMatchObject({ status: "ready" });
  });
});

describe("19: hunk ranges survive git diff prefix configuration", () => {
  for (const [key, value] of [["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"]] as const) {
    it(`keeps the line ranges with ${key}`, () => {
      const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = key;
      process.env.GIT_CONFIG_VALUE_0 = value;
      try {
        const changed = listChangedFiles(repo);
        expect(changed.ranges["src/a.ts"]).toEqual(["1"]);
        expect(changed.ranges["src/b.ts"]).toEqual(["new file"]);
        write("src/c.ts", "export const c = 1;\n");
        expect(listChangedFiles(repo).ranges["src/c.ts"]).toEqual(["new file"]);
      } finally {
        for (const [name, previous] of [["GIT_CONFIG_COUNT", saved.count], ["GIT_CONFIG_KEY_0", saved.key], ["GIT_CONFIG_VALUE_0", saved.value]] as const) {
          if (previous === undefined) delete process.env[name];
          else process.env[name] = previous;
        }
      }
    });
  }
});
