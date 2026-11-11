import type { SubtitleCandidate, VideoQuery } from './providers/types.js';
import type { Preferences } from './userConfig.js';

/**
 * Parses the part after `/subtitles/` of a Stremio subtitle request:
 *   movie/tt0111161.json
 *   series/tt0944947:1:2/videoHash=abc&videoSize=123&filename=x.mkv.json
 */
export function parseSubtitleRequest(rest: string): VideoQuery | undefined {
  if (!rest.endsWith('.json')) return undefined;
  const parts = rest.slice(0, -'.json'.length).split('/');
  if (parts.length < 2 || parts.length > 3) return undefined;
  const [type, rawId, rawExtras] = parts as [string, string, string | undefined];
  if (type !== 'movie' && type !== 'series') return undefined;

  const id = safeDecode(rawId);
  const [imdbId, season, episode] = id.split(':');
  if (!imdbId || !/^tt\d+$/.test(imdbId)) return undefined;

  const query: VideoQuery = { type, imdbId };
  if (type === 'series') {
    const s = Number(season);
    const e = Number(episode);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 0) return undefined;
    query.season = s;
    query.episode = e;
  }

  if (rawExtras) {
    const extras = new URLSearchParams(rawExtras);
    const hash = extras.get('videoHash');
    if (hash && /^[0-9a-f]{1,16}$/i.test(hash)) query.videoHash = hash.padStart(16, '0');
    const size = Number(extras.get('videoSize'));
    if (Number.isSafeInteger(size) && size > 0) query.videoSize = size;
    const filename = extras.get('filename');
    if (filename) query.filename = filename.slice(0, 300);
  }
  return query;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Filters by the user's preferences and orders subtitles: preferred languages first, then
 * per language exact file matches, trusted uploaders and popularity.
 */
export function rankSubtitles(candidates: SubtitleCandidate[], prefs: Preferences): SubtitleCandidate[] {
  const order = new Map(prefs.languages.map((code, i) => [code, i]));
  const seen = new Set<string>();

  const kept = candidates.filter((c) => {
    if (!order.has(c.lang)) return false;
    if (!prefs.includeMachineTranslated && c.machineTranslated) return false;
    if (prefs.hearingImpaired === 'exclude' && c.hearingImpaired) return false;
    const key = `${c.provider}:${c.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const score = (c: SubtitleCandidate) =>
    (c.hashMatch ? 4 : 0) +
    (c.trusted ? 2 : 0) +
    (prefs.hearingImpaired === 'prefer' && c.hearingImpaired ? 1 : 0);

  kept.sort(
    (a, b) =>
      order.get(a.lang)! - order.get(b.lang)! || score(b) - score(a) || b.downloads - a.downloads,
  );

  const perLanguage = new Map<string, number>();
  return kept.filter((c) => {
    const n = perLanguage.get(c.lang) ?? 0;
    perLanguage.set(c.lang, n + 1);
    return n < prefs.maxPerLanguage;
  });
}

/** A subtitle file with one cue, used to tell the viewer why a subtitle could not load. */
export function noticeSrt(message: string): string {
  return `1\n00:00:00,000 --> 00:00:15,000\n${message.replace(/\r?\n/g, ' ')}\n`;
}
