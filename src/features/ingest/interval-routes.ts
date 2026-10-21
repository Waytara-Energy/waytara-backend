import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DbError, type GatewayDb } from "../../db/gateway-db.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { clientIp, userLimited } from "../../plugins/auth.js";

/** The push interval of a unit: how often its averaged 15-minute figures and latest values are written to the database. */
export const ALLOWED_INTERVALS_S = [60, 120, 300, 600, 900, 1800, 3600] as const;
export const DEFAULT_INTERVAL_S = 900;

const idParam = z.object({ id: z.uuid() });
const putBody = z.object({ seconds: z.number().int().refine((n) => (ALLOWED_INTERVALS_S as readonly number[]).includes(n), "must be 60, 120, 300, 600, 900, 1800 or 3600") });

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw badRequest("The request did not match the expected shape", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

function mapDb(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof DbError) {
    if (error.kind === "forbidden" || error.kind === "not_found") throw notFound();
    if (error.kind === "invalid") throw badRequest("That interval is not allowed");
    throw new AppError(503, "unavailable", "The service is busy. Try again in a moment.");
  }
  throw error;
}

export interface IntervalDeps {
  db: GatewayDb;
  /** apply the new value to a running unit at once */
  reload: (equipmentId: string) => Promise<void>;
}

/**
 * GET and PUT /v1/equipment/:id/push-interval. Only people who may manage the unit (admins, employees and site engineers with access to the
 * site) get an answer; anybody else is told the unit does not exist, as everywhere else. The change is recorded in the activity log by the
 * database function.
 */
export async function registerIntervalRoutes(app: FastifyInstance, d: IntervalDeps): Promise<void> {
  app.get("/v1/equipment/:id/push-interval", userLimited(app, 30), async (request, reply) => {
    const { id } = parse(idParam, request.params);
    let seconds: number | null;
    try {
      seconds = await d.db.getPushInterval({ actor: request.user!.id, equipmentId: id });
    } catch (error) {
      mapDb(error);
    }
    if (seconds === null) throw notFound();
    reply.header("Cache-Control", "no-store");
    return { seconds, allowed: [...ALLOWED_INTERVALS_S], default: DEFAULT_INTERVAL_S };
  });

  app.put("/v1/equipment/:id/push-interval", userLimited(app, 20), async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const { seconds } = parse(putBody, request.body);
    let result: { previous: number; seconds: number };
    try {
      result = await d.db.setPushInterval({ equipmentId: id, actor: request.user!.id, seconds, ip: clientIp(request) });
    } catch (error) {
      mapDb(error);
    }
    await d.reload(id).catch((error: unknown) => request.log.warn({ err: error instanceof Error ? error.message : String(error) }, "could not apply the new push interval to the running unit"));
    reply.header("Cache-Control", "no-store");
    return { seconds: result.seconds, previous: result.previous, allowed: [...ALLOWED_INTERVALS_S] };
  });
}
