import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";

/**
 * A small relay for chargers that can only speak plain `ws://` (they cannot do TLS, and the hub's host answers plain requests with a
 * redirect). The charger connects here with `ws://<relay>/ocpp/<secret>/<name>`; the relay opens `wss://<hub>/ocpp/<secret>/<name>` and
 * passes every message and close both ways. It keeps no state and decides nothing: the hub still checks the secret and the name, and
 * answers a wrong one with its usual plain 404, which the relay passes back as a refusal.
 *
 * Everything between the charger and the relay is unencrypted (that is the charger's limit); between the relay and the hub it is TLS.
 * The relay never logs the path (the secret is in it) and only forwards `/ocpp/...` paths of a sane shape.
 */

export interface RelayOptions {
  /** The hub's address, e.g. wss://hub.waytaraenergy.com (no path). */
  hubUrl: string;
  port: number;
  host?: string;
  /** At most this many open connections from one address (default 4). */
  perAddressLimit?: number;
  /** Where to write log lines (never with the path); defaults to nothing. */
  log?: (line: string) => void;
}

export interface RunningRelay {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const PATH = /^\/ocpp\/[A-Za-z0-9._:-]{1,128}(?:\/[A-Za-z0-9._:-]{1,64})?$/;
const MAX_PAYLOAD = 70_000;

function remoteAddress(request: IncomingMessage): string {
  const forwarded = request.headers["fly-client-ip"] ?? request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || request.socket.remoteAddress || "?";
}

function refuse(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function startRelay(options: RelayOptions): Promise<RunningRelay> {
  const log = options.log ?? (() => undefined);
  const hub = new URL(options.hubUrl);
  if (hub.protocol !== "wss:" && hub.protocol !== "ws:") throw new Error("hubUrl must start with wss:// (or ws:// for tests)");
  const limit = options.perAddressLimit ?? 4;
  const open = new Map<string, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, handleProtocols: (p: Set<string>) => (p.has("ocpp1.6") ? "ocpp1.6" : false) });

  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok","relay":true}');
      return;
    }
    response.writeHead(404).end();
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    const url = request.url ?? "";
    const path = url.split("?")[0] ?? "";
    if (!PATH.test(path)) return refuse(socket, "404 Not Found");
    const asked = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim());
    if (!asked.includes("ocpp1.6")) return refuse(socket, "400 Bad Request");
    const from = remoteAddress(request);
    if ((open.get(from) ?? 0) >= limit) return refuse(socket, "429 Too Many Requests");

    const headers: Record<string, string> = { "X-Forwarded-For": from };
    if (typeof request.headers.authorization === "string") headers.Authorization = request.headers.authorization;

    // Connect to the hub first: a refusal there (404 for a wrong secret) is passed back before the charger's socket is upgraded.
    const upstream = new WebSocket(`${hub.origin}${path}`, ["ocpp1.6"], { headers, maxPayload: MAX_PAYLOAD, handshakeTimeout: 15_000 });
    let settled = false;
    upstream.once("unexpected-response", (_req, res) => {
      if (settled) return;
      settled = true;
      log(`hub refused a connection from ${from}: ${res.statusCode}`);
      refuse(socket, `${res.statusCode ?? 502} ${res.statusCode === 404 ? "Not Found" : "Bad Gateway"}`);
      res.resume();
    });
    upstream.once("error", (error) => {
      if (settled) return;
      settled = true;
      log(`could not reach the hub: ${error.message}`);
      refuse(socket, "502 Bad Gateway");
    });
    upstream.once("open", () => {
      if (settled) return;
      settled = true;
      wss.handleUpgrade(request, socket, Buffer.alloc(0), (client) => {
        open.set(from, (open.get(from) ?? 0) + 1);
        log(`charger connected from ${from}`);
        const closeBoth = (code: number, reason: Buffer) => {
          const safe = code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1011;
          for (const s of [client, upstream]) if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.close(safe, reason.subarray(0, 100));
        };
        client.on("message", (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        upstream.on("message", (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        });
        client.on("close", (code, reason) => {
          const n = (open.get(from) ?? 1) - 1;
          if (n <= 0) open.delete(from);
          else open.set(from, n);
          closeBoth(code, reason);
        });
        upstream.on("close", (code, reason) => closeBoth(code, reason));
        client.on("error", () => upstream.terminate());
        upstream.on("error", () => client.terminate());
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
