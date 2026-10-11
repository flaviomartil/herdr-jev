export const DEFAULT_MAX_FRAME_BYTES = 4096;
export const DEFAULT_MAX_FRAMES = 100;

const DECODER_OPTIONS = new Set(['maxFrameBytes', 'maxFrames']);

export function parseFrames(text) {
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function appendedBytes(lastCode, segment) {
  if (segment.length === 0) return 0;
  if (isHighSurrogate(lastCode) && isLowSurrogate(segment.charCodeAt(0))) {
    return Buffer.byteLength(String.fromCharCode(lastCode) + segment, 'utf8') - 3;
  }
  return Buffer.byteLength(segment, 'utf8');
}

export function createFrameDecoder(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Decoder options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (!DECODER_OPTIONS.has(key)) throw new TypeError(`Unknown decoder option: ${key}`);
  }
  const { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, maxFrames = DEFAULT_MAX_FRAMES } = options;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0 ||
      !Number.isSafeInteger(maxFrames) || maxFrames <= 0) {
    throw new RangeError('Decoder limits must be positive safe integers');
  }

  let pending = '';
  let pendingBytes = 0;
  let lastCode = -1;
  let frames = 0;
  let closed = false;
  let deferred = null;

  function frameBytes() {
    return lastCode === 13 ? pendingBytes - 1 : pendingBytes;
  }

  function clearPending() {
    pending = '';
    pendingBytes = 0;
    lastCode = -1;
  }

  function readFrame(records) {
    if (pending.trim()) {
      if (frames >= maxFrames) throw new RangeError('maxFrames exceeded');
      records.push(JSON.parse(pending));
      frames++;
    }
    clearPending();
  }

  function fail(error) {
    closed = true;
    clearPending();
    return error;
  }

  function throwDeferred() {
    if (deferred) {
      const error = deferred;
      deferred = null;
      throw error;
    }
  }

  return {
    reset() {
      clearPending();
      frames = 0;
      closed = false;
      deferred = null;
    },
    push(chunk) {
      throwDeferred();
      if (closed) throw new Error('Frame decoder is closed');
      if (typeof chunk !== 'string') throw new TypeError('Chunk must be a string');
      const records = [];
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf('\n', offset);
          const stop = newline === -1 ? chunk.length : newline;
          if (pending.length + stop - offset > maxFrameBytes + 1) {
            throw new RangeError('maxFrameBytes exceeded');
          }
          const segment = chunk.slice(offset, stop);
          if (segment.length > 0) {
            pendingBytes += appendedBytes(lastCode, segment);
            pending += segment;
            lastCode = segment.charCodeAt(segment.length - 1);
          }
          if (frameBytes() > maxFrameBytes) {
            throw new RangeError('maxFrameBytes exceeded');
          }
          if (newline === -1) break;
          readFrame(records);
          offset = newline + 1;
        }
      } catch (error) {
        fail(error);
        if (records.length === 0) throw error;
        deferred = error;
      }
      return records;
    },
    end() {
      throwDeferred();
      if (closed) throw new Error('Frame decoder is closed');
      closed = true;
      const records = [];
      try {
        if (frameBytes() > maxFrameBytes) {
          throw new RangeError('maxFrameBytes exceeded');
        }
        if (lastCode === 13) {
          pending = pending.slice(0, -1);
          pendingBytes -= 1;
        }
        readFrame(records);
        return records;
      } finally {
        clearPending();
      }
    },
  };
}
