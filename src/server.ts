import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { gracefulClose } from "./lifecycle.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Logging is not set up yet because it depends on the settings, so write the problem list straight to stderr.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const app = await buildApp(config);

  // Render sends SIGTERM on every deploy.
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    void gracefulClose(app, signal, (code) => process.exit(code));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "unhandled promise rejection");
    shutdown("unhandledRejection");
  });
  process.on("uncaughtException", (error) => {
    app.log.fatal({ err: error }, "uncaught exception");
    process.exit(1);
  });

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ version: config.version, env: config.env }, "waytara-backend is up");
}

void main();
