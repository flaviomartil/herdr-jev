import { createFrameDecoder } from './pilot.js';

export async function* streamFrames(source, options = {}) {
  if (source === null || source === undefined || typeof source[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('Source must be an async iterable');
  }
  const frames = createFrameDecoder(options);
  const { maxFrameBytes = 4096 } = options;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let started = false;
  let parts = [];
  let lineBytes = 0;
  let lastCode = 0;

  function append(piece) {
    if (!piece) return;
    const firstCode = piece.charCodeAt(0);
    lineBytes += Buffer.byteLength(piece, 'utf8');
    if (lastCode >= 0xd800 && lastCode <= 0xdbff && firstCode >= 0xdc00 && firstCode <= 0xdfff) {
      lineBytes -= 2;
    }
    lastCode = piece.charCodeAt(piece.length - 1);
    if (lineBytes - (lastCode === 0x0d ? 1 : 0) > maxFrameBytes) {
      throw new RangeError('maxFrameBytes exceeded');
    }
    parts.push(piece);
  }

  for await (const chunk of source) {
    const bytes = chunk instanceof Uint8Array;
    if (!bytes && typeof chunk !== 'string') {
      throw new TypeError('Chunk must be a string or Uint8Array');
    }
    if (!bytes) decoder.decode();
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(bytes ? 0x0a : '\n', offset);
      const stop = newline === -1 ? chunk.length : newline + 1;
      let piece = bytes
        ? decoder.decode(chunk.subarray(offset, stop), { stream: true })
        : chunk.slice(offset, stop);
      if (!started && piece) {
        started = true;
        if (bytes && piece.charCodeAt(0) === 0xfeff) piece = piece.slice(1);
      }
      if (newline !== -1) piece = piece.slice(0, -1);
      append(piece);
      if (newline !== -1) {
        const line = parts.join('') + '\n';
        parts = [];
        lineBytes = 0;
        lastCode = 0;
        for (const frame of frames.push(line)) yield frame;
      }
      offset = stop;
    }
  }
  decoder.decode();
  if (parts.length) {
    const tail = parts.join('');
    frames.push(tail.endsWith('\r') ? tail.slice(0, -1) : tail);
  }
  for (const frame of frames.end()) yield frame;
}

export async function collectFrames(source, options = {}) {
  const frames = [];
  for await (const frame of streamFrames(source, options)) frames.push(frame);
  return frames;
}
