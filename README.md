# waytara-backend

The server behind the WayTara gateway: it receives data from the inverter gateways, decodes it, keeps the 28-day cadence history, writes the 15-minute summaries to Supabase, relays Go Live to the dashboard, sends settings to the inverter (later), and acts as the OCPP central system for EV chargers.

Design and decisions: `docs/GATEWAY_ARCHITECTURE_V2.md` in the dashboard repository (`D:\Manoj-Waytara\Projects`). This repository is built task by task (A2 to A11, then B1 to B6, section 20 of that plan).

## Status

| Task | State |
|---|---|
| **A2** skeleton: settings, health, security layer, safe logs, CI | done |
| **A3** core libraries: sealed messages, decode, 15-minute summaries, register map | done |
| **A4a** sign-in checks, equipment keys, claim tickets, the database layer | done |
| **A4b** built-in MQTT broker (`/mqtt`, WebSocket) and the data intake (sealed batches to 15-minute summaries, acknowledgements, register map) | done |
| **A4c** storage in Supabase (`src/db/supabase-ingest-store.ts`), device status, broker on by default, simulated board | done, live |
| **A5** cadence data in Cloudflare R2 (5-minute files, daily join), `GET /v1/reports/cadence` | done, live |
| **B2/B3** OCPP 1.6-J server, EV sessions with the solar / battery / grid split, remote commands | done, live with a simulated charger; the real charger is next |
| **A9** settings write-back: a changed setting is checked, sent to the unit as a sealed command, written with a read-back and recorded as confirmed or failed; the unit's own values are recorded too | hub and database done and tested without hardware (494 tests, 17 database checks); the board side is written and being built; not yet tried on the real inverter |
| A11 cut-over and over-the-air update | later |

The core libraries (`src/core`) are plain functions with no network or database; the runtime is built from them.

## Settings write-back (A9)

`src/features/ingest/settings.ts` (used by the data intake) keeps the settings log (`equipment_configs`) and the inverter in step. Every 5 seconds, for each board that is checking in, it asks the database for the settings people changed in the last 10 minutes (`gw_pending_writes`) and for each one:

1. finds the setting on the unit's allow-list (the `writes` of its register map) and refuses it in plain words if it is not there, is not marked verified in the catalogue (unless `ALLOW_UNVERIFIED_WRITES=true`), is not a value the setting can hold, or is outside its range (`src/core/setting-value.ts` turns the text into the raw register value with the catalogue rule, and back again for the read-back);
2. seals a command `{id, type: "write", key, reg, mask, raw, issued_at, expires_at}` on `dn/cmd` (valid for 45 seconds);
3. waits for the board's `write_result` event (`{id, ok, readback, error}`), then records `agent_write_ok` (value = what was read back) or `agent_write_failed` (value = what the inverter still holds, previous value = what was asked, notes = why) through `gw_report_settings`. No answer after a minute is recorded as failed.

The unit's own values are recorded as `agent_initial_read` at first sight and when a value changes by itself (a change on the inverter's screen), never while a request for that setting is waiting (the database refuses that too). Setting values come from the same frames as the other readings; nothing extra is polled. Settings that are not shown to the customer are never written. Migration `20261016020000_gateway_settings_writes.sql` in the dashboard repository holds the three database functions; the backend identity has no profile, so the function records the unit itself as the actor of the log row, as the old agent did.

Not done here: settings that need special reading (HHMM times, the inverter clock, serial number) and settings spread over several registers.

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

## Cadence data (A5)

Every frame a board sends is kept as it came: raw register words, in small gzipped CSV files per equipment and 5-minute window (UTC), `cadence/v1/<equipment id>/<yyyy>/<mm>/<dd>/<HHmm>.csv.gz`, in the R2 bucket. Words, not decoded values, so a wrong scale in the catalogue can be corrected and the history read correctly afterwards. A window is written when it has ended (plus 15 s); a late frame rewrites its window after joining it with what is already there, and after a restart the first write of a window reads the old file first. A board is told a frame is stored only after its file has been written, so nothing is lost if the backend restarts or the file store is down for a while (the board keeps what is not acknowledged).

An hour after start-up and then every hour, each finished day's files are joined into `day.csv.gz`, so a week reads 7 files. Files older than 30 days are deleted by a lifecycle rule on the bucket (prefix `cadence/`); the backend itself refuses anything older than 28 days.

