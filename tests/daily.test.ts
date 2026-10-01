import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { lastMeaningfulLine, redactSecrets } from "../src/herdr/pane-text.js";
import {
  buildDailyReport,
  formatDailyMarkdown,
  formatDailyText,
  writeDailyMarkdown,
} from "../src/herdr/daily.js";
import type { GitRunner } from "../src/herdr/agents.js";
import type { RunHistoryEntry } from "../src/orchestration/run-history.js";

test("lastMeaningfulLine filters terminal chrome and leaves only the Ran python3 line from real Codex tail", () => {
  const codexTail = [
    "pane title: Investigar lentidão",
    "• Ran python3 /tmp/imp-benchmark225/collect_case.py 9",
    "for agents · ? for shortcuts 4 warnings · f2 to view",
    "› Ask Codex to do anything",
    "GPT-6.1-Sol low · ~/projects/italents/impmotordados",
  ].join("\n");

  const result = lastMeaningfulLine(codexTail);
  expect(result).toBe("Ran python3 /tmp/imp-benchmark225/collect_case.py 9");
  expect(result).not.toContain("Investigar lentidão");
  expect(result).not.toContain("shortcuts");
  expect(result).not.toContain("Ask Codex");
  expect(result).not.toContain("GPT-6.1-Sol");
});

test("lastMeaningfulLine drops spinner rows, box-drawing, and truncates to 100 characters", () => {
  const textWithChrome = [
    "│ spinner │",
    "┌────────────────────────────────┐",
    "│ meaningful output line here   │",
    "└────────────────────────────────┘",
    "› ",
  ].join("\n");

  expect(lastMeaningfulLine(textWithChrome)).toBe("meaningful output line here");

  const veryLongLine = "a".repeat(150);
  const truncated = lastMeaningfulLine(veryLongLine);
  expect(truncated.length).toBe(100);
  expect(truncated).toBe("a".repeat(100));

  expect(lastMeaningfulLine("")).toBe("");
  expect(lastMeaningfulLine("   \n\n  ")).toBe("");
});

test("redactSecrets masks credentials including sk, ghp, xoxb, bearer, long hex, base64, and key-value pairs", () => {
  const sample = [
    "sk-proj-1234567890abcdef1234567890",
    "ghp_123456789012345678901234567890",
    "xoxb-1234-5678-abcdef",
    "Authorization: Bearer secret-token-value-here-12345",
    "password=supersecretpassword123",
    "my_api_key='secret-api-key'",
    "TOKEN=\"some-secret-token\"",
    "auth_secret=vault-secret",
    "hex token: 4a8f9b2c3d4e5f6a7b8c9d0e",
    "base64 token: dGhpcyBpcyBhIHZlcnkgc2VjcmV0IHRva2Vu",
  ].join("\n");

  const redacted = redactSecrets(sample);

  expect(redacted).not.toContain("sk-proj-1234567890abcdef1234567890");
  expect(redacted).not.toContain("ghp_123456789012345678901234567890");
  expect(redacted).not.toContain("xoxb-1234-5678-abcdef");
  expect(redacted).not.toContain("secret-token-value-here-12345");
  expect(redacted).not.toContain("supersecretpassword123");
  expect(redacted).not.toContain("secret-api-key");
  expect(redacted).not.toContain("some-secret-token");
  expect(redacted).not.toContain("vault-secret");
  expect(redacted).not.toContain("4a8f9b2c3d4e5f6a7b8c9d0e");
  expect(redacted).not.toContain("dGhpcyBpcyBhIHZlcnkgc2VjcmV0IHRva2Vu");

  expect(redacted).toContain("Bearer [REDACTED]");
  expect(redacted).toContain("password=[REDACTED]");
  expect(redacted).toContain("my_api_key='[REDACTED]'");
  expect(redacted).toContain("TOKEN=\"[REDACTED]\"");
  expect(redacted).toContain("auth_secret=[REDACTED]");
});

