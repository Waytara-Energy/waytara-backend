/**
 * Logs must never contain a secret. Two places a secret can hide in a request line are the query string
 * (?token=..., ?ticket=...) and, for chargers later, the path itself; this file cleans the first today and is where the second is added.
 */

const SECRET_QUERY_KEYS = /^(token|ticket|key|secret|password|pass|apikey|api_key|authorization|auth|code|access_token|refresh_token)$/i;

const REDACTED = "[redacted]";

export function redactUrl(raw: string): string {
  const q = raw.indexOf("?");
  if (q < 0) return raw;
  const path = raw.slice(0, q);
  const query = raw.slice(q + 1);
  const cleaned = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const key = pair.slice(0, eq);
      let decoded: string;
      try {
        decoded = decodeURIComponent(key);
      } catch {
        decoded = key;
      }
      return SECRET_QUERY_KEYS.test(decoded) ? `${key}=${REDACTED}` : pair;
    })
    .join("&");
  return `${path}?${cleaned}`;
}

/** Paths that are redacted from every structured log line, wherever they appear. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.token",
  "*.secret",
  "*.key",
  "*.ticket",
  "*.ciphertext",
  "*.api_key",
  "*.authorization",
];

export const REDACT_CENSOR = REDACTED;
