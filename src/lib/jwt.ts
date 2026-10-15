import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Checks the sign-in token a browser sends. Supabase signs its access tokens with a private key and publishes the matching public
 * keys at <project>/auth/v1/.well-known/jwks.json, so the backend can verify any token without holding a secret.
 *
 * Accepted: a valid signature (ES256 or RS256, never a shared-secret algorithm), the project's issuer, audience "authenticated",
 * not expired (5 s of clock tolerance), role "authenticated" and a user id. Anything else is the same "unauthorized" to the caller.
 */

export interface AuthUser {
  id: string;
  email?: string;
  role: string;
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTokenVerifier(opts: { issuer: string; keys: JWTVerifyGetKey }): TokenVerifier {
  return async (token: string): Promise<AuthUser> => {
    if (!token || token.length > 8192) throw new TokenError("no token");
    try {
      const { payload } = await jwtVerify(token, opts.keys, {
        issuer: opts.issuer,
        audience: "authenticated",
        algorithms: ["ES256", "RS256"],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== "string" || !UUID.test(payload.sub)) throw new TokenError("no user in the token");
      if (payload.role !== "authenticated") throw new TokenError("not a signed-in user");
      return { id: payload.sub.toLowerCase(), ...(typeof payload.email === "string" ? { email: payload.email } : {}), role: payload.role };
    } catch (error) {
      if (error instanceof TokenError) throw error;
      if (error instanceof joseErrors.JOSEError) throw new TokenError("the token was refused");
      throw error;
    }
  };
}

export function createSupabaseTokenVerifier(supabaseUrl: string): TokenVerifier {
  const base = supabaseUrl.replace(/\/+$/, "");
  const keys = createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
  return createTokenVerifier({ issuer: `${base}/auth/v1`, keys });
}
