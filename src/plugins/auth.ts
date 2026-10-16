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

/** How many requests from one address a signed-in route lets through per minute before it even looks at who is asking (shared addresses, such as the dashboard's server, carry many people). */
const ADDRESS_FLOOR_PER_MINUTE = 600;

/**
 * Options for a route that needs a signed-in person and is limited per person, not per address: the dashboards call the hub from shared
 * server addresses, so a per-address limit would make one busy person slow everybody else down. The per-person limit runs after the
 * sign-in check (so the key is the verified user, never something the caller wrote); a wide per-address floor in front keeps
 * unauthenticated floods cheap.
 */
export function userLimited(app: FastifyInstance, max: number) {
  // the plugin runs only one limiter per request, so the address floor is called by hand
  const floor = app.createRateLimit({ max: ADDRESS_FLOOR_PER_MINUTE, timeWindow: "1 minute" });
  return {
    onRequest: async (request: FastifyRequest) => {
      const r = await floor(request);
      // `isAllowed` is only true for an allow-listed request; a counted request is over the limit when `isExceeded` says so
      if (r.isAllowed || !r.isExceeded) return;
      const retry = Math.max(1, Math.ceil(r.ttl / 1000));
      throw new AppError(429, "rate_limited", `Too many requests. Try again in ${retry} seconds.`);
    },
    preHandler: app.authenticate,
    config: { rateLimit: { max, timeWindow: "1 minute", hook: "preHandler" as const, keyGenerator: (request: FastifyRequest) => request.user?.id ?? request.ip } },
  };
}
