import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

// promisify loses the options overload, so we restate the signature we use.
const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number, options: ScryptOptions
) => Promise<Buffer>;

// scrypt work factors. N is the CPU/memory cost; 2^15 uses roughly 32 MB and
// takes ~100 ms here.
const N = 32768, r = 8, p = 1, KEYLEN = 32;

/**
 * Why scrypt and not SHA-256?
 *
 * Hashes like SHA-256 are designed to be FAST, which is exactly wrong for
 * passwords: a GPU can try billions per second. scrypt (like bcrypt and argon2)
 * is deliberately slow AND memory-hungry, so an attacker who steals the
 * database still cannot brute-force the hashes cheaply.
 *
 * We use scrypt specifically because it ships inside Node - no native module to
 * compile, which keeps the Alpine image small and the build simple. argon2 is
 * the modern first choice if you are willing to add the dependency.
 */
export async function hashPassword(password: string): Promise<string> {
  // A random per-user salt means two people with the same password get
  // different hashes, so one cracked password does not reveal the other.
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, rr, pp, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, salt, expected.length, {
    N: Number(n), r: Number(rr), p: Number(pp), maxmem: 64 * 1024 * 1024,
  });
  // Constant-time compare. A normal === returns as soon as two bytes differ,
  // and the timing difference can leak the hash one byte at a time.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
