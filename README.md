# Dennie Subs

A Stremio subtitle addon that signs in to subtitle providers with **each user's own account**
and lists subtitles in the languages they choose. It works directly in Stremio and as a custom
addon inside [AIOStreams](https://github.com/Viren070/AIOStreams).

Providers: **OpenSubtitles.com**. The provider interface (`src/providers/types.ts`) is built so
SubDL, SubSource and others can be added later.

## How it works

1. A user opens `https://subs.example.com/configure`, enters the signup code, signs in with their
   OpenSubtitles.com username and password, and orders their languages (e.g. Dutch, English).
2. The server verifies the login and stores the config **encrypted** in SQLite. The user gets a
   private addon URL: `https://subs.example.com/<token>/manifest.json`.
3. When a video plays, Stremio (or AIOStreams) asks the addon for subtitles. The addon searches
   OpenSubtitles (free, no quota) and returns a list ranked by language order, exact file match
   (video hash), trusted uploader and popularity.
4. Each subtitle URL points back to the addon. Only when the player opens one does the addon call
   OpenSubtitles' `/download` (this uses one of the user's daily downloads) and **redirect** the
   player to OpenSubtitles' own temporary link. Subtitle files never pass through this server.
   Resolved links are reused for 2 hours, so reopening a subtitle costs nothing.
5. If the user's daily quota is used up, the player gets a one-line subtitle saying so.

## Security

- The addon URL contains only a random token (24 bytes). The database stores `sha256(token)` and
  encrypts each config with AES-256-GCM using a key derived from `SECRET_KEY` **and** the token.
  A leaked database is useless without the tokens.
- Passwords are never sent back to the browser. Leaving a password blank on the edit page keeps
  the stored one.
- Optionally, new configs require `SIGNUP_CODE`, so the shared OpenSubtitles API key is not open to
  everyone. Without it, signup is open.
  Config writes are rate limited per IP (10 per 10 minutes), new configs to 30 per hour across all
  clients (each one tests a login against the provider, so this blocks credential stuffing and
  protects the API key), and searches to 120 per minute per config.
- Unused configs are deleted after `CONFIG_RETENTION_DAYS` (default 365). To know what is unused,
  each config records only the **day** it was last used (no times, no request details), written
  at most once a day. Using the addon or opening its configure page counts as use.
- Logs contain only fixed messages and paths with the token replaced by `***`. Subtitle request
  details (filename, video hash and size) are left out, so logs are not a viewing history.

## Configuration

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `BASE_URL` | yes | Public origin, e.g. `https://subs.example.com` |
| `SECRET_KEY` | yes | 64 hex chars (`openssl rand -hex 32`). **Never change it**: stored configs become unreadable. |
| `SIGNUP_CODE` | no | Code users must enter to create a config (min. 8 chars). Unset: open signup |
| `OPENSUBTITLES_API_KEY` | yes | Consumer key from <https://www.opensubtitles.com/consumers> |
| `NOTICE` | no | Plain-text notice at the top of the configure page (blank lines split paragraphs), e.g. an availability disclaimer |
| `CONFIG_RETENTION_DAYS` | no | Delete configs unused for this many days (default `365`, `0` keeps them forever) |
| `GITHUB_URL`, `DISCORD_URL` | no | Links shown as icons in the configure page header |
| `PORT` | no | Default `7000` |
| `DATA_DIR` | no | Default `/data` (SQLite database `subs.db`) |

Back up `DATA_DIR` together with `SECRET_KEY`.

## Using it in AIOStreams

Addons → Marketplace → **Custom** → paste the addon URL from the configure page. AIOStreams
forwards the video hash and filename, so exact-match subtitles rank first.

## Development

Node 24 is required (uses the built-in `node:sqlite`). Without Node installed locally:

```bash
docker run --rm --user 1000:1000 -e HOME=/tmp -v "$PWD":/app -w /app node:24-alpine \
  sh -c 'npm ci && npm run typecheck && npm test'
```

Build the image: `docker build -t subs .`

## Deployment

GitHub Actions tests every push and publishes an image to GitHub Container Registry
(`ghcr.io/<owner>/<repo>:latest`, plus a `sha-…` tag) from `main`. Run it with Docker Compose behind a reverse proxy that terminates TLS,
with `/data` on a persistent volume and the variables above set.

## Adding a provider

Implement `Provider` from `src/providers/types.ts` (`verify`, `search`, `resolve`), add the
provider's language codes to `src/languages.ts`, register it in `src/server.ts`, and add tests.
The configure page builds its form from `credentialFields` automatically.

Note: SubDL and SubSource deliver subtitles as ZIP archives. Players cannot open those, so such a
provider would have to download and unpack the file on this server and serve the text itself,
unlike OpenSubtitles' redirect. Decide on that deliberately before adding one.

## License

[MIT](LICENSE)
