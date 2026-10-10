import { decodeFrames, isAbortError } from './pilot-stream.js';
import { createIngestMetrics } from './pilot-metrics.js';

export async function ingestFrames(source, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Ingest options must be an object');
  }
  const { onFrame, metrics = createIngestMetrics(), ...streamOptions } = options;
  if (onFrame !== undefined && typeof onFrame !== 'function') {
    throw new TypeError('onFrame must be a function');
  }
  if (metrics.status !== 'idle') throw new Error('Ingest metrics must be idle');

  const frames = [];
  let error = null;
  let stoppedByConsumer = false;
  const stream = decodeFrames(source, { ...streamOptions, metrics });

  try {
    for await (const frame of stream) {
      if (onFrame) {
        const keepGoing = await onFrame(frame, frames.length);
        if (keepGoing === false) {
          stoppedByConsumer = true;
          break;
        }
      } else {
        frames.push(frame);
      }
    }
  } catch (caught) {
    error = caught;
  }

  const snapshot = metrics.snapshot();
  const status = error
    ? (isAbortError(error) ? 'cancelled' : 'failed')
    : (stoppedByConsumer ? 'cancelled' : 'completed');

  return { status, frames, error, stoppedByConsumer, metrics: snapshot };
}

export function createIngestController() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel(reason) {
      controller.abort(reason);
    },
    get cancelled() {
      return controller.signal.aborted;
    },
  };
}
