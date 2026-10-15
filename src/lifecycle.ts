export interface Closable {
  close(): Promise<unknown>;
  log: { info(obj: object, msg: string): void; error(obj: object | string, msg?: string): void };
}

/**
 * Stops the service cleanly: stop taking new requests, let running ones finish, then exit. If that takes longer than
 * timeoutMs the process is forced to exit with a failure so a hung deploy never lingers.
 * `exit` and `timers` are parameters so the behaviour can be tested without killing the test process.
 */
export async function gracefulClose(
  app: Closable,
  signal: string,
  exit: (code: number) => void,
  timeoutMs = 10_000,
): Promise<void> {
  app.log.info({ signal }, "shutting down");
  const force = setTimeout(() => {
    app.log.error("shutdown took too long, forcing exit");
    exit(1);
  }, timeoutMs);
  force.unref();
  try {
    await app.close();
    clearTimeout(force);
    exit(0);
  } catch (error) {
    clearTimeout(force);
    app.log.error({ err: error }, "error while shutting down");
    exit(1);
  }
}
