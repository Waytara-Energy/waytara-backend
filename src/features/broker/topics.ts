/**
 * MQTT topics (plan section 10.1):  wt/v1/<equipmentId>/<up|dn>/<name>
 *   up/data  up/hb  up/evt  up/state  up/ocpp     a board publishes (ocpp: the messages of a charger on the unit's own Wi-Fi)
 *   dn/ack   dn/cmd dn/map  dn/ocpp               the backend publishes, the board subscribes
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOPIC = new RegExp(`^wt/v1/(${UUID})/(up|dn)/([a-z]+)$`, "i");

export const UP_NAMES = ["data", "hb", "evt", "state", "ocpp"] as const;
export const DN_NAMES = ["ack", "cmd", "map", "ocpp"] as const;
export type UpName = (typeof UP_NAMES)[number];
export type DnName = (typeof DN_NAMES)[number];

export const isUuid = (s: string): boolean => new RegExp(`^${UUID}$`, "i").test(s);

export const upTopic = (id: string, name: UpName) => `wt/v1/${id}/up/${name}`;
export const dnTopic = (id: string, name: DnName) => `wt/v1/${id}/dn/${name}`;

export interface ParsedTopic {
  equipmentId: string;
  dir: "up" | "dn";
  name: string;
}

export function parseTopic(topic: string): ParsedTopic | null {
  const m = TOPIC.exec(topic);
  return m ? { equipmentId: m[1]!.toLowerCase(), dir: m[2]!.toLowerCase() as "up" | "dn", name: m[3]!.toLowerCase() } : null;
}

/** What a board may publish: only its own up/* topics. */
export function boardMayPublish(equipmentId: string, topic: string): boolean {
  const t = parseTopic(topic);
  return !!t && t.equipmentId === equipmentId && t.dir === "up" && (UP_NAMES as readonly string[]).includes(t.name);
}

/** What a board may subscribe to: exactly its own dn/* topics, no wildcards. */
export function boardMaySubscribe(equipmentId: string, topic: string): boolean {
  const t = parseTopic(topic);
  return !!t && t.equipmentId === equipmentId && t.dir === "dn" && (DN_NAMES as readonly string[]).includes(t.name);
}
