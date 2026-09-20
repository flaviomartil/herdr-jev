import { createHash } from "node:crypto";

/**
 * Fast in-process LRU cache for Jev evaluation and routing decisions.
 * Avoids repeated API round-trips for identical queries and states.
 */
export class Lru<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max = 256) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    // Re-insert so the most recently used entry sits at the tail
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }
}

export function hashKey(prefix: string, payload: unknown): string {
  return createHash("sha256")
    .update(prefix)
    .update("::")
    .update(typeof payload === "string" ? payload : JSON.stringify(payload))
    .digest("hex")
    .slice(0, 32);
}
