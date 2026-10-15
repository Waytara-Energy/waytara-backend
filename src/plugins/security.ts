import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { AppError, type ErrorBody } from "../lib/errors.js";

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Use the caller's request id if it looks sane (so a support request can be traced across systems), otherwise make one. */
export function requestIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && VALID_REQUEST_ID.test(value) ? value : randomUUID();
}

function errorBody(code: string, message: string, requestId: string, details?: unknown): ErrorBody {
  return { error: { code, message, request_id: requestId, ...(details !== undefined ? { details } : {}) } };
}

/** Paths that are never rate limited (the platform's own health probes). */
const UNLIMITED_PATHS = new Set(["/healthz"]);

export async function registerSecurity(app: FastifyInstance, config: Config): Promise<void> {
  // Headers an API needs: no framing, no sniffing, no referrer, locked-down content policy, HSTS in production.
  await app.register(helmet, {
    // An API serves JSON, never pages: the whole content policy is "load nothing, frame nothing".
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "no-referrer" },
    hsts: config.env === "production" ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

  // Browsers may call this API only from the listed websites. Calls without an Origin header (a board, a server, curl) are not browsers
  // and are not affected by CORS; they are protected by authentication instead.
  const allowed = new Set(config.allowedOrigins);
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, false);
      callback(null, allowed.has(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "Retry-After", "Content-Disposition"],
    credentials: false,
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowS * 1000,
    allowList: (request) => UNLIMITED_PATHS.has(request.url.split("?")[0] ?? ""),
    errorResponseBuilder: (request, context) => {
      const retry = Math.max(1, Math.ceil(context.ttl / 1000));
      const err = new AppError(429, "rate_limited", `Too many requests. Try again in ${retry} seconds.`);
      return Object.assign(err, { statusCode: 429 });
    },
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("X-Request-Id", request.id);
  });

  // Unknown paths are rate limited too (the plugin skips them unless asked), so probing for routes is not free.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request, reply) => {
    reply.status(404).send(errorBody("not_found", "Not found", request.id));
  });

  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    // A caller-safe error we raised on purpose.
    if (error instanceof AppError) {
      const retry = error.status === 429 ? { "Retry-After": "1" } : undefined;
      if (retry && !reply.hasHeader("retry-after")) reply.headers(retry);
      reply.status(error.status).send(errorBody(error.code, error.message, request.id, error.status < 500 ? error.details : undefined));
      return;
    }

    const fe = error as FastifyError;

    // Request failed schema validation.
    if (fe.validation) {
      const details = fe.validation.map((v) => ({ path: v.instancePath || "/", message: v.message ?? "invalid" }));
      reply.status(400).send(errorBody("invalid_request", "The request did not match the expected shape", request.id, details));
      return;
    }

    // Client mistakes that Fastify itself detects (body too large, wrong content type, bad JSON...): safe to report.
    if (typeof fe.statusCode === "number" && fe.statusCode >= 400 && fe.statusCode < 500) {
      const code = fe.statusCode === 413 ? "payload_too_large" : fe.statusCode === 415 ? "unsupported_media_type" : "bad_request";
      reply.status(fe.statusCode).send(errorBody(code, fe.statusCode === 413 ? "The request is too large" : "The request could not be processed", request.id));
      return;
    }

    // Anything else is our bug: keep the details in the log, give the caller nothing to learn from.
    request.log.error({ err: error }, "unhandled error");
    reply.status(500).send(errorBody("internal", "Something went wrong", request.id));
  });
}
