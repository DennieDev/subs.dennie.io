import { languageByOpenSubtitles, type Language } from '../languages.js';
import { TtlCache } from '../ttlCache.js';
import {
  ProviderAuthError,
  ProviderError,
  type Provider,
  type ProviderContext,
  type ResolveResult,
  type SubtitleCandidate,
  type VideoQuery,
} from './types.js';

// OpenSubtitles.com REST API: https://opensubtitles.stoplight.io/docs/opensubtitles-api
// - Every request carries the app's Api-Key and a User-Agent naming the app.
// - Searching is free. Only POST /download counts toward the user's daily quota, so it
//   runs when the player actually opens a subtitle, never while listing.
// - /download returns a temporary link on OpenSubtitles' own servers; we redirect to it.

const DEFAULT_API = 'https://api.opensubtitles.com/api/v1';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 60 * 60 * 1000;
const MAX_PAGES = 3;
const TIMEOUT_MS = 10_000;

interface Session {
  token: string;
  apiBase: string;
  expiresAt: number;
}

interface SearchItem {
  attributes?: {
    language?: string;
    hearing_impaired?: boolean;
    ai_translated?: boolean;
    machine_translated?: boolean;
    moviehash_match?: boolean;
    from_trusted?: boolean;
    download_count?: number;
    release?: string;
    files?: { file_id?: number }[];
  };
}

interface SearchPage {
  total_pages?: number;
  data?: SearchItem[];
}

