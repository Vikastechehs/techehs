// Public hotel pages: live deals list, expired deals, deal page, save/unsave, booking redirect and the JSON API.
import { config } from '../../config.ts';
import { money } from '../../engine/notify.ts';
import { hotelBookingUrl, hotelPartnerName } from '../../hotels/links.ts';
import { saveHotelDeal, unsaveHotelDeal } from '../../users/service.ts';
import { ago, esc, fmtDate, hotelDealCard } from '../html.ts';
import { json } from '../http.ts';
import { attempt, csrfField, flash, opt, page, postForm, requireUser, type P } from '../pages/common.ts';
import { getHotelDeal, hotelCities, listHotelDeals } from './data.ts';

const monthYear = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const stars = (n: unknown) => n ? `<span class="stars" aria-label="${esc(n)} star">${'★'.repeat(Math.min(5, Math.max(0, Number(n) || 0)))}</span>` : '';
const notFound = (p: P) => page(p, 'Not found', '<h1>Not found</h1><p><a href="/hotels">See live hotel deals</a></p>', 404);


export async function listPage(p: P, expired: boolean) {
  const cities = await hotelCities(p.db);
  const q = p.url.searchParams;
  const city = (q.get('city') ?? '').toUpperCase();
  const minStars = Number(q.get('stars')) || 0;
  const maxNight = Number(q.get('max')) || 0;
  const deals = await listHotelDeals(p.db, { status: expired ? 'expired' : 'live', city: cities.some(c => c.code === city) ? city : undefined, minStars, maxPerNight: maxNight });
  const filters = `<form class="filters" method="get" action="${expired ? '/hotels/expired' : '/hotels'}">
    <select name="city" aria-label="City"><option value="">Any city</option>${cities.map(c => opt(c.code, `${c.name}${!expired && c.live ? ` (${c.live})` : ''}`, city)).join('')}</select>
    <select name="stars" aria-label="Hotel class"><option value="">Any stars</option>${[3, 4, 5].map(n => opt(String(n), `${n}+ stars`, minStars || '')).join('')}</select>
    <input type="number" name="max" min="0" step="500" placeholder="Max ₹ a night" value="${maxNight || ''}" aria-label="Max price a night" style="width:160px">
    <button class="btn">Show</button></form>`;
  const card = expired ? (d: any) => `<div class="card"><h2><a href="/hotel-deal/${esc(d.id)}">${esc(d.name)}</a></h2>
      <p class="hotel-area">${[stars(d.stars), esc([d.area, d.city_name].filter(Boolean).join(', '))].filter(Boolean).join(' · ')}</p>
      <div class="price">${money(d.per_night, d.currency)}<span class="meta"> / night</span></div>
      <div><span class="norm">normally ${money(d.normal_per_night, d.currency)}</span> · <span class="save">${Math.round(d.saving_pct)}% below</span></div>
      <p class="expired" style="margin:8px 0 0">Ended ${esc(ago(d.expired_at))}: ${esc(d.reason ?? 'the price went back up')}</p></div>` : hotelDealCard;
  const body = `<h1>${expired ? 'Expired hotel deals' : 'Hotel deals'}</h1>
    <p class="lead">${expired ? 'Hotel deals that have ended, with the reason. We keep them so you can see how prices move.'
      : 'Rated hotels at least 25% below their own normal price a night, bookable on 3 or more check-in dates. Every deal is re-checked every few hours.'}</p>
    ${filters}
    ${deals.length ? `<div class="grid">${deals.map(card).join('')}</div>` : `<p>${expired ? 'No expired hotel deals.' : 'No hotel deals match right now. New ones appear as soon as the scanner finds them.'}</p>`}
    ${cities.length ? `<h2>Browse by city</h2><div class="chips">${cities.map(c => `<a class="chip" href="/hotels/${esc(c.code)}">${esc(c.name)}</a>`).join('')}</div>` : ''}
    <p class="meta">${expired ? '<a href="/hotels">See live hotel deals</a>' : '<a href="/hotels/expired">Expired hotel deals</a>'}</p>`;
  page(p, expired ? 'Expired hotel deals' : 'Hotel deals', body);
}

