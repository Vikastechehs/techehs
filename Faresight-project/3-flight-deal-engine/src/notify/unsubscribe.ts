// Signed tokens: one-tap unsubscribe links (per channel) and Telegram "connect" links.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';

const hmac = (purpose: string, data: string) => createHmac('sha256', config.appSecret).update(`${purpose}:${data}`).digest();

function safeEqual(a: Buffer, b: Buffer) { return a.length === b.length && timingSafeEqual(a, b); }

/** Token for `${publicUrl}/unsubscribe?t=<token>`: base64url(payload) + '.' + base64url(HMAC-SHA256). Does not expire. */
export function unsubscribeToken(userId: number, channelId: number): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, c: channelId })).toString('base64url');
  return `${payload}.${hmac('unsub', payload).toString('base64url')}`;
}

/** Returns the user and channel the token was made for, or null if it was altered or malformed. */
export function verifyUnsubscribeToken(t: string): { userId: number; channelId: number } | null {
  if (typeof t !== 'string') return null;
  const [payload, sig, extra] = t.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  if (!safeEqual(Buffer.from(sig, 'base64url'), hmac('unsub', payload))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isInteger(p?.u) || !Number.isInteger(p?.c)) return null;
    return { userId: p.u, channelId: p.c };
  } catch { return null; }
}

/**
 * Telegram /start parameter: at most 64 chars of [A-Za-z0-9_-]. Format: <userId>_<expiry base36>_<16 hex HMAC>.
 * Valid for `ttlSec` (default 1 day).
 */
export function telegramStartToken(userId: number, ttlSec = 86400, now = Date.now()): string {
  const body = `${userId}_${Math.floor(now / 1000 + ttlSec).toString(36)}`;
  return `${body}_${hmac('tg', body).toString('hex').slice(0, 16)}`;
}

export function verifyTelegramStartToken(t: string, now = Date.now()): number | null {
  const m = /^(\d+)_([0-9a-z]+)_([0-9a-f]{16})$/.exec(t ?? '');
  if (!m) return null;
  const body = `${m[1]}_${m[2]}`;
  if (!safeEqual(Buffer.from(m[3]), Buffer.from(hmac('tg', body).toString('hex').slice(0, 16)))) return null;
  if (parseInt(m[2], 36) * 1000 < now) return null;
  return Number(m[1]);
}
