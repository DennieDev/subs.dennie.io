import { describe, expect, it } from 'vitest';
import { languageByCode } from '../src/languages.js';
import { OpenSubtitlesProvider } from '../src/providers/opensubtitles.js';
import { ProviderAuthError, type ProviderContext } from '../src/providers/types.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function ctx(state: Record<string, unknown> = {}): ProviderContext & { saved: Record<string, unknown>[] } {
  const saved: Record<string, unknown>[] = [];
  return {
    credentials: { username: 'user', password: 'pass' },
    state,
    saveState(s) {
      saved.push(s);
      this.state = s;
    },
    saved,
  };
}

const langs = ['dut', 'eng'].map((c) => languageByCode(c)!);

describe('OpenSubtitlesProvider', () => {
  it('searches episodes with sorted parameters and maps results', async () => {
    const { fn, calls } = fakeFetch(() =>
      json(200, {
        total_pages: 1,
        data: [
          { attributes: { language: 'nl', moviehash_match: true, download_count: 5, files: [{ file_id: 42 }] } },
          { attributes: { language: 'xx', files: [{ file_id: 1 }] } },
          { attributes: { language: 'en', files: [] } },
        ],
      }),
    );
    const p = new OpenSubtitlesProvider({ apiKey: 'k', userAgent: 'UA v1', fetch: fn });
    const query = { type: 'series' as const, imdbId: 'tt0944947', season: 1, episode: 2, videoHash: '8E245D9679D31E12' };
    const results = await p.search(ctx(), query, langs);

    expect(calls[0]!.url).toBe(
      'https://api.opensubtitles.com/api/v1/subtitles?episode_number=2&languages=en%2Cnl&moviehash=8e245d9679d31e12&parent_imdb_id=944947&season_number=1',
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Api-Key']).toBe('k');
    expect(headers['User-Agent']).toBe('UA v1');
    expect(headers.Authorization).toBeUndefined();
    expect(results).toEqual([
      expect.objectContaining({ provider: 'opensubtitles', ref: '42', lang: 'dut', hashMatch: true, downloads: 5 }),
    ]);

    // Second identical search is served from cache.
    await p.search(ctx(), query, langs);
    expect(calls).toHaveLength(1);
  });

  it('signs in on first download, caches the session, and redirects to the provider link', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.endsWith('/login')) return json(200, { token: 'jwt', base_url: 'vip-api.opensubtitles.com' });
      return json(200, { link: 'https://www.opensubtitles.com/download/abc/file.srt', remaining: 19 });
    });
    const p = new OpenSubtitlesProvider({ apiKey: 'k', userAgent: 'UA', fetch: fn, now: () => 1000 });
    const c = ctx();
    expect(await p.resolve(c, '42')).toEqual({ kind: 'redirect', url: 'https://www.opensubtitles.com/download/abc/file.srt' });
    expect(calls.map((x) => x.url)).toEqual([
      'https://api.opensubtitles.com/api/v1/login',
      'https://vip-api.opensubtitles.com/api/v1/download',
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ file_id: 42, sub_format: 'srt' });
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
    expect(c.saved).toHaveLength(1);

    await p.resolve(c, '43');
    expect(calls.filter((x) => x.url.endsWith('/login'))).toHaveLength(1);
  });

  it('re-signs in once when the stored token is rejected', async () => {
    let downloads = 0;
    const { fn, calls } = fakeFetch((url) => {
      if (url.endsWith('/login')) return json(200, { token: 'fresh' });
      downloads += 1;
      return downloads === 1 ? json(401, {}) : json(200, { link: 'https://dl.opensubtitles.com/x.srt' });
    });
    const p = new OpenSubtitlesProvider({ apiKey: 'k', userAgent: 'UA', fetch: fn, now: () => 0 });
    const c = ctx({ session: { token: 'old', apiBase: 'https://api.opensubtitles.com/api/v1', expiresAt: 10 } });
    expect(await p.resolve(c, '7')).toEqual({ kind: 'redirect', url: 'https://dl.opensubtitles.com/x.srt' });
    expect(calls.map((x) => x.url.split('/').pop())).toEqual(['download', 'login', 'download']);
  });

  it('turns an exhausted quota into a notice', async () => {
    const { fn } = fakeFetch(() => json(406, { message: 'quota', reset_time: '5 hours' }));
    const p = new OpenSubtitlesProvider({ apiKey: 'k', userAgent: 'UA', fetch: fn });
    const c = ctx({ session: { token: 't', apiBase: 'https://api.opensubtitles.com/api/v1', expiresAt: Date.now() + 1e6 } });
    expect(await p.resolve(c, '7')).toEqual({
      kind: 'notice',
      message: 'OpenSubtitles daily download limit reached. Resets in 5 hours.',
    });
  });

  it('explains rate limits and refused API keys', async () => {
    const session = { token: 't', apiBase: 'https://api.opensubtitles.com/api/v1', expiresAt: Date.now() + 1e6 };
    for (const [status, message] of [
      [429, 'OpenSubtitles is busy (rate limited). Try again in a minute.'],
      [403, "OpenSubtitles refused this addon's API key. Ask the addon owner to check it."],
      [500, 'OpenSubtitles download failed (HTTP 500)'],
    ] as const) {
      const { fn } = fakeFetch(() => json(status, {}));
      const p = new OpenSubtitlesProvider({ apiKey: 'k', userAgent: 'UA', fetch: fn });
      await expect(p.resolve(ctx({ session }), '7')).rejects.toThrow(message);
    }
    const { fn } = fakeFetch(() => json(429, {}));
    const p = new OpenSubtitlesProvider({ apiKey: 'k', userAgent: 'UA', fetch: fn });
    await expect(p.verify({ username: 'u', password: 'p' })).rejects.toThrow('rate limited');
  });

  it('refuses download links on foreign hosts and unknown login hosts', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.endsWith('/login')) return json(200, { token: 't', base_url: 'evil.example.com' });
      return json(200, { link: 'https://evil.example.com/x.srt' });
    });
    const p = new OpenSubtitlesProvider({ apiKey: 'k', userAgent: 'UA', fetch: fn });
    await expect(p.resolve(ctx(), '7')).rejects.toThrow('unexpected download host');
    expect(calls[1]!.url).toBe('https://api.opensubtitles.com/api/v1/download');
  });

  it('reports bad credentials as an auth error', async () => {
    const { fn } = fakeFetch(() => json(401, { message: 'Invalid' }));
    const p = new OpenSubtitlesProvider({ apiKey: 'k', userAgent: 'UA', fetch: fn });
    await expect(p.verify({ username: 'u', password: 'bad' })).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
