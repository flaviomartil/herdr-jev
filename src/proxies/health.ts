import { connect } from "node:net";
import type { Proxy } from "./registry.js";

export const PROBE_TIMEOUT_MS = 1000;

export type Probe = (proxy: Proxy) => Promise<boolean>;

function tcp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export const probe: Probe = async (proxy) => {
  if (proxy.port === undefined) return false;
  if (!(await tcp(proxy.port, PROBE_TIMEOUT_MS))) return false;
  if (!proxy.health?.startsWith("/")) return true;
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}${proxy.health}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.status < 500;
  } catch {
    return false;
  }
};
