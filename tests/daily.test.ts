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
import { resolveStateDir } from "../src/herdr/state-dir.js";
import { resolveStandupEnvironment } from "../src/herdr/standup.js";

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

test("lastMeaningfulLine drops all real chrome lines seen today, braille spinners, status bar glyphs, hints, and report lines", () => {
  expect(lastMeaningfulLine("└ Tip: Use /subagents to switch between this session’s subagents.")).toBe("");
  expect(lastMeaningfulLine("⏵ bypass permissions on - 2 shells - ← 2 agents")).toBe("");
  expect(lastMeaningfulLine("⣯  Running command...")).toBe("");
  expect(lastMeaningfulLine("⏱ 7d ↑47%")).toBe("");
  expect(lastMeaningfulLine(" Update installed - Restart to update")).toBe("");
  expect(lastMeaningfulLine("Worked for 39m 13s - 15:48")).toBe("");
  expect(lastMeaningfulLine("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")).toBe("");
  expect(lastMeaningfulLine("⏱ 1h 20m ↑")).toBe("");
  expect(lastMeaningfulLine("⚡ status info ⚙")).toBe("");
  expect(lastMeaningfulLine("expand)")).toBe("");
  expect(lastMeaningfulLine("(ctrl+o to expand)")).toBe("");
  expect(lastMeaningfulLine("Sem atividade: codex, claude")).toBe("");
  expect(lastMeaningfulLine("Resumo do dia 01/10/2026")).toBe("");
});

test("lastMeaningfulLine prefers the last line starting with an action bullet with the bullet stripped", () => {
  const codexLines = [
    "• Ran python3 first.py",
    "Intermediate status message",
    "• Ran python3 second.py",
    "Finished execution with exit 0",
  ].join("\n");
  expect(lastMeaningfulLine(codexLines)).toBe("Ran python3 second.py");

  const claudeLines = [
    "● Read file src/index.ts",
    "Reading completed",
    "● Edit file src/herdr/daily.ts",
    "File written to disk",
  ].join("\n");
  expect(lastMeaningfulLine(claudeLines)).toBe("Edit file src/herdr/daily.ts");

  const fallbackLines = [
    "Building container image",
    "Container image built successfully",
  ].join("\n");
  expect(lastMeaningfulLine(fallbackLines)).toBe("Container image built successfully");
});

