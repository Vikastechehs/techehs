// Per-user Telegram: a "connect" deep link, the bot's /start handler, and a long-poll loop for updates.
import { config } from '../config.ts';
import type { Db } from '../db.ts';
import { telegramStartToken, verifyTelegramStartToken } from './unsubscribe.ts';

/** Link the account page shows: opening it in Telegram and pressing Start connects this chat to the user. */
export function telegramConnectLink(userId: number): string {
  return `https://t.me/${config.telegramBotUsername}?start=${telegramStartToken(userId)}`;
}

async function reply(f: typeof fetch, chatId: number | string, text: string) {
  if (!config.telegramToken) return;
  try {
    await f(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch { /* the reply is a courtesy; the channel is already saved */ }
}

export type TelegramUpdateResult = { action: 'connected'; userId: number; channelId: number } | { action: 'stopped'; channels: number } | { action: 'invalid' } | { action: 'ignored' };

/** Handles one update from getUpdates (or a webhook): "/start <token>" connects, "/stop" switches alerts off. */
export async function handleTelegramUpdate(db: Db, update: any, opts: { fetchImpl?: typeof fetch } = {}): Promise<TelegramUpdateResult> {
  const f = opts.fetchImpl ?? fetch;
  const msg = update?.message;
  const chatId = msg?.chat?.id;
  const text: string = typeof msg?.text === 'string' ? msg.text.trim() : '';
  if (chatId == null || !text.startsWith('/')) return { action: 'ignored' };

  if (/^\/stop\b/.test(text)) {
    const rows = await db.query(`UPDATE notification_channels SET active = false WHERE kind = 'telegram' AND address = $1 AND active RETURNING id`, [String(chatId)]);
    await reply(f, chatId, rows.length ? 'Alerts switched off. You can switch them back on from your account page.' : 'No alerts are connected to this chat.');
    return { action: 'stopped', channels: rows.length };
  }
  const m = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(text);
  if (!m) return { action: 'ignored' };
  const userId = m[1] ? verifyTelegramStartToken(m[1]) : null;
  const [user] = userId ? await db.query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [userId]) : [];
  if (!user) {
    await reply(f, chatId, `To get deal alerts here, open ${config.publicUrl}/account and tap "Connect Telegram". Links from there are valid for one day.`);
    return { action: 'invalid' };
  }
  const meta = { username: msg.from?.username ?? null, first_name: msg.from?.first_name ?? null, chat_type: msg.chat?.type ?? null };
  const [c] = await db.query(`
    INSERT INTO notification_channels (user_id, kind, address, meta, verified_at, active)
    VALUES ($1, 'telegram', $2, $3, now(), true)
    ON CONFLICT (user_id, kind, address) DO UPDATE SET active = true, verified_at = now(), meta = EXCLUDED.meta
    RETURNING id`, [user.id, String(chatId), JSON.stringify(meta)]);
  await reply(f, chatId, `Connected. You'll get ${config.siteName} deal alerts here. Send /stop to switch them off.`);
  return { action: 'connected', userId: user.id, channelId: c.id };
}

/** Long-polls getUpdates until `signal` aborts. Does nothing without TELEGRAM_BOT_TOKEN. */
export async function pollTelegram(db: Db, signal: AbortSignal, opts: { fetchImpl?: typeof fetch; log?: (m: string) => void } = {}): Promise<void> {
  if (!config.telegramToken) return;
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  let offset = 0;
  const pause = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  while (!signal.aborted) {
    try {
      const res = await f(`https://api.telegram.org/bot${config.telegramToken}/getUpdates`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ offset, timeout: 50, allowed_updates: ['message'] }),
      });
      const data: any = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) { log(`telegram getUpdates: HTTP ${res.status} ${data?.description ?? ''}`); await pause(30_000); continue; }
      for (const u of data.result ?? []) {
        offset = Math.max(offset, Number(u.update_id) + 1);
        try { await handleTelegramUpdate(db, u, { fetchImpl: f }); } catch (e) { log(`telegram update: ${(e as Error).message}`); }
      }
    } catch (e) {
      if (signal.aborted) break;
      log(`telegram getUpdates: ${(e as Error).message}`); await pause(10_000);
    }
  }
}
