import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEvaluator, failureVerdict, loadRules, mergeRules, parseRules } from "../src/rules/index.js";
import type { RuleEvent } from "../src/rules/index.js";

const HOME = "/home/dev";
const config = mergeRules(loadRules({ JEV_CONFIG_DIR: "/nonexistent" }), parseRules("workRepo:\n  exclude:\n    - ~/projects/personal\n"));
const ev = () => createEvaluator(config);
const bash = (command: string, extra: Partial<RuleEvent> = {}): RuleEvent => ({ type: "tool", tool: "Bash", input: { command }, cwd: `${HOME}/projects/acme/app`, home: HOME, ...extra }) as RuleEvent;
const write = (file_path: string, content = "x", tool = "Write"): RuleEvent => ({ type: "tool", tool, input: { file_path, content, new_string: content }, cwd: `${HOME}/projects/acme/app`, home: HOME });
const decision = (event: RuleEvent) => ev().evaluate(event).decision;
const awsKey = `AKI${"A"}${"1234567890ABCDEF"}`;

describe("commit attribution", () => {
  test("blocks co-author in -m", () => expect(decision(bash("git commit -m \"feat: x\n\nCo-Authored-By: Someone <a@b.c>\""))).toBe("deny"));
  test("blocks generated-with in heredoc", () => expect(decision(bash("git commit -m \"$(cat <<EOF\nfix: y\n\nGenerated with a tool\nEOF\n)\""))).toBe("deny"));
  test("blocks co-author inside -F file", () => expect(decision(bash("git commit -F msg.txt", { files: { "msg.txt": "fix: z\n\nco-authored-by: A <a@b.c>" } } as Partial<RuleEvent>))).toBe("deny"));
  test("blocks with git global options", () => expect(decision(bash("git -C repo commit -m \"x\" -m \"Co-Authored-By: A\""))).toBe("deny"));
  test("allows a clean commit", () => expect(decision(bash("git commit -m \"feat: add rules\""))).toBe("allow"));
  test("ignores the phrase outside commits", () => expect(decision(bash("echo Co-Authored-By"))).toBe("allow"));
});

describe("rm -rf", () => {
  test("asks", () => expect(decision(bash("cd x && rm -rf build"))).toBe("ask"));
  test("asks on split flags", () => expect(decision(bash("rm -r -f build"))).toBe("ask"));
  test("allows plain rm", () => expect(decision(bash("rm build.log"))).toBe("allow"));
});

describe("git push", () => {
  test("asks on main", () => expect(decision(bash("git push origin main"))).toBe("ask"));
  test("asks on HEAD:master", () => expect(decision(bash("git push origin HEAD:master"))).toBe("ask"));
  test("asks on force", () => expect(decision(bash("git push -f origin feature/x"))).toBe("ask"));
  test("allows a feature branch", () => expect(decision(bash("git push -u origin feature/x"))).toBe("allow"));
});

describe("secrets", () => {
  test("denies a key in Write", () => expect(decision(write("/tmp/a.ts", `const k = "${awsKey}"`))).toBe("deny"));
  test("denies a key in Edit", () => expect(decision(write("/tmp/a.ts", `k = "${awsKey}"`, "Edit"))).toBe("deny"));
  test("denies a private key block", () => expect(decision(write("/tmp/a.txt", `-----BEGIN ${"RSA"} PRIVATE KEY-----`))).toBe("deny"));
  test("allows placeholders", () => expect(decision(write("/tmp/.env.example", "API_KEY=\"your-api-key-placeholder-value-here\""))).toBe("allow"));
  test("allows plain code", () => expect(decision(write("/tmp/a.ts", "const a = 1"))).toBe("allow"));
});

describe("work repo docs", () => {
  test("denies a new md in a work repo", () => expect(decision(write(`${HOME}/projects/acme/app/docs/plan.md`))).toBe("deny"));
  test("allows an edit of an existing md in a work repo", () => expect(decision(write("docs/plan.md", "x", "Edit"))).toBe("allow"));
  test("allows overwriting an existing md in a work repo", () => expect(decision({ ...write(`${HOME}/projects/acme/app/docs/plan.md`), isNew: false } as RuleEvent)).toBe("allow"));
  test("allows README.md", () => expect(decision(write(`${HOME}/projects/acme/app/README.md`))).toBe("allow"));
  test("allows md outside the roots", () => expect(decision(write(`${HOME}/notes/plan.md`))).toBe("allow"));
  test("allows md in an excluded personal repo", () => expect(decision(write(`${HOME}/projects/personal/tool/doc.md`))).toBe("allow"));
  test("allows code files in a work repo", () => expect(decision(write(`${HOME}/projects/acme/app/src/a.ts`))).toBe("allow"));
});

