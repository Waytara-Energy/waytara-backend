import Fastify, { type FastifyInstance } from "fastify";
import type { Writable } from "node:stream";
import type { Config } from "./config.js";
import { KeyVault } from "./core/key-vault.js";
import type { GatewayDb } from "./db/gateway-db.js";
import { createSupabaseGatewayDb } from "./db/supabase-gateway-db.js";
import { registerKeyRoutes } from "./features/keys/routes.js";
import { KeyService } from "./features/keys/service.js";
import { createSupabaseTokenVerifier, type TokenVerifier } from "./lib/jwt.js";
import { registerAuth } from "./plugins/auth.js";
import { Readiness } from "./lib/readiness.js";
import { buildLoggerOptions } from "./logger.js";
import { registerSecurity, requestIdFrom } from "./plugins/security.js";
import { registerHealthRoutes } from "./routes/health.js";

declare module "fastify" {
  interface FastifyInstance {
    readiness: Readiness;
    config: Config;
  }
}

/** The parts that talk to the outside world. Tests pass fakes; otherwise they are built from the settings. */
export interface Deps {
  db: GatewayDb;
  verify: TokenVerifier;
  vault: KeyVault;
}

export interface BuildOptions {
  /** Tests pass a stream to capture log lines, or false to silence them. */
  logger?: false | { stream: Writable };
  deps?: Partial<Deps>;
}

/**
 * Builds the web application. Nothing here opens a port, so tests can call it and use app.inject().
 * Later tasks add their routes and dependencies in this function.
 */
export async function buildApp(config: Config, options: BuildOptions = {}): Promise<FastifyInstance> {
  const loggerOption =
    options.logger === false
      ? false
      : options.logger
        ? { ...buildLoggerOptions({ ...config, env: "test" }), stream: options.logger.stream }
        : buildLoggerOptions(config);

  const app = Fastify({
    logger: loggerOption,
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    genReqId: (req) => requestIdFrom(req.headers["x-request-id"]),
    requestIdHeader: false,
  });

  const readiness = new Readiness();
  app.decorate("readiness", readiness);
  app.decorate("config", config);

  await registerSecurity(app, config);
  await registerHealthRoutes(app, config, readiness);

  const db = options.deps?.db ?? (config.supabase ? createSupabaseGatewayDb(config.supabase) : undefined);
  const verify = options.deps?.verify ?? (config.supabase ? createSupabaseTokenVerifier(config.supabase.url) : undefined);
  const vault = options.deps?.vault ?? (config.keyMasters ? new KeyVault(config.keyMasters) : undefined);
  if (db && verify && vault) {
    registerAuth(app, verify);
    await registerKeyRoutes(app, new KeyService(db, vault));
    readiness.register("database", () => db.ping());
  } else {
    app.log.warn("database or key settings are missing: the key and claim endpoints are not available");
  }

  return app;
}
