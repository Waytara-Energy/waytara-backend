import type { FastifyInstance } from "fastify";
import { createWebSocketStream } from "ws";
import { clientIp } from "../../plugins/auth.js";
import { registerWebSocket } from "../../plugins/websocket.js";
import type { Broker } from "./broker.js";

/** MQTT over WebSocket at /mqtt (boards connect with wss://hub.waytaraenergy.com/mqtt; Render ends the TLS). */
export async function registerBrokerRoute(app: FastifyInstance, broker: Broker): Promise<void> {
  await registerWebSocket(app);
  app.get("/mqtt", { websocket: true }, (socket, request) => {
    broker.handle(createWebSocketStream(socket), request.raw, clientIp(request));
  });
}
