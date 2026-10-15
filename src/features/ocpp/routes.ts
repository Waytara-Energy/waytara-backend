import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { clientIp } from "../../plugins/auth.js";
import { registerWebSocket } from "../../plugins/websocket.js";
import type { FrameArchive } from "./frame-archive.js";
import type { FrameLog } from "./frame-log.js";
import type { OcppHub } from "./hub.js";
import type { ChargerRegistry } from "./registry.js";
import type { EvStore } from "./store.js";

/**
 * Where chargers connect, and how people command them (plan 13.2 and 13.6).
 *
 *   wss://<host>/ocpp/<secret>/<charger name>      the secret in the address (the form for a charger whose app has one address field)
 *   wss://<host>/ocpp/<charger name>               with Basic authentication: user = the charger name, password = the secret
 *
 * An unknown secret or name is refused BEFORE the WebSocket starts, with the same plain "not found" whichever part was wrong, and an
 * address that keeps failing is slowed down. The secret never reaches a log line.
 */

const FAILS_PER_MINUTE = 10;
const NAME = /^[A-Za-z0-9._:-]{1,64}$/;

export interface OcppRouteDeps {
  hub: OcppHub;
  registry: ChargerRegistry;
  store: Pick<EvStore, "access" | "event">;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  /** the recent messages of each charger, for staff */
  frames?: FrameLog;
  /** the long-term message log in the file store */
  archive?: FrameArchive;
}

function basicAuth(header: string | undefined): { user: string; password: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header ?? "");
  if (!m) return null;
  const text = Buffer.from(m[1]!, "base64").toString("utf8");
  const i = text.indexOf(":");
  return i < 0 ? null : { user: text.slice(0, i), password: text.slice(i + 1) };
}

