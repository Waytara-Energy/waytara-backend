import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

/**
 * WebSocket support, registered once for every feature that needs it: boards (MQTT over WebSocket, subprotocol "mqtt") and chargers
 * (OCPP 1.6-J, subprotocol "ocpp1.6"). The server answers with the protocol the client asked for; a client that asks for none of them is
 * refused.
 */
export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  if (app.hasDecorator("wtWebSocket")) return;
  app.decorate("wtWebSocket", true);
  await app.register(websocket, {
    options: {
      maxPayload: 70_000,
      handleProtocols: (protocols: Set<string>) => (protocols.has("ocpp1.6") ? "ocpp1.6" : protocols.has("mqtt") ? "mqtt" : protocols.has("mqttv3.1") ? "mqttv3.1" : false),
    },
  });
}
