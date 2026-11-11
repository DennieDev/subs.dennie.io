// Stremio identifies subtitle languages with ISO 639-2/B codes ("eng", "dut", "pob").
// Providers use their own codes; each language lists them here.

export interface Language {
  /** Stremio / ISO 639-2/B code, used as `lang` in subtitle responses. */
  code: string;
  name: string;
  /** OpenSubtitles.com language code. */
  opensubtitles: string;
}

export const LANGUAGES: readonly Language[] = [
  { code: 'dut', name: 'Dutch', opensubtitles: 'nl' },
  { code: 'eng', name: 'English', opensubtitles: 'en' },
  { code: 'ger', name: 'German', opensubtitles: 'de' },
  { code: 'fre', name: 'French', opensubtitles: 'fr' },
  { code: 'spa', name: 'Spanish', opensubtitles: 'es' },
  { code: 'ita', name: 'Italian', opensubtitles: 'it' },
  { code: 'por', name: 'Portuguese', opensubtitles: 'pt-pt' },
  { code: 'pob', name: 'Portuguese (Brazil)', opensubtitles: 'pt-br' },
  { code: 'swe', name: 'Swedish', opensubtitles: 'sv' },
  { code: 'dan', name: 'Danish', opensubtitles: 'da' },
  { code: 'nor', name: 'Norwegian', opensubtitles: 'no' },
  { code: 'fin', name: 'Finnish', opensubtitles: 'fi' },
  { code: 'ice', name: 'Icelandic', opensubtitles: 'is' },
  { code: 'pol', name: 'Polish', opensubtitles: 'pl' },
  { code: 'cze', name: 'Czech', opensubtitles: 'cs' },
  { code: 'slo', name: 'Slovak', opensubtitles: 'sk' },
  { code: 'hun', name: 'Hungarian', opensubtitles: 'hu' },
  { code: 'rum', name: 'Romanian', opensubtitles: 'ro' },
  { code: 'bul', name: 'Bulgarian', opensubtitles: 'bg' },
  { code: 'gre', name: 'Greek', opensubtitles: 'el' },
  { code: 'tur', name: 'Turkish', opensubtitles: 'tr' },
  { code: 'rus', name: 'Russian', opensubtitles: 'ru' },
  { code: 'ukr', name: 'Ukrainian', opensubtitles: 'uk' },
  { code: 'hrv', name: 'Croatian', opensubtitles: 'hr' },
  { code: 'srp', name: 'Serbian', opensubtitles: 'sr' },
  { code: 'slv', name: 'Slovenian', opensubtitles: 'sl' },
  { code: 'est', name: 'Estonian', opensubtitles: 'et' },
  { code: 'lav', name: 'Latvian', opensubtitles: 'lv' },
  { code: 'lit', name: 'Lithuanian', opensubtitles: 'lt' },
  { code: 'ara', name: 'Arabic', opensubtitles: 'ar' },
  { code: 'heb', name: 'Hebrew', opensubtitles: 'he' },
  { code: 'per', name: 'Persian', opensubtitles: 'fa' },
  { code: 'hin', name: 'Hindi', opensubtitles: 'hi' },
  { code: 'tha', name: 'Thai', opensubtitles: 'th' },
  { code: 'vie', name: 'Vietnamese', opensubtitles: 'vi' },
  { code: 'ind', name: 'Indonesian', opensubtitles: 'id' },
  { code: 'may', name: 'Malay', opensubtitles: 'ms' },
  { code: 'jpn', name: 'Japanese', opensubtitles: 'ja' },
  { code: 'kor', name: 'Korean', opensubtitles: 'ko' },
  { code: 'chi', name: 'Chinese (simplified)', opensubtitles: 'zh-cn' },
  { code: 'zht', name: 'Chinese (traditional)', opensubtitles: 'zh-tw' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
const BY_OPENSUBTITLES = new Map(LANGUAGES.map((l) => [l.opensubtitles, l]));

export function languageByCode(code: string): Language | undefined {
  return BY_CODE.get(code);
}

export function languageByOpenSubtitles(code: string): Language | undefined {
  return BY_OPENSUBTITLES.get(code.toLowerCase());
}
