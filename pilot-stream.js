import { createFrameDecoder } from './pilot.js';
import { byteSize } from './pilot-metrics.js';

const DECODER_OPTIONS = new Set(['maxFrameBytes', 'maxFrames']);
const METRICS_METHODS = ['start', 'recordChunk', 'recordFrames', 'recordError', 'recordCancel', 'finish', 'snapshot'];

function abortError(signal) {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('Frame stream aborted', 'AbortError');
}

export function isAbortError(error) {
  return Boolean(error) && typeof error === 'object' && error.name === 'AbortError';
}

function isAbortSignal(signal) {
  return typeof signal === 'object' && signal !== null &&
    typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function';
}

function isMetrics(metrics) {
  return typeof metrics === 'object' && metrics !== null &&
    typeof metrics.status === 'string' &&
    METRICS_METHODS.every((name) => typeof metrics[name] === 'function');
}

function getIterator(source) {
  if (source === null || source === undefined) throw new TypeError('Source must be iterable');
  if (typeof source[Symbol.asyncIterator] === 'function') return source[Symbol.asyncIterator]();
  if (typeof source[Symbol.iterator] === 'function') return source[Symbol.iterator]();
  throw new TypeError('Source must be an AsyncIterable or Iterable');
}

function toText(chunk, textDecoder) {
  if (typeof chunk === 'string') {
    textDecoder.decode();
    return chunk;
  }
  if (chunk instanceof ArrayBuffer) return textDecoder.decode(new Uint8Array(chunk), { stream: true });
  if (ArrayBuffer.isView(chunk)) {
    return textDecoder.decode(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), { stream: true });
  }
  throw new TypeError('Chunk must be a string, ArrayBuffer or ArrayBuffer view');
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  let onAbort = null;
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

export function validateStreamOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Stream options must be an object');
  }
  const { signal, maxBytes = Infinity, metrics, ...decoderOptions } = options;
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new RangeError('maxBytes must be Infinity or a positive safe integer');
  }
  if (metrics !== undefined && !isMetrics(metrics)) {
    throw new TypeError('metrics must implement the ingest metrics interface');
  }
  for (const key of Object.keys(decoderOptions)) {
    if (!DECODER_OPTIONS.has(key)) throw new TypeError(`Unknown stream option: ${key}`);
  }
  createFrameDecoder(decoderOptions);
  return { signal, maxBytes, metrics, decoderOptions };
}

export function createFrameStream(source, options = {}) {
  const { signal, maxBytes, metrics, decoderOptions } = validateStreamOptions(options);
  const state = { outcome: 'pending', error: undefined };

  async function* run() {
    const decoder = createFrameDecoder(decoderOptions);
    const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const maxFrameBytes = decoderOptions.maxFrameBytes ?? 4096;

    let iterator = null;
    let bytes = 0;
    let metricsStarted = false;
    let upstreamDone = false;
    let upstreamFailed = false;
    let pendingNext = false;
    let lineOpen = false;
    let heldCarriageReturn = false;
    let firstText = true;
    let outcome = 'cancelled';

    function throwIfAborted() {
      if (signal?.aborted) throw abortError(signal);
    }

    function settle(status, error) {
      if (!metricsStarted || metrics.status !== 'running') return;
      if (status === 'completed') metrics.finish();
      else if (status === 'cancelled') metrics.recordCancel();
      else metrics.recordError(error);
    }

    function pushSegment(segment) {
      if (heldCarriageReturn) {
        segment = `\r${segment}`;
        heldCarriageReturn = false;
      }
      const terminated = segment.endsWith('\n');
      if (!terminated && segment.endsWith('\r')) {
        segment = segment.slice(0, -1);
        heldCarriageReturn = true;
      }
      if (!lineOpen && terminated && segment.trim() === '') {
        if (Buffer.byteLength(segment, 'utf8') > maxFrameBytes + 1) throw new RangeError('maxFrameBytes exceeded');
        return [];
      }
      lineOpen = terminated ? false : (lineOpen || segment.length > 0);
      return segment.length > 0 ? decoder.push(segment) : [];
    }

    try {
      if (metrics) {
        metrics.start();
        metricsStarted = true;
      }
      throwIfAborted();
      iterator = getIterator(source);

      while (true) {
        throwIfAborted();
        pendingNext = true;
        let nextPromise;
        try {
          nextPromise = Promise.resolve(iterator.next());
        } catch (error) {
          pendingNext = false;
          upstreamFailed = true;
          throw error;
        }
        nextPromise.then(() => { pendingNext = false; }, () => { pendingNext = false; upstreamFailed = true; });
        const result = await raceAbort(nextPromise, signal);
        if (result.done) {
          upstreamDone = true;
          break;
        }
        throwIfAborted();
        const chunk = result.value;
        bytes += byteSize(chunk);
        if (bytes > maxBytes) throw new RangeError('maxBytes exceeded');
        metrics?.recordChunk(chunk);
        let text = toText(chunk, textDecoder);
        if (firstText && text.length > 0) {
          firstText = false;
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        }
        let offset = 0;
        while (offset < text.length) {
          const newline = text.indexOf('\n', offset);
          const stop = newline === -1 ? text.length : newline + 1;
          const frames = pushSegment(text.slice(offset, stop));
          offset = stop;
          for (const frame of frames) {
            throwIfAborted();
            metrics?.recordFrames(1);
            yield frame;
          }
        }
      }

      const tail = textDecoder.decode();
      const tailFrames = tail ? pushSegment(tail) : [];
      heldCarriageReturn = false;
      for (const frame of [...tailFrames, ...decoder.end()]) {
        throwIfAborted();
        metrics?.recordFrames(1);
        yield frame;
      }
      outcome = 'completed';
      settle('completed');
    } catch (error) {
      outcome = signal?.aborted ? 'cancelled' : 'failed';
      state.error = error;
      settle(outcome, error);
      throw error;
    } finally {
      if (outcome === 'cancelled') settle('cancelled');
      state.outcome = outcome;
      if (iterator && !upstreamDone && !upstreamFailed && typeof iterator.return === 'function') {
        const closing = Promise.resolve().then(() => iterator.return()).catch(() => {});
        if (!pendingNext && !signal?.aborted) await raceAbort(closing, signal).catch(() => {});
      }
    }
  }

  return {
    frames: run(),
    get outcome() {
      return state.outcome;
    },
    get error() {
      return state.error;
    },
  };
}

export function decodeFrames(source, options = {}) {
  return createFrameStream(source, options).frames;
}

export async function collectFrames(source, options = {}) {
  const frames = [];
  for await (const frame of decodeFrames(source, options)) frames.push(frame);
  return frames;
}
