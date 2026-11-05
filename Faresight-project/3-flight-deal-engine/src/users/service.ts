// User accounts and user data. THE CONTRACT used by the API, the web pages, notifications and admin.
// Owned by the accounts module: signatures are fixed; bodies are implemented in this file.
import type { IncomingMessage } from 'node:http';
import type { Db, Row } from '../db.ts';
import { config } from '../config.ts';
import { enqueue, forgetAddress } from '../notify/outbox.ts';
import { cookies } from '../web/http.ts';
import { DUMMY_HASH, hashPassword, newCode, newToken, sameHash, sha256, verifyPassword } from './crypto.ts';

export const SESSION_COOKIE = 'fs_session';
export const REGIONS = ['seAsia', 'saGulf', 'eastAsia', 'europe', 'longHaul'] as const;

export interface User {
  id: number; email: string; name: string | null; phone: string | null; home_airport: string | null;
  market: string; currency: string; locale: string; role: 'user' | 'admin'; status: 'active' | 'disabled' | 'deleted';
  email_verified_at: string | null; marketing_consent: boolean; has_password: boolean;
  created_at: string; last_login_at: string | null;
}
export interface SessionMeta { userAgent?: string; ip?: string; kind?: 'web' | 'app' }
export interface Auth { user: User; token: string }
export interface Alert { id: number; origin: string; city: string; min_saving_pct: number; max_price: number | null; regions: string[] | null; active: boolean; created_at: string }
export interface Channel { id: number; kind: 'email' | 'telegram' | 'whatsapp' | 'push'; address: string; frequency: 'instant' | 'daily'; verified_at: string | null; active: boolean; created_at: string }
export interface Watch { id: number; route_id: number; origin: string; destination: string; from_city: string; to_city: string; max_price: number | null; live_deal_id: number | null; live_price: number | null; created_at: string }
export interface SavedDeal { deal_id: number; origin: string; destination: string; from_city: string; to_city: string; price: number; normal_price: number; saving_pct: number; currency: string; status: string; saved_at: string }
export interface HotelAlert { id: number; city: string; city_name: string; min_saving_pct: number; max_per_night: number | null; min_stars: number | null; active: boolean; created_at: string }
export interface SavedHotelDeal { hotel_deal_id: number; hotel_name: string; city: string; city_name: string; stars: number | null; per_night: number; normal_per_night: number; saving_pct: number; currency: string; status: string; saved_at: string }
export type ProfilePatch = Partial<Pick<User, 'name' | 'phone' | 'home_airport' | 'locale' | 'marketing_consent'>>;

/** Validation problems throw this; the message is safe to show to the user. */
export class UserError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

export const CODE_TTL_MIN = 10, CODE_MAX_ATTEMPTS = 5, CODES_PER_HOUR = 5, PASSWORD_MIN = 8;
/** Channel confirmation: codes work 15 minutes with 5 tries; at most 5 sends per channel per hour; email links work 24 hours. */
export const CHANNEL_CODE_TTL_MIN = 15, CHANNEL_CODE_MAX_ATTEMPTS = 5, CHANNEL_CODES_PER_HOUR = 5, CHANNEL_LINK_TTL_HOURS = 24;
const MAX_CHANNELS = 20, MAX_WATCHES = 100;

// --- Helpers: validation and row mapping ---
/** Timestamps as ISO strings (PGlite returns Date objects, pg too). */
function plain<T>(r: Row): T {
  const o: Row = {};
  for (const [k, v] of Object.entries(r)) o[k] = v instanceof Date ? v.toISOString() : v;
  return o as T;
}
const plainAll = <T>(rows: Row[]) => rows.map(r => plain<T>(r));

export function normEmail(email: unknown): string {
  const e = String(email ?? '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z0-9-]{2,}$/.test(e)) throw new UserError('Enter a valid email address');
  return e;
}
/** E.164: "+" and 8-15 digits. Spaces, dashes and brackets are removed first. */
export function normPhone(phone: unknown): string {
  const p = String(phone ?? '').replace(/[\s\-().]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(p)) throw new UserError('Enter the phone number with the country code, e.g. +919812345678');
  return p;
}
function checkPassword(password: unknown): string {
  const p = String(password ?? '');
  if (p.length < PASSWORD_MIN) throw new UserError(`Password must be at least ${PASSWORD_MIN} characters`);
  if (p.length > 200) throw new UserError('Password is too long');
  return p;
}
function optPrice(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e8) throw new UserError('Max price must be a positive number');
  return Math.round(n);
}
const iata = (v: unknown) => String(v ?? '').trim().toUpperCase();

const USER_COLS = `id, email, name, phone, home_airport, market, currency, locale, role, status, email_verified_at,
  marketing_consent, password_hash IS NOT NULL AS has_password, created_at, last_login_at`;
const uCols = (alias: string) => USER_COLS.replace(/(^|,\s*)(\w+)/g, `$1${alias}.$2`);