test("buildDailyReport collects overview, git, run history, and pane reader output", async () => {
  const fixedNow = new Date("2026-10-01T15:00:00Z").getTime();

  const overview = [
    {
      project: "proj-alpha",
      pane: "pane-1",
      agent: "codex",
      model: "gpt-6.1-sol",
      state: "working",
      handle: "jev-impl-1",
      cwd: "/repos/proj-alpha",
      branch: "feat/daily",
    },
    {
      project: "proj-alpha",
      pane: "pane-2",
      agent: "claude",
      model: "claude-sonnet-5",
      state: "idle",
      handle: "jev-idle-1",
      cwd: "/repos/proj-alpha",
      branch: "feat/daily",
    },
    {
      project: "proj-beta",
      pane: "pane-3",
      agent: "antigravity",
      model: "gemini-3.8-flash",
      state: "blocked",
      handle: "jev-rev-1",
      cwd: "/repos/proj-beta",
      branch: "main",
    },
  ];

  const fakeGit: GitRunner = async (args, cwd) => {
    if (args[0] === "log") {
      if (cwd === "/repos/proj-alpha") {
        return { ok: true, stdout: "feat: add daily report\nfix: handle secrets\nrefactor: cleanup\nchore: bump deps\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "status") {
      if (cwd === "/repos/proj-alpha") {
        return { ok: true, stdout: " M src/herdr/daily.ts\n?? tests/daily.test.ts\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse") {
      if (cwd === "/repos/proj-alpha") return { ok: true, stdout: "feat/daily\n", stderr: "" };
      if (cwd === "/repos/proj-beta") return { ok: true, stdout: "main\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const runs: RunHistoryEntry[] = [
    {
      id: "run-alpha",
      timestampMs: fixedNow - 30_000,
      mtimeMs: fixedNow - 30_000,
      projection: {
        agent: "jev-impl-1",
        tasks: [{ id: "implementer", state: "working" }],
      },
    },
  ];

  const readPane = async (paneId: string) => {
    if (paneId === "pane-1") {
      return "• Ran bun test tests/daily.test.ts\n› Ask Codex to do anything";
    }
    if (paneId === "pane-3") {
      return "Waiting for user input: password=hunter2";
    }
    return "";
  };

  const report = await buildDailyReport(
    {
      overview,
      git: fakeGit,
      runs,
      readPane,
      now: fixedNow,
    },
    {
      now: fixedNow,
    },
  );

  expect(report.projects.length).toBe(2);

  const alphaGroup = report.projects.find((p) => p.project === "proj-alpha");
  expect(alphaGroup).toBeDefined();
  expect(alphaGroup?.branch).toBe("feat/daily");
  expect(alphaGroup?.agents.length).toBe(2);

  const impl = alphaGroup?.agents.find((a) => a.handle === "jev-impl-1");
  expect(impl).toBeDefined();
  expect(impl?.commitsCount).toBe(4);
  expect(impl?.commitSubjects).toEqual(["feat: add daily report", "fix: handle secrets", "refactor: cleanup"]);
  expect(impl?.uncommittedCount).toBe(2);
  expect(impl?.runSummary).toBe("implementer:working");
  expect(impl?.lastLine).toBe("Ran bun test tests/daily.test.ts");

  const betaGroup = report.projects.find((p) => p.project === "proj-beta");
  expect(betaGroup).toBeDefined();
  const rev = betaGroup?.agents.find((a) => a.handle === "jev-rev-1");
  expect(rev?.lastLine).toBe("Waiting for user input: password=[REDACTED]");
});

test("formatDailyMarkdown formats in Brazilian Portuguese, omits empty fields, collapses inactive agents, and asserts no emoji and no en/em dashes", async () => {
  const fixedNow = new Date("2026-10-01T15:00:00Z").getTime();

  const overview = [
    {
      project: "herdr-jev",
      pane: "pane-active",
      agent: "codex",
      model: "gpt-6.1-sol",
      state: "working",
      handle: "codex-active",
      cwd: "/repos/herdr-jev",
      branch: "feat/daily",
    },
    {
      project: "herdr-jev",
      pane: "pane-idle-1",
      agent: "claude",
      model: "opus-5",
      state: "idle",
      handle: "claude-idle",
      cwd: "/repos/herdr-jev-idle-1",
      branch: "feat/daily",
    },
    {
      project: "herdr-jev",
      pane: "pane-idle-2",
      agent: "antigravity",
      model: "gemini-3.8-flash",
      state: "idle",
      handle: "agy-idle",
      cwd: "/repos/herdr-jev-idle-2",
      branch: "feat/daily",
    },
  ];

  const fakeGit: GitRunner = async (args, cwd) => {
    if (cwd === "/repos/herdr-jev") {
      if (args[0] === "log") return { ok: true, stdout: "feat: add daily summary\nfix: sanitize text – detail\n", stderr: "" };
      if (args[0] === "status") return { ok: true, stdout: " M file.ts\n", stderr: "" };
      if (args[0] === "rev-parse") return { ok: true, stdout: "feat/daily\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const runs: RunHistoryEntry[] = [
    {
      id: "run-1",
      timestampMs: fixedNow - 1000,
      mtimeMs: fixedNow - 1000,
      projection: {
        agent: "codex-active",
        tasks: [{ id: "implementer", state: "working" }],
      },
    },
  ];

  const readPane = async (paneId: string) => {
    if (paneId === "pane-active") return "Ran bun test";
    return "";
  };

  const report = await buildDailyReport(
    {
      overview,
      git: fakeGit,
      runs,
      readPane,
      now: fixedNow,
    },
    {
      now: fixedNow,
    },
  );

  const markdown = formatDailyMarkdown(report);
  const text = formatDailyText(report);

  expect(markdown).toMatch(/^Resumo do dia \d{2}\/\d{2}\/\d{4}/);
  expect(markdown).toContain("### herdr-jev (feat/daily)");
  expect(markdown).toContain("- codex-active gpt-6.1-sol: working; 2 commits hoje (feat: add daily summary; fix: sanitize text - detail); 1 arquivo não commitado; run: implementer:working; último: Ran bun test");
  expect(markdown).toContain("Sem atividade: claude-idle, agy-idle");

  const enDashRegex = /\u2013/;
  const emDashRegex = /\u2014/;
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}]/u;

  expect(enDashRegex.test(markdown)).toBe(false);
  expect(emDashRegex.test(markdown)).toBe(false);
  expect(emojiRegex.test(markdown)).toBe(false);

  expect(enDashRegex.test(text)).toBe(false);
  expect(emDashRegex.test(text)).toBe(false);
  expect(emojiRegex.test(text)).toBe(false);

  expect(text).toContain("herdr-jev (feat/daily)");
  expect(text).toContain("codex-active");
  expect(text).toContain("Sem atividade: claude-idle, agy-idle");
});

test("writeDailyMarkdown saves Markdown to <stateDir>/daily/YYYY-MM-DD.md and returns the path", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "herdr-jev-daily-state-"));
  try {
    const fixedNow = new Date("2026-10-01T12:00:00Z").getTime();
    const report = {
      date: new Date(fixedNow),
      projects: [
        {
          project: "test-proj",
          branch: "main",
          agents: [
            {
              project: "test-proj",
              agent: "codex",
              handle: "worker-1",
              model: "gpt-6.1-sol",
              state: "idle",
              branch: "main",
              cwd: "/test",
              commitsCount: 0,
              commitSubjects: [],
              uncommittedCount: 0,
              runSummary: null,
              lastLine: null,
              paneId: "p1",
            },
          ],
        },
      ],
    };

    const savedPath = writeDailyMarkdown(report, tempDir);
    expect(savedPath).toBe(join(tempDir, "daily", "2026-10-01.md"));

    const content = readFileSync(savedPath, "utf8");
    expect(content).toContain("Resumo do dia 01/10/2026");
    expect(content).toContain("### test-proj (main)");
    expect(content).toContain("Sem atividade: worker-1");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI daily works when run with no caller pane (HERDR_PANE_ID unset)", () => {
  const cliScript = resolve(import.meta.dir, "../src/cli.ts");
  const tempState = mkdtempSync(join(tmpdir(), "herdr-jev-cli-daily-"));
  const fakeHerdr = join(tmpdir(), `fake-herdr-${Date.now()}.mjs`);
  writeFileSync(
    fakeHerdr,
    `#!/usr/bin/env node
if (process.argv.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ result: { snapshot: {
    workspaces: [{ workspace_id: "w1", label: "my-cli-project" }],
    agents: [{ workspace_id: "w1", pane_id: "p1", cwd: process.cwd(), agent: "codex", agent_status: "idle", tokens: { quota_model: "gpt-6.1-sol" } }]
  } } }));
  process.exit(0);
}
if (process.argv.includes("read")) {
  process.stdout.write("meaningful pane line\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(fakeHerdr, 0o755);

  try {
    const env = {
      ...process.env,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_JEV_STATE_DIR: tempState,
    };
    delete env.HERDR_PANE_ID;

    const resJson = spawnSync("bun", ["run", cliScript, "daily", "--json"], { env, encoding: "utf8" });
    expect(resJson.status).toBe(0);
    const parsed = JSON.parse(resJson.stdout);
    expect(parsed.projects).toBeDefined();

    const resMd = spawnSync("bun", ["run", cliScript, "daily", "--md"], { env, encoding: "utf8" });
    expect(resMd.status).toBe(0);
    expect(resMd.stdout).toContain("Resumo do dia");

    const resWrite = spawnSync("bun", ["run", cliScript, "daily", "--write"], { env, encoding: "utf8" });
    expect(resWrite.status).toBe(0);
    const writtenPath = resWrite.stdout.trim().split("\n")[0];
    expect(existsSync(writtenPath)).toBe(true);
  } finally {
    try { unlinkSync(fakeHerdr); } catch {}
    rmSync(tempState, { recursive: true, force: true });
  }
});
