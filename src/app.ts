import { readFileSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { isToken, newToken, safeEqual, tokenId } from './crypto.js';
import { LANGUAGES, languageByCode } from './languages.js';
import { ProviderAuthError, ProviderError, type Provider, type ResolveResult } from './providers/types.js';
import { RateLimiter } from './rateLimit.js';
import type { ConfigStore } from './store.js';
import { noticeSrt, parseSubtitleRequest, rankSubtitles } from './stremio.js';
import { TtlCache } from './ttlCache.js';
import { PreferencesSchema, type ProviderEntry, type UserConfig } from './userConfig.js';

export const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const UI_DIR = new URL('./ui/', import.meta.url);
const UI_FILES: Record<string, { file: string; type: string }> = {
  'configure.js': { file: 'configure.js', type: 'text/javascript; charset=utf-8' },
  'configure.css': { file: 'configure.css', type: 'text/css; charset=utf-8' },
};
const RESOLVE_TTL_MS = 2 * 60 * 60 * 1000;

export interface AppDeps {
  baseUrl: string;
  signupCode: string;
  store: ConfigStore;
  providers: Provider[];
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

const ProviderInputSchema = z.object({ credentials: z.record(z.string(), z.string().max(500)) });
const ConfigInputSchema = z.object({
  preferences: PreferencesSchema,
  providers: z.record(z.string(), ProviderInputSchema),
});
const CreateInputSchema = ConfigInputSchema.extend({ signupCode: z.string().max(200) });

class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 429,
    message: string,
  ) {
    super(message);
  }
}

