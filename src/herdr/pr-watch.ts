import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProcessCommandAdapter, type RunCommand } from "./client.js";
import { reserveHerdrHandle } from "./reservation.js";
import { historyCommand } from "./sessions.js";
import { resolveStateDir } from "./state-dir.js";

const ALERTS = {
  checks_failed: { kind: "error", title: "Checks failed" },
  review_required: { kind: "review", title: "Review required" },
  changes_requested: { kind: "review", title: "Changes requested" },
  merged: { kind: "review", title: "Merged" },
} as const;

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const SESSION_KEY = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,239}$/;

type Alert = keyof typeof ALERTS;
type State = "OPEN" | "CLOSED" | "MERGED";
type Review = "" | "APPROVED" | "REVIEW_REQUIRED" | "CHANGES_REQUESTED";
type Snapshot = { state: State; checksFailed: boolean; review: Review };
type Cursor = Snapshot & { sequence: number; pending: Alert[] };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isState(value: unknown): value is State {
  return value === "OPEN" || value === "CLOSED" || value === "MERGED";
}

function isReview(value: unknown): value is Review {
  return value === "" || value === "APPROVED" || value === "REVIEW_REQUIRED" || value === "CHANGES_REQUESTED";
}

function parseTarget(target: string) {
  const matched = /^(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?|([\w.-]+\/[\w.-]+)#([1-9]\d*))$/i.exec(target);
  const repository = (matched?.[1] ?? matched?.[3])?.toLowerCase();
  const number = Number(matched?.[2] ?? matched?.[4]);
  if (!repository || repository.split("/").some(part => !/^[a-z0-9_][a-z0-9_.-]*$/.test(part)) || !Number.isSafeInteger(number)) {
    throw new Error("Use a GitHub pull request URL or owner/repository#number");
  }
  return { repository, number, url: `https://github.com/${repository}/pull/${number}` };
}

function checkFailed(value: unknown): boolean {
  if (record(value) && value.__typename === "CheckRun" && typeof value.status === "string" && typeof value.conclusion === "string") {
    return value.status === "COMPLETED" && FAILED_CONCLUSIONS.has(value.conclusion);
  }
  if (record(value) && value.__typename === "StatusContext" && typeof value.state === "string") {
    return value.state === "FAILURE" || value.state === "ERROR";
  }
  throw new Error("GitHub returned an invalid check status");
}

function parseSnapshot(raw: string, number: number): Snapshot {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("GitHub returned invalid pull request data"); }
  if (!record(value) || value.number !== number || !isState(value.state) || !isReview(value.reviewDecision)
    || !Array.isArray(value.reviewRequests) || !Array.isArray(value.statusCheckRollup)) {
    throw new Error("GitHub returned invalid pull request data");
  }
  if (value.state !== "OPEN") return { state: value.state, checksFailed: false, review: "" };
  const failures = value.statusCheckRollup.map(checkFailed);
  const review = value.reviewRequests.length && value.reviewDecision !== "CHANGES_REQUESTED" ? "REVIEW_REQUIRED" : value.reviewDecision;
  return { state: value.state, checksFailed: failures.includes(true), review };
}

function loadCursor(file: string): Cursor {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { state: "OPEN", checksFailed: false, review: "", sequence: 0, pending: [] };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (record(value) && isState(value.state) && typeof value.checksFailed === "boolean" && isReview(value.review)
      && typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) && value.sequence >= 0
      && Array.isArray(value.pending) && value.pending.length <= Object.keys(ALERTS).length
      && value.pending.every(alert => typeof alert === "string" && Object.hasOwn(ALERTS, alert))) {
      return value as Cursor;
    }
  } catch {}
  throw new Error("Invalid pull request watch cursor; inspect the stored state before retrying");
}

function saveCursor(file: string, cursor: Cursor): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(cursor), { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

function advance(cursor: Cursor, snapshot: Snapshot): Cursor {
  const { state, checksFailed, review } = snapshot;
  if (state === cursor.state && checksFailed === cursor.checksFailed && review === cursor.review) return cursor;
  const pending: Alert[] = [];
  if (state === "MERGED") pending.push("merged");
  if (checksFailed && !cursor.checksFailed) pending.push("checks_failed");
  if (review !== cursor.review && review === "REVIEW_REQUIRED") pending.push("review_required");
  if (review !== cursor.review && review === "CHANGES_REQUESTED") pending.push("changes_requested");
  return { ...snapshot, sequence: cursor.sequence + 1, pending };
}

export async function watchPullRequest(
  input: { target: string; session: string; once?: boolean; intervalSeconds?: number },
  deps: {
    run?: RunCommand;
    history?: (args: string[]) => Promise<unknown>;
    reserve?: (key: string, scope: "state") => Promise<() => Promise<void>>;
    stateRoot?: string;
  } = {},
) {
  const { repository, number, url } = parseTarget(input.target);
  const interval = input.intervalSeconds ?? 90;
  if (!Number.isInteger(interval) || interval < 10 || interval > 3600) throw new Error("Poll interval must be 10 to 3600 seconds");
  if (!SESSION_KEY.test(input.session)) throw new Error("An indexed Harness session key is required");
  const gh = deps.run ? "gh" : Bun.which("gh");
  if (!gh) throw new Error("GitHub CLI (gh) is required");
  const run = deps.run ?? createProcessCommandAdapter({ timeoutMs: 20_000 });
  const history = deps.history ?? historyCommand;
  const source = await history(["show", "--session", input.session, "--no-index", "--limit", "1", "--budget", "512"]);
  const session = record(source) && record(source.session) ? source.session.key : null;
  if (typeof session !== "string" || !SESSION_KEY.test(session)) throw new Error("Harness session could not be resolved");
  const key = createHash("sha256").update(JSON.stringify([session, repository, number])).digest("hex");
  const release = await (deps.reserve ?? reserveHerdrHandle)(`github-pr:${key}`, "state");
  try {
    const dir = join(deps.stateRoot ?? resolveStateDir(), "github-pr-watch-v1");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${key}.json`);
    let cursor = loadCursor(file);
    let delivered = 0;
    const deliver = async () => {
      if (cursor.pending.length === 0) return;
      for (const alert of cursor.pending) {
        const { kind, title } = ALERTS[alert];
        const receipt = await history(["work-event", "--session", session, "--event", `github-pr:${key}:${cursor.sequence}:${alert}`,
          "--kind", kind, "--title", `${title} · ${url}`]);
        if (!record(receipt) || !record(receipt.work) || typeof receipt.work.id !== "string" || typeof receipt.created !== "boolean") {
          throw new Error("Harness returned an invalid inbox receipt");
        }
        if (receipt.created) delivered++;
      }
      const cleared = { ...cursor, pending: [] };
      saveCursor(file, cleared);
      cursor = cleared;
    };
    for (;;) {
      try {
        await deliver();
        const result = await run([gh, "pr", "view", String(number), "--repo", `github.com/${repository}`,
          "--json", "number,state,reviewDecision,reviewRequests,statusCheckRollup"]);
        if (!result.ok) throw new Error("GitHub pull request unavailable; check repository access and gh authentication");
        const next = advance(cursor, parseSnapshot(result.stdout, number));
        if (next !== cursor) {
          saveCursor(file, next);
          cursor = next;
        }
        await deliver();
        if (input.once || cursor.state !== "OPEN") return { url, session, state: cursor.state, delivered };
      } catch (error) {
        if (input.once) throw error;
        console.error("PR watch poll failed; retrying on the next interval");
      }
      await Bun.sleep(interval * 1000);
    }
  } finally { await release(); }
}
