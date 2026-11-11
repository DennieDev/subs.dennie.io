import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decrypt, encrypt, tokenId } from './crypto.js';
import { UserConfigSchema, type UserConfig } from './userConfig.js';

/** Encrypted per-user configs in SQLite, keyed by sha256(token). */
export class ConfigStore {
  private db: DatabaseSync;

  constructor(
    private secretKey: string,
    location: string,
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
  }

  get(token: string): UserConfig | undefined {
    const row = this.db.prepare('SELECT payload FROM configs WHERE id = ?').get(tokenId(token)) as
      | { payload: string }
      | undefined;
    if (!row) return undefined;
    return UserConfigSchema.parse(JSON.parse(decrypt(this.secretKey, token, row.payload)));
  }

  put(token: string, config: UserConfig): void {
    const now = Date.now();
    const payload = encrypt(this.secretKey, token, JSON.stringify(UserConfigSchema.parse(config)));
    this.db
      .prepare(
        `INSERT INTO configs (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(tokenId(token), payload, now, now);
  }

  delete(token: string): boolean {
    return this.db.prepare('DELETE FROM configs WHERE id = ?').run(tokenId(token)).changes > 0;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM configs').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
