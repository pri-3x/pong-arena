import { randomBytes } from "node:crypto";
import { redis } from "./client.js";

/**
 * Private matches: one player creates an invite, shares the code, and the
 * friend who enters it is matched directly with them - bypassing the public
 * queue entirely.
 *
 * The invite lives in Redis rather than in a Pod's memory for the same reason
 * the matchmaking queue does: the two players will usually land on different
 * Pods, and the host's Pod is not the one that receives the join.
 */
const KEY = (code: string) => `invite:${code}`;
const TTL_SECONDS = Number(process.env.INVITE_TTL_SECONDS ?? 900); // 15 minutes

/**
 * No 0/O/1/I/L. Codes get read aloud, typed from a phone screen, and pasted
 * into chat - ambiguous glyphs cost more than the extra entropy is worth.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export interface Invite {
  playerId: string;
  identityId: string;
  userId: string;
  name: string;
  pod: string;
}

function generateCode(): string {
  // rejection-free: 31 symbols from 256 would bias, so take modulo of a wider
  // draw and accept the negligible bias, or just draw per character.
  const bytes = randomBytes(CODE_LENGTH * 2);
  let out = "";
  for (let i = 0; out.length < CODE_LENGTH && i < bytes.length; i++) {
    const v = bytes[i];
    if (v >= 248) continue;                 // 248 = 31 * 8, keeps it uniform
    out += ALPHABET[v % ALPHABET.length];
  }
  return out;
}

/** Returns the code, or null if we could not find a free one. */
export async function createInvite(invite: Invite): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    // NX means "only if it does not already exist", so two simultaneous
    // creations can never be handed the same code.
    const set = await redis.set(KEY(code), JSON.stringify(invite), "EX", TTL_SECONDS, "NX");
    if (set === "OK") return code;
  }
  return null;
}

/**
 * Claim an invite. GETDEL reads and deletes in one atomic operation, so if two
 * people paste the same code at the same moment exactly one of them gets it.
 */
export async function claimInvite(code: string): Promise<Invite | null> {
  const raw = await redis.getdel(KEY(code.toUpperCase()));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Invite;
  } catch {
    return null;
  }
}

/** Host disconnected or cancelled before anyone joined. */
export async function cancelInvite(code: string): Promise<void> {
  await redis.del(KEY(code)).catch(() => {});
}

export async function inviteExists(code: string): Promise<boolean> {
  return (await redis.exists(KEY(code.toUpperCase()))) === 1;
}
