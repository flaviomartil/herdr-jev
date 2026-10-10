import { createFrameStream } from './pilot-stream.js';
import { createIngestMetrics } from './pilot-metrics.js';

export async function ingestFrames(source, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Ingest options must be an object');
  }
  const { onFrame, metrics = createIngestMetrics(), ...streamOptions } = options;
  if (onFrame !== undefined && typeof onFrame !== 'function') {
    throw new TypeError('onFrame must be a function');
  }
  const stream = createFrameStream(source, { ...streamOptions, metrics });
  if (metrics.status !== 'idle') throw new Error('Ingest metrics must be idle');

  const frames = [];
  let delivered = 0;
  let error = null;
  let stoppedByConsumer = false;
  let consumerFailed = false;

  try {
    for await (const frame of stream.frames) {
      if (!onFrame) {
        frames.push(frame);
        delivered += 1;
        continue;
      }
      let keepGoing;
      try {
        keepGoing = await onFrame(frame, delivered);
      } catch (caught) {
        consumerFailed = true;
        error = caught;
        if (metrics.status === 'running') metrics.recordError(caught);
        break;
      }
      delivered += 1;
      if (keepGoing === false) {
        stoppedByConsumer = true;
        break;
      }
    }
  } catch (caught) {
    error = caught;
  }

  let status = 'completed';
  if (consumerFailed) status = 'failed';
  else if (stream.outcome === 'failed') status = 'failed';
  else if (stream.outcome === 'cancelled') status = 'cancelled';

  return { status, frames, delivered, error, stoppedByConsumer, metrics: metrics.snapshot() };
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
