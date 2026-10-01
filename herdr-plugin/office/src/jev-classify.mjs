import { spawn } from 'node:child_process';
import { summarize } from './summary.mjs';

const cache = new Map();
let inflight = null;

export function jevClassificationEnabled(env = process.env, argv = process.argv) {
  if (Array.isArray(env)) {
    argv = env;
    env = process.env;
  }
  if (argv?.includes?.('--demo')) {
    return false;
  }
  const raw = env?.HERDR_JEV_OFFICE_JEV;
  if (raw !== undefined) {
    const val = String(raw).trim().toLowerCase();
    if (val === '0' || val === 'false' || val === 'off') {
      return false;
    }
  }
  return true;
}

export async function classifyPane(paneId, revision, person, outputLines) {
  if (!jevClassificationEnabled()) {
    return { summary: summarize(person, outputLines), state: null, attention: null };
  }

  const key = `${paneId}:${revision}`;
  if (cache.has(key)) {
    return cache.get(key);
  }

  const defaultSummary = summarize(person, outputLines);
  const fallback = { summary: defaultSummary, state: null, attention: null };

  if (inflight) return fallback;

  inflight = new Promise((resolve) => {
    const herdrJevBin = process.env.HERDR_JEV_BIN || 'herdr-jev';
    const child = spawn(herdrJevBin, ['classify-pane', '--json'], {
      stdio: ['pipe', 'pipe', 'ignore']
    });

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (e) {}
      resolve(fallback);
    }, 3000);
    timer.unref?.();

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0 && stdout) {
        try {
          const ans = JSON.parse(stdout);
          const result = {
            summary: defaultSummary,
            state: ans.state?.choice === 'unknown' ? null : ans.state?.choice,
            attention: ans.attention,
            confidence: ans.state?.confidence ?? 0,
            confidence: ans.confidence,
            blockedReason: ans.blockedReason?.choice
          };
          cache.set(key, result);
          resolve(result);
          return;
        } catch (e) {}
      }
      resolve(fallback);
    });

    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(fallback);
    });

    child.stdin.write(JSON.stringify({
      paneText: outputLines.join('\n'),
      agent: person.kind || 'unknown',
      status: person.status
    }));
    child.stdin.end();
  });

  const res = await inflight;
  inflight = null;
  return res;
}
