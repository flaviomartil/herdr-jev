import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearHerdrProtocolCache,
  HerdrEventStream,
  HerdrSocketClient,
  HerdrSocketError,
  resolveHerdrSocketPath,
} from "../src/herdr/socket.js";

let sockDir = "";
let servers: Server[] = [];

beforeEach(() => {
  sockDir = mkdtempSync(join(tmpdir(), "herdr-sock-test-"));
  servers = [];
  clearHerdrProtocolCache();
});

afterEach(async () => {
  clearHerdrProtocolCache();
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
  rmSync(sockDir, { recursive: true, force: true });
});

async function startServer(
  handler: (req: { id: string; method: string; params: Record<string, unknown> }, socket: Socket) => void | Promise<void>,
): Promise<string> {
  const socketPath = join(sockDir, `herdr-${servers.length + 1}.sock`);
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        void handler(req, socket);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

describe("resolveHerdrSocketPath", () => {
  it("blocks ambient default socket, relative overrides, tmpdir root itself, and unsafe overrides when test guard is active", () => {
    expect(resolveHerdrSocketPath({ HERDR_JEV_TEST_GUARD: "1", HOME: "/home/anyone" })).toBeNull();
    expect(
      resolveHerdrSocketPath({
        HERDR_JEV_TEST_GUARD: "1",
        HERDR_SOCKET_PATH: "/home/anyone/.config/herdr/herdr.sock",
      }),
    ).toBeNull();
    expect(
      resolveHerdrSocketPath({
        AI_HARNESS_TEST_GUARD: "1",
        HERDR_SOCKET_PATH: "/etc/herdr.sock",
      }),
    ).toBeNull();
    expect(
      resolveHerdrSocketPath({
        HERDR_JEV_TEST_GUARD: "1",
        HERDR_SOCKET_PATH: "relative.sock",
      }),
    ).toBeNull();
    expect(
      resolveHerdrSocketPath({
        HERDR_JEV_TEST_GUARD: "1",
        HERDR_SOCKET_PATH: tmpdir(),
      }),
    ).toBeNull();
  });

  it("allows ephemeral socket paths inside tmpdir under test guard", () => {
    const allowed = join(sockDir, "herdr.sock");
    expect(
      resolveHerdrSocketPath({
        HERDR_JEV_TEST_GUARD: "1",
        HERDR_SOCKET_PATH: allowed,
      }),
    ).toBe(allowed);
  });

  it("resolves default and session socket paths when test guard is inactive", () => {
    expect(resolveHerdrSocketPath({ HOME: "/tmp/fake-home" })).toBe("/tmp/fake-home/.config/herdr/herdr.sock");
    expect(resolveHerdrSocketPath({ HOME: "/tmp/fake-home", HERDR_SESSION: "dev-1" })).toBe(
      "/tmp/fake-home/.config/herdr/sessions/dev-1/herdr.sock",
    );
  });
});

describe("HerdrSocketClient", () => {
  it("sends pane.focus and layout.apply RPCs over Unix socket", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const socketPath = await startServer((req, sock) => {
      calls.push({ method: req.method, params: req.params });
      if (req.method === "pane.focus") {
        sock.end(`${JSON.stringify({ id: req.id, result: { pane_id: req.params.pane_id } })}\n`);
      } else if (req.method === "layout.apply") {
        sock.end(`${JSON.stringify({ id: req.id, result: { type: "layout_apply", layout: { root: req.params.root } } })}\n`);
      }
    });

    const client = new HerdrSocketClient({ socketPath });
    try {
      expect(await client.paneFocus("w1:p2")).toEqual({ pane_id: "w1:p2" });
      expect(
        await client.layoutApply({
          tab_label: "grid",
          root: { type: "pane", pane_id: "w1:p1" },
        }),
      ).toEqual({ type: "layout_apply", layout: { root: { type: "pane", pane_id: "w1:p1" } } });
      expect(calls).toEqual([
        { method: "pane.focus", params: { pane_id: "w1:p2" } },
        { method: "layout.apply", params: { tab_label: "grid", root: { type: "pane", pane_id: "w1:p1" } } },
      ]);
    } finally {
      client.close();
    }
  });

  it("enforces maxConcurrent cap with FIFO ordering", async () => {
    let inFlight = 0;
    let peak = 0;
    const startedOrder: number[] = [];
    const socketPath = await startServer(async (req, sock) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      startedOrder.push(Number(req.params.seq));
      await new Promise((r) => setTimeout(r, 25));
      inFlight -= 1;
      sock.end(`${JSON.stringify({ id: req.id, result: { seq: req.params.seq } })}\n`);
    });

    const client = new HerdrSocketClient({ socketPath, maxConcurrent: 2 });
    try {
      const results = await Promise.all(
        [1, 2, 3, 4, 5, 6].map((seq) => client.request<{ seq: number }>("pane.get", { seq })),
      );
      expect(peak).toBe(2);
      expect(startedOrder).toEqual([1, 2, 3, 4, 5, 6]);
      expect(results.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      client.close();
    }
  });

  it("gates and caches protocol >= 22 per socketPath", async () => {
    let pingCount = 0;
    const socketPath22 = await startServer((req, sock) => {
      if (req.method === "ping") {
        pingCount += 1;
        sock.end(`${JSON.stringify({ id: req.id, result: { type: "pong", version: "0.9.5", protocol: 22 } })}\n`);
      }
    });
    const client22 = new HerdrSocketClient({ socketPath: socketPath22 });
    try {
      expect(await client22.ensureProtocol(22)).toBe(22);
      expect(await client22.ensureProtocol(22)).toBe(22);
      expect(pingCount).toBe(1);
    } finally {
      client22.close();
    }

    const socketPath21 = await startServer((req, sock) => {
      sock.end(`${JSON.stringify({ id: req.id, result: { type: "pong", version: "0.9.4", protocol: 21 } })}\n`);
    });
    const client21 = new HerdrSocketClient({ socketPath: socketPath21 });
    try {
      await expect(client21.ensureProtocol(22)).rejects.toMatchObject({
        name: "HerdrSocketError",
        code: "unsupported_protocol",
        phase: "rpc",
      });
    } finally {
      client21.close();
    }
  });

  it("maps connect, rpc, id mismatch, XOR, line limit, and timeout errors to HerdrSocketError", async () => {
    const missingClient = new HerdrSocketClient({ socketPath: join(sockDir, "does-not-exist.sock") });
    await expect(missingClient.paneList()).rejects.toMatchObject({
      name: "HerdrSocketError",
      phase: "connect",
    });

    const rpcSock = await startServer((req, sock) => {
      if (req.params.mode === "rpc_error") {
        sock.end(`${JSON.stringify({ id: req.id, error: { code: "pane_not_found", message: "no such pane" } })}\n`);
      } else if (req.params.mode === "id_mismatch") {
        sock.end(`${JSON.stringify({ id: "wrong-id", result: {} })}\n`);
      } else if (req.params.mode === "xor_both") {
        sock.end(`${JSON.stringify({ id: req.id, result: {}, error: { code: "bad", message: "both" } })}\n`);
      } else if (req.params.mode === "too_big") {
        sock.end(`${JSON.stringify({ id: req.id, result: { data: "x".repeat(4096) } })}\n`);
      } else if (req.params.mode === "timeout") {
        // Hold open without replying
      }
    });

    const client = new HerdrSocketClient({ socketPath: rpcSock, maxLineBytes: 1024 });
    try {
      await expect(client.request("pane.get", { mode: "rpc_error" })).rejects.toMatchObject({
        name: "HerdrSocketError",
        code: "pane_not_found",
        phase: "rpc",
      });
      await expect(client.request("pane.get", { mode: "id_mismatch" })).rejects.toMatchObject({
        name: "HerdrSocketError",
        code: "id_mismatch",
        phase: "rpc",
      });
      await expect(client.request("pane.get", { mode: "xor_both" })).rejects.toMatchObject({
        name: "HerdrSocketError",
        code: "invalid_response",
        phase: "rpc",
      });
      await expect(client.request("pane.get", { mode: "too_big" })).rejects.toMatchObject({
        name: "HerdrSocketError",
        code: "line_too_large",
        phase: "io",
      });
      await expect(client.request("pane.get", { mode: "timeout" }, 40)).rejects.toMatchObject({
        name: "HerdrSocketError",
        code: "timeout",
        phase: "timeout",
      });
    } finally {
      client.close();
    }

    const guarded = new HerdrSocketClient({ env: { HERDR_JEV_TEST_GUARD: "1" } });
    await expect(guarded.paneList()).rejects.toBeInstanceOf(HerdrSocketError);
  });

  it("streams events after ack with HerdrEventStream and cleans up on close", async () => {
    let serverSocket: Socket | null = null;
    const socketPath = await startServer((req, sock) => {
      serverSocket = sock;
      sock.write(`${JSON.stringify({ id: req.id, result: { subscribed: true } })}\n`);
      sock.write(`${JSON.stringify({ event: { type: "pane.focused", pane_id: "w1:p2" } })}\n`);
      sock.write(`${JSON.stringify({ event: { type: "pane.closed", pane_id: "w1:p3" } })}\n`);
    });

    const events: Record<string, unknown>[] = [];
    const errors: Error[] = [];
    const stream = new HerdrEventStream({ socketPath });
    await stream.open(["pane.focused", { type: "pane.closed" }], (ev) => events.push(ev), (err) => errors.push(err));
    await new Promise((r) => setTimeout(r, 40));
    stream.close();
    (serverSocket as Socket | null)?.destroy();
    expect(events).toEqual([
      { event: { type: "pane.focused", pane_id: "w1:p2" } },
      { event: { type: "pane.closed", pane_id: "w1:p3" } },
    ]);
    expect(errors).toEqual([]);
  });

  it("handles leading blank lines before JSON response in sendOnce", async () => {
    const socketPath = await startServer((req, sock) => {
      sock.end(`\n\n   \n${JSON.stringify({ id: req.id, result: { ok: true } })}\n`);
    });
    const client = new HerdrSocketClient({ socketPath });
    try {
      expect(await client.request("pane.get", {})).toEqual({ ok: true });
    } finally {
      client.close();
    }
  });

  it("rejects HerdrEventStream ack missing id and aborts pending open() immediately on close()", async () => {
    const badAckSocket = await startServer((_req, sock) => {
      sock.write(`${JSON.stringify({ result: { subscribed: true } })}\n`);
    });
    const badStream = new HerdrEventStream({ socketPath: badAckSocket });
    await expect(badStream.open(["pane.focused"], () => {})).rejects.toMatchObject({
      name: "HerdrSocketError",
      code: "id_mismatch",
      phase: "rpc",
    });

    const slowSocket = await startServer(() => {
      // Hold without ack
    });
    const abortStream = new HerdrEventStream({ socketPath: slowSocket, ackTimeoutMs: 5000 });
    const pendingOpen = abortStream.open(["pane.focused"], () => {});
    setTimeout(() => abortStream.close(), 15);
    await expect(pendingOpen).rejects.toMatchObject({
      name: "HerdrSocketError",
      code: "aborted",
      phase: "io",
    });
  });
});