test("redactSecrets preserves file paths and masks long credentials with 32+ chars, prefixed tokens, and key-value pairs", () => {
  const livePath = "Ran /home/martil/projects/italents/impmotordados/motor-ingestao/.venv/bin/python /home/martil/projec";
  expect(redactSecrets(livePath)).toBe(livePath);

  const sample = [
    "sk-proj-1234567890abcdef1234567890",
    "ghp_123456789012345678901234567890",
    "xoxb-1234-5678-abcdef",
    "Authorization: Bearer secret-token-value-here-12345",
    "password=supersecretpassword123",
    "my_api_key='secret-api-key'",
    "TOKEN=\"some-secret-token\"",
    "auth_secret=vault-secret",
    "hex token: 4a8f9b2c3d4e5f6a7b8c9d0e1f2a3b4c",
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
  expect(redacted).not.toContain("4a8f9b2c3d4e5f6a7b8c9d0e1f2a3b4c");
  expect(redacted).not.toContain("dGhpcyBpcyBhIHZlcnkgc2VjcmV0IHRva2Vu");

  expect(redacted).toContain("Bearer [REDACTED]");
  expect(redacted).toContain("password=[REDACTED]");
  expect(redacted).toContain("my_api_key='[REDACTED]'");
  expect(redacted).toContain("TOKEN=\"[REDACTED]\"");
  expect(redacted).toContain("auth_secret=[REDACTED]");
  expect(redacted).toContain("hex token: [REDACTED]");
  expect(redacted).toContain("base64 token: [REDACTED]");
});

test("buildDailyReport resolves repository from main worktree git-common-dir, respects default branch commit exclusion, and extracts tarefa", async () => {
  const fixedNow = new Date("2026-10-01T15:00:00Z").getTime();

  const overview = [
    {
      project: "workspace-alpha",
      pane: "pane-1",
      agent: "codex",
      model: "gpt-6.1-sol",
      state: "working",
      handle: "jev-impl-1",
      cwd: "/repos/proj-alpha-worktree",
      branch: "feat/daily",
    },
    {
      project: "workspace-alpha",
      pane: "pane-2",
      agent: "claude",
      model: "claude-sonnet-5",
      state: "idle",
      handle: "jev-idle-1",
      cwd: "/repos/proj-alpha-worktree",
      branch: "feat/daily",
    },
    {
      project: "workspace-beta",
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
    if (args.includes("--git-common-dir")) {
      if (cwd === "/repos/proj-alpha-worktree") return { ok: true, stdout: "/repos/proj-alpha/.git\n", stderr: "" };
      if (cwd === "/repos/proj-beta") return { ok: true, stdout: "/repos/proj-beta/.git\n", stderr: "" };
      return { ok: false, stdout: "", stderr: "not git" };
    }
    if (args.includes("--abbrev-ref")) {
      if (cwd === "/repos/proj-alpha-worktree") return { ok: true, stdout: "feat/daily\n", stderr: "" };
      if (cwd === "/repos/proj-beta") return { ok: true, stdout: "main\n", stderr: "" };
      return { ok: true, stdout: "main\n", stderr: "" };
    }
    if (args.includes("symbolic-ref")) {
      return { ok: true, stdout: "origin/main\n", stderr: "" };
    }
    if (args[0] === "log") {
      if (args[1] === "main..HEAD" && cwd === "/repos/proj-alpha-worktree") {
        return { ok: true, stdout: "feat: add daily report\nfix: handle secrets\nrefactor: cleanup\n", stderr: "" };
      }
      if (cwd === "/repos/proj-beta") {
        return { ok: true, stdout: "chore: update beta\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "status") {
      if (cwd === "/repos/proj-alpha-worktree") {
        return { ok: true, stdout: " M src/herdr/daily.ts\n?? tests/daily.test.ts\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
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

  const paneList = [
    {
      pane_id: "pane-1",
      terminal_title_stripped: "Resumir correções dos filtros | InvoiceConAPI",
      label: "codex › Resumir",
    },
    {
      pane_id: "pane-2",
      terminal_title_stripped: "agy --model gemini-3.1-pro-high",
      label: "agy",
    },
  ];

  const report = await buildDailyReport(
    {
      overview,
      git: fakeGit,
      runs,
      readPane,
      paneList,
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
  expect(alphaGroup?.commitsCount).toBe(3);
  expect(alphaGroup?.uncommittedCount).toBe(2);
  expect(alphaGroup?.agents.length).toBe(2);

  const impl = alphaGroup?.agents.find((a) => a.handle === "jev-impl-1");
  expect(impl).toBeDefined();
  expect(impl?.tarefa).toBe("Resumir correções dos filtros | InvoiceConAPI");
  expect(impl?.commitsCount).toBe(3);
  expect(impl?.commitSubjects).toEqual(["feat: add daily report", "fix: handle secrets", "refactor: cleanup"]);
  expect(impl?.uncommittedCount).toBe(2);
  expect(impl?.runSummary).toBe("implementer:working");
  expect(impl?.lastLine).toBe("Ran bun test tests/daily.test.ts");

  const idleAgent = alphaGroup?.agents.find((a) => a.handle === "jev-idle-1");
  expect(idleAgent?.tarefa).toBeNull();

  const betaGroup = report.projects.find((p) => p.project === "proj-beta");
  expect(betaGroup).toBeDefined();
  const rev = betaGroup?.agents.find((a) => a.handle === "jev-rev-1");
  expect(rev?.lastLine).toBe("Waiting for user input: password=[REDACTED]");
});

test("formatDailyMarkdown formats in Brazilian Portuguese, prints repo facts under heading, omits empty fields, collapses inactive agents, and asserts no emoji and no en/em dashes", async () => {
  const fixedNow = new Date("2026-10-01T15:00:00Z").getTime();

  const overview = [
    {
      project: "workspace-label",
      pane: "pane-active",
      agent: "codex",
      model: "gpt-6.1-sol",
      state: "working",
      handle: "codex-active",
      cwd: "/repos/herdr-jev-wt",
      branch: "feat/daily",
    },
    {
      project: "workspace-label",
      pane: "pane-idle-1",
      agent: "claude",
      model: "opus-5",
      state: "idle",
      handle: "claude-idle",
      cwd: "/repos/herdr-jev-wt",
      branch: "feat/daily",
    },
    {
      project: "workspace-label",
      pane: "pane-done-2",
      agent: "antigravity",
      model: "gemini-3.8-flash",
      state: "done",
      handle: "agy-done",
      cwd: "/repos/herdr-jev-wt",
      branch: "feat/daily",
    },
  ];

  const fakeGit: GitRunner = async (args, cwd) => {
    if (args.includes("--git-common-dir")) {
      return { ok: true, stdout: "/repos/herdr-jev/.git\n", stderr: "" };
    }
    if (args.includes("--abbrev-ref")) {
      return { ok: true, stdout: "feat/daily\n", stderr: "" };
    }
    if (args.includes("symbolic-ref")) {
      return { ok: true, stdout: "origin/main\n", stderr: "" };
    }
    if (args[0] === "log") {
      return { ok: true, stdout: "feat: add daily summary\nfix: sanitize text – detail\n", stderr: "" };
    }
    if (args[0] === "status") {
      return { ok: true, stdout: " M file.ts\n", stderr: "" };
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

  const paneList = [
    {
      pane_id: "pane-active",
      terminal_title_stripped: "Resumo do card",
    },
  ];

  const readPane = async (paneId: string) => {
    if (paneId === "pane-active") return "• Ran bun test";
    return "";
  };

  const report = await buildDailyReport(
    {
      overview,
      git: fakeGit,
      runs,
      readPane,
      paneList,
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
  expect(markdown).toContain("2 commits hoje (feat: add daily summary; fix: sanitize text - detail); 1 arquivo não commitado");
  expect(markdown).toContain("- codex-active [Resumo do card] gpt-6.1-sol: working; run: implementer:working; último: Ran bun test");
  expect(markdown).not.toContain("418 arquivos não commitados");

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
  expect(text).toContain("2 commits hoje (feat: add daily summary; fix: sanitize text - detail); 1 arquivo não commitado");
  expect(text).toContain("TASK");
  expect(text).not.toContain("COMMITS");
  expect(text).not.toContain("CHANGES");
  expect(text).toContain("Resumo do card");
  expect(text).toContain("codex-active");
});

test("formatDailyMarkdown collapses idle and done agents with no run and no branch commits into Sem atividade", () => {
  const report = {
    date: new Date("2026-10-01T12:00:00Z"),
    projects: [
      {
        project: "test-repo",
        branch: "main",
        commitsCount: 0,
        commitSubjects: [],
        uncommittedCount: 12,
        agents: [
          {
            project: "test-repo",
            agent: "codex",
            handle: "worker-idle",
            model: "gpt-6.1-sol",
            state: "idle",
            branch: "main",
            cwd: "/test",
            commitsCount: 0,
            commitSubjects: [],
            uncommittedCount: 12,
            runSummary: null,
            lastLine: null,
            paneId: "p1",
            tarefa: null,
          },
          {
            project: "test-repo",
            agent: "claude",
            handle: "worker-done",
            model: "sonnet-5",
            state: "done",
            branch: "main",
            cwd: "/test",
            commitsCount: 0,
            commitSubjects: [],
            uncommittedCount: 12,
            runSummary: null,
            lastLine: null,
            paneId: "p2",
            tarefa: null,
          },
        ],
      },
    ],
  };

  const md = formatDailyMarkdown(report);
  expect(md).toContain("### test-repo (main)");
  expect(md).toContain("12 arquivos não commitados");
  expect(md).toContain("Sem atividade: worker-idle, worker-done");
  expect(md).not.toContain("- worker-idle");
  expect(md).not.toContain("- worker-done");

  const text = formatDailyText(report);
  expect(text).toContain("12 arquivos não commitados");
  expect(text).toContain("Sem atividade: worker-idle, worker-done");
});

test("formatDailyText truncates long cells with ellipsis and 34-character task column", () => {
  const report = {
    date: new Date("2026-10-01T12:00:00Z"),
    projects: [
      {
        project: "long-name-project",
        branch: "feature-branch",
        commitsCount: 1,
        commitSubjects: ["chore: update"],
        uncommittedCount: 0,
        agents: [
          {
            project: "long-name-project",
            agent: "antigravity",
            handle: "super-long-handle-name",
            model: "Gemini 3.8 Flash",
            state: "working",
            branch: "feature-branch",
            cwd: "/repos/long",
            commitsCount: 1,
            commitSubjects: ["chore: update"],
            uncommittedCount: 0,
            runSummary: "implementer:working",
            lastLine: "Running build step",
            paneId: "p1",
            tarefa: "Very long task description exceeding thirty-four characters",
          },
        ],
      },
    ],
  };

  const text = formatDailyText(report);
  expect(text).toContain("TASK");
  expect(text).not.toContain("COMMITS");
  expect(text).not.toContain("CHANGES");
  expect(text).toContain("super-lon...");
  expect(text).toContain("Very long task description exce...");
  expect(text).toContain("Gemini 3....");
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
          commitsCount: 0,
          commitSubjects: [],
          uncommittedCount: 0,
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

test("CLI daily works when run with no caller pane (HERDR_PANE_ID unset) and --write prints saved path as last line", () => {
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
if (process.argv.includes("list")) {
  process.stdout.write(JSON.stringify({ panes: [{ pane_id: "p1", terminal_title_stripped: "my task" }], type: "pane_list" }));
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
    const lines = resWrite.stdout.trim().split("\n");
    const writtenPath = lines[lines.length - 1];
    expect(existsSync(writtenPath)).toBe(true);
    expect(writtenPath).toContain(tempState);

    const resMdWrite = spawnSync("bun", ["run", cliScript, "daily", "--md", "--write"], { env, encoding: "utf8" });
    expect(resMdWrite.status).toBe(0);
    const mdWriteLines = resMdWrite.stdout.trim().split("\n");
    const lastLine = mdWriteLines[mdWriteLines.length - 1];
    expect(existsSync(lastLine)).toBe(true);
    expect(mdWriteLines[0]).toContain("Resumo do dia");
    const resPlain = spawnSync("bun", ["run", cliScript, "daily", "--plain"], { env, encoding: "utf8" });
    expect(resPlain.status).toBe(0);
    expect(resPlain.stdout).not.toContain("Resumo do dia");
    expect(resPlain.stdout).toContain("### ");

    const resProj = spawnSync("bun", ["run", cliScript, "daily", "--project", "my-cli-project", "--json"], { env, encoding: "utf8" });
    expect(resProj.status).toBe(0);
    const parsedProj = JSON.parse(resProj.stdout);
    expect(parsedProj.projects.length).toBe(1);

    const resProjNone = spawnSync("bun", ["run", cliScript, "daily", "--project", "non-existent-project", "--json"], { env, encoding: "utf8" });
    expect(resProjNone.status).toBe(0);
    const parsedProjNone = JSON.parse(resProjNone.stdout);
    expect(parsedProjNone.projects.length).toBe(0);
  } finally {
    try { unlinkSync(fakeHerdr); } catch {}
    rmSync(tempState, { recursive: true, force: true });
  }
});

test("buildDailyReport filters by projects matching repository name or workspace label case-insensitively", async () => {
  const fixedNow = new Date("2026-10-01T15:00:00Z").getTime();
  const overview = [
    {
      project: "Workspace-Alpha",
      pane: "pane-1",
      agent: "codex",
      state: "idle",
      cwd: "/repos/proj-alpha",
      branch: "main",
    },
    {
      project: "Workspace-Beta",
      pane: "pane-2",
      agent: "claude",
      state: "working",
      cwd: "/repos/proj-beta",
      branch: "main",
    },
  ];

  const fakeGit: GitRunner = async (args, cwd) => {
    if (args.includes("--git-common-dir")) {
      if (cwd === "/repos/proj-alpha") return { ok: true, stdout: "/repos/alpha-repo/.git\n", stderr: "" };
      if (cwd === "/repos/proj-beta") return { ok: true, stdout: "/repos/beta-repo/.git\n", stderr: "" };
    }
    return { ok: true, stdout: "main\n", stderr: "" };
  };

  const reportAlphaRepo = await buildDailyReport(
    { overview, git: fakeGit, now: fixedNow, readPane: async () => "", paneList: [] },
    { now: fixedNow, projects: ["ALPHA-REPO"] },
  );
  expect(reportAlphaRepo.projects.length).toBe(1);
  expect(reportAlphaRepo.projects[0].project).toBe("alpha-repo");

  const reportBetaWorkspace = await buildDailyReport(
    { overview, git: fakeGit, now: fixedNow, readPane: async () => "", paneList: [] },
    { now: fixedNow, projects: ["workspace-beta"] },
  );
  expect(reportBetaWorkspace.projects.length).toBe(1);
  expect(reportBetaWorkspace.projects[0].project).toBe("beta-repo");

  const reportBoth = await buildDailyReport(
    { overview, git: fakeGit, now: fixedNow, readPane: async () => "", paneList: [] },
    { now: fixedNow, projects: ["ALPHA-REPO", "beta-repo"] },
  );
  expect(reportBoth.projects.length).toBe(2);

  const reportNone = await buildDailyReport(
    { overview, git: fakeGit, now: fixedNow, readPane: async () => "", paneList: [] },
    { now: fixedNow, projects: ["gamma-repo"] },
  );
  expect(reportNone.projects.length).toBe(0);
});

test("formatDailyMarkdown and formatDailyText display N agentes no mesmo checkout after uncommitted count", () => {
  const report = {
    date: new Date("2026-10-01T12:00:00Z"),
    projects: [
      {
        project: "repo-colliding",
        branch: "main",
        commitsCount: 1,
        commitSubjects: ["fix: something"],
        uncommittedCount: 3,
        agents: [
          {
            project: "repo-colliding",
            agent: "codex",
            handle: "agent-1",
            model: "gpt-6.1-sol",
            state: "working",
            branch: "main",
            cwd: "/repos/same-checkout",
            commitsCount: 1,
            commitSubjects: ["fix: something"],
            uncommittedCount: 3,
            runSummary: null,
            lastLine: "Running tests",
            paneId: "p1",
          },
          {
            project: "repo-colliding",
            agent: "claude",
            handle: "agent-2",
            model: "sonnet-5",
            state: "working",
            branch: "main",
            cwd: "/repos/same-checkout",
            commitsCount: 1,
            commitSubjects: ["fix: something"],
            uncommittedCount: 3,
            runSummary: null,
            lastLine: "Writing files",
            paneId: "p2",
          },
        ],
      },
      {
        project: "repo-isolated",
        branch: "feat/distinct",
        commitsCount: 0,
        commitSubjects: [],
        uncommittedCount: 2,
        agents: [
          {
            project: "repo-isolated",
            agent: "antigravity",
            handle: "agent-3",
            model: "flash",
            state: "working",
            branch: "feat/distinct",
            cwd: "/repos/wt-distinct",
            commitsCount: 0,
            commitSubjects: [],
            uncommittedCount: 2,
            runSummary: null,
            lastLine: null,
            paneId: "p3",
          },
        ],
      },
    ],
  };

  const md = formatDailyMarkdown(report);
  expect(md).toContain("1 commit hoje (fix: something); 3 arquivos não commitados; 2 agentes no mesmo checkout");
  expect(md).toContain("2 arquivos não commitados");
  expect(md).not.toContain("repo-isolated\n2 arquivos não commitados; 2 agentes");

  const text = formatDailyText(report);
  expect(text).toContain("1 commit hoje (fix: something); 3 arquivos não commitados; 2 agentes no mesmo checkout");
  expect(text).toContain("2 arquivos não commitados");
  expect(text).not.toContain("repo-isolated\n  2 arquivos não commitados; 2 agentes");
});

test("formatDailyMarkdown with plain option omits Resumo do dia header", () => {
  const report = {
    date: new Date("2026-10-01T12:00:00Z"),
    projects: [
      {
        project: "test-repo",
        branch: "main",
        commitsCount: 0,
        commitSubjects: [],
        uncommittedCount: 1,
        agents: [
          {
            project: "test-repo",
            agent: "codex",
            handle: "worker",
            model: "gpt-6.1-sol",
            state: "working",
            branch: "main",
            cwd: "/repos/test",
            commitsCount: 0,
            commitSubjects: [],
            uncommittedCount: 1,
            runSummary: null,
            lastLine: "building",
            paneId: "p1",
          },
        ],
      },
    ],
  };

  const mdFull = formatDailyMarkdown(report);
  expect(mdFull).toMatch(/^Resumo do dia \d{2}\/\d{2}\/\d{4}/);
  expect(mdFull).toContain("### test-repo (main)");

  const mdPlain = formatDailyMarkdown(report, { plain: true });
  expect(mdPlain).not.toContain("Resumo do dia");
  expect(mdPlain).toMatch(/^### test-repo \(main\)/);

  const mdPlainBool = formatDailyMarkdown(report, true);
  expect(mdPlainBool).not.toContain("Resumo do dia");
  expect(mdPlainBool).toMatch(/^### test-repo \(main\)/);
});

test("Finding 6: tarefa strips control characters and redacts secrets in daily report, text, and markdown", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "finding-6-daily-"));
  try {
    const fixedNow = new Date("2026-10-01T12:00:00Z").getTime();
    const overview = [
      {
        pane: "w1:p1",
        workspace_id: "w1",
        pane_id: "w1:p1",
        agent: "codex",
        handle: "worker-1",
        agent_status: "idle",
        cwd: "/repos/proj-secret",
        model: "gpt-6.1-sol",
      },
    ];

    const fakeGit: GitRunner = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repos/proj-secret";
      if (args[0] === "branch" && args[1] === "--show-current") return "main";
      if (args[0] === "status") return "";
      if (args[0] === "log") return "";
      return "";
    };

    const paneList = [
      {
        pane_id: "w1:p1",
        terminal_title_stripped: "Task \x00\x1b\x07with password=supersecretpassword123 and \"token\": \"my-secret-token\"",
      },
    ];

    const report = await buildDailyReport(
      {
        overview,
        git: fakeGit,
        runs: [],
        readPane: async () => "",
        paneList,
        now: fixedNow,
      },
      {
        now: fixedNow,
      },
    );

    const agent = report.projects[0]?.agents[0];
    expect(agent).toBeDefined();
    expect(agent?.tarefa).toBeDefined();
    expect(agent?.tarefa).not.toContain("supersecretpassword123");
    expect(agent?.tarefa).not.toContain("my-secret-token");
    expect(/[\x00-\x1F\x7F]/.test(agent!.tarefa!)).toBe(false);
    expect(agent?.tarefa).toContain("password=[REDACTED]");
    expect(agent?.tarefa).toContain('"token": "[REDACTED]"');

    const text = formatDailyText(report);
    expect(text).not.toContain("supersecretpassword123");
    expect(text).not.toContain("my-secret-token");
    expect(text).not.toContain("\x00");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\x07");
    expect(text).toContain("password=[REDACTED]");

    const md = formatDailyMarkdown(report);
    expect(md).not.toContain("supersecretpassword123");
    expect(md).not.toContain("my-secret-token");
    expect(md).not.toContain("\x00");
    expect(md).not.toContain("\x1b");
    expect(md).not.toContain("\x07");
    expect(md).toContain("password=[REDACTED]");

    const savedPath = writeDailyMarkdown(report, tempDir);
    const content = readFileSync(savedPath, "utf8");
    expect(content).not.toContain("supersecretpassword123");
    expect(content).not.toContain("my-secret-token");
    expect(content).not.toContain("\x00");
    expect(content).not.toContain("\x1b");
    expect(content).not.toContain("\x07");
    expect(content).toContain("password=[REDACTED]");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Finding 7: lastMeaningfulLine redacts before truncating and masks key: value and JSON secrets", () => {
  const prefix = "Finished long step in container deployment with session auth with more details ";
  const token = "4a8f9b2c3d4e5f6a7b8c9d0e1f2a3b4c12345";
  const fullLine = "• " + prefix + token;
  const meaningful = lastMeaningfulLine(fullLine);
  expect(meaningful).not.toContain("4a8f9b2c3d4e5f6a7b8c9");
  expect(meaningful).toContain("[REDACTED]");

  expect(redactSecrets("password: mysecretpassword123")).toBe("password: [REDACTED]");
  expect(redactSecrets('"token": "my-secret-token"')).toBe('"token": "[REDACTED]"');
  expect(redactSecrets("'token': 'my-secret-token'")).toBe("'token': '[REDACTED]'");
  expect(redactSecrets('{"token": "abc12345", "status": "ok"}')).toBe('{"token": "[REDACTED]", "status": "ok"}');
  expect(redactSecrets("api_key: secret-api-key")).toBe("api_key: [REDACTED]");
  expect(redactSecrets("password: ...")).toBe("password: [REDACTED]");
  expect(redactSecrets('"token": "..."')).toBe('"token": "[REDACTED]"');

  const livePath = "Ran /home/martil/projects/italents/impmotordados/motor-ingestao/.venv/bin/python /home/martil/projec";
  expect(redactSecrets(livePath)).toBe(livePath);
});

test("Finding 17: redactSecrets covers AWS access key ids, user:pass@host URLs, space-separated passwords, Basic auth, base64 with slashes, and wrapped secret tails in lastMeaningfulLine", () => {
  const livePath = "Ran /home/martil/projects/italents/impmotordados/motor-ingestao/.venv/bin/python /home/martil/projec";
  expect(redactSecrets(livePath)).toBe(livePath);

  expect(redactSecrets("AWS key AKIAIOSFODNN7EXAMPLE")).toBe("AWS key [REDACTED]");
  expect(redactSecrets("AKIA1234567890ABCDEF")).toBe("[REDACTED]");

  expect(redactSecrets("https://user:password123@example.com")).toBe("https://user:[REDACTED]@example.com");
  expect(redactSecrets("postgres://user:password123@localhost:5432/db")).toBe("postgres://user:[REDACTED]@localhost:5432/db");
  expect(redactSecrets("user:pass@host")).toBe("user:[REDACTED]@host");

  expect(redactSecrets("--password mysecretval123")).toBe("--password [REDACTED]");
  expect(redactSecrets("password mysecretval123")).toBe("password mysecretval123");

  expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic [REDACTED]");
  expect(redactSecrets("Authorization: Basic ...")).toBe("Authorization: Basic ...");

  expect(redactSecrets("dGhpcy9pcy9hL3Zlcnkvc2VjcmV0L3Rva2VuMTIzNDU2Nzg5MA==")).toBe("[REDACTED]");

  const wrapped = "Running command with token sk-proj-1234567890abcdef1234567890123\n4567890";
  expect(lastMeaningfulLine(wrapped)).toBe("Running command with token [REDACTED]");
});

test("Finding 18: commit subjects in daily report are redacted before sanitization", async () => {
  const fixedNow = new Date("2026-10-01T12:00:00Z").getTime();
  const overview = [
    {
      pane: "w1:p1",
      workspace_id: "w1",
      pane_id: "w1:p1",
      agent: "codex",
      handle: "worker-1",
      agent_status: "idle",
      cwd: "/repos/proj-commits",
      model: "gpt-6.1-sol",
    },
  ];

  const fakeGit: GitRunner = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repos/proj-commits";
    if (args[0] === "branch" && args[1] === "--show-current") return "main";
    if (args[0] === "status") return "";
    if (args[0] === "log") return "feat: add password=supersecretpassword123 to config\n";
    return "";
  };

  const report = await buildDailyReport(
    {
      overview,
      git: fakeGit,
      runs: [],
      readPane: async () => "",
      paneList: [],
      now: fixedNow,
    },
    {
      now: fixedNow,
    },
  );

  const subject = report.projects[0]?.commitSubjects[0];
  expect(subject).toBeDefined();
  expect(subject).not.toContain("supersecretpassword123");
  expect(subject).toContain("password=[REDACTED]");
});

test("Finding 19: daily honours HERDR_PLUGIN_STATE_DIR via resolveStateDir helper and writes to same state directory as standup", () => {
  const cliScript = resolve(import.meta.dir, "../src/cli.ts");
  const tempState = mkdtempSync(join(tmpdir(), "herdr-jev-f19-state-"));
  const fakeHerdr = join(tmpdir(), `fake-herdr-f19-${Date.now()}.mjs`);
  writeFileSync(
    fakeHerdr,
    `#!/usr/bin/env node
if (process.argv.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ result: { snapshot: {
    workspaces: [{ workspace_id: "w1", label: "my-f19-project" }],
    agents: [{ workspace_id: "w1", pane_id: "p1", cwd: process.cwd(), agent: "codex", agent_status: "idle", tokens: { quota_model: "gpt-6.1-sol" } }]
  } } }));
  process.exit(0);
}
if (process.argv.includes("read")) {
  process.stdout.write("meaningful line\\n");
  process.exit(0);
}
if (process.argv.includes("list")) {
  process.stdout.write(JSON.stringify({ panes: [{ pane_id: "p1", terminal_title_stripped: "task" }], type: "pane_list" }));
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(fakeHerdr, 0o755);

  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_PLUGIN_ID: "herdr-jev",
      HERDR_PLUGIN_STATE_DIR: tempState,
    };
    delete env.HERDR_JEV_STATE_DIR;
    delete env.HERDR_PANE_ID;

    const resolvedState = resolveStateDir(env);
    expect(resolvedState).toBe(tempState);

    const standupEnv = resolveStandupEnvironment(env);
    expect(standupEnv.stateDir).toBe(tempState);

    const resWrite = spawnSync("bun", ["run", cliScript, "daily", "--write"], { env, encoding: "utf8" });
    expect(resWrite.status).toBe(0);
    const lines = resWrite.stdout.trim().split("\n");
    const writtenPath = lines[lines.length - 1];
    expect(writtenPath).toContain(tempState);
    expect(existsSync(writtenPath)).toBe(true);
  } finally {
    try { unlinkSync(fakeHerdr); } catch {}
    rmSync(tempState, { recursive: true, force: true });
  }
});

