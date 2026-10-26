/** In-memory failure counter per key (client IP) with a time window and a hard cap on tracked keys. */
export class FailureLimiter {
  private readonly hits = new Map<string, { n: number; until: number }>();
  constructor(private readonly opts: { max: number; windowMs: number; maxEntries: number }) {}

  get size(): number {
    return this.hits.size;
  }

  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    return !!h && h.until > now && h.n >= this.opts.max;
  }

  fail(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    const n = h && h.until > now ? h.n + 1 : 1;
    this.hits.delete(key); // re-insert so Map order is least-recently-failed first
    this.hits.set(key, { n, until: now + this.opts.windowMs });
    if (this.hits.size > this.opts.maxEntries) {
      for (const [k, v] of this.hits) if (v.until <= now) this.hits.delete(k);
      while (this.hits.size > this.opts.maxEntries) this.hits.delete(this.hits.keys().next().value!);
    }
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}
