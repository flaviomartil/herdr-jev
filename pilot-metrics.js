const STATUSES = new Set(['idle', 'running', 'completed', 'failed', 'cancelled']);

function byteSize(chunk) {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, 'utf8');
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  throw new TypeError('Chunk must be a string, ArrayBuffer or ArrayBuffer view');
}

function safeString(value, fallback) {
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

function describeError(error) {
  const isObject = error !== null && typeof error === 'object';
  const name = isObject && 'name' in error ? safeString(error.name, 'Error') : 'Error';
  const message = isObject && 'message' in error ? safeString(error.message, '') : safeString(error, '');
  return { name, message };
}

export function createIngestMetrics(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Metrics options must be an object');
  }
  const { now = () => performance.now() } = options;
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const state = {
    status: 'idle',
    bytes: 0,
    chunks: 0,
    frames: 0,
    errors: 0,
    errorName: null,
    errorMessage: null,
    startedAt: null,
    endedAt: null,
  };

  function close(status) {
    if (!STATUSES.has(status)) throw new RangeError(`Unknown status: ${status}`);
    if (state.status !== 'running') throw new Error(`Cannot move from ${state.status} to ${status}`);
    state.status = status;
    state.endedAt = now();
  }

  return {
    start() {
      if (state.status !== 'idle') throw new Error('Metrics already started');
      state.status = 'running';
      state.startedAt = now();
    },
    recordChunk(chunk) {
      if (state.status !== 'running') throw new Error('Metrics not running');
      const size = byteSize(chunk);
      state.chunks += 1;
      state.bytes += size;
    },
    recordFrames(count) {
      if (state.status !== 'running') throw new Error('Metrics not running');
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Frame count must be a non-negative safe integer');
      state.frames += count;
    },
    recordError(error) {
      if (state.status !== 'running') throw new Error(`Cannot move from ${state.status} to failed`);
      const { name, message } = describeError(error);
      state.errors += 1;
      state.errorName = name;
      state.errorMessage = message;
      close('failed');
    },
    recordCancel() {
      close('cancelled');
    },
    finish() {
      close('completed');
    },
    get status() {
      return state.status;
    },
    snapshot() {
      const endedAt = state.endedAt ?? (state.startedAt === null ? null : now());
      return {
        ...state,
        durationMs: state.startedAt === null ? null : endedAt - state.startedAt,
      };
    },
  };
}

export { byteSize };