async function activeUserByEmail(db: Db, email: string) {
  const [u] = await db.query(`SELECT ${USER_COLS}, password_hash AS pw FROM users WHERE lower(email) = $1 AND status <> 'deleted'`, [email]);
  return u;
}
async function startSession(db: Db, userId: number, meta: SessionMeta): Promise<Auth> {
  const token = newToken();
  await db.query(`INSERT INTO sessions (id, user_id, kind, user_agent, ip, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6))`,
    [sha256(token), userId, meta.kind === 'app' ? 'app' : 'web', meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null, config.sessionDays]);
  await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
  return { user: (await getUser(db, userId))!, token };
}
async function addEmailChannel(db: Db, userId: number, email: string, verified: boolean) {
  await db.query(`INSERT INTO notification_channels (user_id, kind, address, verified_at) VALUES ($1, 'email', $2, ${verified ? 'now()' : 'NULL'})
    ON CONFLICT (user_id, kind, address) DO UPDATE SET verified_at = coalesce(notification_channels.verified_at, EXCLUDED.verified_at)`, [userId, email]);
}
const disabled = () => new UserError('This account has been disabled. Contact support.', 403);

// --- Sign-in ---
/** Emails a 6-digit code (via notify/outbox.ts enqueue). Rate limited: max 5 per email per hour. */
export async function requestLoginCode(db: Db, email: string): Promise<{ sent: true }> {
  const e = normEmail(email);
  const [c] = await db.query(`SELECT count(*)::int AS n FROM login_codes WHERE lower(email) = $1 AND created_at > now() - interval '1 hour'`, [e]);
  if (c.n >= CODES_PER_HOUR) throw new UserError('Too many codes requested. Try again in an hour.', 429);
  const code = newCode();
  await db.query(`INSERT INTO login_codes (email, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`, [e, sha256(code), CODE_TTL_MIN]);
  await enqueue(db, { channel: 'email', to: e, subject: `Your Faresight sign-in code: ${code}`,
    body: `Your Faresight sign-in code is ${code}\n\nIt works for ${CODE_TTL_MIN} minutes. If you didn't ask for it, you can ignore this email.`,
    meta: { kind: 'login_code' } });
  return { sent: true };
}

/** Checks the code (10 min expiry, max 5 attempts); creates the user on first sign-in, marks email verified, starts a session. */
export async function verifyLoginCode(db: Db, email: string, code: string, meta: SessionMeta = {}): Promise<Auth | null> {
  const e = normEmail(email);
  const [lc] = await db.query(`SELECT id, code_hash, attempts FROM login_codes WHERE lower(email) = $1 AND purpose = 'login'
    AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [e]);
  if (!lc) return null;
  if (lc.attempts >= CODE_MAX_ATTEMPTS) throw new UserError('Too many wrong tries. Ask for a new code.', 429);
  await db.query(`UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1`, [lc.id]);
  if (!sameHash(sha256(String(code ?? '').trim()), lc.code_hash)) return null;
  const used = await db.query(`UPDATE login_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`, [lc.id]);
  if (!used.length) return null;   // a parallel request used it first

  let u = await activeUserByEmail(db, e);
  if (!u) {
    await db.query(`INSERT INTO users (email, email_verified_at) VALUES ($1, now()) ON CONFLICT (lower(email)) WHERE status <> 'deleted' DO NOTHING`, [e]);
    u = await activeUserByEmail(db, e);
    await logEvent(db, u.id, 'signup', { method: 'code' });
  }
  if (u.status !== 'active') throw disabled();
  if (!u.email_verified_at) await db.query(`UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1`, [u.id]);
  await addEmailChannel(db, u.id, e, true);
  await logEvent(db, u.id, 'login', { method: 'code', ip: meta.ip ?? null });
  return startSession(db, u.id, meta);
}

export async function registerWithPassword(db: Db, input: { email: string; password: string; name?: string }, meta: SessionMeta = {}): Promise<Auth> {
  const e = normEmail(input.email), pw = checkPassword(input.password);
  const name = input.name == null ? null : String(input.name).trim().slice(0, 100) || null;
  if (await activeUserByEmail(db, e)) throw new UserError('An account with this email already exists. Sign in instead.', 409);
  const hash = await hashPassword(pw);
  const [r] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3)
    ON CONFLICT (lower(email)) WHERE status <> 'deleted' DO NOTHING RETURNING id`, [e, name, hash]);
  if (!r) throw new UserError('An account with this email already exists. Sign in instead.', 409);
  await addEmailChannel(db, r.id, e, false);
  await logEvent(db, r.id, 'signup', { method: 'password' });
  const [ec] = await db.query(`SELECT id FROM notification_channels WHERE user_id = $1 AND kind = 'email' AND address = $2`, [r.id, e]);
  if (ec) await autoVerify(db, r.id, ec.id);
  await logEvent(db, r.id, 'login', { method: 'password', ip: meta.ip ?? null });
  return startSession(db, r.id, meta);
}

export async function loginWithPassword(db: Db, email: string, password: string, meta: SessionMeta = {}): Promise<Auth | null> {
  const e = normEmail(email);
  const u = await activeUserByEmail(db, e);
  const ok = await verifyPassword(String(password ?? ''), u?.pw ?? DUMMY_HASH);
  if (!u || !ok) return null;
  if (u.status !== 'active') throw disabled();
  await logEvent(db, u.id, 'login', { method: 'password', ip: meta.ip ?? null });
  return startSession(db, u.id, meta);
}

