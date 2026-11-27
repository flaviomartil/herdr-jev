import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWakeSubscriptions,
  DebouncedPump,
  HerdrWakeWatcher,
  pushClaudeMessagingSocket,
  WAKE_HINT_EVENTS,
} from "../src/herdr/event-watcher.js";
import { acquireFileLock } from "../src/herdr/file-lock.js";

let sockDir = "";
let servers: Server[] = [];

beforeEach(() => {
  sockDir = mkdtempSync(join(tmpdir(), "herdr-watcher-test-"));
  servers = [];
});

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  rmSync(sockDir, { recursive: true, force: true });
});

async function startMockHerdrServer(
  onRequest: (req: { id: string; method: string; params: Record<string, any> }, socket: Socket) => void | Promise<void>,
): Promise<string> {
  const socketPath = join(sockDir, `herdr-${servers.length + 1}.sock`);
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          const req = JSON.parse(line);
          void onRequest(req, socket);
        }
        nl = buf.indexOf("\n");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

describe("WAKE_HINT_EVENTS and DebouncedPump", () => {
  test("WAKE_HINT_EVENTS excludes pane.updated and workspace.metadata_updated", () => {
    expect([...WAKE_HINT_EVENTS]).toEqual([
      "pane.agent_status_changed",
      "pane.created",
      "pane.closed",
      "pane.moved",
      "pane.exited",
      "tab.closed",
    ]);
    expect((WAKE_HINT_EVENTS as readonly string[]).includes("pane.updated")).toBe(false);
    expect((WAKE_HINT_EVENTS as readonly string[]).includes("workspace.metadata_updated")).toBe(false);

    const subs = buildWakeSubscriptions(new Set(["w1:p1"]));
    expect(subs.some((s) => s.type === "pane.updated" || s.type === "workspace.metadata_updated")).toBe(false);
    expect(subs).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
  });

  test("DebouncedPump coalesces rapid bursts and preserves trailing wakeups during flush", async () => {
    const batches: string[][] = [];
    let releaseFirst: (() => void) | null = null;
    const pump = new DebouncedPump(async (keys) => {
      batches.push(keys);
      if (batches.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    }, 30);

    pump.trigger("w1:p1");
    pump.trigger("w1:p1");
    pump.trigger("w1:p2");
    await new Promise((r) => setTimeout(r, 60));

    expect(batches).toHaveLength(1);
    expect(batches[0]!.sort()).toEqual(["w1:p1", "w1:p2"]);

    // Trigger while first flush is in flight -> trailing wakeup must not be dropped.
    pump.trigger("w1:p3");
    releaseFirst!();
    await new Promise((r) => setTimeout(r, 80));

    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(["w1:p3"]);

    // Explicit flush() awaits in-flight work and drains trailing triggers immediately.
    let releaseThird: (() => void) | null = null;
    const explicitPump = new DebouncedPump(async (keys) => {
      batches.push(keys);
      if (keys.includes("w1:p4")) {
        await new Promise<void>((resolve) => {
          releaseThird = resolve;
        });
      }
    }, 5000);
    explicitPump.trigger("w1:p4");
    const firstFlush = explicitPump.flush();
    await new Promise((r) => setTimeout(r, 15));
    explicitPump.trigger("w1:p5");
    releaseThird!();
    await firstFlush;
    expect(batches[2]).toEqual(["w1:p4"]);
    expect(batches[3]).toEqual(["w1:p5"]);

    explicitPump.dispose();
    pump.dispose();
  });
});

describe("HerdrWakeWatcher", () => {
  test("subscribes to WAKE_HINT_EVENTS over Unix socket, prunes pane_not_found, ignores noisy events, and resyncs on live_handoff", async () => {
    const subscribeRequests: Array<Array<Record<string, unknown>>> = [];
    const resyncReasons: string[] = [];
    const wakeBatches: Array<{ keys: string[]; types: string[] }> = [];
    let activeStreamSocket: Socket | null = null;
    let snapshotCount = 0;

    const socketPath = await startMockHerdrServer((req, sock) => {
      if (req.method === "session.snapshot") {
        snapshotCount += 1;
        sock.end(
          `${JSON.stringify({
            id: req.id,
            result: {
              snapshot: {
                workspaces: [{ workspace_id: "w1", label: "App" }],
                agents: [
                  { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" },
                  ...(snapshotCount === 1 ? [{ pane_id: "w1:stale", workspace_id: "w1", agent_status: "idle" }] : []),
                ],
                panes: [{ pane_id: "w1:p1" }],
              },
            },
          })}\n`,
        );
        return;
      }

      if (req.method === "events.subscribe") {
        const subs = req.params.subscriptions as Array<Record<string, unknown>>;
        subscribeRequests.push(subs);
        const hasStale = subs.some((s) => s.pane_id === "w1:stale");
        if (hasStale) {
          sock.end(
            `${JSON.stringify({
              id: req.id,
              error: { code: "pane_not_found", message: "pane w1:stale not found" },
            })}\n`,
          );
          return;
        }

        activeStreamSocket = sock;
        sock.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`);

        if (subscribeRequests.length === 2) {
          // Send noisy events (must be ignored) + wake hint burst + live_handoff.
          sock.write(`${JSON.stringify({ event: "pane.updated", data: { pane_id: "w1:p1" } })}\n`);
          sock.write(`${JSON.stringify({ event: "workspace.metadata_updated", data: { workspace_id: "w1" } })}\n`);
          sock.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "done" } })}\n`);
          sock.write(`${JSON.stringify({ event: "pane.moved", data: { pane_id: "w1:p1" } })}\n`);
        }
      }
    });

    const watcher = new HerdrWakeWatcher({
      socketPath,
      debounceMs: 30,
      reconnectDelayMs: 20,
      onResync: (_snap, reason) => {
        resyncReasons.push(reason);
      },
      onWake: (keys, hints) => {
        wakeBatches.push({ keys, types: hints.map((h) => h.type) });
      },
    });

    const started = await watcher.start();
    expect(started.started).toBe(true);
    expect(watcher.getTrackedPaneIds()).toEqual(["w1:p1"]);

    // First subscribe included w1:stale and failed with pane_not_found; second succeeded with w1:p1 only.
    expect(subscribeRequests.length).toBeGreaterThanOrEqual(2);
    for (const subs of subscribeRequests) {
      expect(subs.some((s) => s.type === "pane.updated" || s.type === "workspace.metadata_updated")).toBe(false);
    }

    await new Promise((r) => setTimeout(r, 80));
    expect(wakeBatches).toHaveLength(1);
    expect(wakeBatches[0]).toEqual({
      keys: ["w1:p1"],
      types: ["pane.agent_status_changed", "pane.moved"],
    });

    // Trigger live_handoff and confirm full session.snapshot resync.
    (activeStreamSocket as Socket | null)?.write(`${JSON.stringify({ event: "server.live_handoff", data: {} })}\n`);
    await new Promise((r) => setTimeout(r, 80));

    expect(resyncReasons).toContain("startup");
    expect(resyncReasons).toContain("live_handoff");

    watcher.stop();
  });

  test("no-ops cleanly under test guard without touching live sockets", async () => {
    const errors: Error[] = [];
    const watcher = new HerdrWakeWatcher({
      env: { HERDR_JEV_TEST_GUARD: "1" },
      onWake: () => {},
      onError: (err) => errors.push(err),
    });

    const res = await watcher.start();
    expect(res.started).toBe(false);
    expect(res.reason).toBe("socket_unavailable");
    expect(errors).toHaveLength(1);
    watcher.stop();
  });

  test("prunes delimited pane_not_found without mistaking w1:p1 for w1:p10, tracks pane.moved, and stops on terminal ENOENT", async () => {
    const subscribeRequests: Array<Array<Record<string, unknown>>> = [];
    const wakeBatches: Array<{ keys: string[]; types: string[] }> = [];
    let streamSocket: Socket | null = null;

    const socketPath = await startMockHerdrServer((req, sock) => {
      if (req.method === "events.subscribe") {
        const subs = req.params.subscriptions as Array<Record<string, unknown>>;
        subscribeRequests.push(subs);
        if (subs.some((s) => s.pane_id === "w1:p10")) {
          sock.end(`${JSON.stringify({ id: req.id, error: { code: "pane_not_found", message: "pane w1:p10 not found" } })}\n`);
          return;
        }
        streamSocket = sock;
        sock.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`);
      }
    });

    const watcher = new HerdrWakeWatcher({
      socketPath,
      paneIds: ["w1:p1", "w1:p10"],
      resyncOnStart: false,
      debounceMs: 20,
      reconnectDelayMs: 15,
      onWake: (keys, hints) => {
        wakeBatches.push({ keys, types: hints.map((h) => h.type) });
      },
    });

    const started = await watcher.start();
    expect(started.started).toBe(true);
    // Only w1:p10 was pruned; w1:p1 must remain tracked.
    expect(watcher.getTrackedPaneIds()).toEqual(["w1:p1"]);

    // Emit pane.moved retiring w1:p1 -> w1:p2
    (streamSocket as Socket | null)?.write(
      `${JSON.stringify({ event: "pane.moved", data: { previous_pane_id: "w1:p1", pane_id: "w1:p2" } })}\n`,
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(watcher.getTrackedPaneIds()).toEqual(["w1:p2"]);
    expect(wakeBatches[0]).toEqual({ keys: ["w1:p2"], types: ["pane.moved"] });
    watcher.stop();

    // Terminal ENOENT reconnect exhaustion triggers onTerminalStop cleanly.
    let terminalReason: string | null = null;
    const missingSocket = join(sockDir, "gone.sock");
    let holdOpen: Socket | null = null;
    const goneServerPath = await startMockHerdrServer((req, sock) => {
      holdOpen = sock;
      sock.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`);
    });
    const terminalDone = new Promise<void>((resolve) => {
      const dyingWatcher = new HerdrWakeWatcher({
        socketPath: goneServerPath,
        resyncOnStart: false,
        reconnectDelayMs: 10,
        maxReconnectDelayMs: 20,
        maxConsecutiveFailures: 2,
        onWake: () => {},
        onTerminalStop: (reason) => {
          terminalReason = reason;
          resolve();
        },
      });
      void dyingWatcher.start().then(() => {
        // Close server + remove socket file so reconnects hit ENOENT.
        for (const srv of servers) srv.close();
        rmSync(goneServerPath, { force: true });
        rmSync(missingSocket, { force: true });
        holdOpen?.destroy();
      });
    });
    await terminalDone;
    expect(terminalReason === "ENOENT" || terminalReason === "ECONNREFUSED").toBe(true);
  });
});

