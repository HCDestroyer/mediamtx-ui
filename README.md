# Nodo

Control panel for one or more [MediaMTX](https://mediamtx.org) servers, plus a host
agent that edits `mediamtx.yml`, manages binaries and hardware, and runs routes
(ingest, UDP/RTP/SRT/RTMP outputs, stable PIDs). One React codebase builds the static
web app and, later, the Android APK (Capacitor).

The project was first called "MediaMTX Panel"; the repository name still reflects that.

Target MediaMTX version: **v1.21.4** (the panel reads `GET /v3/info` and adapts
route and field names to older servers).

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Scaffold, responsive layout, theme, server store, endpoint resolver | done |
| 2 | Dashboard, channel list and detail, copy URLs, demo mode, panel login | done |
| 3 | Path editor, transcode wizard, native `forward` multistream, YAML export | |
| 4 | Host agent: `mediamtx.yml` editing with validation, routes, binaries, hardware | |
| 5 | Connections + kick, WHEP/HLS preview | |
| 6 | Android APK | |

## Develop

```bash
npm install
npm run dev          # http://localhost:5173
npm run typecheck
npm test
npm run build        # outputs dist/
npm run preview      # serve dist/ on :4173, needed by the browser tests
npm run e2e          # browser tests; needs Playwright and `npm run preview` running
```

The browser tests in `e2e/` use [Playwright](https://playwright.dev), which is not a
dependency of the project: install it (`npm i -D playwright && npx playwright install chromium`)
before running them.

A stand-in for the Control API is included so the panel can be tried without a
server:

```bash
node scripts/mock-mediamtx.mjs --port 9997 --user panel --pass secret
```

Then add a server in the panel with endpoint `127.0.0.1:9997`. Or use the **demo server**
(button on the empty Channels screen): it runs on an in-memory simulator and needs no network.

## Conventions

- All code, identifiers, comments and commits are in English. The UI is in
  Spanish and every string lives in `src/i18n/es.ts`.
- UI uses HeroUI v3 components only (`@heroui/react`, `@heroui/styles`), Tailwind v4.
- Network access goes through `src/core/http.ts` so the Android build can swap in
  a native transport without touching the rest of the app.
- Initial bundle budget: under 250 KB gzip. Secondary screens are lazy-loaded.

## Layout

```
src/core/        types, HTTP transport, endpoint resolver, server import/export
src/store/       zustand stores: servers, preferences, connection state
src/components/  app shell, sidebar, bottom tabs, header, shared widgets
src/pages/       one file per screen (lazy-loaded except Channels)
src/i18n/        UI strings
scripts/         development helpers
```

## Security

- Panel login: username and password, created on first run (or later in Settings). The
  password is not stored. An argon2id key derived from it encrypts the server
  credentials in `localStorage` (AES-GCM), so they are not readable at rest.
- The key lives in memory only: a reload or the idle timeout (5/15/30 min) locks the
  panel again. Failed attempts back off 1 s, 2 s, 4 s … up to 30 s.
- A forgotten password cannot be recovered. "Forgot my password" deletes the saved
  servers and the account.
- It is a per-device protection, not a multi-user login: the panel has no server of
  its own. The back-off is client-side, so what really slows an offline attack on a
  copied `localStorage` is the argon2id cost.
- The crypto is pure JavaScript (`@noble/*`) on purpose: WebCrypto does not exist on
  plain `http` pages, which is how the panel is usually served inside a LAN. It loads
  on demand, outside the initial bundle.

## Notes

- Changes made through the Control API are applied live but are **not** written to
  `mediamtx.yml`; the panel will say so and offer a YAML export (phase 3).
- A page served over HTTPS cannot call an `http://` API (mixed content). Serve the
  panel over HTTP inside the LAN/VPN, or put the API behind an HTTPS proxy. The APK
  is not affected.
- Without panel protection, server credentials are stored in `localStorage` in clear text.