export async function setPassword(db: Db, userId: number, password: string): Promise<void> {
  const hash = await hashPassword(checkPassword(password));
  await db.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [userId, hash]);
  await logEvent(db, userId, 'password_set');
}
/** True when the password matches the user's current one (false when they have none). */
export async function checkUserPassword(db: Db, userId: number, password: string): Promise<boolean> {
  const [u] = await db.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  return !!u?.password_hash && verifyPassword(String(password ?? ''), u.password_hash);
}

export async function userFromToken(db: Db, token: string): Promise<User | null> {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const [u] = await db.query(`SELECT ${uCols('u')}, s.last_seen_at < now() - interval '5 minutes' AS stale
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now() AND u.status = 'active'`, [id]);
  if (!u) return null;
  if (u.stale) await db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [id]);
  delete u.stale;
  return plain<User>(u);
}
/** The session token on a request and where it came from (Bearer header first, then the cookie). */
export function tokenFromRequest(req: IncomingMessage): { token: string; via: 'bearer' | 'cookie' } | null {
  const h = req.headers.authorization ?? '';
  if (/^Bearer\s+\S/i.test(h)) return { token: h.replace(/^Bearer\s+/i, '').trim(), via: 'bearer' };
  const c = cookies(req)[SESSION_COOKIE];
  return c ? { token: c, via: 'cookie' } : null;
}
/** Reads the fs_session cookie or an "Authorization: Bearer <token>" header. */
export async function userFromRequest(db: Db, req: IncomingMessage): Promise<User | null> {
  const t = tokenFromRequest(req);
  return t ? userFromToken(db, t.token) : null;
}
export async function logout(db: Db, token: string): Promise<void> {
  const [s] = await db.query(`DELETE FROM sessions WHERE id = $1 RETURNING user_id`, [sha256(token)]);
  if (s) await logEvent(db, s.user_id, 'logout');
}
export async function logoutEverywhere(db: Db, userId: number): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await logEvent(db, userId, 'logout', { all: true });
}

