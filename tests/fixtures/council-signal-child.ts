import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarnessProcessScope, registerProcessGuard } from "../../src/harness/bridge.js";
import { trackPath } from "../../src/council/scope.js";
import { defaultSpawn } from "../../src/council/spawn.js";

const dir = process.argv[2]!;
const mode = process.argv[3] ?? "scope";

if (mode === "lifetime") {
  const proc = defaultSpawn(["sh", "-c", `sleep 60 & echo $! > ${join(dir, "pid")}; wait`], { cwd: dir, lifetimeMs: 2000 });
  proc.result.then(() => undefined);
  setTimeout(() => writeFileSync(join(dir, "ready"), "1"), 600);
  setInterval(() => undefined, 1000);
} else {
  const review = join(dir, "review-dir");
  mkdirSync(review, { recursive: true });
  writeFileSync(join(review, "file"), "x");
  trackPath(review);
  const proc = defaultSpawn(["sh", "-c", `sleep 60 & echo $! > ${join(dir, "pid")}; wait`], { cwd: dir });
  proc.result.then(() => undefined);
  if (mode === "both") {
    const extra = createHarnessProcessScope();
    const child = spawn("sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
    if (child.pid !== undefined) {
      extra.groups.set(child.pid, child);
      writeFileSync(join(dir, "pid2"), String(child.pid));
    }
    registerProcessGuard(extra);
  }
  setTimeout(() => writeFileSync(join(dir, "ready"), "1"), 500);
  setInterval(() => undefined, 1000);
}
