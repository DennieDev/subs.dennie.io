import type { Language } from '../languages.js';

/** What Stremio asked subtitles for. */
export interface VideoQuery {
  type: 'movie' | 'series';
  /** e.g. "tt0111161" (the series id for episodes). */
  imdbId: string;
  season?: number;
  episode?: number;
  /** OpenSubtitles-style 64-bit hash Stremio computes from the file. */
  videoHash?: string;
  videoSize?: number;
  filename?: string;
}

/** One subtitle a provider can deliver. Nothing is downloaded until the player asks for it. */
export interface SubtitleCandidate {
  provider: string;
  /** Provider-specific reference, URL-safe ([A-Za-z0-9_-]). Passed back to `resolve`. */
  ref: string;
  /** Stremio language code. */
  lang: string;
  hearingImpaired: boolean;
  machineTranslated: boolean;
  /** The provider matched the exact file (hash), so timing should fit. */
  hashMatch: boolean;
  trusted: boolean;
  downloads: number;
  release?: string;
}

/**
 * How a subtitle reaches the player.
 * - redirect: the player fetches the file straight from the provider; no bytes pass through here.
 * - notice: a short message shown as a one-cue subtitle (quota reached, login failed, ...).
 */
export type ResolveResult = { kind: 'redirect'; url: string } | { kind: 'notice'; message: string };

export interface CredentialField {
  key: string;
  label: string;
  type: 'text' | 'password';
  help?: string;
}

/** Per-user access to a provider. `saveState` persists e.g. a refreshed login token. */
export interface ProviderContext {
  credentials: Record<string, string>;
  state: Record<string, unknown>;
  saveState(state: Record<string, unknown>): void;
}

export interface Provider {
  id: string;
  name: string;
  /** Where users create an account. */
  signupUrl: string;
  credentialFields: CredentialField[];
  /** Checks credentials by signing in. Returns initial state to store, throws ProviderAuthError. */
  verify(credentials: Record<string, string>): Promise<Record<string, unknown>>;
  search(ctx: ProviderContext, query: VideoQuery, languages: Language[]): Promise<SubtitleCandidate[]>;
  resolve(ctx: ProviderContext, ref: string): Promise<ResolveResult>;
}

/** The provider rejected the user's credentials. Safe to show to the user. */
export class ProviderAuthError extends Error {
  override name = 'ProviderAuthError';
}

/** Any other provider failure. The message is safe to show; it never contains secrets. */
export class ProviderError extends Error {
  override name = 'ProviderError';
}