// --- Profile ---
export async function getUser(db: Db, userId: number): Promise<User | null> {
  const [u] = await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [userId]);
  return u ? plain<User>(u) : null;
}
export async function updateProfile(db: Db, userId: number, patch: ProfilePatch): Promise<User> {
  const before = await getUser(db, userId);
  if (!before || before.status === 'deleted') throw new UserError('Account not found', 404);
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name == null ? null : String(patch.name).trim().slice(0, 100) || null;
  if (patch.phone !== undefined) set.phone = patch.phone == null || patch.phone === '' ? null : normPhone(patch.phone);
  if (patch.home_airport !== undefined) {
    const a = patch.home_airport == null || patch.home_airport === '' ? null : iata(patch.home_airport);
    if (a && !(await db.query(`SELECT 1 FROM airports WHERE iata = $1`, [a])).length) throw new UserError('Unknown airport');
    set.home_airport = a;
  }
  if (patch.locale !== undefined) {
    if (patch.locale !== 'en' && patch.locale !== 'hi') throw new UserError('Language must be en or hi');
    set.locale = patch.locale;
  }
  if (patch.marketing_consent !== undefined) {
    if (typeof patch.marketing_consent !== 'boolean') throw new UserError('marketing_consent must be true or false');
    set.marketing_consent = patch.marketing_consent;
  }
  const keys = Object.keys(set);
  if (keys.length) {
    await db.query(`UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [userId, ...keys.map(k => set[k])]);
    if ('marketing_consent' in set && set.marketing_consent !== before.marketing_consent)
      await logEvent(db, userId, 'consent', { marketing_consent: set.marketing_consent });
    if ('phone' in set && set.phone && set.phone !== before.phone) await onPhoneChanged(db, userId, String(set.phone));
  }
  return (await getUser(db, userId))!;
}

// --- City alerts ---
const ALERT_SQL = `SELECT s.id, s.origin, a.city, s.min_saving_pct, s.max_price, s.regions, s.active, s.created_at
  FROM alert_subscriptions s JOIN airports a ON a.iata = s.origin WHERE s.user_id = $1`;
export async function listAlerts(db: Db, userId: number): Promise<Alert[]> {
  return plainAll<Alert>(await db.query(`${ALERT_SQL} ORDER BY a.city`, [userId]));
}
export async function upsertAlert(db: Db, userId: number, a: { origin: string; min_saving_pct?: number; max_price?: number | null; regions?: string[] | null; active?: boolean }): Promise<Alert> {
  const origin = iata(a.origin);
  if (!(await db.query(`SELECT 1 FROM routes WHERE origin = $1 AND active LIMIT 1`, [origin])).length)
    throw new UserError('We don\'t track deals from that airport yet');
  const [old] = await db.query(`SELECT * FROM alert_subscriptions WHERE user_id = $1 AND origin = $2`, [userId, origin]);
  const pct = a.min_saving_pct === undefined ? (old?.min_saving_pct ?? 25) : Number(a.min_saving_pct);
  if (!Number.isInteger(pct) || pct < 25 || pct > 90) throw new UserError('Minimum saving must be a whole number from 25 to 90');
  const maxPrice = a.max_price === undefined ? (old?.max_price ?? null) : optPrice(a.max_price);
  let regions: string[] | null = a.regions === undefined ? (old?.regions ?? null) : a.regions;
  if (regions != null) {
    if (!Array.isArray(regions) || regions.some(r => !(REGIONS as readonly string[]).includes(r))) throw new UserError(`Regions must be from: ${REGIONS.join(', ')}`);
    regions = regions.length ? [...new Set(regions)] : null;
  }
  const active = a.active === undefined ? (old?.active ?? true) : a.active;
  if (typeof active !== 'boolean') throw new UserError('active must be true or false');
  const [r] = await db.query(`INSERT INTO alert_subscriptions (user_id, origin, min_saving_pct, max_price, regions, active) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (user_id, origin) DO UPDATE SET min_saving_pct = EXCLUDED.min_saving_pct, max_price = EXCLUDED.max_price,
      regions = EXCLUDED.regions, active = EXCLUDED.active RETURNING id`, [userId, origin, pct, maxPrice, regions, active]);
  return plain<Alert>((await db.query(`${ALERT_SQL} AND s.id = $2`, [userId, r.id]))[0]);
}
export async function deleteAlert(db: Db, userId: number, origin: string): Promise<void> {
  await db.query(`DELETE FROM alert_subscriptions WHERE user_id = $1 AND origin = $2`, [userId, iata(origin)]);
}

// --- Channels (email is added automatically on sign-in) ---
const CHANNEL_COLS = `id, kind, address, frequency, verified_at, active, created_at`;
const FREQ = ['instant', 'daily'];
export async function listChannels(db: Db, userId: number): Promise<Channel[]> {
  return plainAll<Channel>(await db.query(`SELECT ${CHANNEL_COLS} FROM notification_channels WHERE user_id = $1 ORDER BY id`, [userId]));
}
export async function addChannel(db: Db, userId: number, c: { kind: Channel['kind']; address: string; meta?: unknown; frequency?: Channel['frequency'] }): Promise<Channel> {
  let address: string, meta: unknown = null, verified = false;
  switch (c.kind) {
    case 'email': {
      address = normEmail(c.address);
      // The verified sign-in email is already confirmed (code sign-in proves it)
      const [u] = await db.query(`SELECT 1 FROM users WHERE id = $1 AND lower(email) = $2 AND email_verified_at IS NOT NULL`, [userId, address]);
      verified = !!u;
      break;
    }
    case 'whatsapp': address = normPhone(c.address); break;
    case 'telegram':
      address = String(c.address ?? '').trim();
      if (!/^-?\d{1,20}$/.test(address)) throw new UserError('Telegram chat id must be a number');
      break;
    case 'push': {
      address = String(c.address ?? '').trim();
      const keys = (c.meta as any)?.keys;
      if (!/^https:\/\/\S+$/.test(address) || address.length > 1000) throw new UserError('Push endpoint must be an https URL');
      if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string' || !keys.p256dh || !keys.auth) throw new UserError('Push subscription keys are missing');
      meta = { keys: { p256dh: keys.p256dh, auth: keys.auth } }; verified = true;   // the browser handed us this endpoint
      break;
    }
    default: throw new UserError('Channel kind must be email, telegram, whatsapp or push');
  }
  const frequency = c.frequency ?? 'instant';
  if (!FREQ.includes(frequency)) throw new UserError('Frequency must be instant or daily');
  const [n] = await db.query(`SELECT count(*)::int AS n FROM notification_channels WHERE user_id = $1`, [userId]);
  if (n.n >= MAX_CHANNELS) throw new UserError('Too many channels; remove one first');
  const [r] = await db.query(`INSERT INTO notification_channels (user_id, kind, address, meta, frequency, verified_at)
    VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::boolean THEN now() END)
    ON CONFLICT (user_id, kind, address) DO UPDATE SET active = true, frequency = EXCLUDED.frequency, meta = coalesce(EXCLUDED.meta, notification_channels.meta),
      verified_at = coalesce(notification_channels.verified_at, EXCLUDED.verified_at)
    RETURNING ${CHANNEL_COLS}`, [userId, c.kind, address, meta == null ? null : JSON.stringify(meta), frequency, verified]);
  // Email and WhatsApp must be confirmed before alerts go there: send a code now (unless one is already on its way)
  if (!r.verified_at && (c.kind === 'email' || c.kind === 'whatsapp')) await autoVerify(db, userId, r.id);
  return plain<Channel>(r);
}
export async function updateChannel(db: Db, userId: number, id: number, patch: { active?: boolean; frequency?: Channel['frequency'] }): Promise<Channel> {
  if (patch.active !== undefined && typeof patch.active !== 'boolean') throw new UserError('active must be true or false');
  if (patch.frequency !== undefined && !FREQ.includes(patch.frequency)) throw new UserError('Frequency must be instant or daily');
  const [r] = await db.query(`UPDATE notification_channels SET active = coalesce($3, active), frequency = coalesce($4, frequency)
    WHERE user_id = $1 AND id = $2 RETURNING ${CHANNEL_COLS}`, [userId, id, patch.active ?? null, patch.frequency ?? null]);
  if (!r) throw new UserError('Channel not found', 404);
  return plain<Channel>(r);
}
export async function removeChannel(db: Db, userId: number, id: number): Promise<void> {
  const r = await db.query(`DELETE FROM notification_channels WHERE user_id = $1 AND id = $2 RETURNING id`, [userId, id]);
  if (!r.length) throw new UserError('Channel not found', 404);
}

// --- Channel confirmation: alerts go only to channels with verified_at set ---
// Telegram channels are confirmed when connected through the bot, push channels when the browser subscribes.
// Email and WhatsApp get a 6-digit code (email also a one-tap link). Rows in channel_verifications hold sha256 hashes:
// code rows hold sha256(code), link rows hold 'link:' + sha256(token).
const LINK = 'link:';
async function ownChannel(db: Db, userId: number, channelId: number) {
  const [c] = Number.isInteger(channelId) ? await db.query(`SELECT c.${CHANNEL_COLS.split(', ').join(', c.')} FROM notification_channels c
    JOIN users u ON u.id = c.user_id WHERE c.id = $1 AND c.user_id = $2 AND u.status = 'active'`, [channelId, userId]) : [];
  if (!c) throw new UserError('Channel not found', 404);
  return c;
}
async function markVerified(db: Db, channelId: number): Promise<Channel> {
  const [c] = await db.query(`UPDATE notification_channels SET verified_at = coalesce(verified_at, now()) WHERE id = $1 RETURNING user_id, ${CHANNEL_COLS}`, [channelId]);
  await db.query(`UPDATE channel_verifications SET used_at = now() WHERE channel_id = $1 AND used_at IS NULL`, [channelId]);
  // Confirming the sign-in email confirms the account's email too
  if (c.kind === 'email') await db.query(`UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1 AND lower(email) = lower($2) AND email_verified_at IS NULL`, [c.user_id, c.address]);
  await logEvent(db, c.user_id, 'channel_verified', { channel_id: channelId, kind: c.kind });
  const { user_id: _, ...channel } = c;
  return plain<Channel>(channel);
}

/**
 * Sends a confirmation code to an email or WhatsApp channel: 6 digits, 15 minutes, 5 tries; emails also carry a one-tap
 * link to /confirm. At most 5 sends per channel per hour (UserError 429). An already confirmed channel sends nothing.
 */
export async function startChannelVerification(db: Db, userId: number, channelId: number): Promise<{ sent: boolean; verified: boolean }> {
  const c = await ownChannel(db, userId, channelId);
  if (c.verified_at) return { sent: false, verified: true };
  if (c.kind !== 'email' && c.kind !== 'whatsapp')
    throw new UserError(c.kind === 'telegram' ? 'Telegram is confirmed when you connect it from Telegram.' : 'App notifications are confirmed when you turn them on.');
  const [n] = await db.query(`SELECT count(*)::int AS n FROM channel_verifications WHERE channel_id = $1 AND code_hash NOT LIKE 'link:%'
    AND created_at > now() - interval '1 hour'`, [c.id]);
  if (n.n >= CHANNEL_CODES_PER_HOUR) throw new UserError('Too many codes sent. Try again in an hour.', 429);
  // A new code replaces the old ones
  await db.query(`UPDATE channel_verifications SET used_at = now() WHERE channel_id = $1 AND used_at IS NULL AND code_hash NOT LIKE 'link:%'`, [c.id]);
  const code = newCode();
  await db.query(`INSERT INTO channel_verifications (channel_id, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [c.id, sha256(code), CHANNEL_CODE_TTL_MIN]);
  if (c.kind === 'whatsapp') {
    await enqueue(db, { channel: 'whatsapp', to: c.address, body: `Your ${config.siteName} code: ${code}`,
      meta: { template: 'code', params: [code], purpose: 'verify', channel_id: c.id, user_id: userId } });
  } else {
    const token = newToken();
    await db.query(`INSERT INTO channel_verifications (channel_id, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
      [c.id, LINK + sha256(token), CHANNEL_LINK_TTL_HOURS]);
    const link = `${config.publicUrl}/confirm?c=${c.id}&t=${token}`;
    await enqueue(db, { channel: 'email', to: c.address, subject: 'Confirm your email for alerts',
      body: `Confirm this email to get ${config.siteName} deal alerts here.\n\nTap to confirm: ${link}\n\nOr enter this code: ${code} (it works for ${CHANNEL_CODE_TTL_MIN} minutes).\n\nIf you didn't ask for alerts, you can ignore this email.`,
      meta: { kind: 'channel_verify', purpose: 'verify', channel_id: c.id, user_id: userId } });
  }
  return { sent: true, verified: false };
}

