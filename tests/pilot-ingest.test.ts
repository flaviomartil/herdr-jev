import { describe, expect, test } from "bun:test";
import { createFrameDecoder, parseFrames } from "../pilot.js";
import { createIngestMetrics } from "../pilot-metrics.js";
import { collectFrames, decodeFrames } from "../pilot-stream.js";
import { createIngestController, ingestFrames } from "../pilot-ingest.js";

type Chunk = string | Uint8Array;

function makeSource(chunks: Chunk[], options: { hangAfter?: number } = {}) {
  const state = { returned: false, pulled: 0, released: null as null | (() => void) };
  async function* source() {
    try {
      for (const chunk of chunks) {
        if (options.hangAfter !== undefined && state.pulled >= options.hangAfter) {
          await new Promise<void>((resolve) => { state.released = resolve; });
        }
        state.pulled += 1;
        yield chunk;
      }
    } finally {
      state.returned = true;
    }
  }
  return { source: source(), state };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pilot.js stays intact", () => {
  test("parseFrames and createFrameDecoder keep their contract", () => {
    expect(parseFrames('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    const decoder = createFrameDecoder({ maxFrames: 1 });
    expect(decoder.push('{"a":1}\n')).toEqual([{ a: 1 }]);
    expect(() => decoder.push('{"b":2}\n')).toThrow(RangeError);
  });
});

describe("decodeFrames", () => {
  test("reassembles frames split across string chunks", async () => {
    const { source, state } = makeSource(['{"id":', '1}\n{"id":2}\n{"i', 'd":3}']);
    const frames = await collectFrames(source);
    expect(frames).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(state.returned).toBe(true);
  });

  test("decodes byte chunks with a multibyte character split in two", async () => {
    const encoded = new TextEncoder().encode('{"txt":"ação"}\n{"n":1}\n');
    const cut = 10;
    const { source } = makeSource([encoded.subarray(0, cut), encoded.subarray(cut)]);
    const frames = await collectFrames(source);
    expect(frames).toEqual([{ txt: "ação" }, { n: 1 }]);
  });

  test("accepts synchronous iterables", async () => {
    const frames = await collectFrames(['{"a":1}\n', '{"b":2}']);
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("enforces maxFrameBytes and closes upstream", async () => {
    const { source, state } = makeSource(['{"big":"', "x".repeat(50), '"}\n']);
    const metrics = createIngestMetrics();
    await expect(collectFrames(source, { maxFrameBytes: 16, metrics })).rejects.toThrow("maxFrameBytes exceeded");
    expect(state.returned).toBe(true);
    const snap = metrics.snapshot();
    expect(snap.status).toBe("failed");
    expect(snap.errorName).toBe("RangeError");
    expect(snap.errors).toBe(1);
  });

  test("enforces maxFrames across chunks", async () => {
    const { source, state } = makeSource(['{"a":1}\n', '{"a":2}\n', '{"a":3}\n']);
    const seen: unknown[] = [];
    let error: unknown = null;
    try {
      for await (const frame of decodeFrames(source, { maxFrames: 2 })) seen.push(frame);
    } catch (caught) {
      error = caught;
    }
    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe("maxFrames exceeded");
    expect(state.returned).toBe(true);
  });

  test("enforces total maxBytes before decoding the offending chunk", async () => {
    const { source, state } = makeSource(['{"a":1}\n', '{"a":2}\n', '{"a":3}\n']);
    const metrics = createIngestMetrics();
    const seen: unknown[] = [];
    let error: unknown = null;
    try {
      for await (const frame of decodeFrames(source, { maxBytes: 16, metrics })) seen.push(frame);
    } catch (caught) {
      error = caught;
    }
    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
    expect((error as Error).message).toBe("maxBytes exceeded");
    expect(state.returned).toBe(true);
    expect(metrics.snapshot().bytes).toBe(16);
    expect(metrics.snapshot().chunks).toBe(2);
  });

  test("consumer break cancels upstream and marks metrics cancelled", async () => {
    const { source, state } = makeSource(['{"a":1}\n', '{"a":2}\n', '{"a":3}\n']);
    const metrics = createIngestMetrics();
    for await (const frame of decodeFrames(source, { metrics })) {
      expect(frame).toEqual({ a: 1 });
      break;
    }
    expect(state.returned).toBe(true);
    expect(state.pulled).toBe(1);
    expect(metrics.snapshot().status).toBe("cancelled");
    expect(metrics.snapshot().frames).toBe(1);
  });

  test("abort signal interrupts a hanging upstream and releases it", async () => {
    const { source, state } = makeSource(['{"a":1}\n', '{"a":2}\n'], { hangAfter: 1 });
    const controller = new AbortController();
    const metrics = createIngestMetrics();
    const seen: unknown[] = [];
    const run = (async () => {
      for await (const frame of decodeFrames(source, { signal: controller.signal, metrics })) {
        seen.push(frame);
        if (seen.length === 1) setTimeout(() => controller.abort(), 5);
      }
    })();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual([{ a: 1 }]);
    expect(metrics.snapshot().status).toBe("cancelled");
    expect(state.returned).toBe(false);
    state.released?.();
    await tick();
    await tick();
    expect(state.returned).toBe(true);
  });

  test("abort reason is propagated and an already aborted signal fails before pulling", async () => {
    const { source, state } = makeSource(['{"a":1}\n']);
    const controller = new AbortController();
    const reason = new Error("stop now");
    controller.abort(reason);
    await expect(collectFrames(source, { signal: controller.signal })).rejects.toBe(reason);
    expect(state.pulled).toBe(0);
  });

  test("rejects invalid options and sources", async () => {
    await expect(collectFrames(['{"a":1}'], { maxBytes: 0 })).rejects.toThrow(RangeError);
    await expect(collectFrames(['{"a":1}'], { maxFrameBytes: -1 })).rejects.toThrow(RangeError);
    await expect(collectFrames(['{"a":1}'], { signal: {} as AbortSignal })).rejects.toThrow(TypeError);
    await expect(collectFrames(42 as unknown as Iterable<string>)).rejects.toThrow(TypeError);
    await expect(collectFrames([7 as unknown as string])).rejects.toThrow(TypeError);
  });
});

describe("createIngestMetrics", () => {
  test("tracks bytes, chunks, frames and duration", () => {
    let clock = 100;
    const metrics = createIngestMetrics({ now: () => clock });
    expect(metrics.snapshot().durationMs).toBeNull();
    metrics.start();
    metrics.recordChunk("abc");
    metrics.recordChunk(new Uint8Array(5));
    metrics.recordFrames(2);
    clock = 160;
    metrics.finish();
    expect(metrics.snapshot()).toMatchObject({
      status: "completed",
      bytes: 8,
      chunks: 2,
      frames: 2,
      errors: 0,
      durationMs: 60,
    });
    expect(() => metrics.finish()).toThrow();
    expect(() => metrics.start()).toThrow();
  });

  test("records errors with name and message", () => {
    const metrics = createIngestMetrics();
    metrics.start();
    metrics.recordError(new RangeError("boom"));
    expect(metrics.snapshot()).toMatchObject({ status: "failed", errors: 1, errorName: "RangeError", errorMessage: "boom" });
  });
});

describe("ingestFrames", () => {
  test("collects frames and reports completed metrics", async () => {
    const { source } = makeSource(['{"a":1}\n{"a":2}\n', '{"a":3}']);
    const result = await ingestFrames(source);
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.frames).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(result.metrics).toMatchObject({ status: "completed", frames: 3, chunks: 2, bytes: 23 });
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("delivers frames to onFrame and stops when it returns false", async () => {
    const { source, state } = makeSource(['{"a":1}\n', '{"a":2}\n', '{"a":3}\n']);
    const received: Array<[unknown, number]> = [];
    const result = await ingestFrames(source, {
      onFrame: (frame, index) => {
        received.push([frame, index]);
        return received.length < 2;
      },
    });
    expect(received).toEqual([[{ a: 1 }, 0], [{ a: 2 }, 1]]);
    expect(result.status).toBe("cancelled");
    expect(result.stoppedByConsumer).toBe(true);
    expect(result.frames).toEqual([]);
    expect(state.returned).toBe(true);
    expect(result.metrics.status).toBe("cancelled");
  });

  test("returns failed status with the limit error instead of throwing", async () => {
    const { source, state } = makeSource(['{"a":1}\n', '{"a":2}\n']);
    const result = await ingestFrames(source, { maxFrames: 1 });
    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(RangeError);
    expect(result.frames).toEqual([{ a: 1 }]);
    expect(result.metrics).toMatchObject({ status: "failed", errorName: "RangeError", frames: 1 });
    expect(state.returned).toBe(true);
  });

  test("controller cancels a hanging ingest", async () => {
    const { source, state } = makeSource(['{"a":1}\n', '{"a":2}\n'], { hangAfter: 1 });
    const controller = createIngestController();
    const run = ingestFrames(source, { signal: controller.signal });
    await tick();
    expect(controller.cancelled).toBe(false);
    controller.cancel();
    const result = await run;
    expect(result.status).toBe("cancelled");
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(result.frames).toEqual([{ a: 1 }]);
    expect(result.metrics.status).toBe("cancelled");
    state.released?.();
    await tick();
    expect(state.returned).toBe(true);
  });

  test("rejects a metrics object that already ran", async () => {
    const metrics = createIngestMetrics();
    metrics.start();
    await expect(ingestFrames(['{"a":1}'], { metrics })).rejects.toThrow("Ingest metrics must be idle");
    await expect(ingestFrames(['{"a":1}'], { onFrame: 1 as unknown as () => void })).rejects.toThrow(TypeError);
  });
});

describe("review follow-ups", () => {
  test("cancel with a custom reason still counts as cancelled", async () => {
    const { source, state } = makeSource(['{"a":1}\n', '{"a":2}\n'], { hangAfter: 1 });
    const controller = createIngestController();
    const run = ingestFrames(source, { signal: controller.signal });
    await tick();
    controller.cancel(new Error("user stop"));
    const result = await run;
    expect(result.status).toBe("cancelled");
    expect((result.error as Error).message).toBe("user stop");
    expect(result.metrics).toMatchObject({ status: "cancelled", errors: 0 });
    state.released?.();
    await tick();
    expect(state.returned).toBe(true);
  });

  test("onFrame throwing yields failed status with the consumer error recorded", async () => {
    const { source, state } = makeSource(['{"a":1}\n', '{"a":2}\n']);
    const boom = new Error("consumer boom");
    const result = await ingestFrames(source, { onFrame: () => { throw boom; } });
    expect(result.status).toBe("failed");
    expect(result.error).toBe(boom);
    expect(result.metrics).toMatchObject({ status: "failed", errors: 1, errorMessage: "consumer boom" });
    expect(state.returned).toBe(true);
  });

  test("abort while paused at a yield does not pull another chunk", async () => {
    const { source, state } = makeSource(['{"a":1}\n', '{"a":2}\n', '{"a":3}\n']);
    const controller = new AbortController();
    const seen: unknown[] = [];
    let error: unknown = null;
    try {
      for await (const frame of decodeFrames(source, { signal: controller.signal })) {
        seen.push(frame);
        controller.abort();
      }
    } catch (caught) {
      error = caught;
    }
    expect(seen).toEqual([{ a: 1 }]);
    expect((error as Error).name).toBe("AbortError");
    expect(state.pulled).toBe(1);
    expect(state.returned).toBe(true);
  });

  test("abort between frames of the same chunk stops delivery", async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    let error: unknown = null;
    try {
      for await (const frame of decodeFrames(['{"a":1}\n{"a":2}\n{"a":3}\n'], { signal: controller.signal })) {
        seen.push(frame);
        controller.abort();
      }
    } catch (caught) {
      error = caught;
    }
    expect(seen).toEqual([{ a: 1 }]);
    expect((error as Error).name).toBe("AbortError");
  });

  test("a failing source is not asked to return and metrics record the failure", async () => {
    let returnCalled = false;
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => { throw new Error("source down"); },
          return: async () => { returnCalled = true; return { done: true, value: undefined }; },
        };
      },
    };
    const metrics = createIngestMetrics();
    await expect(collectFrames(source, { metrics })).rejects.toThrow("source down");
    expect(returnCalled).toBe(false);
    expect(metrics.snapshot()).toMatchObject({ status: "failed", errorMessage: "source down" });
  });

  test("invalid source records a failure instead of leaving metrics idle", async () => {
    const metrics = createIngestMetrics();
    await expect(collectFrames(42 as unknown as Iterable<string>, { metrics })).rejects.toThrow(TypeError);
    expect(metrics.snapshot().status).toBe("failed");
  });

  test("ingestFrames throws on invalid stream options instead of returning a result", async () => {
    await expect(ingestFrames(['{"a":1}'], { maxBytes: 0 })).rejects.toThrow(RangeError);
    await expect(ingestFrames(['{"a":1}'], { maxFrames: 0 })).rejects.toThrow(RangeError);
  });

  test("a string chunk after a partial byte sequence fails cleanly", async () => {
    const encoded = new TextEncoder().encode('{"txt":"ç"}\n');
    await expect(collectFrames([encoded.subarray(0, 9), '"}\n'])).rejects.toThrow(TypeError);
  });

  test("recordError refuses to touch state when not running", () => {
    const metrics = createIngestMetrics();
    expect(() => metrics.recordError(new Error("x"))).toThrow();
    expect(metrics.snapshot()).toMatchObject({ status: "idle", errors: 0, errorName: null });
  });
});