| Call | Who | What |
|---|---|---|
| `GET /v1/reports/cadence/keys?equipment=<id>` | signed-in, with access | the values this person may pick, with names, units and groups |
| `GET /v1/reports/cadence?equipment=<id>&from=<time>&to=<time>&keys=a,b,c&format=csv` | same | decoded readings, one row per frame; `format=json` with `limit` for a preview. At most 7 days and 40 values per call, within the last 28 days. Times are ISO 8601 or epoch milliseconds |

Staff (admins, and employees assigned to the site) can pick every value; a customer only those shown to customers, and only on a plan with the reports feature (`gw_cadence_access` decides). Anyone else gets the same "not found" as for equipment that does not exist. Settings: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (all four or none; without them cadence data is not kept). Check them with `npm run check:r2`; look at what a live run wrote with `scripts/inspect-cadence.ts`.

## EV chargers (OCPP 1.6-J)

Chargers connect to `wss://hub.waytaraenergy.com/ocpp/<secret>/<charger name>` (or `/ocpp/<charger name>` with Basic authentication: user = name, password = secret). The secret is a charger key made on the admin **Device keys** page. An unknown address is refused with a plain 404 before any WebSocket starts; there is one connection per charger (a new one replaces the old only if the old no longer answers a ping); failed attempts per address are rate limited; the secret is redacted from every log line (`src/lib/redact.ts`).

The server answers boot, heartbeat, status, authorise, start / stop transaction and meter values (kWh or Wh, kW or W, phases such as `L1-N`, converted by their units: `measurands.ts`) and stores every sample (`ev_session_samples`, kept 6 months). When a session ends, the summary is worked out from the stored samples, so a restart in the middle loses nothing: peak and average power, charging time, and where the energy came from. Solar comes first, then the battery, then the grid, from the inverter at the same site at each sample (`split.ts`), scaled so the three add up to the charger's own energy; the part with no inverter reading is "not known". A meter that goes backwards, or an impossible rate, marks the session `suspect` and keeps the figures as reported.

A charge whose stop never arrives (the connector says Available or Finishing 90 seconds later with the session still open, or a new charge starts on the same connector) is closed at its last reading with status `aborted` and reason `MissingStop`; if the charger's real stop turns up later it replaces those figures. Open sessions are picked up again from the database when the charger reconnects or the server restarts, so readings and a target survive both.

Commands need a sign-in as the charger's owner or site staff; the answer says whether the charger accepted.

| Call | Body |
|---|---|
| `GET /v1/ev/{equipment}/status` | connected or not, charger name, time of the last message |
| `GET /v1/ev/{equipment}/frames?limit=100` | staff only: the last messages the charger sent and the server answered (card identifiers hidden; kept in memory, empty after a restart) |
| `GET /v1/ev/{equipment}/frames/archive?day=YYYY-MM-DD` | staff only: the long-term message log of one UTC day (JSON lines). Written to the file store every 10 minutes as `ocpp/v1/<equipment>/<yyyy>/<mm>/<dd>/…ndjson.gz`, kept 90 days |
| `POST /v1/ev/{equipment}/remote-start` | `{connector_id?, id_tag?, target_kwh?}`; with `target_kwh` the server stops the charge by itself once the meter has delivered that many units (asks again after a minute, up to five times) |
| `POST /v1/ev/{equipment}/remote-stop` | `{transaction_id}` |
| `POST /v1/ev/{equipment}/reset` | `{type: "Soft" or "Hard"}` |
| `POST /v1/ev/{equipment}/unlock` | `{connector_id?}` |
| `POST /v1/ev/{equipment}/trigger` | `{message: "MeterValues" or "StatusNotification" or "Heartbeat" or "BootNotification", connector_id?}` |

Try it without the charger: `SIM_URL=wss://hub.waytaraenergy.com/ocpp/<secret>/<name> npx tsx scripts/simulate-charger.ts 90 10`.

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
  features/cadence/  5-minute files (writer), reading and daily join (archive), decoding and CSV (report), the report routes
  storage/object-store.ts  the file store (Cloudflare R2 over the S3 API) and an in-memory one for tests
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
scripts/             simulate-board.ts (a stand-in board), check-r2.ts, inspect-cadence.ts, make-seal-vectors.ts, make-claim-vectors.ts, make-mqtt-login-vectors.ts (only when a format is changed on purpose); check-supabase.ts
```

## Conventions

* Every new dependency (database, storage, broker) registers a readiness check with `app.readiness.register(name, fn)`.
* Errors meant for the caller are `AppError`s; everything else is a bug and is hidden from the caller.
* Never log a request body, a header value or a key. If something new could hold a secret, add its name to `src/lib/redact.ts` and a test.
* Commit messages are written as timesheets (task, start and end time in IST, hours, work done, verification, open items).