describe("generic file names", () => {
  test("warns on notes.md outside work repos", () => expect(decision(write(`${HOME}/scratch/notes.md`))).toBe("warn"));
  test("warns on temp.ts", () => expect(decision(write(`${HOME}/scratch/temp.ts`))).toBe("warn"));
  test("warns on entrega-final.md", () => expect(decision(write(`${HOME}/scratch/entrega-final.md`))).toBe("warn"));
  test("does not warn on an existing file", () => expect(decision({ ...write(`${HOME}/scratch/notes.md`), isNew: false } as RuleEvent)).toBe("allow"));
  test("allows a descriptive name", () => expect(decision(write(`${HOME}/scratch/invoice-parser.ts`))).toBe("allow"));
});

describe("skill reminder", () => {
  test("adds context once per session", () => {
    const e = ev();
    const first = e.evaluate({ type: "prompt", sessionId: "s1" });
    expect(first.decision === "allow" && first.context?.length).toBe(1);
    const second = e.evaluate({ type: "prompt", sessionId: "s1" });
    expect(second.decision === "allow" && second.context).toBeUndefined();
    const other = e.evaluate({ type: "prompt", sessionId: "s2" });
    expect(other.decision === "allow" && other.context?.length).toBe(1);
  });
});

describe("failures", () => {
  test("a commit-check error denies", () => {
    const e = createEvaluator(config);
    const bad = { type: "tool", tool: "Bash", input: { command: "git commit -m x" }, get files(): never { throw new Error("boom"); } } as unknown as RuleEvent;
    expect(e.evaluate(bad).decision).toBe("deny");
  });
  test("a non-secret rule error allows and logs", () => {
    const logs: string[] = [];
    const e = createEvaluator(config, m => logs.push(m));
    const bad = { type: "tool", tool: "Write", input: { file_path: 5, content: "x" }, cwd: "/x" } as unknown as RuleEvent;
    expect(e.evaluate(bad).decision).toBe("allow");
  });
});

describe("local config", () => {
  test("merge appends lists and overrides scalars", () => {
    const merged = mergeRules(parseRules("a:\n  - x\nb: one\n"), parseRules("a:\n  - y\nb: two\n"));
    expect(merged).toEqual({ a: ["x", "y"], b: "two" });
  });
});

describe("performance", () => {
  test("p95 under 1ms on 1000 events", () => {
    const e = ev();
    const events: RuleEvent[] = [];
    for (let i = 0; i < 1000; i++) {
      events.push(
        i % 4 === 0 ? bash(`git commit -m "feat: change ${i}"`) : i % 4 === 1 ? bash(`rm -rf build${i} && git push origin feature/${i}`) : i % 4 === 2 ? write(`${HOME}/projects/acme/app/src/f${i}.ts`, "const a = 1;\n".repeat(50)) : write(`${HOME}/projects/acme/app/docs/n${i}.md`),
      );
    }
    for (const event of events.slice(0, 50)) e.evaluate(event);
    const times = events.map(event => {
      const t = performance.now();
      e.evaluate(event);
      return performance.now() - t;
    });
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(1);
  });
});

