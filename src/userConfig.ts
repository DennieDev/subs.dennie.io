import { z } from 'zod';
import { languageByCode } from './languages.js';

export const HearingImpairedSchema = z.enum(['include', 'exclude', 'prefer']);

export const PreferencesSchema = z.object({
  /** Stremio language codes, most preferred first. */
  languages: z
    .array(z.string())
    .min(1, 'Pick at least one language')
    .max(10, 'Pick at most 10 languages')
    .refine((codes) => codes.every((c) => languageByCode(c)), 'Unknown language')
    .refine((codes) => new Set(codes).size === codes.length, 'Duplicate language'),
  hearingImpaired: HearingImpairedSchema,
  includeMachineTranslated: z.boolean(),
  maxPerLanguage: z.number().int().min(1).max(30),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

/** Stored per provider. `state` holds cached sessions (e.g. a login token). */
export const ProviderEntrySchema = z.object({
  credentials: z.record(z.string(), z.string()),
  state: z.record(z.string(), z.unknown()).default({}),
});
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

export const UserConfigSchema = z.object({
  preferences: PreferencesSchema,
  providers: z.record(z.string(), ProviderEntrySchema),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;
