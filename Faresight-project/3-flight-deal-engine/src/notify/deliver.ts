// Outbox worker: sends queued messages by email (Resend), Telegram, WhatsApp (Meta Cloud API) or web push.
// A channel without a provider configured is marked 'logged' so everything works in development.
//
// Claiming: rows are picked with FOR UPDATE SKIP LOCKED and leased by setting sent_at to a future time while still
// 'queued' (no other status exists for "in flight"); a queued row is only picked once sent_at is null or past.
// The same lease doubles as the retry back-off. sent_at is set to the real send time once delivered.
import { config } from '../config.ts';
import type { Db, Row } from '../db.ts';
import { buildTextPayload, lastInbound, metaError, templateFor, withinWindow } from './whatsapp.ts';

export const MAX_ATTEMPTS = 5;

export type SendResult =
  | { ok: true; logged?: boolean }
  | { ok: false; error: string; permanent?: boolean; deactivate?: boolean };

/** Sends one web push; resolves on success, rejects with an error carrying statusCode (like web-push's WebPushError). */
export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<unknown>;

export interface DeliverOptions {
  limit?: number;
  fetchImpl?: typeof fetch;
  pushImpl?: PushSender;
  /** Seconds before a failed message is tried again (default 60 x attempts). */
  retryDelaySec?: number;
  log?: (m: string) => void;
}
export interface DeliverResult { sent: number; logged: number; retried: number; failed: number }

async function webPushSender(): Promise<PushSender> {
  const webpush = (await import('web-push')).default;
  return (sub, payload) => webpush.sendNotification(sub, payload, {
    TTL: 24 * 3600,
    vapidDetails: { subject: config.vapidSubject, publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey },
  });
}

async function httpResult(res: Response, what: string): Promise<SendResult> {
  if (res.ok) return { ok: true };
  const text = (await res.text().catch(() => '')).slice(0, 200);
  return { ok: false, error: `${what}: HTTP ${res.status} ${text}`.trim() };
}

/**
 * WhatsApp: sign-in/verification codes always use the authentication template. Other messages go as free text when the
 * person wrote to us in the last 24 hours, otherwise as the approved template for their kind (see whatsapp.ts).
 * The returned message id is kept in outbox.meta.wamid so status webhooks can find the row.
 */
