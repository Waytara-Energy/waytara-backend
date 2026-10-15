import Fastify, { type FastifyInstance } from "fastify";
import type { Writable } from "node:stream";
import type { Config } from "./config.js";
import { KeyVault } from "./core/key-vault.js";
import type { GatewayDb } from "./db/gateway-db.js";
import { createSupabaseGatewayDb, SupabaseGatewayDb } from "./db/supabase-gateway-db.js";
import { SupabaseIngestStore } from "./db/supabase-ingest-store.js";
import { Broker } from "./features/broker/broker.js";
import { KeyCache } from "./features/broker/key-cache.js";
import { registerBrokerRoute } from "./features/broker/routes.js";
import { IngestService } from "./features/ingest/service.js";
import type { IngestStore } from "./features/ingest/store.js";
import { registerKeyRoutes } from "./features/keys/routes.js";
import { KeyService } from "./features/keys/service.js";
import { createSupabaseTokenVerifier, type TokenVerifier } from "./lib/jwt.js";
import { KeyChangeBus } from "./lib/key-events.js";
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
  /** where decoded data goes; without it the board connection and data intake stay switched off */
  store: IngestStore;
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
    const bus = new KeyChangeBus();
    registerAuth(app, verify);
    await registerKeyRoutes(app, new KeyService(db, vault, undefined, bus));
    readiness.register("database", () => db.ping());

    const store = options.deps?.store ?? (config.gatewayIngest && db instanceof SupabaseGatewayDb ? new SupabaseIngestStore(db) : undefined);
    if (store) {
      const keys = new KeyCache(db, vault);
      const throttle = new Map<string, number>();
      const recordFailure = (equipmentId: string, ip: string | null, reason: string) => {
        const k = `${equipmentId}|${ip ?? ""}`;
        if (Date.now() - (throttle.get(k) ?? 0) < 300_000) return;
        throttle.set(k, Date.now());
        if (throttle.size > 2000) throttle.clear();
        void db.recordKeyEvent({ equipmentId, event: "auth_failed", ip, detail: { reason } }).catch(() => undefined);
      };
      const ingest: { current?: IngestService } = {}; // the broker is made first, the intake needs the broker
      const broker = new Broker({
        keys,
        bus,
        log: app.log,
        onUp: (id, name, payload) => void ingest.current?.handleUp(id, name, payload),
        onReady: (id) => void ingest.current?.handleReady(id),
        onAuthFailed: (id, ip) => recordFailure(id, ip, "mqtt login"),
      });
      await broker.start();
      const service = new IngestService({
        keys,
        store,
        publish: (id, topic, payload, retain) => broker.publish(id, topic, payload, { retain }),
        log: app.log,
        onRejected: (id, reason) => recordFailure(id, null, reason),
      });
      ingest.current = service;
      service.start();
      await registerBrokerRoute(app, broker);
      app.addHook("onClose", async () => {
        service.stop();
        await broker.close();
      });
    }
  } else {
    app.log.warn("database or key settings are missing: the key and claim endpoints are not available");
  }

  return app;
}
