// Password hashing (scrypt), session tokens and sign-in codes. Only hashes are ever stored.
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384, KEYLEN = 64;
const scryptAsync = (pw: string, salt: Buffer, n: number) => new Promise<Buffer>((resolve, reject) =>
  scrypt(pw, salt, KEYLEN, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? reject(e) : resolve(k)));

/** Returns `scrypt$N$saltB64$hashB64`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${salt.toString('base64')}$${(await scryptAsync(password, salt, N)).toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [alg, n, salt, hash] = (stored ?? '').split('$');
  if (alg !== 'scrypt' || !salt || !hash || !(Number(n) >= 1024 && Number(n) <= 1 << 20)) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scryptAsync(password, Buffer.from(salt, 'base64'), Number(n));
  return want.length === got.length && timingSafeEqual(want, got);
}
/** A hash that never matches, so unknown emails take as long as wrong passwords. */
export const DUMMY_HASH = `scrypt$${N}$AAAAAAAAAAAAAAAAAAAAAA==$${Buffer.alloc(KEYLEN).toString('base64')}`;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
/** Constant-time comparison of two hex digests. */
export const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
