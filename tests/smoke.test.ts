import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const fastCliScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
const cmd = args[0];
if (cmd === "overview") {
  process.stdout.write(JSON.stringify([{ pane: "w1:p1", agent: "codex", state: "idle", cwd: process.cwd() }]));
  process.exit(0);
}
if (cmd === "agents") {
  process.stdout.write(JSON.stringify([{ agent: "codex" }]));
  process.exit(0);
}
if (cmd === "runs") {
  process.stdout.write(JSON.stringify([]));
  process.exit(0);
}
if (cmd === "daily") {
  if (args.includes("--md")) {
    process.stdout.write("Resumo do dia 01/10/2026\\n\\nNo activity\\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ date: "2026-10-01T00:00:00.000Z", projects: [] }));
  process.exit(0);
}
if (cmd === "standup") {
  if (args.includes("--auto")) {
    process.stdout.write(JSON.stringify({ skipped: "no_file" }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ targets: [{ pane: "w1:p1" }], skipped: [] }));
  process.exit(0);
}
if (cmd === "notify") {
  if (args.includes("--release")) {
    process.stdout.write(JSON.stringify({ skippedReason: "no escalation" }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ dryRun: true, sent: false }));
  process.exit(0);
}
if (cmd === "classify-pane") {
  process.stdout.write(JSON.stringify({
    state: "idle",
    stateConfidence: 0.9,
    attention: "none",
    attentionScore: 0,
    attentionConfidence: 0.9,
    blockedReason: "none",
    blockedReasonConfidence: 0.9,
    activity: "idle",
    activityConfidence: 0.9
  }));
  process.exit(0);
}
process.exit(0);
`;

test("smoke.sh exits 0 when fake herdr fulfills all contracts", () => {
  const repoDir = resolve(import.meta.dir, "..");
  const smokeScript = join(repoDir, "scripts/smoke.sh");
  const tempBinDir = mkdtempSync(join(tmpdir(), "smoke-bin-pass-"));
  const fakeHerdr = join(tempBinDir, "herdr");
  const fakeCli = join(tempBinDir, "fake-cli");

  const herdrScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "agent" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ id: "cli:agent:list", result: { agents: [{ agent: "codex", agent_status: "idle", cwd: process.cwd(), pane_id: "w1:p1", workspace_id: "w1" }] } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ id: "cli:pane:list", result: { panes: [{ pane_id: "w1:p1", terminal_title_stripped: "sample task" }] } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "get") {
  if (args[2] === "w1:p1") {
    process.stdout.write(JSON.stringify({ id: "cli:pane:get", result: { pane: { pane_id: "w1:p1" } } }));
    process.exit(0);
  }
  process.exit(1);
}
if (args[0] === "api" && args[1] === "snapshot") {
  process.stdout.write(JSON.stringify({ result: { snapshot: { workspaces: [{ workspace_id: "w1", label: "test-workspace" }], agents: [{ workspace_id: "w1", pane_id: "w1:p1", cwd: process.cwd(), agent: "codex", agent_status: "idle" }] } } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "read") {
  process.stdout.write("sample terminal output\\n");
  process.exit(0);
}
process.exit(0);
`;
  writeFileSync(fakeHerdr, herdrScript, "utf8");
  chmodSync(fakeHerdr, 0o755);
  writeFileSync(fakeCli, fastCliScript, "utf8");
  chmodSync(fakeCli, 0o755);

  try {
    const env = {
      ...process.env,
      PATH: `${tempBinDir}:${process.env.PATH}`,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_JEV_CLI: fakeCli,
      SMOKE_LIVE_JEV: "0",
      HERDR_JEV_TEST_GUARD: "1",
    };

    const res = spawnSync("bash", [smokeScript], { env, cwd: repoDir, encoding: "utf8", timeout: 60000 });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("ok herdr reachable");
    expect(res.stdout).toContain("ok contract of herdr pane get");
    expect(res.stdout).toContain("ok overview --json");
    expect(res.stdout).toContain("ok agents --json");
    expect(res.stdout).toContain("ok runs list --json --limit 1");
    expect(res.stdout).toContain("ok daily --json and daily --md");
    expect(res.stdout).toContain("ok standup --dry-run --json");
    expect(res.stdout).toContain("ok standup --auto with missing file");
    expect(res.stdout).toContain("ok notify --dry-run --json");
    expect(res.stdout).toContain("ok notify --release --pane <fake>");
    expect(res.stdout).toContain("ok the Office renders");
    expect(res.stdout).toContain("ok test guard present");
    expect(res.stdout).not.toContain("FAIL");
  } finally {
    rmSync(tempBinDir, { recursive: true, force: true });
  }
}, 60000);

