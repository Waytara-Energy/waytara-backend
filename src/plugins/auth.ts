import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import { TokenError, type AuthUser, type TokenVerifier } from "../lib/jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    /** set by `authenticate` on routes that need a signed-in person */
    user: AuthUser | null;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** The caller's address for the audit trail: IPv4-mapped IPv6 is shown as plain IPv4, anything odd as null. */
export function clientIp(request: FastifyRequest): string | null {
  const raw = request.ip?.replace(/^::ffff:/i, "") ?? "";
  return /^[0-9a-f:.]{3,45}$/i.test(raw) ? raw : null;
}

export function registerAuth(app: FastifyInstance, verify: TokenVerifier): void {
  app.decorateRequest("user", null);
  app.decorate("authenticate", async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(header) : null;
    if (!match) throw new AppError(401, "unauthorized", "Sign in required");
    try {
      request.user = await verify(match[1]!);
    } catch (error) {
      if (error instanceof TokenError) throw new AppError(401, "unauthorized", "Sign in required");
      // the signing keys could not be fetched, or something else broke: not the caller's fault
      request.log.error({ err: error }, "token verification failed");
      throw new AppError(503, "unavailable", "The service is busy. Try again in a moment.");
    }
  });
}
