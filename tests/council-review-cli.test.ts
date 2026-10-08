import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
import { createTestStateDir } from "./helpers.js";

setDefaultTimeout(120_000);

let testEnv: { stateDir: string; cleanup: () => void };
let harness: FakeHarness | undefined;
let repo: string;
let scratch: string;

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

function fakeMembers(failKimi = false): string {
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  const script = (name: string, version: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\ncat >/dev/null 2>&1\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("codex", "codex-cli 0.160.1", "echo NO_FINDINGS");
  script("kimi", "2.1.1", failKimi ? "echo boom >&2; exit 3" : "echo NO_FINDINGS");
  script("agy", "1.3.1", 'echo \'{"result":"NO_FINDINGS"}\'');
  return bin;
}

function cli(args: string[], extra: Record<string, string> = {}) {
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, HERDR_ENV: "0", TYPESAFE_API_KEY: "", ...extra };
  const run = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "review", "--client", "codex", "--scopes", "core=src", "--session", `s-${Math.random().toString(36).slice(2, 8)}`, ...args], { encoding: "utf8", env, cwd: repo, timeout: 100_000 });
  return { status: run.status, stdout: run.stdout };
}

beforeEach(() => {
  testEnv = createTestStateDir();
  repo = realpathSync(mkdtempSync(join(tmpdir(), "council-cli-repo-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "council-cli-scratch-")));
  harness = createFakeHarness("contract", { FAKE_PROFILE: "1" });
  seed();
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  testEnv.cleanup();
});

describe("review --council through the CLI", () => {
  it("keeps the review status and exit code the same with and without --council", () => {
    const plain = cli(["--json"]);
    const withCouncil = cli(["--json", "--council"]);
    expect(plain.status).toBe(0);
    expect(withCouncil.status).toBe(plain.status);
    const a = JSON.parse(plain.stdout);
    const { council, session: _s, ...rest } = JSON.parse(withCouncil.stdout);
    const { session: _t, ...base } = a;
    expect(rest).toEqual(base);
    expect(a.status).toBe("ready");
    expect(council.ran).toBe(false);
  });

  it("runs the members in parallel with the review and reports them under a separate heading", () => {
    const bin = fakeMembers();
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, HERDR_JEV_CROSS_HARNESS: "1" };
    const json = cli(["--json", "--council"], env);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.status).toBe("ready");
    expect(parsed.council.ran).toBe(true);
    expect(parsed.council.run.members.map((m: { member: string; status: string }) => [m.member, m.status])).toEqual([["codex", "skipped"], ["kimi", "done"], ["antigravity", "done"]]);
    const text = cli(["--council"], env);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("Council (consultative only");
    expect(text.stdout.indexOf("Council (consultative only")).toBeGreaterThan(0);
  });

  it("does not fail the review when a council member fails", () => {
    const bin = fakeMembers(true);
    const run = cli(["--json", "--council-members", "kimi,antigravity,codex"], { PATH: `${bin}:${process.env.PATH ?? ""}`, HERDR_JEV_CROSS_HARNESS: "1" });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ready");
    expect(parsed.council.run.members.find((m: { member: string }) => m.member === "kimi").status).toBe("failed");
  });

  it("drops a requested member the cross-harness configuration excludes and says so", () => {
    const bin = fakeMembers();
    const run = cli(["--json", "--council-members", "kimi,antigravity"], { PATH: `${bin}:${process.env.PATH ?? ""}`, HERDR_JEV_CROSS_HARNESS: '{"codex":["kimi"]}' });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.council.notes).toEqual(["requested member antigravity was dropped: client codex cannot use it under the cross-harness configuration"]);
    expect(parsed.council.ran).toBe(false);
  });
});
