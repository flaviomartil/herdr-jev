import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { privatePath } from "./council-helpers.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
import { createTestStateDir } from "./helpers.js";

setDefaultTimeout(120_000);

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const PRELOAD = resolve(import.meta.dir, "council-auto-fetch-preload.ts");
const RUN_ID = "00000000-0000-4000-8000-0000000000bb";

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

function members() {
  const ran = join(scratch, "members-ran");
  const body = `echo x >> '${ran}'\necho NO_FINDINGS`;
  priv = privatePath(scratch, { codex: body, kimi: body, agy: `echo x >> '${ran}'\necho '{"result":"NO_FINDINGS"}'` });
  return () => (existsSync(ran) ? readFileSync(ran, "utf8").split("\n").filter(Boolean).length : 0);
}

function env(complexity: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  return { ...process.env, PATH: priv.path, HOME: home, HERDR_ENV: "0", HERDR_JEV_CROSS_HARNESS: "1", TYPESAFE_API_KEY: "test-key", FAKE_TRIAGE: complexity, FAKE_TRIAGE_LOG: join(scratch, "triage.log"), ...extra };
}

function triaged(): string[] {
  const file = join(scratch, "triage.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).state as string) : [];
}

function review(args: string[], complexity: string, extra: Record<string, string> = {}, session = "auto-1") {
  const run = spawnSync(process.execPath, ["--preload", PRELOAD, CLI, "review", "--client", "codex", "--scopes", "core=src", "--session", session, ...args], { encoding: "utf8", env: env(complexity, extra), cwd: repo, timeout: 100_000 });
  return { status: run.status, stdout: run.stdout };
}

function council(args: string[], complexity: string, extra: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, ["--preload", PRELOAD, CLI, "council", "--client", "codex", ...args], { encoding: "utf8", env: env(complexity, extra), cwd: repo, timeout: 100_000 });
  return { status: run.status, stdout: run.stdout };
}

beforeEach(() => {
  testEnv = createTestStateDir();
  repo = realpathSync(mkdtempSync(join(tmpdir(), "council-auto-repo-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "council-auto-scratch-")));
  harness = createFakeHarness("contract", { FAKE_PROFILE: "1" });
  git(repo, "init", "-q", "-b", "main");
  write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
  write("src/a.ts", "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  write("src/c.ts", "export const c = 1;\n");
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  expect(priv.reached()).toEqual([]);
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  testEnv.cleanup();
});

describe("review --council auto", () => {
  it("runs the council for a moderate task and keeps the review result", () => {
    const started = members();
    const plain = review(["--json"], "moderate");
    expect(started()).toBe(0);
    const run = review(["--json", "--council", "auto", "--task", "migrate the billing tables"], "moderate");
    expect(run.status).toBe(plain.status);
    const { council, ...rest } = JSON.parse(run.stdout);
    expect(rest).toEqual(JSON.parse(plain.stdout));
    expect(council.ran).toBe(true);
    expect(started()).toBe(2);
    expect(triaged()).toHaveLength(1);
    expect(triaged()[0]).toContain("migrate the billing tables");
  });

  it("accepts --council=auto and an architectural task", () => {
    const started = members();
    const run = review(["--json", "--council=auto", "--task", "split the monolith"], "architectural");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).council.ran).toBe(true);
    expect(started()).toBe(2);
  });

  for (const complexity of ["trivial", "routine"]) {
    it(`skips a ${complexity} task and adds one note, nothing else`, () => {
      const started = members();
      const plain = review(["--json"], complexity);
      const run = review(["--json", "--council", "auto", "--task", "fix a typo"], complexity);
      expect(run.status).toBe(plain.status);
      const { councilNote, ...rest } = JSON.parse(run.stdout);
      expect(rest).toEqual(JSON.parse(plain.stdout));
      expect(councilNote).toBe(`council skipped: triage ${complexity}`);
      expect(started()).toBe(0);
      const text = review(["--council", "auto", "--task", "fix a typo"], complexity);
      expect(text.stdout).toBe(`${review([], complexity).stdout.trimEnd()}\n\ncouncil skipped: triage ${complexity}\n`);
    });
  }

  it("skips with a note when triage fails and the review is unaffected", () => {
    const started = members();
    const plain = review(["--json"], "fail");
    const run = review(["--json", "--council", "auto", "--task", "migrate"], "fail");
    expect(run.status).toBe(plain.status);
    expect(plain.status).toBe(0);
    const { councilNote, ...rest } = JSON.parse(run.stdout);
    expect(rest).toEqual(JSON.parse(plain.stdout));
    expect(councilNote).toBe("council skipped: triage unavailable");
    expect(started()).toBe(0);
  });

  it("skips with a note when no TypeSafe key is available", () => {
    const started = members();
    const run = review(["--json", "--council", "auto", "--task", "migrate"], "moderate", { TYPESAFE_API_KEY: "" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).councilNote).toBe("council skipped: triage unavailable");
    expect(started()).toBe(0);
    expect(triaged()).toEqual([]);
  });

  it("skips without --task when the session is not a pipeline run", () => {
    const started = members();
    const run = review(["--json", "--council", "auto"], "moderate");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).councilNote).toBe("council skipped: no task summary");
    expect(triaged()).toEqual([]);
    expect(started()).toBe(0);
  });

  it("uses the objective of the pipeline run named by --session", () => {
    const started = members();
    mkdirSync(join(testEnv.stateDir, RUN_ID), { recursive: true });
    writeFileSync(join(testEnv.stateDir, RUN_ID, "objective.md"), "Replace the payment gateway client");
    const run = review(["--json", "--council", "auto"], "moderate", {}, RUN_ID);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).council.ran).toBe(true);
    expect(triaged()[0]).toContain("Replace the payment gateway client");
    expect(started()).toBe(2);
  });

  it("prefers --task over the run objective", () => {
    members();
    mkdirSync(join(testEnv.stateDir, RUN_ID), { recursive: true });
    writeFileSync(join(testEnv.stateDir, RUN_ID, "objective.md"), "Replace the payment gateway client");
    review(["--json", "--council", "auto", "--task", "explicit summary"], "moderate", {}, RUN_ID);
    expect(triaged()[0]).toContain("explicit summary");
    expect(triaged()[0]).not.toContain("payment gateway");
  });

  it("skips the same diff, then the cooldown, and --council-cooldown 0 lifts the cooldown", () => {
    const started = members();
    const args = ["--json", "--council", "auto", "--task", "migrate"];
    expect(JSON.parse(review(args, "moderate").stdout).council.ran).toBe(true);
    expect(JSON.parse(review(args, "moderate").stdout).councilNote).toBe("council skipped: same diff as the last council run");
    write("src/d.ts", "export const d = 1;\n");
    expect(JSON.parse(review(args, "moderate").stdout).councilNote).toContain("council skipped: cooldown");
    expect(started()).toBe(2);
    expect(JSON.parse(review([...args, "--council-cooldown", "0"], "moderate").stdout).council.ran).toBe(true);
    expect(started()).toBe(4);
  });

  it("plain --council ignores the hash and the cooldown", () => {
    const started = members();
    expect(JSON.parse(review(["--json", "--council", "auto", "--task", "migrate"], "moderate").stdout).council.ran).toBe(true);
    expect(JSON.parse(review(["--json", "--council"], "routine").stdout).council.ran).toBe(true);
    expect(JSON.parse(review(["--json", "--council"], "routine").stdout).council.ran).toBe(true);
    expect(started()).toBe(6);
    expect(triaged()).toHaveLength(1);
  });

  it("rejects an unknown --council value before reviewing", () => {
    members();
    const run = review(["--json", "--council", "sometimes"], "moderate");
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).error).toContain("invalid --council value");
  });

  it("does not change a review that runs without --council", () => {
    members();
    const run = review(["--json", "--task", "migrate"], "moderate");
    expect(run.status).toBe(0);
    expect(Object.keys(JSON.parse(run.stdout))).not.toContain("council");
    expect(Object.keys(JSON.parse(run.stdout))).not.toContain("councilNote");
    expect(triaged()).toEqual([]);
  });
});

