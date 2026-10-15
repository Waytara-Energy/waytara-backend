import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
import { beforeAll, describe, expect, it } from "vitest";
import { TokenError, createTokenVerifier } from "../src/lib/jwt.js";

const ISSUER = "https://project.example.supabase.co/auth/v1";
const USER = "bc3e9b3e-d307-4686-b34c-576674f9a79b";

let privateKey: PrivateKey;
let verify: ReturnType<typeof createTokenVerifier>;
let otherPrivateKey: PrivateKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  otherPrivateKey = (await generateKeyPair("ES256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  verify = createTokenVerifier({ issuer: ISSUER, keys: createLocalJWKSet({ keys: [jwk] }) });
});

const sign = (claims: Record<string, unknown> = {}, opts: { key?: PrivateKey; iss?: string; aud?: string; exp?: string | number; kid?: string } = {}) =>
  new SignJWT({ role: "authenticated", email: "a@example.com", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: opts.kid ?? "k1" })
    .setSubject(USER)
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? privateKey);

describe("token verification", () => {
  it("accepts a good token and returns who it is", async () => {
    expect(await verify(await sign())).toEqual({ id: USER, email: "a@example.com", role: "authenticated" });
  });

  it("works without an email in the token", async () => {
    const t = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject(USER).setIssuer(ISSUER).setAudience("authenticated").setExpirationTime("1h").sign(privateKey);
    expect(await verify(t)).toEqual({ id: USER, role: "authenticated" });
  });

  it("refuses an expired token, allowing 5 seconds of clock difference", async () => {
    await expect(verify(await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 }))).rejects.toBeInstanceOf(TokenError);
    expect(await verify(await sign({}, { exp: Math.floor(Date.now() / 1000) - 2 }))).toMatchObject({ id: USER });
  });

  it("refuses a token from another issuer, for another audience, or signed by another key", async () => {
    await expect(verify(await sign({}, { iss: "https://evil.example.com/auth/v1" }))).rejects.toBeInstanceOf(TokenError);
    await expect(verify(await sign({}, { aud: "something-else" }))).rejects.toBeInstanceOf(TokenError);
    await expect(verify(await sign({}, { key: otherPrivateKey }))).rejects.toBeInstanceOf(TokenError);
    await expect(verify(await sign({}, { kid: "unknown" }))).rejects.toBeInstanceOf(TokenError);
  });

  it("refuses the public (anon) role and a token with no or a malformed user", async () => {
    await expect(verify(await sign({ role: "anon" }))).rejects.toThrow(/not a signed-in user/);
    await expect(verify(await sign({ role: "service_role" }))).rejects.toThrow(/not a signed-in user/);
    const noSub = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(ISSUER).setAudience("authenticated").setExpirationTime("1h").sign(privateKey);
    await expect(verify(noSub)).rejects.toBeInstanceOf(TokenError);
    const badSub = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject("not-a-uuid").setIssuer(ISSUER).setAudience("authenticated").setExpirationTime("1h").sign(privateKey);
    await expect(verify(badSub)).rejects.toBeInstanceOf(TokenError);
  });

  it("refuses a shared-secret (HS256) token and an unsigned token", async () => {
    const hs = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setSubject(USER).setIssuer(ISSUER).setAudience("authenticated").setExpirationTime("1h").sign(new TextEncoder().encode("secret-secret-secret-secret-32-bytes!"));
    await expect(verify(hs)).rejects.toBeInstanceOf(TokenError);
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: USER, role: "authenticated", iss: ISSUER, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    await expect(verify(`${header}.${body}.`)).rejects.toBeInstanceOf(TokenError);
  });

  it("refuses garbage, an empty string and an oversized token", async () => {
    await expect(verify("")).rejects.toBeInstanceOf(TokenError);
    await expect(verify("not.a.jwt")).rejects.toBeInstanceOf(TokenError);
    await expect(verify("x".repeat(9000))).rejects.toBeInstanceOf(TokenError);
  });

  it("refuses a token whose payload was changed after signing", async () => {
    const t = await sign();
    const [h, , s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "11111111-1111-1111-1111-111111111111", role: "authenticated", iss: ISSUER, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    await expect(verify(`${h}.${forged}.${s}`)).rejects.toBeInstanceOf(TokenError);
  });
});
