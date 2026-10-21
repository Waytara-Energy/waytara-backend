import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../../lib/errors.js";
import { clientIp, userLimited } from "../../plugins/auth.js";
import type { RotationService } from "./rotation.js";

const idParam = z.object({ id: z.uuid() });

function parseId(params: unknown): string {
  const r = idParam.safeParse(params ?? {});
  if (!r.success) throw badRequest("The request did not match the expected shape");
  return r.data.id;
}

/**
 * GET /v1/equipment/:id/rotation          where a unit's key change stands, and whether one can be started now
 * POST /v1/equipment/:id/rotation         start a key change (the unit must be online and able to)
 * Only people who may manage the unit's keys; anybody else gets the plain 404.
 */
export async function registerRotationRoutes(app: FastifyInstance, service: RotationService): Promise<void> {
  app.get("/v1/equipment/:id/rotation", userLimited(app, 30), async (request, reply) => {
    const status = await service.status({ id: request.user!.id, ip: clientIp(request) }, parseId(request.params));
    reply.header("Cache-Control", "no-store");
    return {
      state: status.state,
      rotation_id: status.rotationId,
      started_at: status.startedAt,
      expires_at: status.expiresAt,
      can_start: status.canStart,
      reason: status.reason,
    };
  });

  app.post("/v1/equipment/:id/rotation", userLimited(app, 10), async (request, reply) => {
    const status = await service.start({ id: request.user!.id, ip: clientIp(request) }, parseId(request.params));
    reply.header("Cache-Control", "no-store");
    reply.status(202);
    return { state: status.state, rotation_id: status.rotationId, started_at: status.startedAt, expires_at: status.expiresAt };
  });
}
