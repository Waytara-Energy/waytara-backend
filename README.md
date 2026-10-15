# waytara-backend

The server behind the WayTara gateway: it receives data from the inverter gateways, decodes it, keeps the 28-day cadence history, writes the 15-minute summaries to Supabase, relays Go Live to the dashboard, sends settings to the inverter, and (later) acts as the OCPP central system for EV chargers.

Design and decisions: `docs/GATEWAY_ARCHITECTURE_V2.md` in the dashboard repository (`D:\Manoj-Waytara\Projects`). This repository is built task by task (A2 to A11, then B1 to B6, section 20 of that plan).

## Status

| Task | State |
|---|---|
| **A2** skeleton: settings, health, security layer, safe logs, CI | done |
| **A3** core libraries: sealed messages, decode, 15-minute summaries, register map | done |
| **A4a** sign-in checks, equipment keys, claim tickets, the database layer | done |
| **A4b** built-in MQTT broker (`/mqtt`, WebSocket) and the data intake (sealed batches to 15-minute summaries, acknowledgements, register map) | done |
| **A4c** storage in Supabase (`src/db/supabase-ingest-store.ts`), device status, broker on by default, simulated board | built; live end-to-end run pending |
| A5 cadence storage and reports; A6 to A11 firmware, setup page, data path, write-back, dashboard, cut-over; Part B EV charger | later |

The core libraries (`src/core`) are plain functions with no network or database; the runtime is built from them.

## Endpoints (A4a)

All under `/v1`. Everything except `/v1/claim` needs `Authorization: Bearer <Supabase access token>`; the token is verified against the project's published signing keys, so the backend holds no sign-in secret. Who may do what is decided by the database (`can_access_site`, `site_staff`, `gw_actor_can_manage_keys`), and a caller who is not allowed gets the same "not found" as for something that does not exist.

| Call | Who | What |
|---|---|---|
| `GET /v1/whoami` | any signed-in user | who the token says you are |
| `POST /v1/equipment/{id}/keys` `{kind, label?}` | admin, or staff assigned to the site | make a key; the secret is in the answer **once** |
| `POST /v1/keys/{id}/rotate` `{grace_seconds?}` | same | replace a key; the old one stops now or after the grace period |
| `DELETE /v1/keys/{id}` `{reason?}` | same | revoke a key |
| `POST /v1/equipment/{id}/claim-tickets` `{hardware_id}` | the site's owner, assigned staff, an admin | a single-use ticket (15 minutes) for one board |
| `POST /v1/claim` `{ticket, hardware_id, board_public_key}` | the board itself (no sign-in) | the board collects its key, encrypted so only that board can read it |

Keys are encrypted with `KEY_ENCRYPTION_MASTER` before they are stored; answers that contain a secret are never cached. Try the settings on your own computer with `npm run check:supabase`.

## The broker (A4b)

Boards connect with MQTT over `wss://hub.waytaraenergy.com/mqtt`. Login: user name = equipment id, client id = `gw-<equipment id>`, password = a token derived one way from the equipment key (`base64url(HMAC-SHA-256(key, "wt-mqtt-login/v1|<id>"))`, vectors in `test-vectors/mqtt-login.json`). A board may publish only `wt/v1/<id>/up/{data,hb,evt,state}`, subscribe only to `wt/v1/<id>/dn/{ack,cmd,map}` (no wildcards), and use only its own `up/state` as last-will. Every refusal looks the same to the board. Revoking or rotating a key drops the connection within seconds; a source address with too many failed logins is shut out for a minute.

Sealed batches become 15-minute summaries; a frame is acknowledged only once the summary containing it has been written and is at least two minutes behind the last written boundary, so a restart can rebuild the open bucket from frames the board still holds.

Storage is `src/db/supabase-ingest-store.ts`, which calls `gw_equipment_profile`, `gw_store_map`, `gw_ingest_summaries` and `gw_report_heartbeat` (migration `20261015020000_gateway_ingest.sql` in the dashboard repository). The broker and the intake start by default whenever the database settings are present; `GATEWAY_INGEST=false` switches them off. A board's check-in is written every 10 s, and the database turns three missed check-ins into "offline".

