import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createApp, redact, VERSION } from './app.js';
import { loadEnv } from './env.js';
import { OpenSubtitlesProvider } from './providers/opensubtitles.js';
import { ConfigStore } from './store.js';

const env = loadEnv();

// Logs never contain tokens, credentials or provider links: only fixed messages and
// redacted paths.
function log(message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));
}

const store = new ConfigStore(env.SECRET_KEY, env.DATA_DIR);
const app = createApp({
  baseUrl: env.BASE_URL,
  signupCode: env.SIGNUP_CODE,
  store,
  log,
  providers: [
    new OpenSubtitlesProvider({
      apiKey: env.OPENSUBTITLES_API_KEY,
      userAgent: `DennieSubs v${VERSION}`,
    }),
  ],
});

const root = new Hono();
root.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  if (c.req.path !== '/health') {
    log('request', { method: c.req.method, path: redact(c.req.path), status: c.res.status, ms: Date.now() - started });
  }
});
root.route('/', app);

const server = serve({ fetch: root.fetch, port: env.PORT }, () => {
  log('listening', { port: env.PORT, version: VERSION, configs: store.count() });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
