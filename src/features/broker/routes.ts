import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { createWebSocketStream } from "ws";
import { clientIp } from "../../plugins/auth.js";
import type { Broker } from "./broker.js";

/** MQTT over WebSocket at /mqtt (boards connect with wss://hub.waytaraenergy.com/mqtt; Render ends the TLS). */
export async function registerBrokerRoute(app: FastifyInstance, broker: Broker): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: 70_000,
      handleProtocols: (protocols: Set<string>) => (protocols.has("mqtt") ? "mqtt" : protocols.has("mqttv3.1") ? "mqttv3.1" : false),
    },
  });
  app.get("/mqtt", { websocket: true }, (socket, request) => {
    broker.handle(createWebSocketStream(socket), request.raw, clientIp(request));
  });
}
