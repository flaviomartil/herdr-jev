import { describe, expect, spyOn, test } from 'bun:test';
import * as pilot from '../pilot.js';
import { collectFrames, streamFrames } from '../pilot-stream.js';

async function* from(chunks: Array<string | Uint8Array | unknown>) {
  for (const chunk of chunks) yield chunk;
}

const enc = new TextEncoder();

describe('pilot-stream', () => {
  test('decodes frames split across arbitrary string chunks', async () => {
    const frames = await collectFrames(from(['{"a":', '1}\n{"b"', ':2}\n', '{"c":3}']));
    expect(frames).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test('yields frames lazily as chunks arrive', async () => {
    let pulled = 0;
    async function* source() {
      pulled++;
      yield '{"n":1}\n';
      pulled++;
      yield '{"n":2}\n';
    }
    const it = streamFrames(source());
    const first = await it.next();
    expect(first.value).toEqual({ n: 1 });
    expect(pulled).toBe(1);
    await it.return(undefined);
  });

  test('reassembles multibyte characters split across byte chunks', async () => {
    const bytes = enc.encode('{"s":"café \u{1F600}"}\n');
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i++) chunks.push(bytes.slice(i, i + 1));
    expect(await collectFrames(from(chunks))).toEqual([{ s: 'café \u{1F600}' }]);
  });

  test('handles CRLF and blank lines', async () => {
    expect(await collectFrames(from(['{"a":1}\r\n\n', '{"b":2}\r\n']))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('flushes a final frame without trailing newline', async () => {
    expect(await collectFrames(from([enc.encode('{"a":1}\n{"b":2}')]))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('empty source yields nothing', async () => {
    expect(await collectFrames(from([]))).toEqual([]);
  });

  test('rejects malformed JSON', async () => {
    await expect(collectFrames(from(['{"a":1}\n', 'not json\n']))).rejects.toThrow();
  });

  test('keeps frames delivered before a later failure', async () => {
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const frame of streamFrames(from(['{"a":1}\n', '{bad\n']))) seen.push(frame);
      })(),
    ).rejects.toThrow();
    expect(seen).toEqual([{ a: 1 }]);
  });

  test('rejects truncated final frame', async () => {
    await expect(collectFrames(from(['{"a":1}\n{"b":']))).rejects.toThrow();
  });

  test('enforces maxFrameBytes across chunks', async () => {
    const chunks = ['{"a":"', 'xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxxxxxxx', '"}\n'];
    await expect(collectFrames(from(chunks), { maxFrameBytes: 32 })).rejects.toThrow('maxFrameBytes exceeded');
    expect(await collectFrames(from(chunks), { maxFrameBytes: 64 })).toHaveLength(1);
  });

  test('enforces maxFrames', async () => {
    await expect(
      collectFrames(from(['{"a":1}\n{"a":2}\n{"a":3}\n']), { maxFrames: 2 }),
    ).rejects.toThrow('maxFrames exceeded');
  });

  test('rejects invalid UTF-8 bytes inside a string with TypeError', async () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0x73, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]);
    await expect(collectFrames(from([bytes]))).rejects.toThrow(TypeError);
  });

  test('rejects an incomplete UTF-8 sequence at end of stream with TypeError', async () => {
    const chunks = [enc.encode('{"a":1}\n'), new Uint8Array([0xc3])];
    await expect(collectFrames(from(chunks))).rejects.toThrow(TypeError);
  });

  test('rejects an incomplete UTF-8 sequence followed by a string chunk with TypeError', async () => {
    const chunks = [enc.encode('{"s":"'), new Uint8Array([0xc3]), 'x', new Uint8Array([0xa9]), enc.encode('"}\n')];
    await expect(collectFrames(from(chunks))).rejects.toThrow(TypeError);
    const yielded: unknown[] = [];
    const run = async () => {
      for await (const frame of streamFrames(from(chunks))) yielded.push(frame);
    };
    await expect(run()).rejects.toThrow(TypeError);
    expect(yielded).toEqual([]);
  });

  test('keeps U+FEFF at the start of a byte chunk that follows a string chunk', async () => {
    const chunks = ['{"s":"', enc.encode('\uFEFFx"}\n')];
    expect(await collectFrames(from(chunks))).toEqual([{ s: '\uFEFFx' }]);
  });

  test('strips a leading BOM at the start of the stream', async () => {
    const chunks = [new Uint8Array([0xef]), new Uint8Array([0xbb, 0xbf]), enc.encode('{"a":1}\n')];
    expect(await collectFrames(from(chunks))).toEqual([{ a: 1 }]);
  });

  test('accepts mixed string and byte chunks at character boundaries', async () => {
    const chunks = ['{"a":1}\n', enc.encode('{"s":"\u00e9"}\n'), '{"b":2}\n'];
    expect(await collectFrames(from(chunks))).toEqual([{ a: 1 }, { s: '\u00e9' }, { b: 2 }]);
  });

  test('rejects unsupported chunk types', async () => {
    await expect(collectFrames(from([42]))).rejects.toThrow(TypeError);
  });

  test('rejects a non-async-iterable source', async () => {
    await expect(collectFrames(['{"a":1}\n'] as never)).rejects.toThrow(TypeError);
    await expect(collectFrames(null as never)).rejects.toThrow(TypeError);
  });

  test('rejects invalid decoder options', async () => {
    await expect(collectFrames(from([]), { maxFrames: 0 })).rejects.toThrow(RangeError);
  });

  test('closes the source when the consumer stops early', async () => {
    let closed = false;
    async function* source() {
      try {
        yield '{"n":1}\n{"n":2}\n';
        yield '{"n":3}\n';
      } finally {
        closed = true;
      }
    }
    for await (const frame of streamFrames(source())) {
      expect(frame).toEqual({ n: 1 });
      break;
    }
    expect(closed).toBe(true);
  });

  test('closes the source when decoding fails', async () => {
    let closed = false;
    async function* source() {
      try {
        yield 'oops\n';
        yield '{"n":1}\n';
      } finally {
        closed = true;
      }
    }
    await expect(collectFrames(source())).rejects.toThrow();
    expect(closed).toBe(true);
  });

  test('works with a web ReadableStream of bytes', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('{"a":1}\n{"b'));
        controller.enqueue(enc.encode('":2}\n'));
        controller.close();
      },
    });
    expect(await collectFrames(stream as never)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('reassembles a 4-byte emoji split byte by byte across Buffer chunks', async () => {
    const bytes = Buffer.from('{"s":"a\u{1F600}b"}\n');
    const chunks = Array.from(bytes, (_, i) => bytes.subarray(i, i + 1));
    expect(chunks.every((c) => Buffer.isBuffer(c))).toBe(true);
    expect(await collectFrames(from(chunks))).toEqual([{ s: 'a\u{1F600}b' }]);
  });

  test('reassembles 2-byte and 3-byte characters split between Buffer chunks', async () => {
    const bytes = Buffer.from('{"s":"é€"}\n{"t":"中"}\n');
    for (let cut = 1; cut < bytes.length; cut++) {
      const chunks = [bytes.subarray(0, cut), bytes.subarray(cut)];
      expect(await collectFrames(from(chunks))).toEqual([{ s: 'é€' }, { t: '中' }]);
    }
  });

  test('accepts Buffer chunks that hold several frames and a partial character', async () => {
    const emoji = Buffer.from('\u{1F600}');
    const chunks = [
      Buffer.concat([Buffer.from('{"a":1}\n{"s":"'), emoji.subarray(0, 3)]),
      Buffer.concat([emoji.subarray(3), Buffer.from('"}\n{"b":2}\n')]),
    ];
    expect(await collectFrames(from(chunks))).toEqual([{ a: 1 }, { s: '\u{1F600}' }, { b: 2 }]);
  });

  test('preserves order of mixed string and Buffer chunks at character boundaries', async () => {
    const chunks = ['{"s":"', Buffer.from('\u{1F600}'), 'é', Buffer.from('é'), '"}\n'];
    expect(await collectFrames(from(chunks))).toEqual([{ s: '\u{1F600}éé' }]);
  });

  test('rejects a string chunk that arrives while a multibyte sequence is pending', async () => {
    const chunks = [Buffer.from('{"s":"'), Buffer.from([0xf0, 0x9f]), 'x', Buffer.from([0x98, 0x80]), Buffer.from('"}\n')];
    const yielded: unknown[] = [];
    const run = async () => {
      for await (const frame of streamFrames(from(chunks))) yielded.push(frame);
    };
    await expect(run()).rejects.toThrow(TypeError);
    expect(yielded).toEqual([]);
  });

  test('rejects a string chunk after a partial sequence even when more Buffers follow', async () => {
    const chunks = [Buffer.from('{"a":1}\n'), Buffer.from([0xe2, 0x82]), '{"b":2}\n', Buffer.from([0xac])];
    const yielded: unknown[] = [];
    const run = async () => {
      for await (const frame of streamFrames(from(chunks))) yielded.push(frame);
    };
    await expect(run()).rejects.toThrow(TypeError);
    expect(yielded).toEqual([{ a: 1 }]);
  });

  test('fails the stream on a trailing partial sequence in Buffer chunks', async () => {
    const emoji = Buffer.from('\u{1F600}');
    for (let keep = 1; keep < 4; keep++) {
      const chunks = [Buffer.from('{"a":1}\n'), emoji.subarray(0, keep)];
      const yielded: unknown[] = [];
      const run = async () => {
        for await (const frame of streamFrames(from(chunks))) yielded.push(frame);
      };
      await expect(run()).rejects.toThrow(TypeError);
      expect(yielded).toEqual([{ a: 1 }]);
    }
  });

  test('fails the stream on an invalid byte in a Buffer chunk', async () => {
    const chunks = [Buffer.from('{"s":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')];
    await expect(collectFrames(from(chunks))).rejects.toThrow(TypeError);
    await expect(collectFrames(from([Buffer.from([0x7b, 0xff, 0x7d, 0x0a])]))).rejects.toThrow(TypeError);
  });

  test('accepts a literal U+FFFD encoded in Buffer chunks', async () => {
    const bytes = Buffer.from('{"s":"�"}\n');
    const chunks = Array.from(bytes, (_, i) => bytes.subarray(i, i + 1));
    expect(await collectFrames(from(chunks))).toEqual([{ s: '�' }]);
  });

  test('flushes the final frame decoded from Buffer chunks without a trailing newline', async () => {
    const bytes = Buffer.from('{"a":1}\n{"s":"\u{1F600}"}');
    const chunks = Array.from(bytes, (_, i) => bytes.subarray(i, i + 1));
    expect(await collectFrames(from(chunks))).toEqual([{ a: 1 }, { s: '\u{1F600}' }]);
  });

  test('enforces maxFrameBytes across Buffer chunks', async () => {
    const chunks = [Buffer.from('{"a":"'), Buffer.from('x'.repeat(10)), Buffer.from('x'.repeat(10)), Buffer.from('x'.repeat(10)), Buffer.from('"}\n')];
    await expect(collectFrames(from(chunks), { maxFrameBytes: 32 })).rejects.toThrow('maxFrameBytes exceeded');
    expect(await collectFrames(from(chunks), { maxFrameBytes: 64 })).toHaveLength(1);
  });

  test('counts maxFrameBytes in bytes for multibyte Buffer content', async () => {
    const line = Buffer.from(`{"s":"${'é'.repeat(10)}"}`);
    const chunks = [line.subarray(0, 9), line.subarray(9), Buffer.from('\n')];
    expect(line.length).toBe(28);
    await expect(collectFrames(from(chunks), { maxFrameBytes: 27 })).rejects.toThrow('maxFrameBytes exceeded');
    expect(await collectFrames(from(chunks), { maxFrameBytes: 28 })).toEqual([{ s: 'é'.repeat(10) }]);
  });

  test('enforces maxFrames across Buffer chunks', async () => {
    const chunks = [Buffer.from('{"a":1}\n{"a'), Buffer.from('":2}\n{"a":3'), Buffer.from('}\n')];
    await expect(collectFrames(from(chunks), { maxFrames: 2 })).rejects.toThrow('maxFrames exceeded');
    expect(await collectFrames(from(chunks), { maxFrames: 3 })).toHaveLength(3);
  });

  test('delivers earlier frames and propagates an upstream failure from Buffer chunks', async () => {
    const boom = new Error('upstream boom');
    async function* source() {
      yield Buffer.from('{"a":1}\n{"b"');
      throw boom;
    }
    const seen: unknown[] = [];
    const run = async () => {
      for await (const frame of streamFrames(source())) seen.push(frame);
    };
    await expect(run()).rejects.toBe(boom);
    expect(seen).toEqual([{ a: 1 }]);
  });

  test('propagates an upstream failure that interrupts a multibyte sequence', async () => {
    const boom = new Error('upstream boom');
    async function* source() {
      yield Buffer.from('{"a":1}\n');
      yield Buffer.from([0xf0, 0x9f]);
      throw boom;
    }
    await expect(collectFrames(source())).rejects.toBe(boom);
  });

  function fakeUpstream(chunks: unknown[]) {
    const state = { returned: 0, pulled: 0 };
    const iterator = {
      next: async () => {
        if (state.pulled >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: chunks[state.pulled++] };
      },
      return: async () => {
        state.returned++;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return { state, iterator };
  }

  test('calls return on the upstream when the consumer breaks mid-frame', async () => {
    const { state, iterator } = fakeUpstream([
      Buffer.concat([Buffer.from('{"n":1}\n{"n":'), Buffer.from([0xf0, 0x9f])]),
      Buffer.from([0x98, 0x80, 0x7d, 0x0a]),
      Buffer.from('{"n":3}\n'),
    ]);
    const seen: unknown[] = [];
    for await (const frame of streamFrames(iterator as never)) {
      seen.push(frame);
      break;
    }
    expect(seen).toEqual([{ n: 1 }]);
    expect(state.returned).toBe(1);
    expect(state.pulled).toBe(1);
  });

  test('calls return on the upstream when the consumer returns the generator early', async () => {
    const { state, iterator } = fakeUpstream([Buffer.from('{"n":1}\n'), Buffer.from('{"n":2}\n')]);
    const it = streamFrames(iterator as never);
    expect((await it.next()).value).toEqual({ n: 1 });
    await it.return(undefined);
    expect(state.returned).toBe(1);
    expect(state.pulled).toBe(1);
  });

  test('calls return on the upstream when a Buffer chunk is invalid UTF-8', async () => {
    const { state, iterator } = fakeUpstream([Buffer.from('{"n":1}\n'), Buffer.from([0xff]), Buffer.from('{"n":2}\n')]);
    await expect(collectFrames(iterator as never)).rejects.toThrow(TypeError);
    expect(state.returned).toBe(1);
  });

  test('does not call return on the upstream when it completes normally', async () => {
    const { state, iterator } = fakeUpstream([Buffer.from('{"n":1}\n')]);
    expect(await collectFrames(iterator as never)).toEqual([{ n: 1 }]);
    expect(state.returned).toBe(0);
  });

  for (const { name, input, options, error } of [
    { name: 'malformed JSON', input: '{"a":1}\n{bad\n', options: {}, error: SyntaxError },
    { name: 'maxFrames', input: '{"a":1}\n{"a":2}\n', options: { maxFrames: 1 }, error: RangeError },
    { name: 'maxFrameBytes', input: '{"a":1}\n{"s":"xxxxxxxx"}\n', options: { maxFrameBytes: 7 }, error: RangeError },
  ]) {
    test(`delivers earlier frames before ${name} in one or many chunks`, async () => {
      for (const chunk of [input, Buffer.from(input), enc.encode(input)]) {
        for (const chunks of [[chunk], Array.from({ length: chunk.length }, (_, i) => chunk.slice(i, i + 1))]) {
          const seen: unknown[] = [];
          const run = async () => {
            for await (const frame of streamFrames(from(chunks), options)) seen.push(frame);
          };
          await expect(run()).rejects.toThrow(error);
          expect(seen).toEqual([{ a: 1 }]);
        }
      }
    });
  }

  test('delivers earlier frames before invalid UTF-8 in one or many chunks', async () => {
    const bytes = Buffer.concat([Buffer.from('{"a":1}\n'), Buffer.from([0xff])]);
    for (const chunk of [bytes, new Uint8Array(bytes)]) {
      for (const chunks of [[chunk], Array.from(chunk, (_, i) => chunk.subarray(i, i + 1))]) {
        const seen: unknown[] = [];
        const run = async () => {
          for await (const frame of streamFrames(from(chunks))) seen.push(frame);
        };
        await expect(run()).rejects.toThrow(TypeError);
        expect(seen).toEqual([{ a: 1 }]);
      }
    }
  });

  test('preserves a second BOM whether the BOMs share a chunk or are split', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const bytes = Buffer.concat([bom, bom, Buffer.from('{}\n')]);
    for (const chunks of [
      [bytes],
      [bom, Buffer.concat([bom, Buffer.from('{}\n')])],
      Array.from(bytes, (_, i) => bytes.subarray(i, i + 1)),
    ]) {
      await expect(collectFrames(from(chunks))).rejects.toThrow(SyntaxError);
    }
  });

  test('accepts a final carriage return at maxFrameBytes like CRLF', async () => {
    const frame = '{"a":1}';
    for (const ending of ['\r', '\r\n']) {
      for (const chunk of [frame + ending, Buffer.from(frame + ending)]) {
        for (const chunks of [[chunk], Array.from({ length: chunk.length }, (_, i) => chunk.slice(i, i + 1))]) {
          expect(await collectFrames(from(chunks), { maxFrameBytes: 7 })).toEqual([{ a: 1 }]);
        }
      }
    }
  });

  test('counts a string surrogate pair split across chunks as four UTF-8 bytes', async () => {
    for (const ending of ['\n', '']) {
      const chunks = ['{"s":"\ud83d', '\ude00"}' + ending];
      expect(await collectFrames(from(chunks), { maxFrameBytes: 12 })).toEqual([{ s: '😀' }]);
      await expect(collectFrames(from(chunks), { maxFrameBytes: 11 })).rejects.toThrow('maxFrameBytes exceeded');
    }
  });

  test('calls push once for a 64 KB line delivered in one-byte chunks', async () => {
    const value = 'x'.repeat(64 * 1024 - 8);
    const bytes = Buffer.from(JSON.stringify({ s: value }) + '\n');
    const createFrameDecoder = pilot.createFrameDecoder;
    let pushes = 0;
    const factory = spyOn(pilot, 'createFrameDecoder').mockImplementation((options) => {
      const decoder = createFrameDecoder(options);
      const push = decoder.push;
      decoder.push = (chunk: string) => {
        pushes++;
        return push(chunk);
      };
      return decoder;
    });
    try {
      async function* source() {
        for (let i = 0; i < bytes.length; i++) yield bytes.subarray(i, i + 1);
      }
      expect(await collectFrames(source(), { maxFrameBytes: bytes.length - 1 })).toEqual([{ s: value }]);
      expect(pushes).toBe(1);
    } finally {
      factory.mockRestore();
    }
  });
});