Try it without hardware: `SIM_URL=wss://hub.waytaraenergy.com/mqtt SIM_EQUIPMENT_ID=<id> SIM_KEY_FILE=<file with the key> npx tsx scripts/simulate-board.ts 240` (see the top of `scripts/simulate-board.ts`).

## Run it

Needs Node 24 (see `.node-version`) and npm.

```bash
npm install
cp .env.example .env     # local settings; this file is git-ignored
npm run dev              # restarts on change, pretty logs
```

Then open http://localhost:3000/healthz.

| Command | What it does |
|---|---|
| `npm run dev` | Run with automatic restart, reads `.env` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server (Render does this) |
| `npm run typecheck` | TypeScript check, no output files |
| `npm run lint` | ESLint |
| `npm test` | All tests (no network, no database) |

## Settings

All settings are environment variables, checked once at start-up. A wrong value stops the service with a message that names the setting and never prints its value. The full list with examples is in `.env.example`. On Render, set them on the service's **Environment** page; `TRUST_PROXY=true` and `NODE_ENV=production` are the two that matter most there.

## What the skeleton protects against

* **Browsers from other websites:** CORS answers only for the websites in `ALLOWED_ORIGINS` (https only in production).
* **Floods and probing:** a rate limit per client address, applied to unknown paths as well; the health probe is exempt.
* **Oversized or broken requests:** body size limit, and JSON or schema errors answered with a short JSON error that never echoes the input.
* **Leaks through errors:** an unexpected error is logged in full and answered with "Something went wrong" plus a request id.
* **Leaks through logs:** `Authorization`, cookies, and secret query values (`token`, `ticket`, `key`, `password`...) are removed before anything is written.
* **Browser-side attacks on a JSON API:** a strict content policy (`default-src 'none'`), no framing, no content sniffing, no referrer, and HSTS in production.

## Layout

```
src/
  core/
    seal.ts          sealed message format (AES-256-GCM, HKDF, MessagePack) and replay guard
    decode.ts        raw register words -> values, from the catalogue rules
    rollup.ts        15-minute summaries (sample and hold), late-data safe
    register-map.ts  what a board polls and may write, built from the catalogue
    key-vault.ts     equipment keys encrypted at rest (master key from the environment)
    ecies.ts         the box a board opens to receive its key
  db/                the one interface to the database (gw_* functions) and its Supabase implementation
  features/keys/     key and claim logic, key generation, the HTTP routes
  features/broker/   the MQTT broker (Aedes), topic rules, key cache, the /mqtt WebSocket route
  features/ingest/   sealed message intake: decode, summaries, acknowledgements, register map, heartbeat
  db/supabase-ingest-store.ts  the intake's storage (gw_* functions)
  lib/jwt.ts         sign-in token verification
  server.ts          start-up and signal handling
  app.ts             builds the web app (also used by tests)
  config.ts          settings schema
  lifecycle.ts       graceful shutdown
  logger.ts          log options (redaction)
  plugins/security.ts  headers, CORS, rate limit, errors, request ids
  plugins/auth.ts    the signed-in user on each request
  routes/health.ts   /healthz and /readyz
  lib/               errors, readiness checks, redaction helpers
test/                one file per area; no test needs the network
test/fixtures/       the Waytara Office catalogue and a replayed afternoon of real readings
test-vectors/        shared proofs that the firmware and this backend agree (seal.json, decode.json, claim.json, mqtt-login.json)
scripts/             simulate-board.ts (a stand-in board), make-seal-vectors.ts, make-claim-vectors.ts, make-mqtt-login-vectors.ts (only when a format is changed on purpose); check-supabase.ts
```

## Conventions

* Every new dependency (database, storage, broker) registers a readiness check with `app.readiness.register(name, fn)`.
* Errors meant for the caller are `AppError`s; everything else is a bug and is hidden from the caller.
* Never log a request body, a header value or a key. If something new could hold a secret, add its name to `src/lib/redact.ts` and a test.
* Commit messages are written as timesheets (task, start and end time in IST, hours, work done, verification, open items).