/** Sends a code unless one sent in the last minute is still waiting; never fails the caller (rate limit is swallowed). */
async function autoVerify(db: Db, userId: number, channelId: number) {
  const [recent] = await db.query(`SELECT 1 FROM channel_verifications WHERE channel_id = $1 AND used_at IS NULL AND expires_at > now()
    AND code_hash NOT LIKE 'link:%' AND created_at > now() - interval '1 minute'`, [channelId]);
  if (recent) return;
  try { await startChannelVerification(db, userId, channelId); }
  catch (e) { if (!(e instanceof UserError)) throw e; }
}

/** A new phone number: a WhatsApp channel for it is (added if the user uses WhatsApp and) sent a confirmation code. */
async function onPhoneChanged(db: Db, userId: number, phone: string) {
  const wa = await db.query(`SELECT id, address, frequency, verified_at FROM notification_channels WHERE user_id = $1 AND kind = 'whatsapp' ORDER BY id`, [userId]);
  const same = wa.find(w => w.address === phone);
  if (same) { if (!same.verified_at) await autoVerify(db, userId, same.id); return; }
  if (!wa.length) return;
  await addChannel(db, userId, { kind: 'whatsapp', address: phone, frequency: wa[wa.length - 1].frequency });
}

/** Checks a confirmation code. Returns the confirmed channel, or null when the code is wrong or expired (429 after 5 wrong tries). */
export async function confirmChannel(db: Db, userId: number, channelId: number, code: string): Promise<Channel | null> {
  const c = await ownChannel(db, userId, channelId);
  if (c.verified_at) return plain<Channel>(c);
  const [v] = await db.query(`SELECT id, code_hash, attempts FROM channel_verifications WHERE channel_id = $1 AND used_at IS NULL
    AND expires_at > now() AND code_hash NOT LIKE 'link:%' ORDER BY created_at DESC, id DESC LIMIT 1`, [c.id]);
  if (!v) return null;
  if (v.attempts >= CHANNEL_CODE_MAX_ATTEMPTS) throw new UserError('Too many wrong tries. Ask for a new code.', 429);
  await db.query(`UPDATE channel_verifications SET attempts = attempts + 1 WHERE id = $1`, [v.id]);
  if (!sameHash(sha256(String(code ?? '').replace(/\s/g, '')), v.code_hash)) return null;
  const used = await db.query(`UPDATE channel_verifications SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`, [v.id]);
  if (!used.length) return null;
  return markVerified(db, c.id);
}

