import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decrypt, encrypt, tokenId } from './crypto.js';
import { UserConfigSchema, type UserConfig } from './userConfig.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days since the Unix epoch. Usage is only ever recorded at this resolution. */
export function dayNumber(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/**
 * Encrypted per-user configs in SQLite, keyed by sha256(token).
 * `last_used_day` records the last day a config was used (no times, no request details),
 * so configs nobody uses anymore can be deleted.
 */
export class ConfigStore {
  private db: DatabaseSync;
  /** Days already written per config, so usage costs at most one write per config per day. */
  private touched = new Map<string, number>();

  constructor(
    private secretKey: string,
    location: string,
    private now: () => number = Date.now,
  ) {
    if (location !== ':memory:') mkdirSync(location, { recursive: true });
    this.db = new DatabaseSync(location === ':memory:' ? location : join(location, 'subs.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS configs (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(configs)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'last_used_day')) {
      // Added in 0.3.0. Existing rows count as used on their last update.
      this.db.exec('ALTER TABLE configs ADD COLUMN last_used_day INTEGER');
      this.db.exec(`UPDATE configs SET last_used_day = updated_at / ${DAY_MS}`);
    }
  }

  get(token: string): UserConfig | undefined {
    const row = this.db.prepare('SELECT payload FROM configs WHERE id = ?').get(tokenId(token)) as
      | { payload: string }
      | undefined;
    if (!row) return undefined;
    return UserConfigSchema.parse(JSON.parse(decrypt(this.secretKey, token, row.payload)));
  }

  put(token: string, config: UserConfig): void {
    const now = this.now();
    const id = tokenId(token);
    const payload = encrypt(this.secretKey, token, JSON.stringify(UserConfigSchema.parse(config)));
    this.db
      .prepare(
        `INSERT INTO configs (id, payload, created_at, updated_at, last_used_day) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at,
           last_used_day = excluded.last_used_day`,
      )
      .run(id, payload, now, now, dayNumber(now));
    this.touched.set(id, dayNumber(now));
  }

  /** Records that a config was used today. Writes at most once per config per day. */
  touch(token: string): void {
    const id = tokenId(token);
    const today = dayNumber(this.now());
    if (this.touched.get(id) === today) return;
    this.db
      .prepare('UPDATE configs SET last_used_day = ? WHERE id = ? AND (last_used_day IS NULL OR last_used_day < ?)')
      .run(today, id, today);
    this.touched.set(id, today);
    if (this.touched.size > 50_000) this.touched.clear();
  }

  /** Deletes configs not used for `days` days. Returns how many were deleted. */
  deleteUnused(days: number): number {
    const cutoff = dayNumber(this.now()) - days;
    const deleted = this.db
      .prepare('DELETE FROM configs WHERE COALESCE(last_used_day, updated_at / ?) < ?')
      .run(DAY_MS, cutoff).changes;
    if (deleted > 0) this.touched.clear();
    return Number(deleted);
  }

  delete(token: string): boolean {
    const id = tokenId(token);
    this.touched.delete(id);
    return this.db.prepare('DELETE FROM configs WHERE id = ?').run(id).changes > 0;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM configs').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
