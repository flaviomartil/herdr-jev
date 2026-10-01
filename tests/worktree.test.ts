import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync, chmodSync, mkdirSync, rmdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("subagent worktree flag", () => {
  it("creates a worktree when not existing", () => {
    const tmp = join(tmpdir(), "wt-test-" + Date.now());
    mkdirSync(tmp, { recursive: true });
    
    const fakeGit = join(tmp, "git");
    writeFileSync(fakeGit, `#!/usr/bin/env bash
if [[ "$1" == "rev-parse" && "$2" == "--show-toplevel" ]]; then
  echo "${tmp}"
  exit 0
fi
if [[ "$1" == "rev-parse" && "$2" == "--git-dir" ]]; then
  exit 1
fi
if [[ "$1" == "show-ref" ]]; then
  exit 1
fi
if [[ "$1" == "worktree" ]]; then
  echo "created worktree $5 on branch $4" > "\${KILL_LOG}"
  exit 0
fi
echo "unknown git cmd: $@" >&2
exit 1
`);
    chmodSync(fakeGit, 0o755);

    const fakeAgy = join(tmp, "agy");
    writeFileSync(fakeAgy, `#!/usr/bin/env bash\nexit 0\n`);
    chmodSync(fakeAgy, 0o755);

    const logFile = join(tmp, "log.txt");

    const resBun = spawnSync("bun", ["src/cli.ts", "subagent", "--no-split", "--print", "--worktree", "myname", "--model", "invalid-model-123", "--", "prompt"], {
      env: Object.assign({}, process.env, {
        PATH: tmp + ":" + process.env.PATH,
        KILL_LOG: logFile,
        HERDR_ENV: "0", 
      }),
      encoding: "utf8",
    });

    const out = resBun.stdout + resBun.stderr;
    expect(out).not.toContain("Error creating worktree");
    
    const logged = readFileSync(logFile, "utf8");
    expect(logged).toContain("created worktree " + tmp + "-wt-myname on branch wt/myname");
    
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reuses worktree if directory already exists", () => {
    const tmp = join(tmpdir(), "wt-test-reuse-" + Date.now());
    mkdirSync(tmp, { recursive: true });
    
    const targetDir = tmp + "-wt-myname";
    mkdirSync(targetDir, { recursive: true });

    const fakeGit = join(tmp, "git");
    writeFileSync(fakeGit, `#!/usr/bin/env bash
if [[ "$1" == "rev-parse" && "$2" == "--show-toplevel" ]]; then
  echo "${tmp}"
  exit 0
fi
echo "unknown git cmd: $@" >&2
exit 1
`);
    chmodSync(fakeGit, 0o755);

    const fakeAgy = join(tmp, "agy");
    writeFileSync(fakeAgy, `#!/usr/bin/env bash\nexit 0\n`);
    chmodSync(fakeAgy, 0o755);

    const logFile = join(tmp, "log.txt");

    const resBun = spawnSync("bun", ["src/cli.ts", "subagent", "--no-split", "--print", "--worktree", "myname", "--model", "invalid-model-123", "--", "prompt"], {
      env: Object.assign({}, process.env, {
        PATH: tmp + ":" + process.env.PATH,
        HERDR_ENV: "0", 
      }),
      encoding: "utf8",
    });

    const out = resBun.stdout + resBun.stderr;
    expect(out).not.toContain("already exists but is not a worktree");
    expect(out).not.toContain("Error creating worktree");
    
    rmSync(tmp, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("fails if not inside a git repository", () => {
    const tmp = join(tmpdir(), "wt-test-fail-" + Date.now());
    mkdirSync(tmp, { recursive: true });
    
    const fakeGit = join(tmp, "git");
    writeFileSync(fakeGit, `#!/usr/bin/env bash
exit 1
`);
    chmodSync(fakeGit, 0o755);

    const resBun = spawnSync("bun", ["src/cli.ts", "subagent", "--no-split", "--print", "--worktree", "myname", "--model", "invalid-model-123", "--", "prompt"], {
      env: Object.assign({}, process.env, {
        PATH: tmp + ":" + process.env.PATH,
        HERDR_ENV: "0",
      }),
      encoding: "utf8",
    });

    expect(resBun.stderr).toContain("Error: Directory is not inside a git repository");
    
    rmSync(tmp, { recursive: true, force: true });
  });
});