export function createApp(deps: AppDeps) {
  const { baseUrl, store } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const providers = new Map(deps.providers.map((p) => [p.id, p]));
  const writeLimiter = new RateLimiter(10, 10 * 60 * 1000, now);
  // Remembers download links per user and file (they stay valid for hours), so reopening a
  // subtitle does not spend another download from the user's quota.
  const resolved = new TtlCache<ResolveResult>(5000);
  const inflight = new Map<string, Promise<ResolveResult>>();
  const ui = (name: string) => readFileSync(new URL(name, UI_DIR), 'utf8');

  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  // Stremio clients call addon routes cross-origin.
  const addonCors = cors({ origin: '*', allowMethods: ['GET'] });
  app.use('/manifest.json', addonCors);
  app.use('/:token/manifest.json', addonCors);
  app.use('/:token/subtitles/*', addonCors);
  app.use('/:token/dl/*', addonCors);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof ProviderAuthError) return c.json({ error: err.message }, 400);
    if (err instanceof ProviderError) return c.json({ error: err.message }, 502);
    log('unhandled error', { path: redact(c.req.path), error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: 'Internal error' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true, version: VERSION }));

  // ---- Configuration page -------------------------------------------------------------

  const page = (c: Context) => {
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    c.header('Cache-Control', 'no-store');
    return c.html(ui('configure.html'));
  };
  app.get('/', (c) => c.redirect('/configure'));
  app.get('/configure', page);
  app.get('/:token/configure', (c) => (isToken(c.req.param('token')) ? page(c) : c.notFound()));
  app.get('/ui/:file', (c) => {
    const entry = UI_FILES[c.req.param('file')];
    if (!entry) return c.notFound();
    c.header('Content-Type', entry.type);
    c.header('Cache-Control', 'no-cache');
    return c.body(ui(entry.file));
  });

  // ---- Configuration API --------------------------------------------------------------

  app.get('/api/meta', (c) =>
    c.json({
      version: VERSION,
      languages: LANGUAGES.map(({ code, name }) => ({ code, name })),
      providers: [...providers.values()].map(({ id, name, signupUrl, credentialFields }) => ({
        id,
        name,
        signupUrl,
        credentialFields,
      })),
    }),
  );

  app.post('/api/configs', async (c) => {
    limit(c);
    const input = CreateInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new HttpError(400, firstIssue(input.error));
    if (!safeEqual(input.data.signupCode, deps.signupCode)) throw new HttpError(403, 'Wrong signup code');

    const config: UserConfig = {
      preferences: input.data.preferences,
      providers: await buildProviders(input.data.providers, {}),
    };
    const token = newToken();
    store.put(token, config);
    log('config created');
    return c.json({ token, manifestUrl: manifestUrl(token) }, 201);
  });

  app.get('/api/configs/:token', (c) => {
    const { config } = loadConfig(c.req.param('token'));
    return c.json({ preferences: config.preferences, providers: publicProviders(config) });
  });

  app.put('/api/configs/:token', async (c) => {
    limit(c);
    const { token, config } = loadConfig(c.req.param('token'));
    const input = ConfigInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new HttpError(400, firstIssue(input.error));
    const updated: UserConfig = {
      preferences: input.data.preferences,
      providers: await buildProviders(input.data.providers, config.providers),
    };
    store.put(token, updated);
    clearResolved(token);
    return c.json({ token, manifestUrl: manifestUrl(token) });
  });

  app.delete('/api/configs/:token', (c) => {
    const { token } = loadConfig(c.req.param('token'));
    store.delete(token);
    clearResolved(token);
    log('config deleted');
    return c.body(null, 204);
  });

  // ---- Stremio addon ------------------------------------------------------------------

  app.get('/manifest.json', (c) => c.json(manifest(true)));

  app.get('/:token/manifest.json', (c) => {
    loadConfig(c.req.param('token'));
    return c.json(manifest(false));
  });

  app.get('/:token/subtitles/*', async (c) => {
    const { token, config } = loadConfig(c.req.param('token'));
    const prefix = `/${c.req.param('token')}/subtitles/`;
    const query = parseSubtitleRequest(c.req.path.slice(prefix.length));
    if (!query) return c.json({ subtitles: [] });

    const languages = config.preferences.languages.map((code) => languageByCode(code)!);
    const results = await Promise.all(
      Object.entries(config.providers).map(async ([id, entry]) => {
        const provider = providers.get(id);
        if (!provider) return [];
        try {
          return await provider.search(context(token, id, entry), query, languages);
        } catch (error) {
          log('search failed', { provider: id, error: error instanceof Error ? error.message : String(error) });
          return [];
        }
      }),
    );

    const subtitles = rankSubtitles(results.flat(), config.preferences).map((s) => ({
      id: `${s.provider}-${s.ref}`,
      url: `${baseUrl}/${token}/dl/${s.provider}/${s.ref}.srt`,
      lang: s.lang,
    }));
    c.header('Cache-Control', 'private, max-age=900');
    return c.json({ subtitles });
  });

  app.get('/:token/dl/:provider/:file', async (c) => {
    const { token, config } = loadConfig(c.req.param('token'));
    const providerId = c.req.param('provider');
    const ref = c.req.param('file').replace(/\.srt$/, '');
    const provider = providers.get(providerId);
    const entry = config.providers[providerId];
    if (!provider || !entry || !/^[A-Za-z0-9_-]{1,64}$/.test(ref)) return c.notFound();

    const key = `${tokenId(token)}:${providerId}:${ref}`;
    let result = resolved.get(key, now());
    if (!result) {
      let pending = inflight.get(key);
      if (!pending) {
        pending = provider.resolve(context(token, providerId, entry), ref).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      try {
        result = await pending;
      } catch (error) {
        const message =
          error instanceof ProviderAuthError || error instanceof ProviderError
            ? error.message
            : 'Subtitle could not be loaded';
        log('download failed', { provider: providerId, error: message });
        result = { kind: 'notice', message };
      }
      if (result.kind === 'redirect') resolved.set(key, result, now() + RESOLVE_TTL_MS);
    }

    if (result.kind === 'redirect') {
      c.header('Cache-Control', 'no-store');
      return c.redirect(result.url, 302);
    }
    c.header('Content-Type', 'application/x-subrip; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return c.body(noticeSrt(result.message));
  });

  return app;

  // ---- helpers ------------------------------------------------------------------------

  function limit(c: Context) {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    if (!writeLimiter.take(ip)) throw new HttpError(429, 'Too many attempts, try again later');
  }

  function loadConfig(token: string): { token: string; config: UserConfig } {
    if (!isToken(token)) throw new HttpError(404, 'Unknown config');
    let config: UserConfig | undefined;
    try {
      config = store.get(token);
    } catch {
      config = undefined;
    }
    if (!config) throw new HttpError(404, 'Unknown config');
    return { token, config };
  }

  function context(token: string, id: string, entry: ProviderEntry) {
    return {
      credentials: entry.credentials,
      state: entry.state,
      saveState(state: Record<string, unknown>) {
        entry.state = state;
        // Re-read so a concurrent preference change is not overwritten with stale data.
        const latest = store.get(token);
        const target = latest?.providers[id];
        if (!latest || !target || JSON.stringify(target.credentials) !== JSON.stringify(entry.credentials)) return;
        target.state = state;
        store.put(token, latest);
      },
    };
  }

  /** Validates input credentials. Blank password fields keep the stored value. */
  async function buildProviders(
    input: Record<string, { credentials: Record<string, string> }>,
    existing: Record<string, ProviderEntry>,
  ): Promise<Record<string, ProviderEntry>> {
    const out: Record<string, ProviderEntry> = {};
    for (const [id, { credentials }] of Object.entries(input)) {
      const provider = providers.get(id);
      if (!provider) throw new HttpError(400, `Unknown provider: ${id}`);
      const previous = existing[id];
      const merged: Record<string, string> = {};
      for (const field of provider.credentialFields) {
        const value = (credentials[field.key] ?? '').trim();
        merged[field.key] = value === '' && field.type === 'password' ? (previous?.credentials[field.key] ?? '') : value;
        if (!merged[field.key]) throw new HttpError(400, `${provider.name}: ${field.label} is required`);
      }
      const unchanged = previous && JSON.stringify(previous.credentials) === JSON.stringify(merged);
      out[id] = unchanged ? previous : { credentials: merged, state: await provider.verify(merged) };
    }
    if (Object.keys(out).length === 0) throw new HttpError(400, 'Connect at least one subtitle provider');
    return out;
  }

  function publicProviders(config: UserConfig) {
    const out: Record<string, { credentials: Record<string, string> }> = {};
    for (const [id, entry] of Object.entries(config.providers)) {
      const provider = providers.get(id);
      if (!provider) continue;
      const credentials: Record<string, string> = {};
      for (const field of provider.credentialFields) {
        // Passwords and keys never leave the server again.
        credentials[field.key] = field.type === 'password' ? '' : (entry.credentials[field.key] ?? '');
      }
      out[id] = { credentials };
    }
    return out;
  }

  function clearResolved(token: string) {
    const id = tokenId(token);
    resolved.deleteWhere((key) => key.startsWith(`${id}:`));
  }

  function manifestUrl(token: string) {
    return `${baseUrl}/${token}/manifest.json`;
  }

  function manifest(configurationRequired: boolean) {
    return {
      id: 'io.dennie.subs',
      version: VERSION,
      name: 'Dennie Subs',
      description: 'Subtitles from your own OpenSubtitles.com account, in your preferred languages.',
      resources: ['subtitles'],
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired },
    };
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'Invalid input';
}

/**
 * Makes a path safe to log: token-shaped segments become `***`, and subtitle request extras
 * (filename, video hash and size) are dropped so logs do not become a viewing history.
 */
export function redact(path: string): string {
  return path
    .replace(/\/[A-Za-z0-9_-]{32}(?=\/|$)/g, '/***')
    .replace(/(\/subtitles\/[^/]+\/[^/]+)\/[^/]+\.json$/, '$1/<extras>.json');
}
