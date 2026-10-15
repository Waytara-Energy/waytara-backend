# waytara-backend

The server behind the WayTara gateway: it receives data from the inverter gateways, decodes it, keeps the 28-day cadence history, writes the 15-minute summaries to Supabase, relays Go Live to the dashboard, sends settings to the inverter, and (later) acts as the OCPP central system for EV chargers.

Design and decisions: `docs/GATEWAY_ARCHITECTURE_V2.md` in the dashboard repository (`D:\Manoj-Waytara\Projects`). This repository is built task by task (A2 to A11, then B1 to B6, section 20 of that plan).

## Status

**Task A2 (this commit): the skeleton.** It starts, answers health checks, protects itself, logs safely, and has no business logic yet.

| Done | Not yet |
|---|---|
| Validated settings; `/healthz` and `/readyz`; security headers; allowed-websites list; rate limits (including unknown paths); safe error answers; request ids; secret-free logs; graceful shutdown; tests; CI | Sign-in checks (A4); MQTT broker (A4); Supabase and storage (A4, A5); decoding and summaries (A3); OCPP (Part B) |

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
  server.ts          start-up and signal handling
  app.ts             builds the web app (also used by tests)
  config.ts          settings schema
  lifecycle.ts       graceful shutdown
  logger.ts          log options (redaction)
  plugins/security.ts  headers, CORS, rate limit, errors, request ids
  routes/health.ts   /healthz and /readyz
  lib/               errors, readiness checks, redaction helpers
test/                one file per area; no test needs the network
```

## Conventions

* Every new dependency (database, storage, broker) registers a readiness check with `app.readiness.register(name, fn)`.
* Errors meant for the caller are `AppError`s; everything else is a bug and is hidden from the caller.
* Never log a request body, a header value or a key. If something new could hold a secret, add its name to `src/lib/redact.ts` and a test.
* Commit messages are written as timesheets (task, start and end time in IST, hours, work done, verification, open items).