async function flightsBox(p: P, code: string, cityName: string) {
  const home = p.user?.home_airport ?? '';
  const deals = await p.db.query(`SELECT d.id, d.price, d.currency, d.saving_pct, r.origin, ao.city AS from_city
    FROM deals d JOIN routes r ON r.id = d.route_id JOIN airports ao ON ao.iata = r.origin
    WHERE d.status = 'live' AND r.destination = $1 ORDER BY (r.origin = $2) DESC, d.saving_pct DESC LIMIT 4`, [code, home]);
  const routes = await p.db.query(`SELECT r.origin, a.city FROM routes r JOIN airports a ON a.iata = r.origin
    WHERE r.active AND r.destination = $1 ORDER BY (r.origin = $2) DESC, r.priority DESC, a.city LIMIT 4`, [code, home]);
  if (!deals.length && !routes.length) return '';
  return `<div class="panel"><h2>Flights to ${esc(cityName)}</h2>
    ${deals.length ? `<ul class="list">${deals.map(d => `<li><a href="/deal/${esc(d.id)}">${esc(d.from_city)} → ${esc(cityName)}</a> · <b>${money(d.price, d.currency)}</b> return · <span class="save">${Math.round(d.saving_pct)}% below</span></li>`).join('')}</ul>`
      : `<p class="meta">No flight deals to ${esc(cityName)} right now.</p>`}
    ${routes.length ? `<p class="row">${routes.map(r => `<a class="btn secondary" href="/route/${esc(r.origin)}-${esc(code)}">Fares from ${esc(r.city)}</a>`).join('')}</p>` : ''}</div>`;
}

export async function dealPage(p: P, id: number) {
  const d = await getHotelDeal(p.db, id);
  if (!d || !['live', 'expired'].includes(d.status)) return notFound(p);
  const dates = await p.db.query(`SELECT id, checkin::text AS checkin, nights, per_night, total, normal_per_night, provider, last_checked
    FROM hotel_deal_dates WHERE hotel_deal_id = $1 AND checkin >= current_date + 1 ORDER BY per_night, checkin LIMIT 60`, [id]);
  const best = dates[0];
  const live = d.status === 'live';
  let saved = false;
  if (p.user) saved = (await p.db.query(`SELECT 1 FROM saved_hotel_deals WHERE user_id = $1 AND hotel_deal_id = $2`, [p.user.id, id])).length > 0;
  const f = csrfField(p);
  const window = d.first_date ? (monthYear(d.first_date) === monthYear(d.last_date) ? monthYear(d.first_date) : `${monthYear(d.first_date)} – ${monthYear(d.last_date)}`) : '';
  const status = live ? '' : `<p class="expired">This deal has ended (${esc(d.reason ?? 'the price went back up')}). <a href="/hotels/${esc(d.city)}">See hotels in ${esc(d.city_name)}</a></p>`;
  const body = `${status}<p class="meta"><a href="/hotels">Hotel deals</a> / <a href="/hotels/${esc(d.city)}">${esc(d.city_name)}</a></p>
    <h1>${esc(d.name)}</h1>
    <p class="lead">${[stars(d.stars), d.rating != null ? `rated ${esc(Number(d.rating).toFixed(1))}/10${d.reviews ? ` (${esc(Number(d.reviews).toLocaleString('en-IN'))} reviews)` : ''}` : '', esc([d.area, d.city_name].filter(Boolean).join(', '))].filter(Boolean).join(' · ')} · verified ${ago(d.last_verified)}</p>
    ${d.image_url && /^https:\/\//.test(d.image_url) ? `<p><img class="hotel-img" src="${esc(d.image_url)}" alt="${esc(d.name)}" loading="lazy" referrerpolicy="no-referrer"></p>` : ''}
    <p><span class="price">${money(d.per_night, d.currency)}</span> a night · <span class="norm">normally ${money(d.normal_per_night, d.currency)}</span> · <span class="save">${Math.round(d.saving_pct)}% below</span></p>
    ${best ? `<p>Cheapest stay: <b>${best.nights} night${best.nights === 1 ? '' : 's'} from ${esc(fmtDate(best.checkin))}</b> — ${money(best.per_night, d.currency)} a night, <b>${money(best.total, d.currency)}</b> in total.</p>` : ''}
    <div class="row" style="margin:8px 0 16px">
      ${saved ? `<form method="post" action="/hotel-deal/${esc(id)}/unsave">${f}<button class="btn secondary">Saved · Remove</button></form>`
        : `<form method="post" action="/hotel-deal/${esc(id)}/save">${f}<button class="btn secondary">Save deal</button></form>`}
      <a class="btn secondary" href="/hotels/${esc(d.city)}">Price calendar for ${esc(d.city_name)}</a></div>
    <h2>Dates that work</h2>
    ${dates.length ? `<table><thead><tr><th>Check in</th><th>Nights</th><th>A night</th><th>Total</th><th></th></tr></thead><tbody>
      ${dates.map(x => `<tr><td>${esc(fmtDate(x.checkin))}<div class="meta" style="margin:0">out ${esc(fmtDate(addDays(x.checkin, x.nights)))}</div></td><td>${esc(x.nights)}</td>
        <td>${money(x.per_night, d.currency)}${x.provider ? `<div class="meta" style="margin:0">${esc(x.provider)}</div>` : ''}</td><td>${money(x.total, d.currency)}</td>
        <td>${live ? `<a class="btn" rel="nofollow" href="/go/h/${esc(x.id)}?ch=web">Book</a>` : ''}</td></tr>`).join('')}
      </tbody></table>` : '<p class="meta">No upcoming dates left for this deal.</p>'}
    <p class="meta">${window ? `Check-in ${esc(window)}. ` : ''}Cheapest room rate found for each stay, checked ${ago(d.last_verified)}. "Normally" is this hotel's median price a night for that month. The booking site shows the final price.</p>
    ${await flightsBox(p, d.city, d.city_name)}`;
  page(p, `${d.name}, ${d.city_name} from ${money(d.per_night, d.currency)} a night`, body);
}

