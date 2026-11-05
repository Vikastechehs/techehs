// Daily digest: one message per daily channel grouping that channel's queued notifications. Runs once a day
// (after `hour` o'clock India time); the day of the last run is kept in settings.last_digest_date.
import type { Db } from '../db.ts';
import { dealSummary } from '../engine/notify.ts';
import { enqueue, type OutChannel } from './outbox.ts';
import { hotelDealSummary } from './hotels.ts';
import { renderDigest, type DigestKind } from './render.ts';

const TZ = 'Asia/Kolkata';
export const localDate = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const localHour = (now: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now)) % 24;

export interface DigestOptions { now?: Date; /** local hour (IST) from which the day's digest may go out; default 8 */ hour?: number }

/** Returns the number of digest messages queued (0 if today's digest already ran or it's too early). */
export async function sendDailyDigests(db: Db, opts: DigestOptions = {}): Promise<number> {
  const now = opts.now ?? new Date();
  if (localHour(now) < (opts.hour ?? 8)) return 0;
  const today = localDate(now);
  // Claim today's run atomically: only one caller gets a row back
  const claimed = await db.query(`INSERT INTO settings (key, value) VALUES ('last_digest_date', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE settings.value < EXCLUDED.value RETURNING key`, [today]);
  if (!claimed.length) return 0;

  // Queued notifications on daily channels that no outbox message carries yet
  const pending = await db.query(`
    SELECT n.id, n.kind, n.deal_id, n.hotel_deal_id, c.id AS channel_id, c.user_id, c.kind AS channel_kind, c.address
    FROM notifications n
    JOIN notification_channels c ON c.id = n.channel_id
    JOIN users u ON u.id = n.user_id
    WHERE n.status = 'queued' AND (
        (n.kind IN ('deal_live','route_watch','deal_ended') AND n.deal_id IS NOT NULL)
        OR (n.kind IN ('hotel_live','hotel_ended') AND n.hotel_deal_id IS NOT NULL))
      AND c.active AND c.frequency = 'daily' AND u.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.meta -> 'notification_ids' @> to_jsonb(n.id))
    ORDER BY c.id, n.id`);
  const byChannel = new Map<number, typeof pending>();
  for (const p of pending) byChannel.set(p.channel_id, [...(byChannel.get(p.channel_id) ?? []), p]);

  const deals = new Map<number, any>(), hotelDeals = new Map<number, any>();
  let queued = 0;
  for (const [channelId, rows] of byChannel) {
    const items: { kind: DigestKind; d: any }[] = [];
    const ids: number[] = []; const stale: number[] = [];
    for (const r of rows) {
      let d: any;
      if (r.deal_id != null) {
        if (!deals.has(r.deal_id)) deals.set(r.deal_id, await dealSummary(db, r.deal_id));
        d = deals.get(r.deal_id);
      } else {
        if (!hotelDeals.has(r.hotel_deal_id)) hotelDeals.set(r.hotel_deal_id, await hotelDealSummary(db, r.hotel_deal_id));
        d = hotelDeals.get(r.hotel_deal_id);
      }
      // A deal that ended before the digest isn't worth announcing
      const ended = r.kind === 'deal_ended' || r.kind === 'hotel_ended';
      if (!d || (!ended && d.status !== 'live')) { stale.push(Number(r.id)); continue; }
      items.push({ kind: r.kind, d }); ids.push(Number(r.id));
    }
    if (stale.length) await db.query(`UPDATE notifications SET status = 'skipped', error = 'deal ended before the digest' WHERE id = ANY($1::bigint[])`, [stale]);
    if (!items.length) continue;
    const first = rows[0];
    const [dg] = await db.query(`INSERT INTO notifications (user_id, channel_id, kind) VALUES ($1,$2,'digest') RETURNING id`, [first.user_id, channelId]);
    const ch = { id: channelId, user_id: first.user_id, kind: first.channel_kind as OutChannel };
    const msg = renderDigest(items, ch);
    await enqueue(db, { channel: ch.kind, to: first.address, subject: msg.subject, body: msg.body,
      meta: { ...msg.meta, notification_ids: [...ids, Number(dg.id)], channel_id: channelId, user_id: first.user_id, kind: 'digest' } });
    queued++;
  }
  return queued;
}
