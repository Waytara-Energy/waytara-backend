import { z } from "zod";

/**
 * The OCPP 1.6-J messages a charger sends (plan 13.3), checked before anything is acted on. Limits follow the OCPP 1.6 specification;
 * unknown extra fields are dropped. A message that does not match is answered with a CallError and never reaches the database.
 * Shapes were checked against what the Plugzmart charger really sent (an empty imsi, kWh in meter values, "L1-N" phases).
 */

const str = (max: number) => z.string().max(max);
const int = z.number().int();
const ts = z.string().min(10).max(40);

export const bootNotification = z.object({
  chargePointVendor: str(20).min(1),
  chargePointModel: str(20).min(1),
  chargePointSerialNumber: str(25).optional(),
  chargeBoxSerialNumber: str(25).optional(),
  firmwareVersion: str(50).optional(),
  iccid: str(20).optional(),
  imsi: str(20).optional(),
  meterType: str(25).optional(),
  meterSerialNumber: str(25).optional(),
});

export const heartbeat = z.object({});

export const ERROR_CODES = [
  "ConnectorLockFailure", "EVCommunicationError", "GroundFailure", "HighTemperature", "InternalError", "LocalListConflict", "NoError",
  "OtherError", "OverCurrentFailure", "PowerMeterFailure", "PowerSwitchFailure", "ReaderFailure", "ResetFailure", "UnderVoltage", "OverVoltage", "WeakSignal",
] as const;
export const CONNECTOR_STATUSES = ["Available", "Preparing", "Charging", "SuspendedEVSE", "SuspendedEV", "Finishing", "Reserved", "Unavailable", "Faulted"] as const;

export const statusNotification = z.object({
  connectorId: int.min(0).max(64),
  errorCode: z.enum(ERROR_CODES),
  status: z.enum(CONNECTOR_STATUSES),
  info: str(50).optional(),
  timestamp: ts.optional(),
  vendorId: str(255).optional(),
  vendorErrorCode: str(50).optional(),
});

export const authorize = z.object({ idTag: str(20).min(1) });

export const startTransaction = z.object({
  connectorId: int.min(1).max(64),
  idTag: str(20).min(1),
  meterStart: int.min(0).max(2_000_000_000),
  timestamp: ts,
  reservationId: int.optional(),
});

const sampledValue = z.object({
  value: str(64),
  context: str(32).optional(),
  format: str(16).optional(),
  measurand: str(64).optional(),
  phase: str(8).optional(),
  location: str(16).optional(),
  unit: str(16).optional(),
});
export const meterValueEntry = z.object({ timestamp: ts, sampledValue: z.array(sampledValue).min(1).max(40) });

export const meterValues = z.object({
  connectorId: int.min(0).max(64),
  transactionId: int.optional(),
  meterValue: z.array(meterValueEntry).min(1).max(50),
});

export const stopTransaction = z.object({
  meterStop: int.min(0).max(2_000_000_000),
  timestamp: ts,
  transactionId: int,
  reason: str(32).optional(),
  idTag: str(20).optional(),
  transactionData: z.array(meterValueEntry).max(200).optional(),
});

export const dataTransfer = z.object({ vendorId: str(255).min(1), messageId: str(50).optional(), data: z.unknown().optional() });
export const diagnosticsStatusNotification = z.object({ status: str(32) });
export const firmwareStatusNotification = z.object({ status: str(32) });

export const ACTIONS = {
  BootNotification: bootNotification,
  Heartbeat: heartbeat,
  StatusNotification: statusNotification,
  Authorize: authorize,
  StartTransaction: startTransaction,
  MeterValues: meterValues,
  StopTransaction: stopTransaction,
  DataTransfer: dataTransfer,
  DiagnosticsStatusNotification: diagnosticsStatusNotification,
  FirmwareStatusNotification: firmwareStatusNotification,
} as const;
export type ActionName = keyof typeof ACTIONS;
export const isAction = (a: string): a is ActionName => Object.prototype.hasOwnProperty.call(ACTIONS, a);

export type SampledValue = z.infer<typeof sampledValue>;
export type MeterValueEntry = z.infer<typeof meterValueEntry>;