test("smoke.sh exits 1 when a check fails", () => {
  const repoDir = resolve(import.meta.dir, "..");
  const smokeScript = join(repoDir, "scripts/smoke.sh");
  const tempBinDir = mkdtempSync(join(tmpdir(), "smoke-bin-fail-"));
  const fakeHerdr = join(tempBinDir, "herdr");
  const fakeCli = join(tempBinDir, "fake-cli");

  const herdrScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "agent" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ id: "cli:agent:list", result: { agents: [{ agent: "codex", agent_status: "idle", cwd: process.cwd(), pane_id: "w1:p1", workspace_id: "w1" }] } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ id: "cli:pane:list", result: { panes: [{ pane_id: "w1:p1" }] } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "get") {
  process.stdout.write(JSON.stringify({ id: "cli:pane:get", result: { pane: { pane_id: args[2] } } }));
  process.exit(0);
}
process.exit(0);
`;
  writeFileSync(fakeHerdr, herdrScript, "utf8");
  chmodSync(fakeHerdr, 0o755);
  writeFileSync(fakeCli, fastCliScript, "utf8");
  chmodSync(fakeCli, 0o755);

  try {
    const env = {
      ...process.env,
      PATH: `${tempBinDir}:${process.env.PATH}`,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_JEV_CLI: fakeCli,
      SMOKE_LIVE_JEV: "0",
      HERDR_JEV_TEST_GUARD: "1",
    };

    const res = spawnSync("bash", [smokeScript], { env, cwd: repoDir, encoding: "utf8", timeout: 60000 });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("FAIL contract of herdr pane get");
  } finally {
    rmSync(tempBinDir, { recursive: true, force: true });
  }
}, 60000);

test("smoke.sh prints skip and exits 0 when Herdr is unreachable", () => {
  const repoDir = resolve(import.meta.dir, "..");
  const smokeScript = join(repoDir, "scripts/smoke.sh");
  const tempBinDir = mkdtempSync(join(tmpdir(), "smoke-bin-unreach-"));
  const fakeHerdr = join(tempBinDir, "herdr");
  const fakeCli = join(tempBinDir, "fake-cli");

  writeFileSync(fakeHerdr, `#!/usr/bin/env node\nprocess.exit(1);\n`, "utf8");
  chmodSync(fakeHerdr, 0o755);
  writeFileSync(fakeCli, fastCliScript, "utf8");
  chmodSync(fakeCli, 0o755);

  try {
    const env = {
      ...process.env,
      PATH: `${tempBinDir}:${process.env.PATH}`,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_JEV_CLI: fakeCli,
      SMOKE_LIVE_JEV: "0",
      HERDR_JEV_TEST_GUARD: "1",
    };

    const res = spawnSync("bash", [smokeScript], { env, cwd: repoDir, encoding: "utf8", timeout: 60000 });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("skip herdr reachable");
    expect(res.stdout).toContain("skip contract of herdr pane get");
    expect(res.stdout).toContain("skip overview --json");
    expect(res.stdout).toContain("skip agents --json");
    expect(res.stdout).toContain("skip daily --json and daily --md");
    expect(res.stdout).toContain("skip standup --dry-run --json");
    expect(res.stdout).toContain("ok runs list --json --limit 1");
    expect(res.stdout).toContain("ok standup --auto with missing file");
    expect(res.stdout).toContain("ok notify --dry-run --json");
    expect(res.stdout).toContain("ok notify --release --pane <fake>");
    expect(res.stdout).toContain("ok the Office renders");
    expect(res.stdout).toContain("ok test guard present");
    expect(res.stdout).not.toContain("FAIL");
  } finally {
    rmSync(tempBinDir, { recursive: true, force: true });
  }
}, 60000);
