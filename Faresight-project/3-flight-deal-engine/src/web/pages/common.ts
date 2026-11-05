// Shared helpers for the user-facing pages: per-request state, CSRF tokens, flash messages, signed cookies.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.ts';
import { SESSION_COOKIE, userFromRequest, UserError, type User } from '../../users/service.ts';
import { esc, layout } from '../html.ts';
import { cookies, HttpError, readForm, send, setCookie, type Ctx } from '../http.ts';

const CSRF_COOKIE = 'fs_csrf';
const FLASH_COOKIE = 'fs_flash';
export const secure = config.publicUrl.startsWith('https:');

/** Per-request state for a page: the signed-in user and the cookies to set on the response. */
export interface P extends Ctx { user: User | null; ck: Record<string, string>; out: string[] }

export async function makeP(ctx: Ctx): Promise<P> {
  const ck = cookies(ctx.req);
  // Don't touch the session store for visitors who have no session at all.
  const hasAuth = !!ck[SESSION_COOKIE] || (ctx.req.headers.authorization ?? '').startsWith('Bearer ');
  const user = hasAuth ? await userFromRequest(ctx.db, ctx.req) : null;
  return { ...ctx, user, ck, out: [] };
}

const hmac = (s: string) => createHmac('sha256', config.appSecret).update(s).digest('base64url');
function sameText(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** CSRF token: HMAC of the session cookie (or, before sign-in, of a random fs_csrf cookie). */
export function csrfToken(p: P) {
  let seed = p.ck[SESSION_COOKIE] || p.ck[CSRF_COOKIE];
  if (!seed) {
    seed = randomBytes(18).toString('base64url');
    p.ck[CSRF_COOKIE] = seed;
    p.out.push(setCookie(CSRF_COOKIE, seed, { secure }));
  }
  return hmac('csrf:' + seed);
}
export const csrfField = (p: P) => `<input type="hidden" name="csrf" value="${esc(csrfToken(p))}">`;
export function checkCsrf(p: P, token: string | null | undefined) {
  const seed = p.ck[SESSION_COOKIE] || p.ck[CSRF_COOKIE];
  if (!seed || !token || !sameText(hmac('csrf:' + seed), token)) throw new HttpError(403, 'This form has expired. Go back, reload the page and try again.');
}
/** Reads a POSTed form and checks its CSRF token. */
export async function postForm(p: P) {
  const f = await readForm(p.req);
  checkCsrf(p, f.get('csrf'));
  return f;
}

export function flash(p: P, msg: string, kind: 'ok' | 'error' = 'ok') {
  p.out.push(setCookie(FLASH_COOKIE, `${kind}:${msg}`, { maxAgeSec: 60, secure }));
}
function takeFlash(p: P) {
  const v = p.ck[FLASH_COOKIE];
  if (!v) return '';
  p.out.push(setCookie(FLASH_COOKIE, '', { maxAgeSec: 0, secure }));
  const i = v.indexOf(':');
  const kind = v.slice(0, i) === 'error' ? 'error' : 'ok';
  return `<div class="flash ${kind}" role="status">${esc(v.slice(i + 1))}</div>`;
}

export function page(p: P, title: string, body: string, status = 200) {
  send(p.res, status, layout(title, takeFlash(p) + body, { user: p.user }), 'text/html; charset=utf-8', p.out.length ? { 'set-cookie': p.out } : {});
}
export function go(p: P, location: string) {
  p.res.writeHead(303, { location, ...(p.out.length ? { 'set-cookie': p.out } : {}) });
  p.res.end();
}

/** Only same-site relative paths are allowed as a post-sign-in destination. */
export function safeNext(s: string | null | undefined, fallback = '/account') {
  return s && s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : fallback;
}
/** Returns the user, or redirects to /signin?next=<this page> and returns null. */
export function requireUser(p: P): User | null {
  if (p.user) return p.user;
  const here = p.req.method === 'GET' ? p.url.pathname + p.url.search : (p.req.headers.referer ? new URL(p.req.headers.referer, 'http://x').pathname : '/account');
  go(p, `/signin?next=${encodeURIComponent(safeNext(here))}`);
  return null;
}

export function setSession(p: P, token: string) {
  p.out.push(setCookie(SESSION_COOKIE, token, { maxAgeSec: config.sessionDays * 86400, secure }));
  p.ck[SESSION_COOKIE] = token;
}
export function clearSession(p: P) {
  p.out.push(setCookie(SESSION_COOKIE, '', { maxAgeSec: 0, secure }));
  delete p.ck[SESSION_COOKIE];
}

/** Signed cookie values: base64url(JSON).hmac */
export function signValue(v: unknown) { const b = Buffer.from(JSON.stringify(v)).toString('base64url'); return `${b}.${hmac('v:' + b)}`; }
export function unsignValue<T>(s: string | undefined): T | null {
  if (!s) return null;
  const i = s.lastIndexOf('.');
  if (i < 0 || !sameText(hmac('v:' + s.slice(0, i)), s.slice(i + 1))) return null;
  try { return JSON.parse(Buffer.from(s.slice(0, i), 'base64url').toString()) as T; } catch { return null; }
}

/** Runs a form action; a UserError becomes a flash message and a redirect back. */
export async function attempt(p: P, back: string, fn: () => Promise<string | void>) {
  try {
    const to = await fn();
    if (!p.res.headersSent) go(p, to ?? back);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    flash(p, e.message, 'error');
    go(p, back);
  }
}

export const opt = (v: string, label: string, sel: unknown) => `<option value="${esc(v)}"${String(sel ?? '') === v ? ' selected' : ''}>${esc(label)}</option>`;
export const errMsg = (e: unknown) => e instanceof UserError ? e.message : 'Something went wrong';
