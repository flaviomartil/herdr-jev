import { mkdirSync, openSync, closeSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveStateDir } from "./state-dir.js";

function reservationPath(key: string) {
  const root = join(resolveStateDir(), "peer-locks");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return join(root, createHash("sha256").update(`${process.env.HERDR_SOCKET_PATH ?? "default"}:${key}`).digest("hex"));
}

export function claimHerdrSpawn(key: string) {
  closeSync(openSync(`${reservationPath(key)}.dispatch`, "wx", 0o600));
}

export function releaseHerdrSpawn(key: string) {
  rmSync(`${reservationPath(key)}.dispatch`, { force: true });
}

export async function reserveHerdrHandle(key: string) {
  const lock = reservationPath(key);
  const reservation = Bun.spawn(["flock", "--nonblock", lock, "sh", "-c", "printf ready; cat >/dev/null"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  const ready = await reservation.stdout.getReader().read();
  if (ready.done) { reservation.stdin.end(); await reservation.exited; throw new Error("Peer turn already reserved; inspect the existing peer before retrying"); }
  return async () => { reservation.stdin.end(); await reservation.exited; };
}
