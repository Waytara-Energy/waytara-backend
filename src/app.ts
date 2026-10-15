import Fastify, { type FastifyInstance } from "fastify";
import type { Writable } from "node:stream";
import type { Config } from "./config.js";
import { KeyVault } from "./core/key-vault.js";
import type { GatewayDb } from "./db/gateway-db.js";
import { createSupabaseGatewayDb, SupabaseGatewayDb } from "./db/supabase-gateway-db.js";
import { SupabaseIngestStore } from "./db/supabase-ingest-store.js";
import { Broker } from "./features/broker/broker.js";
import { KeyCache } from "./features/broker/key-cache.js";
import { OcppHub } from "./features/ocpp/hub.js";
import { ChargerRegistry } from "./features/ocpp/registry.js";
import { registerOcppRoutes } from "./features/ocpp/routes.js";
import type { EvStore } from "./features/ocpp/store.js";
import { SupabaseEvStore } from "./db/supabase-ev-store.js";
import { CadenceArchive } from "./features/cadence/archive.js";
import { startCadenceMaintenance } from "./features/cadence/maintenance.js";
import { registerCadenceRoutes } from "./features/cadence/routes.js";
import { CadenceWriter } from "./features/cadence/writer.js";
import { R2ObjectStore, type ObjectStore } from "./storage/object-store.js";
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
import { registerSpeedtestRoutes } from "./routes/speedtest.js";

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
  /** where the OCPP server (EV chargers) keeps sessions, samples and events; without it chargers cannot connect */
  evStore: EvStore;
  /** where cadence files are kept; without it cadence data is not kept or served */
  objectStore: ObjectStore;
  /** tells the rest of the backend that an equipment's keys changed; tests share it to trigger that */
  bus: KeyChangeBus;
  /** the clock the report rules use (limits on how far back and how far ahead); tests fix it */
  clock: () => number;
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
  await registerSpeedtestRoutes(app);

  const db = options.deps?.db ?? (config.supabase ? createSupabaseGatewayDb(config.supabase) : undefined);
  const verify = options.deps?.verify ?? (config.supabase ? createSupabaseTokenVerifier(config.supabase.url) : undefined);
  const vault = options.deps?.vault ?? (config.keyMasters ? new KeyVault(config.keyMasters) : undefined);
  if (db && verify && vault) {
    const bus = options.deps?.bus ?? new KeyChangeBus();
    registerAuth(app, verify);
    await registerKeyRoutes(app, new KeyService(db, vault, undefined, bus));
    readiness.register("database", () => db.ping());

    // EV chargers (OCPP 1.6-J): on whenever the database is, unless switched off
    const evStore = options.deps?.evStore ?? (config.ocppEnabled && db instanceof SupabaseGatewayDb ? new SupabaseEvStore(db) : undefined);
    if (evStore) {
      const registry = new ChargerRegistry(evStore, vault, bus);
      const hub = new OcppHub({ store: evStore, log: app.log });
      await registerOcppRoutes(app, { hub, registry, store: evStore, log: app.log });
      bus.onChanged((equipmentId) => {
        const c = hub.get(equipmentId);
        if (c) void registry.isActive(c.info.keyId).then((ok) => ok || hub.kick(equipmentId)).catch(() => undefined);
      });
      app.addHook("onClose", async () => hub.closeAll());
    }

    const store = options.deps?.store ?? (config.gatewayIngest && db instanceof SupabaseGatewayDb ? new SupabaseIngestStore(db) : undefined);
    const objectStore = options.deps?.objectStore ?? (config.r2 ? new R2ObjectStore(config.r2) : undefined);
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
      // "last used" of a key, written at most every 5 minutes per key so a board that reconnects often does not flood the database
      const touched = new Map<string, number>();
      const touchKey = (keyId: string, ip: string | null) => {
        if (Date.now() - (touched.get(keyId) ?? 0) < 300_000) return;
        touched.set(keyId, Date.now());
        if (touched.size > 2000) touched.clear();
        void db.touchKey(keyId, ip).catch(() => undefined);
      };
      const ingest: { current?: IngestService } = {}; // the broker is made first, the intake needs the broker
      const broker = new Broker({
        keys,
        bus,
        log: app.log,
        onUp: (id, name, payload) => void ingest.current?.handleUp(id, name, payload),
        onReady: (id) => void ingest.current?.handleReady(id),
        onAuthFailed: (id, ip) => recordFailure(id, ip, "mqtt login"),
        onLogin: (_id, keyId, ip) => touchKey(keyId, ip),
      });
      await broker.start();
      const cadence = objectStore ? new CadenceWriter({ store: objectStore, log: app.log }) : undefined;
      const archive = objectStore ? new CadenceArchive(objectStore, app.log) : undefined;
      if (objectStore && archive && cadence) {
        readiness.register("cadence_store", () => objectStore.ping());
        await registerCadenceRoutes(app, { db, store, archive, ...(options.deps?.clock ? { now: options.deps.clock } : {}) });
        const maintenance = startCadenceMaintenance(archive, app.log);
        app.addHook("onClose", async () => {
          maintenance.stop();
          await cadence.flushAll(); // what is still in memory goes to the file store before we stop
        });
      } else {
        app.log.warn("no file store is configured (R2_*): cadence data is not kept");
      }
      const service = new IngestService({
        keys,
        store,
        ...(cadence ? { cadence } : {}),
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
