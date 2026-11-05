// Per-user hotel deal notifications (owned by the user-data module). Same conventions as fanout.ts: one notifications
// row per user and channel (kind hotel_live / hotel_ended, hotel_deal_id set), instant channels get an outbox message
// whose meta carries notification_ids so deliverOutbox updates the rows; daily channels wait for the digest.
// Only confirmed channels (verified_at set) get anything, "ended" messages included.
import type { Db } from '../db.ts';
import { enqueue, type OutChannel } from './outbox.ts';
import { renderHotelNotice, type HotelNoticeKind } from './render.ts';

interface ChannelRow { id: number; user_id: number; kind: OutChannel; address: string; frequency: 'instant' | 'daily' }
type Targets = Map<number, { kind: HotelNoticeKind; channels: Set<number> | null }>;
export interface HotelFanoutResult { users: number; instant: number; daily: number }
const none = (): HotelFanoutResult => ({ users: 0, instant: 0, daily: 0 });

/** A hotel deal with its hotel, city and the stay dates still ahead (what the messages need). */
export async function hotelDealSummary(db: Db, hotelDealId: number) {
  const [d] = await db.query(`
    SELECT d.*, h.name AS hotel_name, h.stars, h.city, c.name AS city_name, c.region,
           (SELECT count(*)::int FROM hotel_deal_dates WHERE hotel_deal_id = d.id AND checkin >= current_date + 1) AS dates,
           (SELECT min(checkin)::text FROM hotel_deal_dates WHERE hotel_deal_id = d.id AND checkin >= current_date + 1) AS first_checkin,
           (SELECT max(checkin)::text FROM hotel_deal_dates WHERE hotel_deal_id = d.id) AS last_checkin
    FROM hotel_deals d JOIN hotels h ON h.id = d.hotel_id JOIN hotel_cities c ON c.code = h.city
    WHERE d.id = $1`, [hotelDealId]);
  return d;
}

async function fanOut(db: Db, d: any, targets: Targets): Promise<HotelFanoutResult> {
  const res = { users: targets.size, instant: 0, daily: 0 };
  if (!targets.size) return res;
  const channels = await db.query<ChannelRow>(`
    SELECT c.id, c.user_id, c.kind, c.address, c.frequency FROM notification_channels c JOIN users u ON u.id = c.user_id
    WHERE c.user_id = ANY($1::int[]) AND c.active AND c.verified_at IS NOT NULL AND u.status = 'active' ORDER BY c.id`, [[...targets.keys()]]);
  for (const c of channels) {
    const t = targets.get(c.user_id)!;
    if (t.channels && !t.channels.has(c.id)) continue;
    // notifications_once_v2 makes this a no-op if the user already got this notice on this channel
    const [n] = await db.query(`INSERT INTO notifications (user_id, hotel_deal_id, channel_id, kind) VALUES ($1,$2,$3,$4)
      ON CONFLICT DO NOTHING RETURNING id`, [c.user_id, d.id, c.id, t.kind]);
    if (!n) continue;
    if (c.frequency === 'daily') { res.daily++; continue; }
    const id = Number(n.id);
    const msg = renderHotelNotice(t.kind, d, c);
    await enqueue(db, { channel: c.kind, to: c.address, subject: msg.subject, body: msg.body,
      meta: { ...msg.meta, notification_id: id, notification_ids: [id], channel_id: c.id, user_id: c.user_id, hotel_deal_id: d.id, kind: t.kind } });
    res.instant++;
  }
  return res;
}

/** A hotel deal just went live: alert subscribers for its city (saving, price per night, stars). */
export async function onHotelDealLive(db: Db, hotelDealId: number): Promise<{ users: number; instant: number; daily: number }> {
  const d = await hotelDealSummary(db, hotelDealId);
  if (!d || d.status !== 'live') return none();
  const subs = await db.query(`
    SELECT DISTINCT a.user_id FROM hotel_alert_subscriptions a JOIN users u ON u.id = a.user_id
    WHERE u.status = 'active' AND a.active AND a.city = $1 AND $2::float8 >= a.min_saving_pct
      AND (a.max_per_night IS NULL OR $3::float8 <= a.max_per_night)
      AND (a.min_stars IS NULL OR coalesce($4::int, 0) >= a.min_stars)`,
    [d.city, d.saving_pct, d.per_night, d.stars ?? null]);
  const targets: Targets = new Map();
  for (const s of subs) targets.set(s.user_id, { kind: 'hotel_live', channels: null });
  return fanOut(db, d, targets);
}

/**
 * A hotel deal ended: tell the people who were told about it (on the channels they were told on) and everyone who
 * saved it. Messages about it that haven't gone out yet are cancelled.
 */
export async function onHotelDealEnded(db: Db, hotelDealId: number): Promise<{ users: number; instant: number; daily: number }> {
  const d = await hotelDealSummary(db, hotelDealId);
  if (!d || ['candidate', 'review', 'live'].includes(d.status)) return none();
  const cancelled = await db.query(`UPDATE outbox SET status = 'failed', error = 'deal ended before delivery'
    WHERE status = 'queued' AND meta ->> 'hotel_deal_id' = $1::text AND meta ->> 'kind' = 'hotel_live' RETURNING id`, [hotelDealId]);
  await db.query(`UPDATE notifications n SET status = 'skipped', error = 'deal ended before delivery'
    WHERE n.hotel_deal_id = $1 AND n.status = 'queued' AND n.kind = 'hotel_live'
      AND (NOT EXISTS (SELECT 1 FROM outbox o WHERE o.meta -> 'notification_ids' @> to_jsonb(n.id))
           OR EXISTS (SELECT 1 FROM outbox o WHERE o.id = ANY($2::bigint[]) AND o.meta -> 'notification_ids' @> to_jsonb(n.id)))`,
    [hotelDealId, cancelled.map(c => c.id)]);

  const targets: Targets = new Map();
  const told = await db.query(`SELECT user_id, channel_id FROM notifications
    WHERE hotel_deal_id = $1 AND kind = 'hotel_live' AND status = 'sent' AND channel_id IS NOT NULL`, [hotelDealId]);
  for (const r of told) {
    const t = targets.get(r.user_id) ?? { kind: 'hotel_ended' as const, channels: new Set<number>() };
    t.channels!.add(r.channel_id);
    targets.set(r.user_id, t);
  }
  const saved = await db.query(`SELECT s.user_id FROM saved_hotel_deals s JOIN users u ON u.id = s.user_id WHERE s.hotel_deal_id = $1 AND u.status = 'active'`, [hotelDealId]);
  for (const s of saved) targets.set(s.user_id, { kind: 'hotel_ended', channels: null });
  return fanOut(db, d, targets);
}
