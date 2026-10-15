import type { Config } from "./config.js";
import { REDACT_CENSOR, REDACT_PATHS, redactUrl } from "./lib/redact.js";

/** Structured JSON logs (Render shows them in its dashboard). Secrets are redacted before anything is written. */
export function buildLoggerOptions(config: Pick<Config, "logLevel" | "env">) {
  return {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    serializers: {
      req(req: { method?: string; url?: string; host?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) {
        return {
          method: req.method,
          url: req.url ? redactUrl(req.url) : undefined,
          host: req.host ?? req.hostname,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        };
      },
    },
    ...(config.env === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } }
      : {}),
  };
}
