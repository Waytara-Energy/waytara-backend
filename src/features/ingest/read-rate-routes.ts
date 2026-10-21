import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DbError, type GatewayDb } from "../../db/gateway-db.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { clientIp, userLimited } from "../../plugins/auth.js";

/** How often a value may be read from the inverter. The standard is 30 seconds; the register map may have its own rate for a value. */
export const ALLOWED_READ_RATES_S = [10, 15, 30, 60, 120, 300, 600, 900] as const;

const idParam = z.object({ id: z.uuid() });
const putBody = z.object({
  changes: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        // a number from the list, or null for "use the register map's rate"
        seconds: z.number().int().refine((n) => (ALLOWED_READ_RATES_S as readonly number[]).includes(n), "not an allowed rate").nullable(),
      }),
    )
    .min(1)
    .max(500),
});

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw badRequest("The request did not match the expected shape", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

function mapDb(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof DbError) {
    if (error.kind === "forbidden" || error.kind === "not_found") throw notFound();
    if (error.kind === "invalid") throw badRequest("That read rate or value is not allowed");
    throw new AppError(503, "unavailable", "The service is busy. Try again in a moment.");
  }
  throw error;
}

export interface ReadRateDeps {
  db: GatewayDb;
  /** rebuild the register map of a running unit and send it, so the new rates reach the unit */
  reload: (equipmentId: string) => Promise<void>;
}

/**
 * GET and PUT /v1/equipment/:id/read-rates. Same people as the push interval (those who may manage the unit); anybody else is told the unit does
 * not exist. A change is written to the activity log by the database function, then the register map is rebuilt and sent to the unit.
 */
export async function registerReadRateRoutes(app: FastifyInstance, d: ReadRateDeps): Promise<void> {
  app.get("/v1/equipment/:id/read-rates", userLimited(app, 30), async (request, reply) => {
    const { id } = parse(idParam, request.params);
    let list;
    try {
      list = await d.db.getCadences({ actor: request.user!.id, equipmentId: id });
    } catch (error) {
      mapDb(error);
    }
    if (!list) throw notFound();
    reply.header("Cache-Control", "no-store");
    return list;
  });

  app.put("/v1/equipment/:id/read-rates", userLimited(app, 20), async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const { changes } = parse(putBody, request.body);
    let result: { changed: number };
    try {
      result = await d.db.setCadences({ equipmentId: id, actor: request.user!.id, changes, ip: clientIp(request) });
    } catch (error) {
      mapDb(error);
    }
    if (result.changed > 0) {
      await d.reload(id).catch((error: unknown) => request.log.warn({ err: error instanceof Error ? error.message : String(error) }, "could not send the new register map to the running unit"));
    }
    reply.header("Cache-Control", "no-store");
    return { changed: result.changed };
  });
}
