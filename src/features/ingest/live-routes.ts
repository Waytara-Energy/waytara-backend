import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DbError, type GatewayDb } from "../../db/gateway-db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { userLimited } from "../../plugins/auth.js";

const idParam = z.object({ id: z.uuid() });

export interface LiveWakeDeps {
  db: Pick<GatewayDb, "cadenceAccess">;
  /** look at once whether somebody watches this unit, instead of at the next check */
  wake: (equipmentId: string) => Promise<void>;
}

/**
 * POST /v1/equipment/:id/live-wake (task T13). The dashboard calls this the moment someone presses Go Live (right after the database
 * request), so the hub tells the unit to stream within a fraction of a second instead of at its next 3-second check. It changes nothing by
 * itself: the hub still asks the database whether somebody is watching, so a wake-up that was not backed by a real request does nothing.
 * Only people who may read the unit's data get an answer; anybody else is told it does not exist.
 */
export async function registerLiveWakeRoutes(app: FastifyInstance, d: LiveWakeDeps): Promise<void> {
  app.post("/v1/equipment/:id/live-wake", userLimited(app, 30), async (request, reply) => {
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success) throw badRequest("The request did not match the expected shape");
    const { id } = parsed.data;
    let scope: "staff" | "customer" | null;
    try {
      scope = await d.db.cadenceAccess(request.user!.id, id);
    } catch (error) {
      if (error instanceof DbError && error.kind === "not_found") throw notFound();
      throw error;
    }
    if (!scope) throw notFound();
    // answered at once; the wake-up itself runs on its own and never fails the request
    void d.wake(id).catch((error: unknown) => request.log.warn({ err: error instanceof Error ? error.message : String(error) }, "live wake-up failed"));
    reply.header("Cache-Control", "no-store");
    reply.code(202);
    return { ok: true };
  });
}
