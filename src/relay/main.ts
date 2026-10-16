import { startRelay } from "./relay.js";

// Starts the plain ws:// relay for chargers that cannot use TLS. HUB_URL defaults to the production hub.
const out = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const hubUrl = process.env.HUB_URL ?? "wss://hub.waytaraenergy.com";
const port = Number(process.env.PORT ?? 8080);
const relay = await startRelay({ hubUrl, port, log: out });
out(`relay listening on port ${relay.port}, forwarding to ${hubUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