/** The one-tap link from a confirmation email (no sign-in needed). True when the channel is (now) confirmed. */
export async function confirmChannelByLink(db: Db, channelId: number, token: string): Promise<boolean> {
  const t = String(token ?? '');
  if (!Number.isInteger(channelId) || !t || t.length > 100) return false;
  const want = LINK + sha256(t);
  const rows = await db.query(`SELECT v.id, v.code_hash, v.used_at, c.verified_at FROM channel_verifications v
    JOIN notification_channels c ON c.id = v.channel_id JOIN users u ON u.id = c.user_id
    WHERE v.channel_id = $1 AND v.code_hash LIKE 'link:%' AND v.expires_at > now() AND u.status = 'active'`, [channelId]);
  const hit = rows.find(r => sameHash(want, r.code_hash));
  if (!hit) return false;
  if (hit.verified_at) return true;   // tapped twice
  if (hit.used_at) return false;
  await markVerified(db, channelId);
  return true;
}

// --- Route watches ---
const WATCH_SQL = `SELECT w.id, w.route_id, r.origin, r.destination, ao.city AS from_city, ad.city AS to_city, w.max_price,
    ld.id AS live_deal_id, ld.price AS live_price, w.created_at
  FROM route_watches w JOIN routes r ON r.id = w.route_id
  JOIN airports ao ON ao.iata = r.origin JOIN airports ad ON ad.iata = r.destination
  LEFT JOIN LATERAL (SELECT id, price FROM deals WHERE route_id = w.route_id AND status = 'live' ORDER BY price LIMIT 1) ld ON true
  WHERE w.user_id = $1`;
export async function listWatches(db: Db, userId: number): Promise<Watch[]> {
  return plainAll<Watch>(await db.query(`${WATCH_SQL} ORDER BY w.created_at DESC, w.id DESC`, [userId]));
}
export async function addWatch(db: Db, userId: number, w: { origin: string; destination: string; max_price?: number | null }): Promise<Watch> {
  const [route] = await db.query(`SELECT id FROM routes WHERE origin = $1 AND destination = $2 ORDER BY active DESC LIMIT 1`, [iata(w.origin), iata(w.destination)]);
  if (!route) throw new UserError('We don\'t track that route', 404);
  const maxPrice = optPrice(w.max_price);
  const [n] = await db.query(`SELECT count(*)::int AS n FROM route_watches WHERE user_id = $1`, [userId]);
  if (n.n >= MAX_WATCHES) throw new UserError('Too many watches; remove one first');
  const [r] = await db.query(`INSERT INTO route_watches (user_id, route_id, max_price) VALUES ($1,$2,$3)
    ON CONFLICT (user_id, route_id) DO UPDATE SET max_price = EXCLUDED.max_price RETURNING id`, [userId, route.id, maxPrice]);
  return plain<Watch>((await db.query(`${WATCH_SQL} AND w.id = $2`, [userId, r.id]))[0]);
}
export async function removeWatch(db: Db, userId: number, id: number): Promise<void> {
  const r = await db.query(`DELETE FROM route_watches WHERE user_id = $1 AND id = $2 RETURNING id`, [userId, id]);
  if (!r.length) throw new UserError('Watch not found', 404);
}

