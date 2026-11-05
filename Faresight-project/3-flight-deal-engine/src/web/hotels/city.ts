// /hotels/:city — hotels in a city with their normal and cheapest recent per-night price, a price calendar and live deals.
import { money } from '../../engine/notify.ts';
import { esc, hotelDealCard } from '../html.ts';
import { page, type P } from '../pages/common.ts';
import { monthCalendar, monthName } from './calendar.ts';
import { listHotelDeals, median } from './data.ts';

export async function cityPage(p: P, code: string): Promise<boolean> {
  const [c] = await p.db.query(`SELECT * FROM hotel_cities WHERE code = $1`, [code]);
  if (!c) return false;
  const hotels = await p.db.query(`
    SELECT h.id, h.name, h.stars, h.rating, h.reviews, h.area,
      (SELECT n.median_per_night FROM hotel_norms n WHERE n.hotel_id = h.id
        ORDER BY (n.month < date_trunc('month', current_date)::date), n.month LIMIT 1) AS normal,
      (SELECT min(x.per_night) FROM hotel_prices x WHERE x.hotel_id = h.id AND x.observed_at > now() - interval '14 days' AND x.checkin >= current_date) AS cheapest,
      (SELECT x.currency FROM hotel_prices x WHERE x.hotel_id = h.id ORDER BY x.observed_at DESC LIMIT 1) AS currency,
      (SELECT d.id FROM hotel_deals d WHERE d.hotel_id = h.id AND d.status = 'live' ORDER BY d.saving_pct DESC LIMIT 1) AS deal_id
    FROM hotels h WHERE h.city = $1 AND h.active
    ORDER BY (SELECT count(*) FROM hotel_deals d WHERE d.hotel_id = h.id AND d.status = 'live') DESC, h.rating DESC NULLS LAST, h.name LIMIT 100`, [code]);
  const cal = await p.db.query(`
    SELECT x.checkin::text AS checkin, percentile_cont(0.5) WITHIN GROUP (ORDER BY x.per_night) AS med, count(*)::int AS n, max(x.currency) AS currency
    FROM hotel_prices x JOIN hotels h ON h.id = x.hotel_id
    WHERE h.city = $1 AND x.kind = 'sweep' AND x.observed_at > now() - interval '14 days' AND x.checkin >= current_date
    GROUP BY x.checkin ORDER BY x.checkin`, [code]);
  const norms = await p.db.query(`SELECT to_char(n.month, 'YYYY-MM') AS ym, percentile_cont(0.5) WITHIN GROUP (ORDER BY n.median_per_night) AS normal
    FROM hotel_norms n JOIN hotels h ON h.id = n.hotel_id WHERE h.city = $1 GROUP BY 1`, [code]);
  const deals = await listHotelDeals(p.db, { city: code, limit: 24 });
  const cur = cal[0]?.currency ?? hotels.find(h => h.currency)?.currency ?? deals[0]?.currency ?? 'INR';

  const byMonth = new Map<string, Map<string, number>>();
  for (const x of cal) {
    const ym = x.checkin.slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, new Map());
    byMonth.get(ym)!.set(x.checkin, Number(x.med));
  }
  const overall = median(cal.map(x => Number(x.med)));
  const normalFor = (ym: string) => {
    const n = norms.find(r => r.ym === ym);
    return n ? Number(n.normal) : (median([...(byMonth.get(ym)?.values() ?? [])]) ?? overall);
  };
  const months = [...byMonth.keys()].slice(0, 10);
  const nights = Array.isArray(c.stay_nights) && c.stay_nights.length ? c.stay_nights[0] : 3;
  const samples = cal.reduce((a, b) => a + b.n, 0);

  const body = `<p class="meta"><a href="/hotels">Hotel deals</a> / ${esc(c.name)}</p>
    <h1>Hotels in ${esc(c.name)}</h1>
    <p class="lead">What a good hotel in ${esc(c.name)} normally costs a night, the cheapest check-in dates, and any live deals.${samples ? ` Based on ${samples.toLocaleString('en-IN')} room prices checked in the last 14 days.` : ''}</p>
    ${overall ? `<div><span class="stat"><b>${money(overall, cur)}</b>typical price a night</span></div>` : ''}
    <h2>Live hotel deals</h2>
    ${deals.length ? `<div class="grid">${deals.map(hotelDealCard).join('')}</div>` : `<p class="meta">No hotel deals in ${esc(c.name)} right now. New ones appear as soon as the scanner finds them.</p>`}
    <h2>Price calendar</h2>
    <p class="meta legend">Typical (median) price a night across the hotels we track, per check-in date, ${esc(nights)}-night stays, seen in the last 14 days.
      <span class="lv-deal"></span>deal level <span class="lv-low"></span>below normal <span class="lv-mid"></span>normal <span class="lv-high"></span>above normal</p>
    ${months.length ? `<div class="months">${months.map(ym => monthCalendar(ym, byMonth.get(ym)!, normalFor(ym), cur)).join('')}</div>`
      : `<p>We're still collecting prices for ${esc(c.name)}. Check back in a day or two.</p>`}
    <h2>Hotels we track</h2>
    ${hotels.length ? `<table><thead><tr><th>Hotel</th><th>Normally</th><th>Cheapest recent</th></tr></thead><tbody>
      ${hotels.map(h => `<tr><td>${h.deal_id ? `<a href="/hotel-deal/${esc(h.deal_id)}">${esc(h.name)}</a> <span class="tag save">deal</span>` : esc(h.name)}
        <div class="meta" style="margin:0">${[h.stars ? `<span class="stars">${'★'.repeat(Math.min(5, Number(h.stars) || 0))}</span>` : '', h.rating != null ? `${esc(Number(h.rating).toFixed(1))}/10` : '', esc(h.area ?? '')].filter(Boolean).join(' · ')}</div></td>
        <td>${h.normal != null ? money(h.normal, h.currency ?? cur) : '<span class="meta">not enough data</span>'}</td>
        <td>${h.cheapest != null ? money(h.cheapest, h.currency ?? cur) : '<span class="meta">—</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<p class="meta">No hotels tracked here yet.</p>'}
    <p class="meta">Prices are the cheapest room rate per night, taxes included where the booking site shows them. ${months.length ? `Showing ${esc(monthName(months[0]))} onwards.` : ''} The booking site shows the final price.</p>`;
  page(p, `Hotels in ${c.name}`, body);
  return true;
}
