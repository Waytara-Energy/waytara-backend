/**
 * The last messages each charger exchanged with the server, kept in memory for staff to read when a charger misbehaves (what exactly
 * did it send? what did we answer?). Nothing here is stored: a restart empties it, and that is intended.
 *
 * What is kept out: card / tag identifiers (any "idTag" value is replaced), and frames are cut at a fixed length. The charger's secret
 * is never in a frame (it is in the address, not the messages).
 */

export interface LoggedFrame {
  /** ISO time the server saw it */
  at: string;
  /** "in" = from the charger, "out" = from the server */
  direction: "in" | "out";
  frame: string;
}

const PER_CHARGER = 300;
const MAX_CHARGERS = 200;
const MAX_FRAME_CHARS = 4000;

/** Replaces the value of every "idTag" (also inside idTagInfo and parentIdTag) with [hidden]. */
export function hideTags(raw: string): string {
  return raw.replace(/("(?:idTag|parentIdTag)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, '$1"[hidden]"');
}

export class FrameLog {
  private readonly byCharger = new Map<string, LoggedFrame[]>();

  constructor(private readonly now: () => number = Date.now) {}

  add(equipmentId: string, direction: "in" | "out", raw: string): void {
    let list = this.byCharger.get(equipmentId);
    if (!list) {
      if (this.byCharger.size >= MAX_CHARGERS) {
        const oldest = this.byCharger.keys().next().value;
        if (oldest !== undefined) this.byCharger.delete(oldest);
      }
      list = [];
      this.byCharger.set(equipmentId, list);
    }
    const hidden = hideTags(raw);
    list.push({ at: new Date(this.now()).toISOString(), direction, frame: hidden.length > MAX_FRAME_CHARS ? `${hidden.slice(0, MAX_FRAME_CHARS)}…` : hidden });
    if (list.length > PER_CHARGER) list.splice(0, list.length - PER_CHARGER);
  }

  /** Newest last. */
  list(equipmentId: string, limit = PER_CHARGER): LoggedFrame[] {
    const list = this.byCharger.get(equipmentId) ?? [];
    return list.slice(-Math.max(1, Math.min(limit, PER_CHARGER)));
  }
}
