export function parseFrames(text) {
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function createFrameDecoder(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Decoder options must be an object');
  }
  const { maxFrameBytes = 4096, maxFrames = 100 } = options;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0 ||
      !Number.isSafeInteger(maxFrames) || maxFrames <= 0) {
    throw new RangeError('Decoder limits must be positive safe integers');
  }

  let pending = '';
  let frames = 0;
  let closed = false;

  function readFrame(records) {
    if (pending.trim()) {
      if (frames >= maxFrames) throw new RangeError('maxFrames exceeded');
      records.push(JSON.parse(pending));
      frames++;
    }
    pending = '';
  }

  return {
    reset() {
      pending = '';
      frames = 0;
      closed = false;
    },
    push(chunk) {
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
          pending += chunk.slice(offset, stop);
          const frame = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
          if (Buffer.byteLength(frame, 'utf8') > maxFrameBytes) {
            throw new RangeError('maxFrameBytes exceeded');
          }
          if (newline === -1) break;
          readFrame(records);
          offset = newline + 1;
        }
      } catch (error) {
        closed = true;
        pending = '';
        throw error;
      }
      return records;
    },
    end() {
      if (closed) throw new Error('Frame decoder is closed');
      closed = true;
      const records = [];
      try {
        if (Buffer.byteLength(pending, 'utf8') > maxFrameBytes) {
          throw new RangeError('maxFrameBytes exceeded');
        }
        readFrame(records);
        return records;
      } finally {
        pending = '';
      }
    },
  };
}
