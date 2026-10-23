# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Stack and commands
- Zero-dependency Node.js 20 server ([`server.js`](server.js)) plus a single-file vanilla JS SPA ([`public/index.html`](public/index.html)). There is no `package.json`, bundler, linter, formatter or test suite. Do not add npm dependencies. Code and UI strings are in Italian.
- Run locally: `USERS='mister:pw:coach;luca:pw:scout' DATA_DIR=./data node server.js` (port 8080, `/healthz` for health). Without `USERS` it prints temporary credentials to the log.
- Hash a password: `node server.js hash '<pw>'` gives `scrypt$salt$hash`, which can go in `USERS` instead of a plaintext password.
- Docker: `docker compose up -d --build`. HTTPS with Caddy: `docker compose --profile https up -d --build`. Both need a `.env` at the repo root (`env_file: .env`), which is git-ignored and never committed.
- Manage users with [`users.sh`](users.sh) (`list`, `roles`, `add`, `passwd`, `role`, `remove`, `apply`) instead of editing `USERS` by hand. It rewrites only the `USERS=` line of `.env` (single-quoted so compose does not expand the `$` in scrypt hashes), keeps a `.env.bak`, and stores passwords hashed. If `.env` is missing, `add` creates it from `.env.example`. Hashing uses `node`, or falls back to building and running the `scout-pallavolo:latest` Docker image. `ENV_FILE=path` overrides the file, which is useful for testing without touching the real `.env`.
- [`.env.example`](.env.example) is the template `users.sh add` copies to `.env` when it is missing. The image is still called `scout-pallavolo:latest` (used by `docker-compose.yml` and `users.sh`): do not rename it without updating both.
- The Dockerfile copies only `server.js` and `public/`. Any new server-side file must be added to the Dockerfile `COPY` lines.

## Server conventions ([`server.js`](server.js))
- All state is in-memory (`DB`, `HIST`, `LOCK`) and written to `DATA_DIR` as `data.json`, `history.json` and `secret`. Always use `writeJson()` (tmp file + rename) and never write these files directly.
- `DB.ver` is an optimistic-concurrency counter. `PUT /api/data` takes `base` and returns 409 with `conflict:true` if it is stale, or `error:'lock'` if another session holds the scout lock. The client handles both.
- Only one session (`sid`) holds the scout lock. It expires after `LOCK_TTL`, which is at least 20 s and defaults to 90 s. Clients send `beat` every ~9 s (every third 3 s tick), `get`, `take` and `release` are the other actions, and `pagehide` sends a `release` beacon.
- Sessions are HMAC-signed cookies named `sv`. `readSession` rejects the cookie if the user was removed or their role changed, so editing `USERS` invalidates sessions.
- Roles are `coach`, `scoutman` and `scout`. `coach` and `scoutman` are equivalent for now (`isFull()` in `server.js`, `isCoach()` in `index.html`) and are the only ones receiving `hist` and using `GET`/`DELETE /api/history/:mid` (`DELETE` also requires holding the scout lock, 409 otherwise). `normRole` also accepts the aliases `allenatore` and `admin` for `coach`. When roles change, keep `valid_role`, `cmd_roles` and the last-admin check in [`users.sh`](users.sh), the role labels in `paintBars()` in `index.html`, and the README roles table in sync.
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
- Credits footer (`credits()`, `[data-r=cr]`) is hidden in the scout view while a match is running and in print. The optional logo `public/image/Scouty-Logo.jpg` (name is case-sensitive) is probed with an `Image()` and injected into `[data-logo]` only if it loads, so never reference it with a plain `<img>` (it would show a broken icon). Images in `public/` ship in the Docker image, so adding one needs a rebuild.
- Data lives in a bind mount `./data:/data` (not a named volume). The container runs as `node` (UID 1000), so `data/` must be owned by 1000:1000; `server.js` exits at start with a clear message if `DATA_DIR` is not writable. `data/` is git-ignored and excluded from the build via `.dockerignore` at the repo root.
