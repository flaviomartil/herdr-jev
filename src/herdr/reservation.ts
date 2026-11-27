import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { claimFence, releaseFence } from "./file-lock.js";
import { resolveStateDir } from "./state-dir.js";

const claimedSpawnNonces = new Map<string, { nonce: string; ino: number }>();

function reservationPath(key: string, scope: "pane" | "state" = "pane") {
  const root = join(resolveStateDir(), "peer-locks");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const identity = scope === "state" ? JSON.stringify([scope, key]) : `${process.env.HERDR_SOCKET_PATH ?? "default"}:${key}`;
  return join(root, createHash("sha256").update(identity).digest("hex"));
}

export function claimHerdrSpawn(key: string) {
  const lockPath = `${reservationPath(key)}.dispatch`;
  const handle = claimFence(lockPath);
  claimedSpawnNonces.set(lockPath, { nonce: handle.nonce, ino: handle.ino });
}

export function releaseHerdrSpawn(key: string) {
  const lockPath = `${reservationPath(key)}.dispatch`;
  const entry = claimedSpawnNonces.get(lockPath);
  if (!entry) return;
  releaseFence(lockPath, entry.nonce, entry.ino);
  claimedSpawnNonces.delete(lockPath);
}

export async function reserveHerdrHandle(key: string, scope: "pane" | "state" = "pane") {
  const lock = reservationPath(key, scope);
  const reservation = Bun.spawn(["flock", "--nonblock", lock, "sh", "-c", "printf ready; cat >/dev/null"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  const ready = await reservation.stdout.getReader().read();
  if (ready.done) {
    reservation.stdin.end();
    await reservation.exited;
    throw new Error(scope === "state" ? "Pull request watch is already reserved in this state directory" : "Peer turn already reserved; inspect the existing peer before retrying");
  }
  return async () => { reservation.stdin.end(); await reservation.exited; };
}
