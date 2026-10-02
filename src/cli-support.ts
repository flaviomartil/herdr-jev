export function parseListLimit(value: string): number {
  const limit = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(limit)) throw new Error("invalid_limit");
  return limit;
}

export function peerBroadcastFailed(output: string): boolean {
  let items: unknown;
  try { items = JSON.parse(output); } catch { return true; }
  return !Array.isArray(items) || items.some((item) => !item || typeof item !== "object" || !(item as { acknowledged?: unknown }).acknowledged);
}
