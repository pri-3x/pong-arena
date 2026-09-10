import { SignJWT, jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "dev-only-insecure-secret-change-me"
);
const ISSUER = "pong-arena";
const TTL = process.env.JWT_TTL ?? "24h";

export interface TokenClaims { sub: string; username: string }

export async function issueToken(claims: TokenClaims): Promise<string> {
  return new SignJWT({ username: claims.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(SECRET);
}

/**
 * Returns the claims, or null if the token is missing, expired, tampered with,
 * or signed by someone else.
 *
 * A JWT is signed, NOT encrypted: anyone can read its contents. Never put a
 * secret in one. Its value is that the server can trust the contents without a
 * database lookup, which is exactly what we want on a WebSocket handshake.
 */
export async function verifyToken(token: string | undefined): Promise<TokenClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET, {
      issuer: ISSUER,
      algorithms: ["HS256"],   // pin the algorithm: never let the token choose
    });
    if (!payload.sub || typeof payload.username !== "string") return null;
    return { sub: payload.sub, username: payload.username };
  } catch {
    return null;
  }
}
