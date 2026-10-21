import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { makeGrant, GRANT_LIFETIME_S, LEVELS, type LevelName } from "../../core/ble-grant.js";
import { DbError, type GatewayDb } from "../../db/gateway-db.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { clientIp, userLimited } from "../../plugins/auth.js";
import type { BoardKey } from "../broker/key-cache.js";

const idParam = z.object({ id: z.uuid() });
const body = z.object({ pub: z.string().regex(/^[A-Za-z0-9_-]{87}$/, "the unit's public key, 65 bytes in base64url") });

export interface BleGrantDeps {
  db: Pick<GatewayDb, "bleAccess" | "openRotation">;
  /** the unit's working gateway keys */
  keys: { get(equipmentId: string): Promise<BoardKey[]> };
  now?: () => number;
}

/**
 * POST /v1/equipment/:id/ble-grant  { pub }  ->  { grant, level, level_name, expires_in }
 * A signed-in person asks for a pass to talk to this unit over Bluetooth. The unit's public key for this connection (read from its
 * Bluetooth "info") is in the request, so the pass only works on that connection. The level comes from who the person is: the customer who
 * owns the site may look and change the Wi-Fi, assigned staff may also run checks and change the push interval, admins may do everything.
 * Anybody else is told the unit does not exist. The request is recorded in the unit's activity log.
 */
export async function registerBleGrantRoutes(app: FastifyInstance, d: BleGrantDeps): Promise<void> {
  const now = d.now ?? Date.now;
  app.post("/v1/equipment/:id/ble-grant", userLimited(app, 20), async (request, reply) => {
    const p = idParam.safeParse(request.params);
    const b = body.safeParse(request.body ?? {});
    if (!p.success || !b.success) throw badRequest("The request did not match the expected shape");
    const { id } = p.data;
    const pub = Buffer.from(b.data.pub, "base64url");
    if (pub.length !== 65 || pub[0] !== 0x04) throw badRequest("The request did not match the expected shape");

    let level: LevelName | null;
    try {
      level = await d.db.bleAccess({ actor: request.user!.id, equipmentId: id, ip: clientIp(request) });
    } catch (error) {
      if (error instanceof DbError && (error.kind === "forbidden" || error.kind === "not_found")) throw notFound();
      throw error;
    }
    if (!level) throw notFound();

    if (await d.db.openRotation(id)) throw new AppError(409, "key_change_in_progress", "The unit is changing its key right now. Try again in a few minutes.");
    const keys = await d.keys.get(id);
    if (keys.length === 0) throw new AppError(409, "not_set_up", "This unit has not been set up yet. Open its setup with the BOOT button instead.");
    if (keys.length > 1) throw new AppError(409, "key_change_in_progress", "The unit's key is being replaced. Try again in a few minutes.");

    const expiresAtS = Math.floor(now() / 1000) + GRANT_LIFETIME_S;
    const grant = makeGrant({ equipmentKey: keys[0]!.key, equipmentId: id, userId: request.user!.id, level, expiresAtS, devicePublicKey: pub });
    reply.header("Cache-Control", "no-store");
    return { grant: grant.toString("base64url"), level: LEVELS[level], level_name: level, expires_in: GRANT_LIFETIME_S };
  });
}
