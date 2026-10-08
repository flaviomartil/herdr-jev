import { appendFileSync } from "node:fs";
import { acquireRepoLock } from "../../src/council/scope.js";

const [state, repo, results, startAt, holdMs] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
const lock = acquireRepoLock(state!, repo!);
appendFileSync(results!, `${lock ? "won" : "lost"}\n`);
if (lock) {
  const end = Date.now() + Number(holdMs);
  while (Date.now() < end) {}
  lock.release();
}
