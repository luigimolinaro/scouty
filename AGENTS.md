# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Stack and commands
- Zero-dependency Node.js 20 server ([`server.js`](server.js)) plus a single-file vanilla JS SPA ([`public/index.html`](public/index.html)). There is no `package.json`, bundler, linter, formatter or test suite. Do not add npm dependencies. Code and UI strings are in Italian.
- Run locally: `USERS='mister:pw:coach;luca:pw:scout' DATA_DIR=./data node server.js` (port 8080, `/healthz` for health). Without `USERS` it prints temporary credentials to the log.
- Hash a password: `node server.js hash '<pw>'` gives `scrypt$salt$hash`, which can go in `USERS` instead of a plaintext password.
- Docker: `docker compose up -d --build`. HTTPS with Caddy: `docker compose --profile https up -d --build`. Both need a `.env` next to `docker-compose.yml` (`env_file: .env`).
- [`.env.example`](scout-pallavolo/.env.example) and [`.dockerignore`](scout-pallavolo/.dockerignore) live in `scout-pallavolo/`, not the repo root. Copy `.env.example` to `.env` at the root. The README says `cd scout-pallavolo`, which does not match the layout.
- The Dockerfile copies only `server.js` and `public/`. Any new server-side file must be added to the Dockerfile `COPY` lines.

## Server conventions ([`server.js`](server.js))
- All state is in-memory (`DB`, `HIST`, `LOCK`) and written to `DATA_DIR` as `data.json`, `history.json` and `secret`. Always use `writeJson()` (tmp file + rename) and never write these files directly.
- `DB.ver` is an optimistic-concurrency counter. `PUT /api/data` takes `base` and returns 409 with `conflict:true` if it is stale, or `error:'lock'` if another session holds the scout lock. The client handles both.
- Only one session (`sid`) holds the scout lock. It expires after `LOCK_TTL`, which is at least 20 s and defaults to 90 s. Clients send `beat` every ~9 s (every third 3 s tick), `get`, `take` and `release` are the other actions, and `pagehide` sends a `release` beacon.
- Sessions are HMAC-signed cookies named `sv`. `readSession` rejects the cookie if the user was removed or their role changed, so editing `USERS` invalidates sessions.
- Roles are `coach` and `scout`. Only the coach receives `hist` and may read `/api/history/:mid`. `normRole` also accepts the aliases `allenatore`, `admin` and `scoutman`.
- Every non-GET API call must be `application/json` (415 otherwise). Body size limits are set per route in `readBody`. Handler errors return a generic `{error:'errore'}` and details go only to the server log.
- The CSP in `SEC_HEADERS` allows only `'self'`, inline script/style, and Google Fonts. Do not add external scripts, CDNs or analytics, because they would be blocked.
- Static fallback is SPA-style: any unknown GET path serves `index.html`.

## Frontend conventions ([`public/index.html`](public/index.html))
- The whole app is one IIFE wrapped in `#sv`. Elements are looked up with `$('name')`, which resolves `[data-r=name]` inside `#sv`, not by id. Clicks are handled through `data-*` attributes (`data-v`, `data-fs`, `data-i`/`data-e`, and so on).
- CSS and JS are minified-style one-liners. Match the surrounding terse style when editing. Italian user-visible text uses `\uXXXX` escapes for accents and symbols, not literal characters.
- Never use `localStorage`. The `store` object keeps `state` and `squads` in memory (`MEM`/`SYNC`) and syncs them to the server through debounced `markDirty()`/`flush()`. Changing `S` requires `persist()`, which `render()` already calls. Add new persisted fields to both `persist()` and `freshMatch()`.
- Remote data is applied through `hydrate()`, which keeps local view state (`view`, `fs`, `f`, `so`, `si`, `rp`). Add any new local-only UI state to its `keep` list.
- Before changing match data, call `canWrite()` first. It returns false while another user holds the lock (read-only mode).
- Always pass user-supplied text through `esc()` before putting it in `innerHTML`.
- Events are stored as arrays `[playerIdx, fund, '+'|'/'|'-', set, role, pointTeam]`. Fundamentals are `BT`, `ATT`, `R`, `M` and `Fallo`. Rally history is `rally:[[set, team]]`. `sc` is a fixed array of 5 sets. A set ends at `tgt(s)` points with a 2-point lead, and 3 sets won archives the match.
- Excel export is hand-built SpreadsheetML XML (`xc`/`xr`/`xsheet`). PDF export is `window.print()` on the stats view. Do not add libraries for either.
- Historical matches are shown by temporarily swapping them into `S` through `withMatch()`. Stats code must read from `S`, not from a separate parameter.