export interface OpenSubtitlesOptions {
  apiKey: string;
  userAgent: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class OpenSubtitlesProvider implements Provider {
  readonly id = 'opensubtitles';
  readonly name = 'OpenSubtitles.com';
  readonly signupUrl = 'https://www.opensubtitles.com/en/users/sign_up';
  readonly credentialFields = [
    { key: 'username', label: 'Username', type: 'text' as const },
    { key: 'password', label: 'Password', type: 'password' as const },
  ];

  private fetchImpl: typeof fetch;
  private now: () => number;
  private searchCache = new TtlCache<SubtitleCandidate[]>(2000);

  constructor(private options: OpenSubtitlesOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async verify(credentials: Record<string, string>): Promise<Record<string, unknown>> {
    return { session: await this.login(credentials) };
  }

  async search(_ctx: ProviderContext, query: VideoQuery, languages: Language[]): Promise<SubtitleCandidate[]> {
    const wanted = languages.map((l) => l.opensubtitles).sort();
    if (wanted.length === 0) return [];

    const imdbNumber = Number(query.imdbId.replace(/^tt/, ''));
    if (!Number.isInteger(imdbNumber) || imdbNumber <= 0) return [];

    // The API asks for alphabetically sorted, lower-case parameters (it redirects otherwise).
    const params: Record<string, string> = { languages: wanted.join(',') };
    if (query.type === 'series' && query.season !== undefined && query.episode !== undefined) {
      params.parent_imdb_id = String(imdbNumber);
      params.season_number = String(query.season);
      params.episode_number = String(query.episode);
    } else {
      params.imdb_id = String(imdbNumber);
    }
    if (query.videoHash && /^[0-9a-f]{16}$/i.test(query.videoHash)) {
      params.moviehash = query.videoHash.toLowerCase();
    }

    // Results are the same for every user, so they are cached and shared.
    const cacheKey = JSON.stringify(params);
    const cached = this.searchCache.get(cacheKey, this.now());
    if (cached) return cached;

    const results: SubtitleCandidate[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const pageParams = page === 1 ? params : { ...params, page: String(page) };
      const qs = Object.keys(pageParams)
        .sort()
        .map((k) => `${k}=${encodeURIComponent(pageParams[k]!)}`)
        .join('&');
      const res = await this.request(`${DEFAULT_API}/subtitles?${qs}`, { method: 'GET' });
      if (!res.ok) throw failure(res, 'search');
      const body = (await res.json()) as SearchPage;
      for (const item of body.data ?? []) {
        const candidate = toCandidate(item);
        if (candidate) results.push(candidate);
      }
      if ((body.total_pages ?? 1) <= page) break;
    }

    this.searchCache.set(cacheKey, results, this.now() + SEARCH_TTL_MS);
    return results;
  }

  async resolve(ctx: ProviderContext, ref: string): Promise<ResolveResult> {
    const fileId = Number(ref);
    if (!/^\d+$/.test(ref) || !Number.isSafeInteger(fileId)) throw new ProviderError('Invalid subtitle reference');

    let session = await this.session(ctx, false);
    let res = await this.download(session, fileId);
    if (res.status === 401) {
      // Token expired or revoked early: sign in again once.
      session = await this.session(ctx, true);
      res = await this.download(session, fileId);
    }

    const body = (await res.json().catch(() => ({}))) as {
      link?: string;
      message?: string;
      reset_time?: string;
    };

    if (res.status === 406 || (res.ok && !body.link && body.reset_time)) {
      return {
        kind: 'notice',
        message: `OpenSubtitles daily download limit reached.${body.reset_time ? ` Resets in ${body.reset_time}.` : ''}`,
      };
    }
    if (!res.ok) throw failure(res, 'download');
    if (!body.link) throw new ProviderError('OpenSubtitles returned no download link');

    const link = new URL(body.link);
    if (link.protocol !== 'https:' || !isOpenSubtitlesHost(link.hostname)) {
      throw new ProviderError('OpenSubtitles returned an unexpected download host');
    }
    return { kind: 'redirect', url: link.toString() };
  }

  private download(session: Session, fileId: number): Promise<Response> {
    return this.request(`${session.apiBase}/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }),
    });
  }

  /** Returns a cached login token, signing in when it is missing, expired or `force`d. */
  private async session(ctx: ProviderContext, force: boolean): Promise<Session> {
    const stored = ctx.state.session as Session | undefined;
    if (!force && stored?.token && stored.expiresAt > this.now() && stored.apiBase) return stored;
    const session = await this.login(ctx.credentials);
    ctx.saveState({ ...ctx.state, session });
    return session;
  }

  private async login(credentials: Record<string, string>): Promise<Session> {
    const { username, password } = credentials;
    if (!username || !password) throw new ProviderAuthError('Enter your OpenSubtitles username and password');

    const res = await this.request(`${DEFAULT_API}/login`, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    if (res.status === 401 || res.status === 400) {
      throw new ProviderAuthError('OpenSubtitles rejected the username or password');
    }
    if (!res.ok) throw failure(res, 'sign-in');

    const body = (await res.json()) as { token?: string; base_url?: string };
    if (!body.token) throw new ProviderError('OpenSubtitles sign-in returned no token');

    // VIP accounts get their own API host; only accept OpenSubtitles hosts.
    const host = body.base_url?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const apiBase = host && isOpenSubtitlesHost(host) ? `https://${host}/api/v1` : DEFAULT_API;
    return { token: body.token, apiBase, expiresAt: this.now() + SESSION_TTL_MS };
  }

  private async request(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'Api-Key': this.options.apiKey,
          'User-Agent': this.options.userAgent,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new ProviderError(`OpenSubtitles ${reason}`);
    }
  }
}

/**
 * 429: too many requests (per IP or API key), temporary.
 * 403: OpenSubtitles refused the API key itself; only the instance owner can fix that.
 */
function failure(res: Response, action: 'search' | 'download' | 'sign-in'): ProviderError {
  if (res.status === 429) return new ProviderError('OpenSubtitles is busy (rate limited). Try again in a minute.');
  if (res.status === 403) return new ProviderError('OpenSubtitles refused this addon\'s API key. Ask the addon owner to check it.');
  return new ProviderError(`OpenSubtitles ${action} failed (HTTP ${res.status})`);
}

function isOpenSubtitlesHost(hostname: string): boolean {
  return hostname === 'opensubtitles.com' || hostname.endsWith('.opensubtitles.com');
}

function toCandidate(item: SearchItem): SubtitleCandidate | undefined {
  const a = item.attributes;
  const fileId = a?.files?.[0]?.file_id;
  const lang = a?.language ? languageByOpenSubtitles(a.language) : undefined;
  if (!a || !fileId || !lang) return undefined;
  return {
    provider: 'opensubtitles',
    ref: String(fileId),
    lang: lang.code,
    hearingImpaired: a.hearing_impaired === true,
    machineTranslated: a.ai_translated === true || a.machine_translated === true,
    hashMatch: a.moviehash_match === true,
    trusted: a.from_trusted === true,
    downloads: a.download_count ?? 0,
    release: a.release,
  };
}
