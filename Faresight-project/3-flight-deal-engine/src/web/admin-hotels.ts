// /admin/hotels (owned by the hotel website module). Called only after the admin login check.
// Counts, the hotel deal review queue (Publish / Reject), recent decisions and the hotel search queue.
import { config } from '../config.ts';
import { money } from '../engine/notify.ts';
import { reviewHotelDeal } from '../hotels/deals.ts';
import { onHotelDealLive } from '../notify/hotels.ts';
import { ago, esc, layout } from './html.ts';
import { redirect, send, type Handler } from './http.ts';
import { HOTEL_DEAL_SQL } from './hotels/data.ts';

const stat = (label: string, v: unknown) => `<span class="stat"><b>${esc(typeof v === 'number' ? v.toLocaleString('en-IN') : v)}</b>${esc(label)}</span>`;
const table = (head: string[], rows: string[], empty = 'None.') => rows.length
  ? `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
  : `<p class="meta">${esc(empty)}</p>`;

export const handleAdminHotels: Handler = async ({ db, req, res, url }) => {
  const path = url.pathname;
  const act = path.match(/^\/admin\/hotels\/deal\/(\d{1,9})\/(approve|reject)$/);
  if (act) {
    if (req.method !== 'POST') { send(res, 405, 'Use POST', 'text/plain', { allow: 'POST' }); return true; }
    // Approving tells users with matching hotel alerts (the user-data module's fan-out).
    await reviewHotelDeal(db, Number(act[1]), act[2] === 'approve', async id => { await onHotelDealLive(db, id); });
    redirect(res, '/admin/hotels');
    return true;
  }
  const pv = path.match(/^\/admin\/hotels\/preview\/(\d{1,9})$/);
  if (pv && req.method === 'GET') {
    const [d] = await db.query(`${HOTEL_DEAL_SQL} WHERE hd.id = $1`, [Number(pv[1])]);
    if (!d) { send(res, 404, layout('Not found', '<h1>Not found</h1><p><a href="/admin/hotels">Hotels admin</a></p>', { admin: true })); return true; }
    const dates = await db.query(`SELECT checkin::text AS checkin, nights, per_night, total, normal_per_night, provider, last_checked
      FROM hotel_deal_dates WHERE hotel_deal_id = $1 ORDER BY checkin, nights`, [d.id]);
    const body = `<p class="meta"><a href="/admin/hotels">← Hotels admin</a></p><h1>${esc(d.name)}</h1>
      <p class="lead">${esc(d.city_name)} · ${esc(d.area ?? '')} · ${d.stars ? `${esc(d.stars)}★` : 'no class'} · ${d.rating != null ? `${esc(Number(d.rating).toFixed(1))}/10` : 'no rating'} · status <b>${esc(d.status)}</b></p>
      <p><span class="price">${money(d.per_night, d.currency)}</span> a night · normally ${money(d.normal_per_night, d.currency)} · ${Math.round(d.saving_pct)}% below</p>
      ${d.status === 'review' ? `<p><form method="post" action="/admin/hotels/deal/${esc(d.id)}/approve" style="display:inline"><button class="btn">Publish</button></form>
        <form method="post" action="/admin/hotels/deal/${esc(d.id)}/reject" style="display:inline"><button class="btn secondary">Reject</button></form></p>` : ''}
      ${table(['Check in', 'Nights', 'A night', 'Total', 'Normal', 'Provider', 'Checked'], dates.map(x => `<tr><td>${esc(x.checkin)}</td><td>${esc(x.nights)}</td>
        <td>${money(x.per_night, d.currency)}</td><td>${money(x.total, d.currency)}</td><td>${money(x.normal_per_night, d.currency)}</td><td>${esc(x.provider ?? '')}</td><td>${esc(ago(x.last_checked))}</td></tr>`), 'No dates.')}`;
    send(res, 200, layout(`Review ${d.name}`, body, { admin: true }));
    return true;
  }
  if (path !== '/admin/hotels' || req.method !== 'GET') return false;

  const [c] = await db.query(`SELECT
      (SELECT count(*)::int FROM hotel_cities WHERE active) AS cities,
      (SELECT count(*)::int FROM hotels WHERE active) AS hotels,
      (SELECT count(*)::int FROM hotel_prices WHERE observed_at > now() - interval '24 hours') AS prices_day,
      (SELECT count(*)::int FROM hotel_prices) AS prices,
      (SELECT count(*)::int FROM hotel_clicks WHERE clicked_at > now() - interval '24 hours') AS clicks_day,
      (SELECT coalesce(sum(credits), 0)::int FROM hotel_search_jobs WHERE created_at >= date_trunc('month', now())) AS credits`);
  const byStatus = Object.fromEntries((await db.query(`SELECT status, count(*)::int AS n FROM hotel_deals GROUP BY status`)).map(r => [r.status, r.n]));
  const n = (s: string) => byStatus[s] ?? 0;
  const review = await db.query(`${HOTEL_DEAL_SQL} WHERE hd.status = 'review' ORDER BY hd.saving_pct DESC, hd.id`);
  const recent = await db.query(`${HOTEL_DEAL_SQL} WHERE hd.status IN ('live','expired','rejected')
    ORDER BY coalesce(hd.expired_at, hd.published_at, hd.first_seen) DESC, hd.id DESC LIMIT 15`);
  const queue = await db.query(`SELECT kind, status, count(*)::int AS n, min(run_at) FILTER (WHERE status = 'queued') AS next_run
    FROM hotel_search_jobs GROUP BY kind, status ORDER BY kind, status`);
  const failed = await db.query(`SELECT kind, city, checkin::text AS checkin, nights, attempts, error, finished_at FROM hotel_search_jobs
    WHERE status = 'failed' ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 5`);

  const body = `<h1>Hotels</h1>
    <p class="meta"><a href="/admin">← Admin</a> · <a href="/hotels">Public hotel deals</a> · <a href="/hotels/expired">Expired</a></p>
    <div>${stat('cities', c.cities)}${stat('hotels', c.hotels)}${stat('prices stored', c.prices)}${stat('prices last 24 h', c.prices_day)}${stat('booking clicks, 24 h', c.clicks_day)}${stat('credits this month', c.credits)}</div>
    <div>${stat('live deals', n('live'))}${stat('waiting for review', n('review'))}${stat('in deep check', n('candidate'))}${stat('expired', n('expired'))}${stat('rejected', n('rejected'))}</div>
    <p class="meta">Hotel source: <b>${esc(config.hotelSource)}</b>${config.hotelSource === 'mock' ? ' (simulated prices)' : ''} · hotels ${config.hotelsEnabled ? 'enabled' : '<b>disabled</b> (HOTELS_ENABLED=false)'}</p>
    <h2>Waiting for review (${review.length})</h2>
    ${table(['Hotel', 'A night', 'Normal', 'Below', 'Dates', ''], review.map(d => `<tr>
      <td><a href="/admin/hotels/preview/${esc(d.id)}">${esc(d.name)}</a><div class="meta" style="margin:0">${esc(d.city_name)} · ${d.stars ? `${esc(d.stars)}★` : 'no class'} · ${d.rating != null ? `${esc(Number(d.rating).toFixed(1))}/10` : 'no rating'}${d.reviews ? ` (${esc(d.reviews)})` : ''}</div></td>
      <td>${money(d.per_night, d.currency)}</td><td>${money(d.normal_per_night, d.currency)}</td><td>${Math.round(d.saving_pct)}%</td><td>${esc(d.dates)}</td>
      <td><form method="post" action="/admin/hotels/deal/${esc(d.id)}/approve" style="display:inline"><button class="btn">Publish</button></form>
          <form method="post" action="/admin/hotels/deal/${esc(d.id)}/reject" style="display:inline"><button class="btn secondary">Reject</button></form></td></tr>`), 'Nothing waiting.')}
    <h2>Recent decisions</h2>
    ${table(['Hotel', 'Status', 'A night', 'Below', 'Note'], recent.map(d => `<tr>
      <td>${d.status === 'rejected' ? esc(d.name) : `<a href="/hotel-deal/${esc(d.id)}">${esc(d.name)}</a>`}<div class="meta" style="margin:0">${esc(d.city_name)}</div></td>
      <td>${esc(d.status)}</td><td>${money(d.per_night, d.currency)}</td><td>${Math.round(d.saving_pct)}%</td>
      <td class="meta">${esc(d.reason ?? (d.status === 'live' ? `verified ${ago(d.last_verified)}` : ''))}</td></tr>`), 'No decisions yet.')}
    <h2>Hotel search queue</h2>
    ${table(['Kind', 'Status', 'Jobs', 'Next run'], queue.map(q => `<tr><td>${esc(q.kind)}</td><td>${esc(q.status)}</td><td>${esc(q.n)}</td><td class="meta">${q.next_run ? esc(new Date(q.next_run).toISOString().slice(0, 16).replace('T', ' ')) : ''}</td></tr>`), 'Queue is empty.')}
    ${failed.length ? `<h2>Recent failures</h2>${table(['Kind', 'City', 'Check in', 'Attempts', 'Error'], failed.map(f => `<tr><td>${esc(f.kind)}</td><td>${esc(f.city)}</td><td>${esc(f.checkin)} · ${esc(f.nights)}n</td><td>${esc(f.attempts)}</td><td class="meta">${esc(String(f.error ?? '').slice(0, 160))}</td></tr>`))}` : ''}
    <p class="meta">Hotel deal rules (hotel_*) are edited with the other rules on the <a href="/admin#settings">admin page</a>.</p>`;
  send(res, 200, layout('Hotels admin', body, { admin: true }));
  return true;
};
