import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, redact } from '../src/app.js';
import { ProviderAuthError, ProviderError, type Provider, type ResolveResult, type SubtitleCandidate } from '../src/providers/types.js';
import { ConfigStore } from '../src/store.js';

const BASE = 'https://subs.example.test';

class FakeProvider implements Provider {
  id = 'fake';
  name = 'Fake';
  signupUrl = 'https://fake.test/signup';
  credentialFields = [
    { key: 'username', label: 'Username', type: 'text' as const },
    { key: 'password', label: 'Password', type: 'password' as const },
  ];
  verifies = 0;
  resolves = 0;
  result: ResolveResult = { kind: 'redirect', url: 'https://fake.test/file.srt' };

  async verify(c: Record<string, string>) {
    this.verifies += 1;
    if (c.password !== 'good') throw new ProviderAuthError('Fake rejected the password');
    return { session: 'ok' };
  }
  async search(): Promise<SubtitleCandidate[]> {
    const base = { provider: 'fake', hearingImpaired: false, machineTranslated: false, hashMatch: false, trusted: false };
    return [
      { ...base, ref: '1', lang: 'eng', downloads: 10 },
      { ...base, ref: '2', lang: 'dut', downloads: 1 },
      { ...base, ref: '3', lang: 'ger', downloads: 99 },
    ];
  }
  async resolve() {
    this.resolves += 1;
    return this.result;
  }
}

const preferences = { languages: ['dut', 'eng'], hearingImpaired: 'include', includeMachineTranslated: false, maxPerLanguage: 5 };

