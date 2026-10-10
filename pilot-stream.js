import { createFrameDecoder } from './pilot.js';
import { byteSize } from './pilot-metrics.js';

function abortError(signal) {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('Frame stream aborted', 'AbortError');
}

export function isAbortError(error) {
  return Boolean(error) && typeof error === 'object' && error.name === 'AbortError';
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

export function validateStreamOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Stream options must be an object');
  }
  const { signal, maxBytes = Infinity, metrics, ...decoderOptions } = options;
  if (signal !== undefined && (typeof signal !== 'object' || signal === null || typeof signal.aborted !== 'boolean')) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new RangeError('maxBytes must be Infinity or a positive safe integer');
  }
  if (metrics !== undefined && (metrics === null || typeof metrics !== 'object')) {
    throw new TypeError('metrics must be an object');
  }
  createFrameDecoder(decoderOptions);
  return { signal, maxBytes, metrics, decoderOptions };
}

export async function* decodeFrames(source, options = {}) {
  const { signal, maxBytes, metrics, decoderOptions } = validateStreamOptions(options);
  const decoder = createFrameDecoder(decoderOptions);
  const textDecoder = new TextDecoder('utf-8', { fatal: true });

  let rejectAbort = null;
  const abortPromise = signal
    ? new Promise((_, reject) => { rejectAbort = reject; })
    : null;
  if (abortPromise) abortPromise.catch(() => {});
  const onAbort = () => rejectAbort(abortError(signal));

  let iterator = null;
  let bytes = 0;
  let upstreamDone = false;
  let upstreamFailed = false;
  let pendingNext = false;
  let outcome = 'cancelled';

  function throwIfAborted() {
    if (signal?.aborted) throw abortError(signal);
  }

  function emit(frames) {
    metrics?.recordFrames?.(frames.length);
    return frames;
  }

  try {
    metrics?.start?.();
    throwIfAborted();
    iterator = getIterator(source);
    signal?.addEventListener('abort', onAbort, { once: true });

    while (true) {
      throwIfAborted();
      pendingNext = true;
      const nextPromise = Promise.resolve().then(() => iterator.next());
      nextPromise.then(() => { pendingNext = false; }, () => { pendingNext = false; upstreamFailed = true; });
      const result = abortPromise
        ? await Promise.race([nextPromise, abortPromise])
        : await nextPromise;
      if (result.done) {
        upstreamDone = true;
        break;
      }
      throwIfAborted();
      const chunk = result.value;
      bytes += byteSize(chunk);
      if (bytes > maxBytes) throw new RangeError('maxBytes exceeded');
      metrics?.recordChunk?.(chunk);
      const text = toText(chunk, textDecoder);
      for (const frame of emit(decoder.push(text))) {
        throwIfAborted();
        yield frame;
      }
    }

    const tail = textDecoder.decode();
    if (tail) {
      for (const frame of emit(decoder.push(tail))) {
        throwIfAborted();
        yield frame;
      }
    }
    for (const frame of emit(decoder.end())) {
      throwIfAborted();
      yield frame;
    }
    outcome = 'completed';
    metrics?.finish?.();
  } catch (error) {
    outcome = signal?.aborted || isAbortError(error) ? 'cancelled' : 'failed';
    if (metrics?.status === 'running') {
      if (outcome === 'cancelled') metrics.recordCancel?.();
      else metrics.recordError?.(error);
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (outcome === 'cancelled' && metrics?.status === 'running') metrics.recordCancel?.();
    if (iterator && !upstreamDone && !upstreamFailed && typeof iterator.return === 'function') {
      const closing = Promise.resolve().then(() => iterator.return()).catch(() => {});
      if (!pendingNext) await closing;
    }
  }
}

export async function collectFrames(source, options = {}) {
  const frames = [];
  for await (const frame of decodeFrames(source, options)) frames.push(frame);
  return frames;
}