export async function saveAction(p: P, id: number, action: 'save' | 'unsave') {
  const user = requireUser(p); if (!user) return;
  const d = await getHotelDeal(p.db, id);
  if (!d || !['live', 'expired'].includes(d.status)) return notFound(p);
  if (p.req.method !== 'POST') {
    page(p, 'Save hotel deal', `<h1>${action === 'save' ? 'Save' : 'Remove'} ${esc(d.name)}?</h1><p class="lead">${money(d.per_night, d.currency)} a night in ${esc(d.city_name)}.</p>
      <form method="post" action="/hotel-deal/${esc(id)}/${action}">${csrfField(p)}<button class="btn">${action === 'save' ? 'Save deal' : 'Remove'}</button> <a href="/hotel-deal/${esc(id)}">Back to the deal</a></form>`);
    return;
  }
  await postForm(p);
  await attempt(p, `/hotel-deal/${id}`, async () => {
    await (action === 'save' ? saveHotelDeal : unsaveHotelDeal)(p.db, user.id, id);
    flash(p, action === 'save' ? 'Saved. Find it under Saved deals.' : 'Removed.');
    return `/hotel-deal/${id}`;
  });
}

export async function goBooking(p: P, dateId: number) {
  const [x] = Number.isSafeInteger(dateId) ? await p.db.query(`SELECT dd.id, dd.hotel_deal_id, dd.checkin::text AS checkin, dd.nights, h.name, c.name AS city_name
    FROM hotel_deal_dates dd JOIN hotel_deals hd ON hd.id = dd.hotel_deal_id JOIN hotels h ON h.id = hd.hotel_id JOIN hotel_cities c ON c.code = h.city
    WHERE dd.id = $1 AND hd.status IN ('live','expired')`, [dateId]) : [];
  if (!x) return notFound(p);
  const ch = (p.url.searchParams.get('ch') ?? 'web').slice(0, 32);
  await p.db.query(`INSERT INTO hotel_clicks (hotel_deal_id, hotel_deal_date_id, user_id, channel, partner) VALUES ($1,$2,$3,$4,$5)`,
    [x.hotel_deal_id, x.id, p.user?.id ?? null, ch, hotelPartnerName()]);
  p.res.writeHead(302, { location: hotelBookingUrl(x.name, x.city_name, x.checkin, x.nights), 'cache-control': 'no-store' });
  p.res.end();
}

export async function apiDeals(p: P) {
  const city = (p.url.searchParams.get('city') ?? '').toUpperCase();
  const deals = await listHotelDeals(p.db, { city: /^[A-Z]{3}$/.test(city) ? city : undefined, limit: 200 });
  json(p.res, 200, deals.map(d => ({
    id: d.id, hotel: d.name, city: d.city, city_name: d.city_name, area: d.area, stars: d.stars, rating: d.rating,
    per_night: d.per_night, normal_per_night: d.normal_per_night, saving_pct: d.saving_pct, currency: d.currency,
    dates: d.dates, first_checkin: d.first_date, last_checkin: d.last_date, last_verified: d.last_verified,
    url: `${config.publicUrl}/hotel-deal/${d.id}`,
  })));
}

