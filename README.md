# waytara-backend

The server behind the WayTara gateway: it receives data from the inverter gateways, decodes it, keeps the 28-day cadence history, writes the 15-minute summaries to Supabase, relays Go Live to the dashboard, sends settings to the inverter, and (later) acts as the OCPP central system for EV chargers.

Design and decisions: `docs/GATEWAY_ARCHITECTURE_V2.md` in the dashboard repository (`D:\Manoj-Waytara\Projects`). This repository is built task by task (A2 to A11, then B1 to B6, section 20 of that plan).

## Status

| Task | State |
|---|---|
| **A2** skeleton: settings, health, security layer, safe logs, CI | done |
| **A3** core libraries: sealed messages, decode, 15-minute summaries, register map | done (this commit) |
| A4 runtime: sign-in checks, keys, built-in broker, Supabase writes, first deploy | next |
| A5 cadence storage and reports; A6 to A11 firmware, setup page, data path, write-back, dashboard, cut-over; Part B EV charger | later |

The core libraries are plain functions with no network or database; they are what the runtime (A4) is built from.

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
  server.ts          start-up and signal handling
  app.ts             builds the web app (also used by tests)
  config.ts          settings schema
  lifecycle.ts       graceful shutdown
  logger.ts          log options (redaction)
  plugins/security.ts  headers, CORS, rate limit, errors, request ids
  routes/health.ts   /healthz and /readyz
  lib/               errors, readiness checks, redaction helpers
test/                one file per area; no test needs the network
test/fixtures/       the Waytara Office catalogue and a replayed afternoon of real readings
test-vectors/        shared proofs that the firmware and this backend agree (seal.json, decode.json)
scripts/             make-seal-vectors.ts regenerates test-vectors/seal.json (only when the format is changed on purpose)
```

## Conventions

* Every new dependency (database, storage, broker) registers a readiness check with `app.readiness.register(name, fn)`.
* Errors meant for the caller are `AppError`s; everything else is a bug and is hidden from the caller.
* Never log a request body, a header value or a key. If something new could hold a secret, add its name to `src/lib/redact.ts` and a test.
* Commit messages are written as timesheets (task, start and end time in IST, hours, work done, verification, open items).
