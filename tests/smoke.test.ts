import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("smoke.sh exits 0 when fake herdr fulfills all contracts", () => {
  const repoDir = resolve(import.meta.dir, "..");
  const smokeScript = join(repoDir, "scripts/smoke.sh");
  const tempBinDir = mkdtempSync(join(tmpdir(), "smoke-bin-pass-"));
  const fakeHerdr = join(tempBinDir, "herdr");

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

  try {
    const env = {
      ...process.env,
      PATH: `${tempBinDir}:${process.env.PATH}`,
      HERDR_BIN_PATH: fakeHerdr,
      SMOKE_LIVE_JEV: "0",
    };

    const res = spawnSync("bash", [smokeScript], { env, cwd: repoDir, encoding: "utf8" });
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
    expect(res.stdout).not.toContain("FAIL");
  } finally {
    rmSync(tempBinDir, { recursive: true, force: true });
  }
});

test("smoke.sh exits 1 when a check fails", () => {
  const repoDir = resolve(import.meta.dir, "..");
  const smokeScript = join(repoDir, "scripts/smoke.sh");
  const tempBinDir = mkdtempSync(join(tmpdir(), "smoke-bin-fail-"));
  const fakeHerdr = join(tempBinDir, "herdr");

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

  try {
    const env = {
      ...process.env,
      PATH: `${tempBinDir}:${process.env.PATH}`,
      HERDR_BIN_PATH: fakeHerdr,
      SMOKE_LIVE_JEV: "0",
    };

    const res = spawnSync("bash", [smokeScript], { env, cwd: repoDir, encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("FAIL contract of herdr pane get");
  } finally {
    rmSync(tempBinDir, { recursive: true, force: true });
  }
});

test("smoke.sh prints skip and exits 0 when Herdr is unreachable", () => {
  const repoDir = resolve(import.meta.dir, "..");
  const smokeScript = join(repoDir, "scripts/smoke.sh");
  const tempBinDir = mkdtempSync(join(tmpdir(), "smoke-bin-unreach-"));
  const fakeHerdr = join(tempBinDir, "herdr");

  writeFileSync(fakeHerdr, `#!/usr/bin/env node\nprocess.exit(1);\n`, "utf8");
  chmodSync(fakeHerdr, 0o755);

  try {
    const env = {
      ...process.env,
      PATH: `${tempBinDir}:${process.env.PATH}`,
      HERDR_BIN_PATH: fakeHerdr,
      SMOKE_LIVE_JEV: "0",
    };

    const res = spawnSync("bash", [smokeScript], { env, cwd: repoDir, encoding: "utf8" });
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
    expect(res.stdout).not.toContain("FAIL");
  } finally {
    rmSync(tempBinDir, { recursive: true, force: true });
  }
});
