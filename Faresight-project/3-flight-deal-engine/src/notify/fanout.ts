// Per-user fan-out: when a deal goes live (or ends), write one notifications row per matching user and channel,
// and queue the message in the outbox for instant channels. Daily channels wait for the digest (digest.ts).
// Only confirmed channels (verified_at set) get anything, "ended" messages included.
import type { Db } from '../db.ts';
import { dealSummary } from '../engine/notify.ts';
import { enqueue, type OutChannel } from './outbox.ts';
import { regionOf } from './regions.ts';
import { renderNotice, type NoticeKind } from './render.ts';

interface ChannelRow { id: number; user_id: number; kind: OutChannel; address: string; frequency: 'instant' | 'daily' }
/** userId -> what to send, and optionally which of the user's channels (null = all active channels). */
type Targets = Map<number, { kind: NoticeKind; channels: Set<number> | null }>;
export interface FanoutResult { users: number; instant: number; daily: number }

// An outbox row linked to notification n (meta.notification_ids contains n.id)
const HAS_OUTBOX = `EXISTS (SELECT 1 FROM outbox o WHERE o.meta -> 'notification_ids' @> to_jsonb(n.id))`;

async function fanOut(db: Db, d: any, targets: Targets): Promise<FanoutResult> {
  const res = { users: targets.size, instant: 0, daily: 0 };
  if (!targets.size) return res;
  const channels = await db.query<ChannelRow>(`
    SELECT c.id, c.user_id, c.kind, c.address, c.frequency FROM notification_channels c JOIN users u ON u.id = c.user_id
    WHERE c.user_id = ANY($1::int[]) AND c.active AND c.verified_at IS NOT NULL AND u.status = 'active' ORDER BY c.id`, [[...targets.keys()]]);
  for (const c of channels) {
    const t = targets.get(c.user_id)!;
    if (t.channels && !t.channels.has(c.id)) continue;
    // The unique index notifications_once makes this a no-op if the user already got this notice on this channel
    const [n] = await db.query(`INSERT INTO notifications (user_id, deal_id, channel_id, kind) VALUES ($1,$2,$3,$4)
      ON CONFLICT DO NOTHING RETURNING id`, [c.user_id, d.id, c.id, t.kind]);
    if (!n) continue;
    if (c.frequency === 'daily') { res.daily++; continue; }
    const id = Number(n.id);
    const msg = renderNotice(t.kind, d, c);
    await enqueue(db, { channel: c.kind, to: c.address, subject: msg.subject, body: msg.body,
      meta: { ...msg.meta, notification_id: id, notification_ids: [id], channel_id: c.id, user_id: c.user_id, deal_id: d.id, kind: t.kind } });
    res.instant++;
  }
  return res;
}

/** A deal just went live: alert subscribers (origin, saving, budget, region) and route watchers. */
export async function onDealLive(db: Db, dealId: number): Promise<FanoutResult> {
  const d = await dealSummary(db, dealId);
  if (!d || d.status !== 'live') return { users: 0, instant: 0, daily: 0 };
  const targets: Targets = new Map();
  const alerts = await db.query(`
    SELECT DISTINCT a.user_id FROM alert_subscriptions a JOIN users u ON u.id = a.user_id
    WHERE u.status = 'active' AND a.active AND a.origin = $1 AND $2::float8 >= a.min_saving_pct
      AND (a.max_price IS NULL OR $3::float8 <= a.max_price)
      AND (a.regions IS NULL OR cardinality(a.regions) = 0 OR $4::text = ANY(a.regions))`,
    [d.origin, d.saving_pct, d.price, regionOf(d.destination) ?? '']);
  for (const a of alerts) targets.set(a.user_id, { kind: 'deal_live', channels: null });
  // A watcher gets the route-watch message instead (one message per user, not two)
  const watches = await db.query(`
    SELECT DISTINCT w.user_id FROM route_watches w JOIN users u ON u.id = w.user_id
    WHERE u.status = 'active' AND w.route_id = $1 AND (w.max_price IS NULL OR $2::float8 <= w.max_price)`, [d.route_id, d.price]);
  for (const w of watches) targets.set(w.user_id, { kind: 'route_watch', channels: null });
  return fanOut(db, d, targets);
}

/**
 * A deal ended: tell the people who were told about it (on the channels they were told on) and everyone who saved it.
 * Messages about it that haven't gone out yet are cancelled.
 */
export async function onDealEnded(db: Db, dealId: number): Promise<FanoutResult> {
  const d = await dealSummary(db, dealId);
  if (!d || ['candidate', 'review', 'live'].includes(d.status)) return { users: 0, instant: 0, daily: 0 };
  // Don't announce a deal that is already over: cancel undelivered outbox messages and drop it from pending digests
  const cancelled = await db.query(`UPDATE outbox SET status = 'failed', error = 'deal ended before delivery'
    WHERE status = 'queued' AND meta ->> 'deal_id' = $1::text AND meta ->> 'kind' IN ('deal_live','route_watch') RETURNING id`, [dealId]);
  await db.query(`UPDATE notifications n SET status = 'skipped', error = 'deal ended before delivery'
    WHERE n.deal_id = $1 AND n.status = 'queued' AND n.kind IN ('deal_live','route_watch')
      AND (NOT ${HAS_OUTBOX} OR EXISTS (SELECT 1 FROM outbox o WHERE o.id = ANY($2::bigint[]) AND o.meta -> 'notification_ids' @> to_jsonb(n.id)))`,
    [dealId, cancelled.map(c => c.id)]);

  const targets: Targets = new Map();
  const told = await db.query(`SELECT user_id, channel_id FROM notifications
    WHERE deal_id = $1 AND kind IN ('deal_live','route_watch') AND status = 'sent' AND channel_id IS NOT NULL`, [dealId]);
  for (const r of told) {
    const t = targets.get(r.user_id) ?? { kind: 'deal_ended' as const, channels: new Set<number>() };
    t.channels!.add(r.channel_id);
    targets.set(r.user_id, t);
  }
  const saved = await db.query(`SELECT user_id FROM saved_deals WHERE deal_id = $1`, [dealId]);
  for (const s of saved) targets.set(s.user_id, { kind: 'deal_ended', channels: null });
  return fanOut(db, d, targets);
}
