import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "dev-only-insecure-secret-change-me"
);
const ISSUER = "pong-arena";
const TTL = process.env.JWT_TTL ?? "24h";

export interface TokenClaims { sub: string; username: string; guest?: boolean }

const GUEST_TTL = process.env.GUEST_JWT_TTL ?? "6h";

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
 * A guest token. Signed exactly like a normal one, so the WebSocket handshake
 * needs no special case - but it carries `guest: true`, and its subject is a
 * random id that does NOT correspond to any row in `users`.
 *
 * That distinction is what keeps guest matches out of the database: recording
 * one would violate the foreign key from match_players to users.
 */
export async function issueGuestToken(): Promise<{ token: string; username: string; id: string }> {
  const id = `guest_${randomUUID()}`;
  // Short, readable, and obviously not a real account.
  const username = `Guest-${randomUUID().slice(0, 4).toUpperCase()}`;
  const token = await new SignJWT({ username, guest: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(GUEST_TTL)
    .sign(SECRET);
  return { token, username, id };
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
    return { sub: payload.sub, username: payload.username, guest: payload.guest === true };
  } catch {
    return null;
  }
}