async function sendWhatsApp(db: Db, m: Row, f: typeof fetch): Promise<SendResult> {
  const meta = m.meta ?? {};
  const post = async (payload: unknown, mode: 'text' | 'template'): Promise<SendResult & { code?: number }> => {
    const res = await f(`https://graph.facebook.com/v21.0/${config.whatsappPhoneId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.whatsappToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => '');
    let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.ok) {
      const wamid = body?.messages?.[0]?.id;
      await db.query(`UPDATE outbox SET meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('wa_mode', $2::text, 'wamid', $3::text) WHERE id = $1`,
        [m.id, mode, wamid ?? null]);
      return { ok: true };
    }
    const e = body ? metaError(res.status, body) : { code: 0, message: `whatsapp: HTTP ${res.status} ${text.slice(0, 200)}`.trim(), permanent: res.status >= 400 && res.status < 500 && res.status !== 429 };
    return { ok: false, error: e.message, permanent: e.permanent, code: e.code };
  };
  const template = async (): Promise<SendResult> => {
    const t = await templateFor(db, m);
    if ('error' in t) return { ok: false, error: t.error, permanent: true };
    const { code: _code, ...r } = await post(t.payload, 'template');
    return r;
  };
  if (meta.template === 'code') return template();
  if (!withinWindow(await lastInbound(db, m))) return template();
  const r = await post(buildTextPayload(m.to_address, m.body), 'text');
  // Our record of the window was stale (Meta says it closed): fall back to the template right away
  if (!r.ok && r.code === 131047 && meta.kind) return template();
  const { code: _code, ...rest } = r;
  return rest;
}

async function send(db: Db, m: Row, o: DeliverOptions): Promise<SendResult> {
  const f = o.fetchImpl ?? fetch;
  const meta = m.meta ?? {};
  switch (m.channel) {
    case 'email': {
      if (!config.resendApiKey) return { ok: true, logged: true };
      const res = await f('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: config.emailFrom, to: [m.to_address], subject: m.subject ?? config.siteName, text: m.body,
          ...(meta.html ? { html: meta.html } : {}),
          ...(meta.unsubscribe_url ? { headers: { 'List-Unsubscribe': `<${meta.unsubscribe_url}>` } } : {}),
        }),
      });
      return httpResult(res, 'resend');
    }
    case 'telegram': {
      if (!config.telegramToken) return { ok: true, logged: true };
      const res = await f(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: m.to_address, text: m.body, disable_web_page_preview: true }),
      });
      const r = await httpResult(res, 'telegram');
      // 403: the user blocked the bot; 400 "chat not found": the chat is gone. Stop using this channel.
      if (!r.ok && (res.status === 403 || (res.status === 400 && /chat not found/i.test(r.error)))) return { ...r, permanent: true, deactivate: true };
      return r;
    }
    case 'whatsapp': {
      if (!config.whatsappToken || !config.whatsappPhoneId) return { ok: true, logged: true };
      return sendWhatsApp(db, m, f);
    }
    case 'push': {
      if (!o.pushImpl && (!config.vapidPublicKey || !config.vapidPrivateKey)) return { ok: true, logged: true };
      let keys = meta.keys;
      if (!keys && meta.channel_id) {
        const [c] = await db.query(`SELECT meta FROM notification_channels WHERE id = $1`, [meta.channel_id]);
        keys = c?.meta?.keys;
      }
      if (!keys?.p256dh || !keys?.auth) return { ok: false, error: 'push: subscription keys missing', permanent: true, deactivate: true };
      try {
        await (o.pushImpl ?? await webPushSender())({ endpoint: m.to_address, keys }, m.body);
        return { ok: true };
      } catch (e: any) {
        const code = Number(e?.statusCode);
        const error = `push: ${code ? `HTTP ${code} ` : ''}${String(e?.body || e?.message || e).slice(0, 200)}`.trim();
        if (code === 404 || code === 410) return { ok: false, error, permanent: true, deactivate: true };
        return { ok: false, error };
      }
    }
    default:
      return { ok: false, error: `unknown channel ${m.channel}`, permanent: true };
  }
}

/** Is the channel this message was rendered for still wanted? (The user may have unsubscribed since.) */
async function stillWanted(db: Db, meta: any) {
  if (!meta?.channel_id) return true;
  const [c] = await db.query(`SELECT c.active, u.status FROM notification_channels c JOIN users u ON u.id = c.user_id WHERE c.id = $1`, [meta.channel_id]);
  return !!c && c.active && c.status === 'active';
}

const notificationIds = (meta: any): number[] =>
  Array.isArray(meta?.notification_ids) ? meta.notification_ids.map(Number) : meta?.notification_id ? [Number(meta.notification_id)] : [];

/** Delivers up to `limit` queued outbox messages. Safe to run from several processes at once. */
export async function deliverOutbox(db: Db, opts: DeliverOptions = {}): Promise<DeliverResult> {
  const out: DeliverResult = { sent: 0, logged: 0, retried: 0, failed: 0 };
  const rows = await db.query(`
    UPDATE outbox SET attempts = attempts + 1, sent_at = now() + interval '5 minutes'
    WHERE id IN (SELECT id FROM outbox WHERE status = 'queued' AND (sent_at IS NULL OR sent_at <= now())
                 ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING *`, [opts.limit ?? 50]);
  for (const m of rows) {
    const nids = notificationIds(m.meta);
    if (!(await stillWanted(db, m.meta))) {
      await db.query(`UPDATE outbox SET status = 'failed', error = 'channel switched off', sent_at = NULL WHERE id = $1`, [m.id]);
      if (nids.length) await db.query(`UPDATE notifications SET status = 'skipped', error = 'channel switched off' WHERE id = ANY($1::bigint[])`, [nids]);
      out.failed++;
      continue;
    }
    let r: SendResult;
    try { r = await send(db, m, opts); } catch (e) { r = { ok: false, error: `${m.channel}: ${(e as Error).message}` }; }

    if (r.ok) {
      await db.query(`UPDATE outbox SET status = $2, sent_at = now(), error = NULL WHERE id = $1`, [m.id, r.logged ? 'logged' : 'sent']);
      if (nids.length) await db.query(`UPDATE notifications SET status = 'sent', sent_at = now(), attempts = $2, error = $3 WHERE id = ANY($1::bigint[])`,
        [nids, m.attempts, r.logged ? 'logged only: no provider configured' : null]);
      if (r.logged) { out.logged++; opts.log?.(`outbox ${m.id} (${m.channel} to ${m.to_address}) logged: no provider configured`); }
      else out.sent++;
      continue;
    }
    const final = r.permanent || m.attempts >= MAX_ATTEMPTS;
    const delay = opts.retryDelaySec ?? 60 * m.attempts;
    await db.query(`UPDATE outbox SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'queued' THEN now() + make_interval(secs => $4) END WHERE id = $1`,
      [m.id, final ? 'failed' : 'queued', r.error, delay]);
    if (nids.length) await db.query(`UPDATE notifications SET status = $2, attempts = $3, error = $4 WHERE id = ANY($1::bigint[])`,
      [nids, final ? 'failed' : 'queued', m.attempts, r.error]);
    if (r.deactivate && m.meta?.channel_id) await db.query(`UPDATE notification_channels SET active = false WHERE id = $1`, [m.meta.channel_id]);
    else if (r.deactivate && m.channel === 'push') await db.query(`UPDATE notification_channels SET active = false WHERE kind = 'push' AND address = $1`, [m.to_address]);
    if (final) { out.failed++; opts.log?.(`outbox ${m.id} failed: ${r.error}`); } else out.retried++;
  }
  return out;
}