describe('app', () => {
  let provider: FakeProvider;
  let store: ConfigStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    provider = new FakeProvider();
    store = new ConfigStore('c'.repeat(64), ':memory:');
    app = createApp({ baseUrl: BASE, signupCode: 'letmein123', store, providers: [provider] });
  });

  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

  async function create(): Promise<string> {
    const res = await send('POST', '/api/configs', {
      signupCode: 'letmein123',
      preferences,
      providers: { fake: { credentials: { username: 'u', password: 'good' } } },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; manifestUrl: string };
    expect(body.manifestUrl).toBe(`${BASE}/${body.token}/manifest.json`);
    return body.token;
  }

  it('requires the signup code and valid credentials', async () => {
    const wrongCode = await send('POST', '/api/configs', {
      signupCode: 'nope',
      preferences,
      providers: { fake: { credentials: { username: 'u', password: 'good' } } },
    });
    expect(wrongCode.status).toBe(403);
    const badLogin = await send('POST', '/api/configs', {
      signupCode: 'letmein123',
      preferences,
      providers: { fake: { credentials: { username: 'u', password: 'bad' } } },
    });
    expect(badLogin.status).toBe(400);
    expect(await badLogin.json()).toEqual({ error: 'Fake rejected the password' });
    expect(store.count()).toBe(0);
  });

  it('serves a configured manifest and ranked subtitles that point back at the addon', async () => {
    const token = await create();
    const manifest = await (await send('GET', `/${token}/manifest.json`)).json();
    expect(manifest).toMatchObject({
      resources: ['subtitles'],
      logo: `${BASE}/logo.png`,
      behaviorHints: { configurationRequired: false },
    });

    const res = await send('GET', `/${token}/subtitles/movie/tt0111161/videoHash=abc.json`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({
      subtitles: [
        { id: 'fake-2', url: `${BASE}/${token}/dl/fake/2.srt`, lang: 'dut' },
        { id: 'fake-1', url: `${BASE}/${token}/dl/fake/1.srt`, lang: 'eng' },
      ],
    });
  });

  it('redirects downloads and reuses the resolved link', async () => {
    const token = await create();
    const first = await send('GET', `/${token}/dl/fake/2.srt`);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('https://fake.test/file.srt');
    await send('GET', `/${token}/dl/fake/2.srt`);
    expect(provider.resolves).toBe(1);
  });

  it('serves notices as a subtitle file', async () => {
    const token = await create();
    provider.result = { kind: 'notice', message: 'Quota reached' };
    const res = await send('GET', `/${token}/dl/fake/9.srt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-subrip');
    expect(await res.text()).toContain('Quota reached');
  });

  it('turns provider errors on download into a notice, without caching them', async () => {
    const token = await create();
    provider.resolve = async () => {
      provider.resolves += 1;
      throw new ProviderError('OpenSubtitles is busy (rate limited). Try again in a minute.');
    };
    const res = await send('GET', `/${token}/dl/fake/5.srt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('rate limited');
    await send('GET', `/${token}/dl/fake/5.srt`);
    expect(provider.resolves).toBe(2);
  });

  it('never returns passwords and keeps them when left blank on update', async () => {
    const token = await create();
    const read = (await (await send('GET', `/api/configs/${token}`)).json()) as any;
    expect(read.providers.fake.credentials).toEqual({ username: 'u', password: '' });

    const update = await send('PUT', `/api/configs/${token}`, {
      preferences: { ...preferences, languages: ['eng'] },
      providers: { fake: { credentials: { username: 'u', password: '' } } },
    });
    expect(update.status).toBe(200);
    expect(provider.verifies).toBe(1); // unchanged credentials are not re-checked
    expect(store.get(token)?.providers.fake?.credentials.password).toBe('good');
    expect(store.get(token)?.preferences.languages).toEqual(['eng']);
  });

  it('counts addon requests as use', async () => {
    let now = 5000 * 24 * 60 * 60 * 1000;
    store = new ConfigStore('c'.repeat(64), ':memory:', () => now);
    app = createApp({ baseUrl: BASE, signupCode: 'letmein123', store, providers: [provider], now: () => now });
    const token = await create();
    now += 300 * 24 * 60 * 60 * 1000;
    await send('GET', `/${token}/subtitles/movie/tt0111161.json`);
    now += 300 * 24 * 60 * 60 * 1000;
    expect(store.deleteUnused(365)).toBe(0); // used 300 days ago, not 600
  });

  it('deletes configs and 404s unknown tokens', async () => {
    const token = await create();
    expect((await send('DELETE', `/api/configs/${token}`)).status).toBe(204);
    expect((await send('GET', `/${token}/manifest.json`)).status).toBe(404);
    expect((await send('GET', '/not-a-token/manifest.json')).status).toBe(404);
  });

  it('exposes the optional notice to the configure page', async () => {
    expect(((await (await send('GET', '/api/meta')).json()) as any).notice).toBeNull();
    const withNotice = createApp({ baseUrl: BASE, signupCode: 'letmein123', store, providers: [provider], notice: '  Personal instance.  ' });
    expect(((await (await withNotice.request('/api/meta')).json()) as any).notice).toBe('Personal instance.');
  });

  it('exposes optional header links', async () => {
    expect(((await (await send('GET', '/api/meta')).json()) as any).links).toEqual({ github: null, discord: null });
    const withLinks = createApp({
      baseUrl: BASE, signupCode: 'letmein123', store, providers: [provider],
      links: { github: 'https://github.com/example/repo', discord: 'https://discord.gg/example' },
    });
    expect(((await (await withLinks.request('/api/meta')).json()) as any).links).toEqual({
      github: 'https://github.com/example/repo',
      discord: 'https://discord.gg/example',
    });
  });

  it('serves the logo files', async () => {
    const png = await send('GET', '/logo.png');
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect((await send('GET', '/logo.svg')).headers.get('content-type')).toBe('image/svg+xml');
    expect((await send('GET', '/logo.gif')).status).toBe(404);
  });

  it('serves the configure page with a strict CSP', async () => {
    const res = await send('GET', '/configure');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it('redacts tokens from logged paths', () => {
    expect(redact('/abcdefghijklmnopqrstuvwxyzABCDEF/dl/fake/1.srt')).toBe('/***/dl/fake/1.srt');
    expect(redact('/abcdefghijklmnopqrstuvwxyzABCDEF/subtitles/series/tt1%3A1%3A1/filename=Show.S01E01.mkv&videoSize=1.json')).toBe(
      '/***/subtitles/series/tt1%3A1%3A1/<extras>.json',
    );
    expect(redact('/abcdefghijklmnopqrstuvwxyzABCDEF/subtitles/movie/tt1.json')).toBe('/***/subtitles/movie/tt1.json');
  });
});
