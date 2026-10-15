import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../lib/errors.js";

/**
 * The speed test of the setup screens (plan 8.4): a unit that has just joined Wi-Fi measures how fast it can really move data to the hub,
 * not what the radio says it negotiated. Open to anyone (a unit being set up has no key yet) but small and rate limited: at most 256 KB
 * per call and a handful of calls a minute per address.
 *
 *   GET  /v1/speedtest?bytes=N   N bytes of random data
 *   POST /v1/speedtest           takes up to 256 KB of any content and says how many bytes arrived
 */
export const SPEEDTEST_MAX_BYTES = 262_144;

const query = z.object({ bytes: z.coerce.number().int().min(1).max(SPEEDTEST_MAX_BYTES).default(65_536) });
const limited = { rateLimit: { max: 12, timeWindow: "1 minute" } };

export async function registerSpeedtestRoutes(app: FastifyInstance): Promise<void> {
  // the unit sends raw bytes; keep them as a buffer so nothing tries to parse them
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: SPEEDTEST_MAX_BYTES }, (_request, body, done) => done(null, body));

  app.get("/v1/speedtest", { config: limited }, async (request, reply) => {
    const q = query.safeParse(request.query);
    if (!q.success) throw badRequest(`bytes must be a whole number from 1 to ${SPEEDTEST_MAX_BYTES}`);
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Cache-Control", "no-store");
    return reply.send(randomBytes(q.data.bytes));
  });

  app.post("/v1/speedtest", { config: limited, bodyLimit: SPEEDTEST_MAX_BYTES }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = request.body;
    const received = Buffer.isBuffer(body) ? body.length : typeof body === "string" ? Buffer.byteLength(body) : body ? Buffer.byteLength(JSON.stringify(body)) : 0;
    return { received };
  });
}