describe("review regressions", () => {
  const commitMsg = "-m \"x\" -m \"Co-Authored-By: A <a@b.c>\"";
  test.each([
    `env -i git commit ${commitMsg}`,
    `env -u FOO FOO=1 git commit ${commitMsg}`,
    `sudo -u root git commit ${commitMsg}`,
    `nice -n 5 git commit ${commitMsg}`,
    `command git commit ${commitMsg}`,
    `time -p git commit ${commitMsg}`,
    `xargs -I{} git commit ${commitMsg}`,
    `FOO=bar git commit ${commitMsg}`,
    `git -c user.name=x commit ${commitMsg}`,
    `/usr/bin/git commit ${commitMsg}`,
    `bash -c 'git commit ${commitMsg}'`,
  ])("F2 blocks a wrapped commit: %s", command => expect(decision(bash(command))).toBe("deny"));

  test("F2 a commit file that could not be read is denied", () => {
    expect(decision(bash("git commit -F gone.txt", { unreadable: ["gone.txt"] } as Partial<RuleEvent>))).toBe("deny");
  });

  test.each(["/bin/rm -rf x", "/usr/bin/rm -fr x", "rm --recursive --force x", "rm -r -f x", "bash -c \"rm -rf x\"", "sh -c 'cd a && rm -rf b'", "zsh -c 'bash -c \"rm -rf x\"'", "sudo rm -rf x", "env -i rm -rf x"])(
    "F3 asks for %s",
    command => expect(decision(bash(command))).toBe("ask"),
  );
  test("F3 plain rm and rm -r stay allowed", () => {
    expect(decision(bash("rm -r build"))).toBe("allow");
    expect(decision(bash("bash -c 'rm file'"))).toBe("allow");
  });

  test("F4 an allowlisted first match does not hide a real key later", () => {
    const text = `a = "your-api-key-placeholder-value-here"\nk = "${awsKey}"`;
    expect(decision(write("/tmp/a.ts", text))).toBe("deny");
    expect(decision(write("/tmp/a.ts", `token = "${awsKey.toLowerCase()}"\nx = "${awsKey}"`))).toBe("deny");
  });

  test("F5 sk- inside prose is not a key and a real key is", () => {
    expect(decision(write("/tmp/a.md", `see risk-assessment-${"abcd".repeat(10)} for details`))).toBe("allow");
    expect(decision(write("/tmp/a.ts", `k = "sk-${"a1".repeat(20)}"`))).toBe("deny");
  });

  test("F6 NotebookEdit is covered", () => {
    const nb = (path: string, source: string): RuleEvent => ({ type: "tool", tool: "NotebookEdit", input: { notebook_path: path, new_source: source }, cwd: `${HOME}/projects/acme/app`, home: HOME });
    expect(decision(nb("/tmp/a.ipynb", `k = "${awsKey}"`))).toBe("deny");
    expect(decision(nb("/tmp/a.ipynb", "x = 1"))).toBe("allow");
  });
  test("F6 a real path inside a work repo denies even through a link", () => {
    const event = { ...write("/tmp/link.md"), realPaths: { "/tmp/link.md": `${HOME}/projects/acme/app/docs/real.md` } } as RuleEvent;
    expect(decision(event)).toBe("deny");
  });
  test("F6 .claude and personal are not work docs", () => {
    expect(decision(write(`${HOME}/projects/acme/app/.claude/skills/x/SKILL.md`))).toBe("allow");
    expect(decision(write(`${HOME}/projects/acme/app/.claude/agents/a.md`))).toBe("allow");
    const plain = createEvaluator(loadRules({ JEV_CONFIG_DIR: "/nonexistent" }));
    expect(plain.evaluate(write(`${HOME}/projects/personal/tool/doc.md`)).decision).toBe("allow");
  });

  test("F7 a bare push asks on a protected branch only", () => {
    expect(decision(bash("git push", { branch: "main" } as Partial<RuleEvent>))).toBe("ask");
    expect(decision(bash("git push origin", { branch: "master" } as Partial<RuleEvent>))).toBe("ask");
    expect(decision(bash("git push", { branch: "feature/x" } as Partial<RuleEvent>))).toBe("allow");
    expect(decision(bash("git push origin feature/x", { branch: "main" } as Partial<RuleEvent>))).toBe("allow");
  });

  test("F1 failure policy denies writes and commits, allows the rest", () => {
    expect(failureVerdict(write("/tmp/a.ts")).decision).toBe("deny");
    expect(failureVerdict({ type: "tool", tool: "NotebookEdit", input: {} }).decision).toBe("deny");
    expect(failureVerdict(bash("git commit -m x")).decision).toBe("deny");
    expect(failureVerdict(bash("ls")).decision).toBe("allow");
    expect(failureVerdict({ type: "prompt" }).decision).toBe("allow");
  });
  test("F1 an internal error on a write is denied by evaluate", () => {
    const e = createEvaluator(config);
    const bad = { type: "tool", tool: "Write", input: { file_path: "/tmp/a.ts", content: "x" }, get cwd(): never { throw new Error("boom"); } } as unknown as RuleEvent;
    expect(e.evaluate(bad).decision).toBe("deny");
  });
});

describe("plugin copy", () => {
  test("claude-plugin core and data are in sync with src and rules", () => {
    const root = join(import.meta.dir, "..");
    expect(readFileSync(join(root, "claude-plugin/hooks/rules-core.ts"), "utf8")).toBe(readFileSync(join(root, "src/rules/core.ts"), "utf8"));
    const data = readFileSync(join(root, "claude-plugin/hooks/rules-data.ts"), "utf8");
    expect(data).toBe(`export const DEFAULT_RULES = ${JSON.stringify(readFileSync(join(root, "rules/jev-rules.yml"), "utf8"))}\n`);
  });
});

describe("dynamic command position", () => {
  test.each(["$(echo rm) -rf /x", "R=rm; $R -rf /x", "`echo rm` -r -f /x", "${R} --recursive --force /x"])("N1 asks for %s", command => expect(decision(bash(command))).toBe("ask"));
  test("N1 dynamic commands without recursive force stay allowed", () => {
    expect(decision(bash("$(echo ls) -la /x"))).toBe("allow");
    expect(decision(bash("$R -r /x"))).toBe("allow");
  });
});