describe("council --auto", () => {
  it("exits 2 with the note for a routine task and starts no member", () => {
    const started = members();
    const run = council(["--auto", "--task", "fix a typo"], "routine");
    expect(run.status).toBe(2);
    expect(run.stdout.trim()).toBe("council skipped: triage routine");
    expect(started()).toBe(0);
  });

  it("exits 2 with the note when triage fails", () => {
    members();
    const run = council(["--auto", "--task", "migrate"], "fail");
    expect(run.status).toBe(2);
    expect(run.stdout.trim()).toBe("council skipped: triage unavailable");
  });

  it("exits 2 without a task summary", () => {
    members();
    const run = council(["--auto"], "moderate");
    expect(run.status).toBe(2);
    expect(run.stdout.trim()).toBe("council skipped: no task summary");
  });

  it("runs for a moderate task, then skips the same diff", () => {
    const started = members();
    const first = council(["--auto", "--task", "migrate", "--json"], "moderate");
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).run.ran).toBe(true);
    expect(started()).toBe(2);
    const second = council(["--auto", "--task", "migrate", "--json"], "moderate");
    expect(second.status).toBe(2);
    expect(JSON.parse(second.stdout)).toEqual({ skipped: "council skipped: same diff as the last council run" });
  });

  it("without --auto it runs for any task and does not call triage", () => {
    const started = members();
    const run = council(["--json"], "routine");
    expect(run.status).toBe(0);
    expect(started()).toBe(2);
    expect(triaged()).toEqual([]);
  });
});

describe("pipeline commands", () => {
  for (const command of ["route", "run-resume"]) {
    it(`offers --council on ${command}`, () => {
      members();
      const help = spawnSync(process.execPath, [CLI, command, "--help"], { encoding: "utf8", env: env("routine"), cwd: repo, timeout: 60_000 });
      expect(help.stdout).toContain("--council <mode>");
      expect(help.stdout).toContain("off or auto");
    });
  }

  it("rejects an unknown --council value on run-resume", () => {
    members();
    const run = spawnSync(process.execPath, [CLI, "run-resume", RUN_ID, "--council", "always"], { encoding: "utf8", env: env("routine"), cwd: repo, timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("invalid --council value");
  });
});
