// Incoming webhooks: /webhooks/whatsapp (owned by the WhatsApp module).
//
// GET  /webhooks/whatsapp  Meta's subscription check: echoes hub.challenge when hub.verify_token matches WHATSAPP_VERIFY_TOKEN.
// POST /webhooks/whatsapp  Messages and delivery statuses. The X-Hub-Signature-256 header (HMAC-SHA256 of the raw body
//                          with WHATSAPP_APP_SECRET) is checked when the secret is set. An inbound message opens the
//                          24-hour free-text window (last_inbound_at); STOP / UNSUBSCRIBE / BAND switches the person's
//                          WhatsApp channels off and START switches them back on. Failed statuses are recorded on the
//                          outbox row (found by meta.wamid).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config } from '../config.ts';
import type { Db } from '../db.ts';
import { send, type Handler } from './http.ts';

const STOP_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'BAND']);   // "band" = stop/close in Hindi
const START_WORDS = new Set(['START']);

async function readRaw(req: IncomingMessage, limit = 1e6): Promise<Buffer | null> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += b.length; if (size > limit) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** True when the header is `sha256=<hex HMAC-SHA256 of raw with secret>`. */
export function validSignature(raw: Buffer, header: unknown, secret: string): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header ?? ''));
  if (!m) return false;
  const want = createHmac('sha256', secret).update(raw).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const MATCH = `kind = 'whatsapp' AND regexp_replace(address, '\\D', '', 'g') = $1`;

/** The words of an inbound message: text body, quick-reply button text or interactive reply title. */
function messageText(msg: any): string {
  return String(msg?.text?.body ?? msg?.button?.text ?? msg?.button?.payload ?? msg?.interactive?.button_reply?.title
    ?? msg?.interactive?.list_reply?.title ?? '').trim();
}

/** Applies one webhook payload. Returns what it did (used by tests and logs). */
export async function handleWhatsAppEvent(db: Db, body: any): Promise<{ inbound: number; stopped: number; started: number; failed: number }> {
  const out = { inbound: 0, stopped: 0, started: 0, failed: 0 };
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value ?? {};
      for (const msg of Array.isArray(value.messages) ? value.messages : []) {
        const from = digits(msg?.from);
        if (!from) continue;
        out.inbound++;
        await db.query(`UPDATE notification_channels SET last_inbound_at = now() WHERE ${MATCH}`, [from]);
        const word = messageText(msg).toUpperCase().replace(/[^A-Z]/g, '');
        if (STOP_WORDS.has(word)) {
          const r = await db.query(`UPDATE notification_channels SET active = false WHERE ${MATCH} AND active RETURNING id`, [from]);
          out.stopped += r.length;
        } else if (START_WORDS.has(word)) {
          const r = await db.query(`UPDATE notification_channels SET active = true WHERE ${MATCH} AND NOT active RETURNING id`, [from]);
          out.started += r.length;
        }
      }
      for (const st of Array.isArray(value.statuses) ? value.statuses : []) {
        if (st?.status !== 'failed' || !st?.id) continue;
        const e = Array.isArray(st.errors) ? st.errors[0] : null;
        const error = `whatsapp: failed after sending${e?.code ? ` (error ${e.code})` : ''}${e?.title ? ` ${e.title}` : ''}${e?.error_data?.details ? `: ${e.error_data.details}` : ''}`.slice(0, 300);
        const rows = await db.query(`UPDATE outbox SET status = 'failed', error = $2 WHERE channel = 'whatsapp' AND meta ->> 'wamid' = $1 RETURNING meta`, [String(st.id), error]);
        for (const r of rows) {
          const ids = Array.isArray(r.meta?.notification_ids) ? r.meta.notification_ids.map(Number) : [];
          if (ids.length) await db.query(`UPDATE notifications SET status = 'failed', error = $2 WHERE id = ANY($1::bigint[])`, [ids, error]);
        }
        out.failed += rows.length;
      }
    }
  }
  return out;
}

export const handleWebhooks: Handler = async ({ db, req, res, url }) => {
  if (url.pathname !== '/webhooks/whatsapp') return false;
  if (req.method === 'GET') {
    const q = url.searchParams;
    if (q.get('hub.mode') === 'subscribe' && config.whatsappVerifyToken && q.get('hub.verify_token') === config.whatsappVerifyToken) {
      send(res, 200, q.get('hub.challenge') ?? '', 'text/plain; charset=utf-8');
    } else send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return true;
  }
  if (req.method !== 'POST') { send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8', { allow: 'GET, POST' }); return true; }
  const raw = await readRaw(req);
  if (!raw) { send(res, 413, 'Request too large', 'text/plain; charset=utf-8'); return true; }
  if (config.whatsappAppSecret && !validSignature(raw, req.headers['x-hub-signature-256'], config.whatsappAppSecret)) {
    send(res, 401, 'Bad signature', 'text/plain; charset=utf-8'); return true;
  }
  let body: any;
  try { body = JSON.parse(raw.toString('utf8')); } catch { send(res, 400, 'Invalid JSON', 'text/plain; charset=utf-8'); return true; }
  try { await handleWhatsAppEvent(db, body); }
  catch (e) { console.error(`whatsapp webhook: ${(e as Error).message}`); }   // still 200: Meta would otherwise retry for days
  send(res, 200, 'OK', 'text/plain; charset=utf-8');
  return true;
};
