import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSpawn } from "../../src/council/spawn.js";
import { trackPath } from "../../src/council/scope.js";

const dir = process.argv[2]!;
const review = join(dir, "review-dir");
mkdirSync(review, { recursive: true });
writeFileSync(join(review, "file"), "x");
trackPath(review);
const proc = defaultSpawn(["sh", "-c", `sleep 60 & echo $! > ${join(dir, "pid")}; wait`], { cwd: dir });
proc.result.then(() => undefined);
setTimeout(() => {
  writeFileSync(join(dir, "ready"), "1");
}, 400);
setInterval(() => undefined, 1000);