// --- Saved deals ---
export async function listSaved(db: Db, userId: number): Promise<SavedDeal[]> {
  return plainAll<SavedDeal>(await db.query(`SELECT d.id AS deal_id, r.origin, r.destination, ao.city AS from_city, ad.city AS to_city,
      d.price, d.normal_price, d.saving_pct, d.currency, d.status, s.created_at AS saved_at
    FROM saved_deals s JOIN deals d ON d.id = s.deal_id JOIN routes r ON r.id = d.route_id
    JOIN airports ao ON ao.iata = r.origin JOIN airports ad ON ad.iata = r.destination
    WHERE s.user_id = $1 ORDER BY s.created_at DESC`, [userId]));
}
export async function saveDeal(db: Db, userId: number, dealId: number): Promise<void> {
  if (!Number.isInteger(dealId) || !(await db.query(`SELECT 1 FROM deals WHERE id = $1 AND status IN ('live','expired')`, [dealId])).length)
    throw new UserError('Deal not found', 404);
  await db.query(`INSERT INTO saved_deals (user_id, deal_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, dealId]);
}
export async function unsaveDeal(db: Db, userId: number, dealId: number): Promise<void> {
  await db.query(`DELETE FROM saved_deals WHERE user_id = $1 AND deal_id = $2`, [userId, dealId]);
}

// --- Hotel alerts: "tell me about hotel deals in Bangkok at least 35% below normal" ---
const HOTEL_ALERT_SQL = `SELECT s.id, s.city, c.name AS city_name, s.min_saving_pct, s.max_per_night, s.min_stars, s.active, s.created_at
  FROM hotel_alert_subscriptions s JOIN hotel_cities c ON c.code = s.city WHERE s.user_id = $1`;
const cityCode = (v: unknown) => String(v ?? '').trim().toUpperCase();
export async function listHotelAlerts(db: Db, userId: number): Promise<HotelAlert[]> {
  return plainAll<HotelAlert>(await db.query(`${HOTEL_ALERT_SQL} ORDER BY c.name`, [userId]));
}
export async function upsertHotelAlert(db: Db, userId: number, a: { city: string; min_saving_pct?: number; max_per_night?: number | null; min_stars?: number | null; active?: boolean }): Promise<HotelAlert> {
  const city = cityCode(a?.city);
  if (!city || city.length > 10 || !(await db.query(`SELECT 1 FROM hotel_cities WHERE code = $1 AND active`, [city])).length)
    throw new UserError('We don\'t track hotel deals in that city yet');
  const [old] = await db.query(`SELECT * FROM hotel_alert_subscriptions WHERE user_id = $1 AND city = $2`, [userId, city]);
  const pct = a.min_saving_pct === undefined ? (old?.min_saving_pct ?? 25) : Number(a.min_saving_pct);
  if (!Number.isInteger(pct) || pct < 25 || pct > 90) throw new UserError('Minimum saving must be a whole number from 25 to 90');
  let maxPerNight: number | null;
  if (a.max_per_night === undefined) maxPerNight = old?.max_per_night ?? null;
  else {
    try { maxPerNight = optPrice(a.max_per_night); } catch { throw new UserError('Max price per night must be a positive number'); }
  }
  let stars: number | null;
  if (a.min_stars === undefined) stars = old?.min_stars ?? null;
  else if (a.min_stars == null || (a.min_stars as unknown) === '') stars = null;
  else {
    stars = Number(a.min_stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new UserError('Minimum stars must be a whole number from 1 to 5');
  }
  const active = a.active === undefined ? (old?.active ?? true) : a.active;
  if (typeof active !== 'boolean') throw new UserError('active must be true or false');
  const [r] = await db.query(`INSERT INTO hotel_alert_subscriptions (user_id, city, min_saving_pct, max_per_night, min_stars, active) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (user_id, city) DO UPDATE SET min_saving_pct = EXCLUDED.min_saving_pct, max_per_night = EXCLUDED.max_per_night,
      min_stars = EXCLUDED.min_stars, active = EXCLUDED.active RETURNING id`, [userId, city, pct, maxPerNight, stars, active]);
  return plain<HotelAlert>((await db.query(`${HOTEL_ALERT_SQL} AND s.id = $2`, [userId, r.id]))[0]);
}
export async function deleteHotelAlert(db: Db, userId: number, city: string): Promise<void> {
  await db.query(`DELETE FROM hotel_alert_subscriptions WHERE user_id = $1 AND city = $2`, [userId, cityCode(city)]);
}

// --- Saved hotel deals ---
export async function listSavedHotels(db: Db, userId: number): Promise<SavedHotelDeal[]> {
  return plainAll<SavedHotelDeal>(await db.query(`SELECT d.id AS hotel_deal_id, h.name AS hotel_name, h.city, c.name AS city_name, h.stars,
      d.per_night, d.normal_per_night, d.saving_pct, d.currency, d.status, s.created_at AS saved_at
    FROM saved_hotel_deals s JOIN hotel_deals d ON d.id = s.hotel_deal_id JOIN hotels h ON h.id = d.hotel_id
    JOIN hotel_cities c ON c.code = h.city
    WHERE s.user_id = $1 ORDER BY s.created_at DESC, d.id DESC`, [userId]));
}
export async function saveHotelDeal(db: Db, userId: number, hotelDealId: number): Promise<void> {
  if (!Number.isInteger(hotelDealId) || !(await db.query(`SELECT 1 FROM hotel_deals WHERE id = $1 AND status IN ('live','expired')`, [hotelDealId])).length)
    throw new UserError('Hotel deal not found', 404);
  await db.query(`INSERT INTO saved_hotel_deals (user_id, hotel_deal_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, hotelDealId]);
}
export async function unsaveHotelDeal(db: Db, userId: number, hotelDealId: number): Promise<void> {
  if (!Number.isInteger(hotelDealId)) return;
  await db.query(`DELETE FROM saved_hotel_deals WHERE user_id = $1 AND hotel_deal_id = $2`, [userId, hotelDealId]);
}

