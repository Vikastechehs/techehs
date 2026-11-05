// Route pages with a price calendar, and "Explore from your airport".
import { money } from '../../engine/notify.ts';
import { esc, fmtDate, ago } from '../html.ts';
import { opt, page, type P } from './common.ts';
import { origins, regionOf, REGION_NAMES } from './data.ts';

const RECENT = `kind = 'sweep' AND observed_at > now() - interval '14 days' AND depart >= current_date AND price IS NOT NULL`;
const bandOf = (nights: number) => nights <= 5 ? 'short' : nights <= 9 ? 'mid' : 'long';
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const monthName = (ym: string) => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** ₹19.6k style label for small calendar cells. */
function short(n: number, cur: string) {
  const sym = money(0, cur).replace(/[\d.,\s]/g, '');
  return n >= 1000 ? `${sym}${(n / 1000).toFixed(n < 100000 ? 1 : 0)}k` : money(n, cur);
}
/** Cell colour relative to the normal price for that month. */
export function level(price: number, normal: number | null) {
  if (!normal) return 'lv-mid';
  const r = price / normal;
  return r <= 0.75 ? 'lv-deal' : r <= 0.92 ? 'lv-low' : r <= 1.08 ? 'lv-mid' : 'lv-high';
}

function calendar(ym: string, prices: Map<string, number>, normal: number | null, currency: string) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;                     // Monday first
  const cells: string[] = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<div class="hd">${d}</div>`);
  for (let i = 0; i < lead; i++) cells.push('<div></div>');
  for (let d = 1; d <= days; d++) {
    const iso = `${ym}-${String(d).padStart(2, '0')}`, pr = prices.get(iso);
    cells.push(pr == null ? `<div class="d">${d}</div>`
      : `<div class="d ${level(pr, normal)}" title="${esc(fmtDate(iso))}: ${esc(money(pr, currency))}">${d}<b>${esc(short(pr, currency))}</b></div>`);
  }
  return `<div class="cal"><h3>${esc(monthName(ym))}</h3><div class="meta" style="margin:0 0 6px">${normal ? `Normally ${money(normal, currency)}` : ''}</div><div class="wk">${cells.join('')}</div></div>`;
}

export async function handleExplore(p: P): Promise<boolean> {
  const path = p.url.pathname;
  if (p.req.method !== 'GET') return false;

  const rm = path.match(/^\/route\/([A-Za-z]{3})-([A-Za-z]{3})$/);
  if (rm) {
    const [o, d] = [rm[1].toUpperCase(), rm[2].toUpperCase()];
    if (rm[1] !== o || rm[2] !== d) { p.res.writeHead(301, { location: `/route/${o}-${d}` }); p.res.end(); return true; }
    const [r] = await p.db.query(`SELECT r.*, ao.city AS from_city, ad.city AS to_city, m.currency FROM routes r JOIN markets m ON m.code = r.market
      JOIN airports ao ON ao.iata = r.origin JOIN airports ad ON ad.iata = r.destination WHERE r.origin = $1 AND r.destination = $2 ORDER BY r.active DESC LIMIT 1`, [o, d]);
    if (!r) return false;
    const obs = await p.db.query(`SELECT depart::text AS depart, min(price) AS price, count(*)::int AS n FROM price_observations
      WHERE route_id = $1 AND ${RECENT} GROUP BY depart ORDER BY depart`, [r.id]);
    const norms = await p.db.query(`SELECT to_char(month, 'YYYY-MM') AS ym, trip_band, median_price FROM route_norms WHERE route_id = $1`, [r.id]);
    const band = bandOf(r.trip_lengths?.[0] ?? 7);
    const overall = median(obs.map(x => x.price));
    const normalFor = (ym: string) => {
      const rows = norms.filter(n => n.ym === ym);
      const own = rows.find(n => n.trip_band === band) ?? rows[0];
      return own ? own.median_price : (median(obs.filter(x => x.depart.startsWith(ym)).map(x => x.price)) ?? overall);
    };
    const byMonth = new Map<string, Map<string, number>>();
    for (const x of obs) {
      const ym = x.depart.slice(0, 7);
      if (!byMonth.has(ym)) byMonth.set(ym, new Map());
      byMonth.get(ym)!.set(x.depart, x.price);
    }
    const months = [...byMonth.keys()].slice(0, 10);
    const monthNorm = months.map(ym => ({ ym, n: normalFor(ym) })).filter(x => x.n != null) as { ym: string; n: number }[];
    const cheapM = [...monthNorm].sort((a, b) => a.n - b.n)[0], dearM = [...monthNorm].sort((a, b) => b.n - a.n)[0];
    const cheapest = obs.length ? obs.reduce((a, b) => (b.price < a.price ? b : a)) : null;
    const [deal] = await p.db.query(`SELECT d.*, (SELECT count(*)::int FROM deal_dates WHERE deal_id = d.id AND depart >= current_date + 1) AS pairs
      FROM deals d WHERE d.route_id = $1 AND d.status = 'live' ORDER BY d.saving_pct DESC LIMIT 1`, [r.id]);
    const past = await p.db.query(`SELECT id, price, saving_pct, currency, to_char(month, 'YYYY-MM') AS ym, published_at, expired_at FROM deals
      WHERE route_id = $1 AND status = 'expired' AND published_at IS NOT NULL ORDER BY expired_at DESC LIMIT 6`, [r.id]);
    const cur = r.currency;
    const stat = (label: string, v: string, sub = '') => `<span class="stat"><b>${v}</b>${esc(label)}${sub ? `<div class="meta" style="margin:0">${esc(sub)}</div>` : ''}</span>`;
    const title = `${r.from_city} to ${r.to_city} flights`;
    const body = `<p class="meta"><a href="/">Live deals</a> / <a href="/explore?from=${esc(o)}">From ${esc(r.from_city)}</a> / ${esc(r.from_city)} to ${esc(r.to_city)}</p>
      <h1>${esc(title)}</h1>
      <p class="lead">What a return ticket normally costs, the cheapest dates to fly, and any live deal on this route.${obs.length ? ` Based on ${obs.reduce((a, b) => a + b.n, 0).toLocaleString('en-IN')} fares checked in the last 14 days.` : ''}</p>
      <div>${overall ? stat('Normal return price', money(overall, cur), 'Middle of recent fares') : ''}${cheapM ? stat('Cheapest month', esc(monthName(cheapM.ym).split(' ')[0]), `Normally ${money(cheapM.n, cur)}`) : ''}${dearM && dearM !== cheapM ? stat('Priciest month', esc(monthName(dearM.ym).split(' ')[0]), `Normally ${money(dearM.n, cur)}`) : ''}${cheapest ? stat('Cheapest date seen', money(cheapest.price, cur), fmtDate(cheapest.depart)) : ''}</div>
      ${deal ? `<div class="panel" style="border-color:var(--good)"><h2>Live deal on this route</h2>
        <p><span class="price">${money(deal.price, deal.currency)}</span> return · <span class="save">${Math.round(deal.saving_pct)}% below normal</span></p>
        <p class="meta">${deal.pairs} date pair${deal.pairs === 1 ? "" : "s"} · ${r.max_stops === 0 ? 'nonstop' : 'up to 1 stop'} · checked ${ago(deal.last_verified)}</p><p><a class="btn" href="/deal/${deal.id}">See the dates</a></p></div>` : ''}
      <div class="row" style="margin:8px 0 16px"><a class="btn" href="/watch?origin=${esc(o)}&amp;destination=${esc(d)}">Watch this route</a><a class="btn secondary" href="/alerts">Get alerts from ${esc(r.from_city)}</a></div>
      <h2>Price calendar</h2>
      <p class="meta legend">Cheapest return fare per departure date, ${r.trip_lengths?.[0] ?? 7} nights, economy, seen in the last 14 days.
        <span class="lv-deal"></span>deal level <span class="lv-low"></span>below normal <span class="lv-mid"></span>normal <span class="lv-high"></span>above normal</p>
      ${months.length ? `<div class="months">${months.map(ym => calendar(ym, byMonth.get(ym)!, normalFor(ym), cur)).join('')}</div>`
        : '<p>We\'re still collecting prices for this route. Check back in a day or two.</p>'}
      ${past.length ? `<h2>Past deals on this route</h2><table><thead><tr><th>Travel</th><th>Price</th><th>Below normal</th><th>Lasted</th></tr></thead><tbody>
        ${past.map(x => `<tr><td>${esc(monthName(x.ym))}</td><td>${money(x.price, x.currency)}</td><td>${Math.round(x.saving_pct)}%</td><td>${lasted(x.published_at, x.expired_at)}</td></tr>`).join('')}</tbody></table>` : ''}
      <p class="meta">Prices are for 1 adult, economy, return, up to ${r.max_stops === 0 ? '0' : '1'} stop. They change all the time; the booking site shows the final price.</p>`;
    page(p, title, body);
    return true;
  }

  if (path === '/explore') {
    const os = await origins(p.db);
    const want = (p.url.searchParams.get('from') ?? '').toUpperCase();
    const from = os.find(x => x.origin === want)?.origin ?? (os.find(x => x.origin === p.user?.home_airport)?.origin) ?? os[0]?.origin ?? '';
    const budget = Number(p.url.searchParams.get('max')) || 0;
    const region = p.url.searchParams.get('region') ?? '';
    const rows = await p.db.query(`SELECT r.origin, r.destination, a.city, a.country, m.currency,
        (SELECT min(price) FROM price_observations o WHERE o.route_id = r.id AND ${RECENT}) AS cheapest,
        d.id AS deal_id, d.price AS deal_price, d.saving_pct
      FROM routes r JOIN airports a ON a.iata = r.destination JOIN markets m ON m.code = r.market
      LEFT JOIN LATERAL (SELECT id, price, saving_pct FROM deals WHERE route_id = r.id AND status = 'live' ORDER BY price LIMIT 1) d ON true
      WHERE r.active AND r.origin = $1`, [from]);
    const list = rows
      .map((x): Record<string, any> => ({ ...x, best: Math.min(x.cheapest ?? Infinity, x.deal_price ?? Infinity), region: regionOf(x.destination) }))
      .filter(x => (!region || x.region === region) && (!budget || x.best <= budget))
      .sort((a, b) => (a.deal_id ? 0 : 1) - (b.deal_id ? 0 : 1) || a.best - b.best);
    const city = os.find(x => x.origin === from)?.city ?? from;
    const body = `<h1>Explore from ${esc(city)}</h1><p class="lead">Where can you go, and for how much? Cheapest return fares we've seen in the last 14 days, and any live deals.</p>
      <form method="get" action="/explore" class="filters">
        <select name="from" aria-label="From">${os.map(x => opt(x.origin, `From ${x.city}`, from)).join('')}</select>
        <input type="number" name="max" min="0" step="1000" placeholder="Budget ₹ (any)" value="${budget || ''}" aria-label="Budget" style="width:150px">
        <select name="region" aria-label="Region"><option value="">Anywhere</option>${Object.entries(REGION_NAMES).map(([k, v]) => opt(k, v, region)).join('')}</select>
        <button class="btn">Show</button></form>
      ${list.length ? `<div class="grid">${list.map(x => `<a class="card" href="/route/${esc(x.origin)}-${esc(x.destination)}">
        <h2>${esc(x.city)}</h2><div class="meta" style="margin:0">${esc(REGION_NAMES[x.region ?? ''] ?? x.country)}</div>
        ${Number.isFinite(x.best) ? `<div class="price">${money(x.best, x.currency)}</div>` : '<div class="meta">No recent prices yet</div>'}
        ${x.deal_id ? `<div><span class="save">Live deal · ${Math.round(x.saving_pct)}% below normal</span></div>` : x.cheapest ? '<div class="norm">cheapest recent return</div>' : ''}</a>`).join('')}</div>`
        : `<p>Nothing ${budget ? `under ${money(budget, rows[0]?.currency ?? 'INR')} ` : ''}right now. Try a higher budget or another region.</p>`}`;
    page(p, `Explore from ${city}`, body);
    return true;
  }
  return false;
}

function lasted(a: string | null, b: string | null) {
  if (!a || !b) return '';
  const h = Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 36e5));
  return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
}
