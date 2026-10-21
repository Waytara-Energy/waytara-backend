import { z } from "zod";

/** The bodies a board seals (plan section 10). Strict limits: a sealed message is trusted, but a bug or an attack is not. */

const u16 = z.number().int().min(0).max(0xffff);
const u32 = z.number().int().min(0).max(0xffffffff);

export const dataBody = z.object({
  boot: u32,
  seq_first: u32.optional(),
  seq_last: u32.optional(),
  map_ver: z.number().int().min(0).max(1_000_000).optional(),
  frames: z
    .array(
      z.object({
        /** milliseconds since 1970 */
        t: z.number().int().min(0),
        seq: u32,
        /** [first register, [raw words...]] */
        blocks: z.array(z.tuple([u16, z.array(u16).min(1).max(125)])).min(1).max(128),
        flags: z.number().int().min(0).max(0xffff).optional(),
      }),
    )
    .min(1)
    .max(600),
});
export type DataBody = z.infer<typeof dataBody>;

export const hbBody = z.object({
  boot: u32,
  uptime_s: z.number().min(0),
  seq_sent: u32.optional(),
  seq_acked: u32.optional(),
  queue_frames: z.number().int().min(0).optional(),
  queue_bytes: z.number().int().min(0).optional(),
  rssi: z.number().int().min(-130).max(0).optional(),
  wifi_channel: z.number().int().min(0).max(200).optional(),
  heap_free_min: z.number().int().min(0).optional(),
  modbus_ok_pct_5min: z.number().min(0).max(100).optional(),
  last_modbus_ok_age_s: z.number().min(0).optional(),
  inverter_online: z.boolean().optional(),
  fw_version: z.string().max(40).optional(),
  map_ver: z.number().int().min(0).max(1_000_000).optional(),
  clock_valid: z.boolean().optional(),
  clock_source: z.string().max(16).optional(),
  device_time_ms: z.number().int().min(0).optional(),
  reset_reason: z.string().max(40).optional(),
  /** true while the board is answering from its built-in test inverter instead of reading the real one (bench tests only) */
  simulated: z.boolean().optional(),
});
export type HbBody = z.infer<typeof hbBody>;

export const evtBody = z.object({
  type: z.string().min(1).max(32),
  map_ver: z.number().int().min(0).max(1_000_000).optional(),
  fw_version: z.string().max(40).optional(),
  hardware_id: z.string().max(64).optional(),
  message: z.string().max(200).optional(),
  // the answer to a "write" command (task A9): which command, whether the read-back matched, what the register held, why not
  id: z.string().min(1).max(40).optional(),
  ok: z.boolean().optional(),
  readback: z.number().int().min(0).max(0xffff).optional(),
  error: z.string().max(200).optional(),
});
export type EvtBody = z.infer<typeof evtBody>;
