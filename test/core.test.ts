import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decrypt, encrypt, isToken, newToken, tokenId } from '../src/crypto.js';
import { ConfigStore } from '../src/store.js';
import { noticeSrt, parseSubtitleRequest, rankSubtitles } from '../src/stremio.js';
import type { SubtitleCandidate } from '../src/providers/types.js';
import type { Preferences } from '../src/userConfig.js';

const KEY = 'a'.repeat(64);

describe('crypto', () => {
  it('round-trips and depends on both key and token', () => {
    const token = newToken();
    expect(isToken(token)).toBe(true);
    const payload = encrypt(KEY, token, 'secret');
    expect(payload).not.toContain('secret');
    expect(decrypt(KEY, token, payload)).toBe('secret');
    expect(() => decrypt(KEY, newToken(), payload)).toThrow();
    expect(() => decrypt('b'.repeat(64), token, payload)).toThrow();
  });
});

describe('ConfigStore', () => {
  it('stores encrypted configs by token hash', () => {
    const store = new ConfigStore(KEY, ':memory:');
    const token = newToken();
    const config = {
      preferences: { languages: ['dut'], hearingImpaired: 'include' as const, includeMachineTranslated: false, maxPerLanguage: 5 },
      providers: { opensubtitles: { credentials: { username: 'u', password: 'p' }, state: {} } },
    };
    store.put(token, config);
    expect(store.get(token)).toEqual(config);
    expect(store.get(newToken())).toBeUndefined();
    expect(store.delete(token)).toBe(true);
    expect(store.count()).toBe(0);
  });
});

describe('ConfigStore usage tracking', () => {
  const config = {
    preferences: { languages: ['dut'], hearingImpaired: 'include' as const, includeMachineTranslated: false, maxPerLanguage: 5 },
    providers: { opensubtitles: { credentials: { username: 'u', password: 'p' }, state: {} } },
  };
  const DAY = 24 * 60 * 60 * 1000;

  it('upgrades a database created before usage tracking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subs-'));
    const old = new DatabaseSync(join(dir, 'subs.db'));
    old.exec('CREATE TABLE configs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    const token = newToken();
    const updatedAt = 1000 * DAY;
    old.prepare('INSERT INTO configs VALUES (?, ?, ?, ?)').run(tokenId(token), encrypt(KEY, token, JSON.stringify(config)), updatedAt, updatedAt);
    old.close();

    let now = updatedAt + 100 * DAY;
    const store = new ConfigStore(KEY, dir, () => now);
    expect(store.get(token)).toEqual(config);
    expect(store.deleteUnused(365)).toBe(0); // last update 100 days ago
    now += 300 * DAY;
    expect(store.deleteUnused(365)).toBe(1);
    store.close();
    rmSync(dir, { recursive: true });
  });

  it('deletes only configs unused for longer than the retention period', () => {
    let now = 1000 * DAY;
    const store = new ConfigStore(KEY, ':memory:', () => now);
    const active = newToken();
    const idle = newToken();
    store.put(active, config);
    store.put(idle, config);

    now += 200 * DAY;
    store.touch(active);
    now += 200 * DAY; // idle: 400 days unused, active: 200 days
    expect(store.deleteUnused(365)).toBe(1);
    expect(store.get(active)).toBeDefined();
    expect(store.get(idle)).toBeUndefined();
    expect(store.deleteUnused(365)).toBe(0);
  });
});

describe('parseSubtitleRequest', () => {
  it('parses movies, episodes and extras', () => {
    expect(parseSubtitleRequest('movie/tt0111161.json')).toEqual({ type: 'movie', imdbId: 'tt0111161' });
    expect(
      parseSubtitleRequest('series/tt0944947%3A1%3A2/videoHash=8e245d9679d31e12&videoSize=123&filename=a%20b.mkv.json'),
    ).toEqual({
      type: 'series',
      imdbId: 'tt0944947',
      season: 1,
      episode: 2,
      videoHash: '8e245d9679d31e12',
      videoSize: 123,
      filename: 'a b.mkv',
    });
  });

  it('rejects unsupported ids', () => {
    expect(parseSubtitleRequest('movie/kitsu:1.json')).toBeUndefined();
    expect(parseSubtitleRequest('series/tt1.json')).toBeUndefined();
    expect(parseSubtitleRequest('tv/tt1.json')).toBeUndefined();
  });
});

describe('rankSubtitles', () => {
  const base: SubtitleCandidate = {
    provider: 'p', ref: '1', lang: 'eng', hearingImpaired: false, machineTranslated: false,
    hashMatch: false, trusted: false, downloads: 0,
  };
  const prefs: Preferences = { languages: ['dut', 'eng'], hearingImpaired: 'include', includeMachineTranslated: false, maxPerLanguage: 2 };

  it('orders by language preference, then match quality and popularity', () => {
    const ranked = rankSubtitles(
      [
        { ...base, ref: 'e-pop', downloads: 900 },
        { ...base, ref: 'd-pop', lang: 'dut', downloads: 500 },
        { ...base, ref: 'd-hash', lang: 'dut', hashMatch: true },
        { ...base, ref: 'd-third', lang: 'dut', downloads: 1 },
        { ...base, ref: 'ger', lang: 'ger' },
        { ...base, ref: 'mt', lang: 'dut', machineTranslated: true, downloads: 9999 },
      ],
      prefs,
    );
    expect(ranked.map((s) => s.ref)).toEqual(['d-hash', 'd-pop', 'e-pop']);
  });

  it('applies hearing-impaired preference', () => {
    const subs = [{ ...base, ref: 'hi', hearingImpaired: true }, { ...base, ref: 'plain' }];
    expect(rankSubtitles(subs, { ...prefs, hearingImpaired: 'exclude' }).map((s) => s.ref)).toEqual(['plain']);
    expect(rankSubtitles(subs, { ...prefs, hearingImpaired: 'prefer' }).map((s) => s.ref)).toEqual(['hi', 'plain']);
  });
});

describe('noticeSrt', () => {
  it('produces a single cue', () => {
    expect(noticeSrt('Limit\nreached')).toBe('1\n00:00:00,000 --> 00:00:15,000\nLimit reached\n');
  });
});