export async function registerOcppRoutes(app: FastifyInstance, d: OcppRouteDeps): Promise<void> {
  await registerWebSocket(app);
  const failures = new Map<string, { at: number; n: number }>();

  const recordFailure = (ip: string | null) => {
    const k = ip ?? "?";
    const f = failures.get(k);
    if (!f || Date.now() - f.at > 60_000) failures.set(k, { at: Date.now(), n: 1 });
    else f.n++;
    if (failures.size > 5000) failures.clear();
  };
  const blocked = (ip: string | null) => {
    const f = failures.get(ip ?? "?");
    return !!f && Date.now() - f.at < 60_000 && f.n >= FAILS_PER_MINUTE;
  };

  type Identity = { equipmentId: string; keyId: string; chargePointId: string };
  const identify = async (request: FastifyRequest): Promise<Identity> => {
    const ip = clientIp(request);
    if (blocked(ip)) throw new AppError(429, "rate_limited", "Too many attempts");
    const p = request.params as { secret?: string; cp?: string };
    let secret = p.secret;
    const cp = p.cp ?? "";
    if (secret === undefined) {
      const b = basicAuth(request.headers.authorization);
      if (b && b.user === cp) secret = b.password;
    }
    const id = secret !== undefined && NAME.test(cp) && secret.length >= 8 && secret.length <= 128 ? await d.registry.match(secret, cp) : null;
    if (!id) {
      recordFailure(ip);
      d.log.warn({ ip, charger: NAME.test(cp) ? cp : "?" }, "charger connection refused");
      throw notFound();
    }
    return { ...id, chargePointId: cp };
  };

  const hook = async (request: FastifyRequest) => {
    (request as FastifyRequest & { charger?: Identity }).charger = await identify(request);
  };
  const handler = (socket: import("ws").WebSocket, request: FastifyRequest) => {
    const id = (request as FastifyRequest & { charger?: Identity }).charger!;
    void d.hub.attach(socket, { equipmentId: id.equipmentId, chargePointId: id.chargePointId, keyId: id.keyId, ip: clientIp(request) });
  };

  app.get("/ocpp/:secret/:cp", { websocket: true, preValidation: hook }, handler);
  app.get("/ocpp/:cp", { websocket: true, preValidation: hook }, handler);

  // ---- commands (signed-in people with access to the charger)

  const signedIn = { preHandler: app.authenticate };
  const limited = { rateLimit: { max: 20, timeWindow: "1 minute" } };
  const id = z.object({ equipment: z.uuid() });

  async function allowed(request: FastifyRequest, equipment: string): Promise<void> {
    if (!(await d.store.access(request.user!.id, equipment))) throw notFound();
  }
  async function command(request: FastifyRequest, equipment: string, name: string, action: string, payload: unknown): Promise<{ status: string; detail?: unknown }> {
    await allowed(request, equipment);
    const conn = d.hub.get(equipment);
    if (!conn) throw new AppError(409, "offline", "The charger is not connected right now.");
    await d.store.event(equipment, null, new Date().toISOString(), "command", { command: name, by: request.user!.id }).catch(() => undefined);
    try {
      const r = (await conn.call(action, payload)) as { status?: string };
      return { status: typeof r?.status === "string" ? r.status : "Accepted", detail: r };
    } catch (error) {
      throw new AppError(504, "no_answer", error instanceof Error ? error.message : "The charger did not answer.");
    }
  }
  const parse = <T extends z.ZodType>(schema: T, input: unknown): z.infer<T> => {
    const r = schema.safeParse(input ?? {});
    if (!r.success) throw badRequest("The request did not match the expected shape", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    return r.data;
  };

  app.get("/v1/ev/:equipment/status", { ...signedIn, config: limited }, async (request) => {
    const { equipment } = parse(id, request.params);
    await allowed(request, equipment);
    const c = d.hub.get(equipment);
    return { connected: !!c, charge_point_id: c?.info.chargePointId ?? null, last_message_at: c ? new Date(c.lastMessageAt).toISOString() : null };
  });

  // What the charger sent and what the server answered, newest last (staff only; card identifiers are hidden; empty after a restart).
  app.get("/v1/ev/:equipment/frames", { ...signedIn, config: limited }, async (request) => {
    const { equipment } = parse(id, request.params);
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(300).default(100) }), request.query);
    if ((await d.store.access(request.user!.id, equipment)) !== "staff") throw notFound();
    return { frames: d.frames?.list(equipment, limit) ?? [] };
  });

  // The long-term message log of one UTC day, as lines of JSON (staff only; at most 20 000 lines). The last ten minutes are still in
  // memory: they show up in the call above, and here after the next write.
  app.get("/v1/ev/:equipment/frames/archive", { ...signedIn, config: limited }, async (request, reply) => {
    const { equipment } = parse(id, request.params);
    const { day } = parse(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), request.query);
    if (Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw badRequest("The day is not a real date");
    if ((await d.store.access(request.user!.id, equipment)) !== "staff") throw notFound();
    if (!d.archive) throw new AppError(503, "unavailable", "The message log is not kept on this server");
    try {
      const r = await d.archive.readDay(equipment, day);
      reply.header("Cache-Control", "no-store");
      reply.header("X-Truncated", r.truncated ? "true" : "false");
      reply.type("application/x-ndjson");
      return r.lines.join("\n") + (r.lines.length ? "\n" : "");
    } catch {
      throw new AppError(503, "unavailable", "The message log could not be read right now");
    }
  });

  app.post("/v1/ev/:equipment/remote-start", { ...signedIn, config: limited }, async (request) => {
    const { equipment } = parse(id, request.params);
    const b = parse(
      z.object({
        connector_id: z.number().int().min(1).max(8).default(1),
        id_tag: z.string().min(1).max(20).default("WAYTARA"),
        /** charge this many units (kWh), then stop by itself */
        target_kwh: z.number().positive().max(1000).optional(),
      }),
      request.body,
    );
    await allowed(request, equipment);
    const conn = d.hub.get(equipment);
    // the target is noted before the command goes out: the charger may begin the charge before its answer reaches us
    if (conn && b.target_kwh !== undefined) conn.setPendingTarget(b.connector_id, b.target_kwh);
    try {
      const r = await command(request, equipment, "remote-start", "RemoteStartTransaction", { connectorId: b.connector_id, idTag: b.id_tag });
      if (conn && r.status !== "Accepted") conn.clearPendingTarget(b.connector_id);
      return { ...r, ...(b.target_kwh !== undefined ? { target_kwh: b.target_kwh } : {}) };
    } catch (error) {
      conn?.clearPendingTarget(b.connector_id);
      throw error;
    }
  });

  app.post("/v1/ev/:equipment/remote-stop", { ...signedIn, config: limited }, async (request) => {
    const { equipment } = parse(id, request.params);
    const b = parse(z.object({ transaction_id: z.number().int() }), request.body);
    return command(request, equipment, "remote-stop", "RemoteStopTransaction", { transactionId: b.transaction_id });
  });

  app.post("/v1/ev/:equipment/reset", { ...signedIn, config: limited }, async (request) => {
    const { equipment } = parse(id, request.params);
    const b = parse(z.object({ type: z.enum(["Soft", "Hard"]).default("Soft") }), request.body);
    return command(request, equipment, "reset", "Reset", { type: b.type });
  });

  app.post("/v1/ev/:equipment/unlock", { ...signedIn, config: limited }, async (request) => {
    const { equipment } = parse(id, request.params);
    const b = parse(z.object({ connector_id: z.number().int().min(1).max(8).default(1) }), request.body);
    return command(request, equipment, "unlock", "UnlockConnector", { connectorId: b.connector_id });
  });

  app.post("/v1/ev/:equipment/trigger", { ...signedIn, config: limited }, async (request) => {
    const { equipment } = parse(id, request.params);
    const b = parse(z.object({ message: z.enum(["MeterValues", "StatusNotification", "Heartbeat", "BootNotification"]), connector_id: z.number().int().min(1).max(8).optional() }), request.body);
    return command(request, equipment, "trigger", "TriggerMessage", { requestedMessage: b.message, ...(b.connector_id ? { connectorId: b.connector_id } : {}) });
  });
}
