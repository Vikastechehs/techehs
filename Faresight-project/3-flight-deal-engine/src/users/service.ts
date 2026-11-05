// User accounts and user data. THE CONTRACT used by the API, the web pages, notifications and admin.
// Owned by the accounts module: signatures are fixed; bodies are implemented in this file.
import type { IncomingMessage } from 'node:http';
import type { Db } from '../db.ts';

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
export type ProfilePatch = Partial<Pick<User, 'name' | 'phone' | 'home_airport' | 'locale' | 'marketing_consent'>>;

/** Validation problems throw this; the message is safe to show to the user. */
export class UserError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

const todo = (): never => { throw new Error('not implemented'); };

// --- Sign-in ---
/** Emails a 6-digit code (via notify/outbox.ts enqueue). Rate limited: max 5 per email per hour. */
export async function requestLoginCode(db: Db, email: string): Promise<{ sent: true }> { return todo(); }
/** Checks the code (10 min expiry, max 5 attempts); creates the user on first sign-in, marks email verified, starts a session. */
export async function verifyLoginCode(db: Db, email: string, code: string, meta: SessionMeta = {}): Promise<Auth | null> { return todo(); }
export async function registerWithPassword(db: Db, input: { email: string; password: string; name?: string }, meta: SessionMeta = {}): Promise<Auth> { return todo(); }
export async function loginWithPassword(db: Db, email: string, password: string, meta: SessionMeta = {}): Promise<Auth | null> { return todo(); }
export async function setPassword(db: Db, userId: number, password: string): Promise<void> { return todo(); }
export async function userFromToken(db: Db, token: string): Promise<User | null> { return todo(); }
/** Reads the fs_session cookie or an "Authorization: Bearer <token>" header. */
export async function userFromRequest(db: Db, req: IncomingMessage): Promise<User | null> { return todo(); }
export async function logout(db: Db, token: string): Promise<void> { return todo(); }
export async function logoutEverywhere(db: Db, userId: number): Promise<void> { return todo(); }

// --- Profile ---
export async function getUser(db: Db, userId: number): Promise<User | null> { return todo(); }
export async function updateProfile(db: Db, userId: number, patch: ProfilePatch): Promise<User> { return todo(); }

// --- City alerts ---
export async function listAlerts(db: Db, userId: number): Promise<Alert[]> { return todo(); }
export async function upsertAlert(db: Db, userId: number, a: { origin: string; min_saving_pct?: number; max_price?: number | null; regions?: string[] | null; active?: boolean }): Promise<Alert> { return todo(); }
export async function deleteAlert(db: Db, userId: number, origin: string): Promise<void> { return todo(); }

// --- Channels (email is added automatically on sign-in) ---
export async function listChannels(db: Db, userId: number): Promise<Channel[]> { return todo(); }
export async function addChannel(db: Db, userId: number, c: { kind: Channel['kind']; address: string; meta?: unknown; frequency?: Channel['frequency'] }): Promise<Channel> { return todo(); }
export async function updateChannel(db: Db, userId: number, id: number, patch: { active?: boolean; frequency?: Channel['frequency'] }): Promise<Channel> { return todo(); }
export async function removeChannel(db: Db, userId: number, id: number): Promise<void> { return todo(); }

// --- Route watches ---
export async function listWatches(db: Db, userId: number): Promise<Watch[]> { return todo(); }
export async function addWatch(db: Db, userId: number, w: { origin: string; destination: string; max_price?: number | null }): Promise<Watch> { return todo(); }
export async function removeWatch(db: Db, userId: number, id: number): Promise<void> { return todo(); }

// --- Saved deals ---
export async function listSaved(db: Db, userId: number): Promise<SavedDeal[]> { return todo(); }
export async function saveDeal(db: Db, userId: number, dealId: number): Promise<void> { return todo(); }
export async function unsaveDeal(db: Db, userId: number, dealId: number): Promise<void> { return todo(); }

// --- Privacy (India DPDP Act 2023): export and erase ---
/** Everything stored about the user, as one JSON object. Logs a user_events 'export' row. */
export async function exportUserData(db: Db, userId: number): Promise<Record<string, unknown>> { return todo(); }
/** Erases personal data: deletes sessions/alerts/channels/watches/saved, anonymises the users row (status 'deleted'). */
export async function deleteAccount(db: Db, userId: number): Promise<void> { return todo(); }

export async function logEvent(db: Db, userId: number | null, kind: string, data?: unknown): Promise<void> { return todo(); }
