import { z } from 'zod';

const EnvSchema = z.object({
  // Public origin, e.g. https://subs.example.com. Used in manifest and subtitle URLs.
  BASE_URL: z
    .string()
    .url()
    .transform((v) => v.replace(/\/+$/, '')),
  // 64 hex chars. Together with each user's token it encrypts stored credentials.
  SECRET_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'SECRET_KEY must be 64 hex characters'),
  // Code new users must enter to create a config. Keeps the instance from being an open
  // relay for the shared OpenSubtitles API key.
  SIGNUP_CODE: z.string().min(8, 'SIGNUP_CODE must be at least 8 characters'),
  // Consumer key from https://www.opensubtitles.com/consumers
  OPENSUBTITLES_API_KEY: z.string().min(1),
  // Optional notice shown at the top of the configure page (plain text; blank lines split
  // paragraphs). Use it for things like an availability disclaimer.
  NOTICE: z.string().max(2000).optional(),
  // Delete configs nobody has used for this many days. 0 keeps them forever.
  CONFIG_RETENTION_DAYS: z.coerce.number().int().min(0).default(365),
  PORT: z.coerce.number().int().positive().default(7000),
  DATA_DIR: z.string().default('/data'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Report which variables are wrong, never their values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}
