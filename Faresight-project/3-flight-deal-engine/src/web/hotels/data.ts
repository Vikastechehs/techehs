// Hotel deal queries shared by the hotel pages, the admin page and the flight pages (hotel strip).
import type { Db, Row } from '../../db.ts';
import { esc, hotelDealCard } from '../html.ts';

/** One row per hotel deal with hotel and city details, and the upcoming dates that work. */
export const HOTEL_DEAL_SQL = `
  SELECT hd.*, h.name, h.stars, h.rating, h.reviews, h.area, h.city, h.image_url, h.lat, h.lng,
         c.name AS city_name, c.country,
         (SELECT count(*)::int FROM hotel_deal_dates WHERE hotel_deal_id = hd.id AND checkin >= current_date + 1) AS dates,
         (SELECT min(checkin)::text FROM hotel_deal_dates WHERE hotel_deal_id = hd.id AND checkin >= current_date + 1) AS first_date,
         (SELECT max(checkin)::text FROM hotel_deal_dates WHERE hotel_deal_id = hd.id AND checkin >= current_date + 1) AS last_date
  FROM hotel_deals hd JOIN hotels h ON h.id = hd.hotel_id JOIN hotel_cities c ON c.code = h.city`;

export interface HotelDealFilter { city?: string; minStars?: number; maxPerNight?: number; status?: 'live' | 'expired'; limit?: number }

export async function listHotelDeals(db: Db, f: HotelDealFilter = {}): Promise<Row[]> {
  const params: unknown[] = [f.status ?? 'live'];
  let where = `WHERE hd.status = $1`;
  if (f.city) { params.push(f.city); where += ` AND h.city = $${params.length}`; }
  if (f.minStars) { params.push(f.minStars); where += ` AND coalesce(h.stars, 0) >= $${params.length}`; }
  if (f.maxPerNight) { params.push(f.maxPerNight); where += ` AND hd.per_night <= $${params.length}`; }
  params.push(Math.min(Math.max(f.limit ?? 120, 1), 500));
  const order = f.status === 'expired' ? 'hd.expired_at DESC NULLS LAST, hd.id DESC' : 'hd.saving_pct DESC, hd.id';
  return db.query(`${HOTEL_DEAL_SQL} ${where} ORDER BY ${order} LIMIT $${params.length}`, params);
}

export async function getHotelDeal(db: Db, id: number): Promise<Row | undefined> {
  if (!Number.isSafeInteger(id)) return undefined;
  const [d] = await db.query(`${HOTEL_DEAL_SQL} WHERE hd.id = $1`, [id]);
  return d;
}

/** "Hotel deals in <city>" strip for the flight deal page; empty string when there are none. */
export async function hotelStrip(db: Db, cityCode: string, cityName: string): Promise<string> {
  const deals = await listHotelDeals(db, { city: cityCode, limit: 3 });
  if (!deals.length) return '';
  return `<h2>Hotel deals in ${esc(cityName)}</h2><div class="grid">${deals.map(hotelDealCard).join('')}</div>
    <p><a href="/hotels/${esc(cityCode)}">All hotels in ${esc(cityName)}</a></p>`;
}

export async function hotelCities(db: Db): Promise<Row[]> {
  return db.query(`SELECT c.code, c.name, c.country,
      (SELECT count(*)::int FROM hotel_deals hd JOIN hotels h ON h.id = hd.hotel_id WHERE h.city = c.code AND hd.status = 'live') AS live
    FROM hotel_cities c WHERE c.active ORDER BY c.priority DESC, c.name`);
}

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
