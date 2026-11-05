// Shared HTTP helpers for the website, the JSON API and the admin pages.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db.ts';
import type { Notify } from '../engine/deals.ts';

/** Everything a route handler needs. A handler returns true when it answered the request. */
export interface Ctx { db: Db; req: IncomingMessage; res: ServerResponse; url: URL; notify: Notify }
export type Handler = (ctx: Ctx) => Promise<boolean>;

export function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
}
export function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string | string[]> = {}) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', headers);
}
export function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(303, { location, ...headers }); res.end();
}

async function readBody(req: IncomingMessage, limit = 1e5) {
  let body = ''; for await (const c of req) { body += c; if (body.length > limit) throw new HttpError(413, 'Request too large'); }
  return body;
}
export async function readForm(req: IncomingMessage) { return new URLSearchParams(await readBody(req)); }
/** Reads a JSON body (or a form body) into a plain object. */
export async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const body = await readBody(req);
  if (!body) return {};
  if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(body));
  try { const v = JSON.parse(body); return v && typeof v === 'object' ? v : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function setCookie(name: string, value: string, opts: { maxAgeSec?: number; secure?: boolean } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${opts.maxAgeSec != null ? `; Max-Age=${opts.maxAgeSec}` : ''}${opts.secure ? '; Secure' : ''}`;
}
export const clientIp = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '';

/** Throw from a handler to answer with a status and message (JSON for /api, HTML otherwise). */
export class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