// --- Privacy (India DPDP Act 2023): export and erase ---
/** Everything stored about the user, as one JSON object. Logs a user_events 'export' row. */
export async function exportUserData(db: Db, userId: number): Promise<Record<string, unknown>> {
  const profile = await getUser(db, userId);
  if (!profile) throw new UserError('Account not found', 404);
  await logEvent(db, userId, 'export');
  const q = async (sql: string) => plainAll<Row>(await db.query(sql, [userId]));
  return {
    exported_at: new Date().toISOString(),
    profile: plain<Row>((await db.query(`SELECT ${USER_COLS}, updated_at, deleted_at FROM users WHERE id = $1`, [userId]))[0]),
    alerts: await listAlerts(db, userId),
    channels: await q(`SELECT ${CHANNEL_COLS}, meta FROM notification_channels WHERE user_id = $1 ORDER BY id`),
    watches: await listWatches(db, userId),
    saved: await listSaved(db, userId),
    hotel_alerts: await listHotelAlerts(db, userId),
    saved_hotels: await listSavedHotels(db, userId),
    notifications: await q(`SELECT id, deal_id, hotel_deal_id, channel_id, kind, status, created_at, sent_at FROM notifications WHERE user_id = $1 ORDER BY id`),
    clicks: await q(`SELECT deal_id, deal_date_id, channel, partner, clicked_at FROM clicks WHERE user_id = $1 ORDER BY id`),
    hotel_clicks: await q(`SELECT hotel_deal_id, hotel_deal_date_id, channel, partner, clicked_at FROM hotel_clicks WHERE user_id = $1 ORDER BY id`),
    sessions: await q(`SELECT kind, user_agent, ip, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = $1 ORDER BY created_at`),
    user_events: await q(`SELECT kind, data, created_at FROM user_events WHERE user_id = $1 ORDER BY id`),
  };
}
/** Erases personal data: deletes sessions/alerts/channels/watches/saved (flights and hotels), anonymises the users row (status 'deleted'). */
export async function deleteAccount(db: Db, userId: number): Promise<void> {
  const [u] = await db.query(`SELECT email, status FROM users WHERE id = $1`, [userId]);
  if (!u || u.status === 'deleted') return;
  // Erase queued and past messages to this person too (they hold the address and old sign-in codes)
  const addrs = (await db.query(`SELECT address FROM notification_channels WHERE user_id = $1`, [userId])).map(r => String(r.address));
  const [p] = await db.query(`SELECT phone FROM users WHERE id = $1`, [userId]);
  await forgetAddress(db, [u.email, ...addrs, ...(p?.phone ? [p.phone, String(p.phone).replace(/\D/g, '')] : [])]);
  for (const t of ['sessions', 'alert_subscriptions', 'notification_channels', 'route_watches', 'saved_deals', 'hotel_alert_subscriptions', 'saved_hotel_deals'])
    await db.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
  await db.query(`DELETE FROM login_codes WHERE lower(email) = lower($1)`, [u.email]);
  await db.query(`UPDATE users SET email = $2, name = NULL, phone = NULL, password_hash = NULL, home_airport = NULL,
    marketing_consent = false, status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1`, [userId, `deleted-${userId}@deleted.invalid`]);
  await logEvent(db, userId, 'delete');
}

export async function logEvent(db: Db, userId: number | null, kind: string, data?: unknown): Promise<void> {
  await db.query(`INSERT INTO user_events (user_id, kind, data) VALUES ($1,$2,$3)`, [userId, kind, data === undefined ? null : JSON.stringify(data)]);
}
