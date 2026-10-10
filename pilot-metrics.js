const STATUSES = new Set(['idle', 'running', 'completed', 'failed', 'cancelled']);

function byteSize(chunk) {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, 'utf8');
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  throw new TypeError('Chunk must be a string, ArrayBuffer or ArrayBuffer view');
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
      state.chunks += 1;
      state.bytes += byteSize(chunk);
    },
    recordFrames(count) {
      if (state.status !== 'running') throw new Error('Metrics not running');
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Frame count must be a non-negative safe integer');
      state.frames += count;
    },
    recordError(error) {
      state.errors += 1;
      state.errorName = error && typeof error === 'object' && 'name' in error ? String(error.name) : 'Error';
      state.errorMessage = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
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