describe("pushClaudeMessagingSocket", () => {
  test("returns unsupported when env var is missing and sends framed payload when reachable", async () => {
    expect(await pushClaudeMessagingSocket({}, { type: "wake" })).toEqual({
      sent: false,
      reason: "unsupported",
    });

    const received: unknown[] = [];
    let markReceived: (() => void) | null = null;
    const receivedPromise = new Promise<void>((resolve) => {
      markReceived = resolve;
    });
    const msgSocketPath = join(sockDir, "claude-msg.sock");
    const server = createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          received.push(JSON.parse(buf.slice(0, nl)));
          markReceived?.();
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(msgSocketPath, resolve));

    const res = await pushClaudeMessagingSocket(
      { HERDR_JEV_TEST_GUARD: "1", CLAUDE_CODE_MESSAGING_SOCKET: msgSocketPath },
      { type: "wake", pane_id: "w1:p1" },
    );
    await receivedPromise;
    expect(res).toEqual({ sent: true });
    expect(received).toEqual([{ type: "wake", pane_id: "w1:p1" }]);
  });

  test("CLI watch-events --once exits cleanly under test guard with isolated HOME", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "herdr-cli-watch-"));
    try {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src/cli.ts"), "watch-events", "--once"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: fakeHome,
          HERDR_JEV_TEST_GUARD: "1",
          HERDR_JEV_STATE_DIR: join(fakeHome, "state"),
          HERDR_JEV_CONFIG_DIR: join(fakeHome, "config"),
        },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout.trim())).toEqual({ status: "socket_unavailable", tracked: [] });

      // When singleton lock is already held by a live process, watch-events exits 0 with already_running.
      const stateDir = join(fakeHome, "state");
      const lockHash = createHash("sha256").update("default").digest("hex").slice(0, 16);
      const lockPath = join(stateDir, `watch-events-${lockHash}.lock`);
      const heldLock = await acquireFileLock(lockPath, { timeoutMs: 0 });
      try {
        const dupProc = Bun.spawn(["bun", join(import.meta.dir, "..", "src/cli.ts"), "watch-events", "--once"], {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: fakeHome,
            HERDR_JEV_TEST_GUARD: "1",
            HERDR_JEV_STATE_DIR: stateDir,
            HERDR_JEV_CONFIG_DIR: join(fakeHome, "config"),
          },
        });
        const [dupOut, dupErr, dupCode] = await Promise.all([
          new Response(dupProc.stdout).text(),
          new Response(dupProc.stderr).text(),
          dupProc.exited,
        ]);
        expect(dupCode).toBe(0);
        expect(dupErr).toBe("");
        expect(JSON.parse(dupOut.trim())).toEqual({ status: "already_running", tracked: [] });
      } finally {
        heldLock.release();
      }
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
