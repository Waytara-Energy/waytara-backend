import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { badRequest } from "../../lib/errors.js";
import { clientIp } from "../../plugins/auth.js";
import type { KeyService } from "./service.js";

const hardwareId = z.string().regex(/^[A-Za-z0-9:_-]{6,64}$/, "must be 6 to 64 letters, digits, colons, dashes or underscores");

const createBody = z.object({
  kind: z.enum(["gateway", "charger"]),
  label: z.string().trim().min(1).max(80).optional(),
});
const rotateBody = z.object({ grace_seconds: z.number().int().min(0).max(86_400).default(0) });
const revokeBody = z.object({ reason: z.string().trim().max(200).optional() });
const ticketBody = z.object({ hardware_id: hardwareId });
const claimBody = z.object({
  ticket: z.uuid(),
  hardware_id: hardwareId,
  /** the board's P-256 public key, 65 bytes (04 || X || Y), base64url */
  board_public_key: z.string().min(80).max(100),
});

/** Only the problem and where it is: never the value that was sent. */
function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw badRequest("The request did not match the expected shape", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

const idParam = z.object({ id: z.uuid() });

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
}

export async function registerKeyRoutes(app: FastifyInstance, service: KeyService): Promise<void> {
  const signedIn = { preHandler: app.authenticate };
  const limited = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });

  app.get("/v1/whoami", signedIn, async (request) => ({ user_id: request.user!.id, email: request.user!.email ?? null, role: request.user!.role }));

  app.post("/v1/equipment/:id/keys", { ...signedIn, config: limited(20) }, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const body = parse(createBody, request.body);
    const r = await service.createKey({ id: request.user!.id, ip: clientIp(request) }, id, body.kind, body.label ?? null);
    noStore(reply);
    reply.status(201);
    return { key_id: r.keyId, equipment_id: r.equipmentId, kind: r.kind, fingerprint: r.fingerprint, secret: r.secret, created_at: r.createdAt };
  });

  app.post("/v1/keys/:id/rotate", { ...signedIn, config: limited(20) }, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const body = parse(rotateBody, request.body);
    const r = await service.rotateKey({ id: request.user!.id, ip: clientIp(request) }, id, body.grace_seconds);
    noStore(reply);
    reply.status(201);
    return { key_id: r.keyId, equipment_id: r.equipmentId, kind: r.kind, fingerprint: r.fingerprint, secret: r.secret, created_at: r.createdAt, replaces: id };
  });

  app.delete("/v1/keys/:id", { ...signedIn, config: limited(30) }, async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(revokeBody, request.body);
    const r = await service.revokeKey({ id: request.user!.id, ip: clientIp(request) }, id, body.reason ?? null);
    return { revoked: r.revoked };
  });

  app.post("/v1/equipment/:id/claim-tickets", { ...signedIn, config: limited(20) }, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const body = parse(ticketBody, request.body);
    const r = await service.issueClaimTicket({ id: request.user!.id, ip: clientIp(request) }, id, body.hardware_id);
    noStore(reply);
    reply.status(201);
    return { ticket: r.ticket, expires_at: r.expiresAt };
  });

  // The board itself, over the internet after it joined Wi-Fi. No sign-in: the single-use ticket is the proof.
  app.post("/v1/claim", { config: limited(10) }, async (request, reply) => {
    const body = parse(claimBody, request.body);
    const pub = Buffer.from(body.board_public_key, "base64url");
    if (pub.length !== 65) throw badRequest("The board key is not valid");
    const r = await service.claim({ ticket: body.ticket, hardwareId: body.hardware_id, boardPublicKey: pub, ip: clientIp(request) });
    noStore(reply);
    return {
      equipment_id: r.equipmentId,
      key_id: r.keyId,
      alg: r.alg,
      server_public_key: r.serverPublicKey.toString("base64url"),
      nonce: r.nonce.toString("base64url"),
      ciphertext: r.ciphertext.toString("base64url"),
    };
  });
}
