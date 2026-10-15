/**
 * Checks, on your own computer, that the backend's settings work: the database login, the permission of the backend's identity, and
 * the master key. It prints only OK or a short reason, never a password or a key.
 *
 *   1. copy .env.example to .env and fill in the database and key settings (the file is git-ignored)
 *   2. npm run check:supabase
 */
import { ConfigError, loadConfig } from "../src/config.js";
import { KeyVault } from "../src/core/key-vault.js";
import { createSupabaseGatewayDb } from "../src/db/supabase-gateway-db.js";
import { createSupabaseTokenVerifier } from "../src/lib/jwt.js";

const out = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    out(error instanceof ConfigError ? `FAIL settings\n${error.message}` : "FAIL settings could not be read");
    return 1;
  }
  if (!config.supabase) {
    out("FAIL the database settings are not set (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_USER_EMAIL, SUPABASE_SERVICE_USER_PASSWORD)");
    return 1;
  }
  let failed = 0;

  if (config.keyMasters) {
    const vault = new KeyVault(config.keyMasters);
    const probe = Buffer.alloc(32, 1);
    const ctx = { equipmentId: "00000000-0000-0000-0000-000000000000", kind: "gateway" as const };
    out(vault.decrypt(vault.encrypt(probe, ctx), ctx).equals(probe) ? "OK   master key: 32 bytes, encrypts and decrypts" : "FAIL master key");
  } else {
    out("FAIL KEY_ENCRYPTION_MASTER is not set");
    failed++;
  }

  try {
    await createSupabaseGatewayDb(config.supabase).ping();
    out("OK   signed in as the backend's service user and the database accepted it");
  } catch (error) {
    const kind = (error as { kind?: string }).kind;
    out(
      kind === "forbidden"
        ? "FAIL signed in, but this user is not registered as the backend's service user (gateway_service_users)"
        : kind === "unavailable"
          ? "FAIL could not sign in or reach the database: check the URL, the public key, the email and the password"
          : "FAIL unexpected error",
    );
    failed++;
  }

  try {
    const verify = createSupabaseTokenVerifier(config.supabase.url);
    await verify("a.b.c").catch((e: unknown) => {
      if ((e as Error).name !== "TokenError") throw e;
    });
    out("OK   token verification reaches the project's signing keys and refuses a forged token");
  } catch {
    out("FAIL could not fetch the project's signing keys");
    failed++;
  }
  return failed;
}

process.exitCode = await main();
