/** Small in-memory cache with per-entry expiry and a size cap (oldest entries go first). */
export class TtlCache<V> {
  private entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private maxEntries: number) {}

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, expiresAt: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (predicate(key)) this.entries.delete(key);
  }
}
