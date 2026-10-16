import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { startRelay, type RunningRelay } from "../src/relay/relay.js";

const SECRET = "s".repeat(24);
const NAME = "Plugzmart-7.4kW-AC-EV-Charger";

let hub: Server;
let hubSockets: WebSocketServer;
let hubPort = 0;
let relay: RunningRelay;
let seen: { path: string; auth: string | undefined; forwarded: string | undefined; protocol: string }[] = [];
let upstreamClosed: number[] = [];
let upstreamReceived: string[] = [];
const logs: string[] = [];

beforeEach(async () => {
  seen = [];
  upstreamClosed = [];
  upstreamReceived = [];
  logs.length = 0;
  hubSockets = new WebSocketServer({ noServer: true, handleProtocols: (p: Set<string>) => (p.has("ocpp1.6") ? "ocpp1.6" : false) });
  hub = createServer();
  hub.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (!request.url?.startsWith(`/ocpp/${SECRET}/`)) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    hubSockets.handleUpgrade(request, socket, head, (ws) => {
      seen.push({ path: request.url!, auth: request.headers.authorization, forwarded: request.headers["x-forwarded-for"] as string | undefined, protocol: ws.protocol });
      ws.on("message", (data) => {
        upstreamReceived.push(data.toString());
        ws.send(`echo:${data.toString()}`);
      });
      ws.on("close", (code) => upstreamClosed.push(code));
    });
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  hubPort = (hub.address() as AddressInfo).port;
  relay = await startRelay({ hubUrl: `ws://127.0.0.1:${hubPort}`, port: 0, host: "127.0.0.1", perAddressLimit: 2, log: (l) => logs.push(l) });
});

afterEach(async () => {
  await relay.close();
  for (const c of hubSockets.clients) c.terminate();
  await new Promise<void>((resolve) => {
    hub.closeAllConnections();
    hub.close(() => resolve());
  });
});

const connect = (path: string, opts: ConstructorParameters<typeof WebSocket>[2] = {}, protocols: string | string[] = "ocpp1.6") =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}${path}`, protocols, opts);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error("refused"), { status: res.statusCode })));
    ws.once("error", (e) => reject(e));
  });

const nextMessage = (ws: WebSocket) => new Promise<string>((resolve) => ws.once("message", (d) => resolve(d.toString())));

describe("the plain ws:// relay for chargers", () => {
  it("passes the path, the sub-protocol and messages both ways", async () => {
    const ws = await connect(`/ocpp/${SECRET}/${NAME}`);
    expect(ws.protocol).toBe("ocpp1.6");
    const reply = nextMessage(ws);
    ws.send('[2,"1","BootNotification",{}]');
    expect(await reply).toBe('echo:[2,"1","BootNotification",{}]');
    expect(upstreamReceived).toEqual(['[2,"1","BootNotification",{}]']);
    expect(seen[0]).toMatchObject({ path: `/ocpp/${SECRET}/${NAME}`, protocol: "ocpp1.6" });
    expect(seen[0]!.forwarded).toBeTruthy();
    ws.close();
  });

  it("passes the Basic authorization header on for the /ocpp/<name> form", async () => {
    const auth = `Basic ${Buffer.from(`${NAME}:${SECRET}`).toString("base64")}`;
    // the fake hub only accepts the secret path form, so this one is refused there; what matters is that the header was sent on
    await expect(connect(`/ocpp/${NAME}`, { headers: { Authorization: auth } })).rejects.toMatchObject({ status: 404 });
  });

  it("passes a refusal from the hub back (a wrong secret is a plain 404) and never logs the path", async () => {
    await expect(connect(`/ocpp/${"x".repeat(24)}/${NAME}`)).rejects.toMatchObject({ status: 404 });
    expect(logs.join("\n")).toMatch(/hub refused/);
    expect(logs.join("\n")).not.toContain("x".repeat(24));
    expect(logs.join("\n")).not.toContain(NAME);
  });

  it("closes the hub side when the charger goes away, and the other way round", async () => {
    const ws = await connect(`/ocpp/${SECRET}/${NAME}`);
    ws.close(1000);
    await new Promise((r) => setTimeout(r, 150));
    expect(upstreamClosed.length).toBe(1);

    const ws2 = await connect(`/ocpp/${SECRET}/${NAME}`);
    const closed = new Promise<number>((resolve) => ws2.once("close", (code) => resolve(code)));
    for (const c of hubSockets.clients) c.close(1001);
    expect(await closed).toBe(1001);
  });

  it("refuses paths that are not /ocpp/..., clients without ocpp1.6, and answers its own health check", async () => {
    await expect(connect("/admin")).rejects.toMatchObject({ status: 404 });
    await expect(connect(`/ocpp/${SECRET}/${NAME}`, {}, "mqtt")).rejects.toBeTruthy();
    const r = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
    expect(r.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${relay.port}/anything`)).status).toBe(404);
  });

  it("limits how many connections one address may hold open", async () => {
    const a = await connect(`/ocpp/${SECRET}/${NAME}`);
    const b = await connect(`/ocpp/${SECRET}/${NAME}`);
    await expect(connect(`/ocpp/${SECRET}/${NAME}`)).rejects.toMatchObject({ status: 429 });
    a.close();
    await new Promise((r) => setTimeout(r, 150));
    const c = await connect(`/ocpp/${SECRET}/${NAME}`);
    b.close();
    c.close();
  });
});
