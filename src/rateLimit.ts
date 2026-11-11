/** Fixed-window limiter per key (client IP). In memory: resets on restart, which is fine here. */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      if (this.windows.size > 10_000) this.prune(t);
      this.windows.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    w.count += 1;
    return w.count <= this.max;
  }

  private prune(t: number) {
    for (const [key, w] of this.windows) if (w.resetAt <= t) this.windows.delete(key);
  }
}
