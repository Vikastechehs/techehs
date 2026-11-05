// Scrape.do Google Hotels plugin (same Scrape.do account and SCRAPEDO_TOKEN as flights).
//
// UNVERIFIED: unlike the flights plugin (src/sources/scrapedo.ts, tested on ~5,000 searches), this endpoint,
// its parameter names and its response shape have NOT been checked against live Scrape.do. The request is built
// exactly like the flights one (same host, token param, currency/gl/hl, same error mapping). The parser is
// tolerant: it expects a SerpApi-style Google Hotels response ({ properties: [...] }) but also accepts
// hotels[]/results[], ratings out of 5 or 10 and prices as numbers or "₹3,200" strings.
// First real run: `node src/cli.ts hotels-once 5` (test-hotels.bat) saves the raw response to
// data/hotels-sample.json. If nothing parses, correct the constants below.
import { FatalSourceError, RetryableError } from '../../sources/types.ts';
import type { HotelOffer, HotelQuery, HotelResult, HotelSource } from '../contract.ts';

// ---- Request shape: correct here if the live plugin differs ------------------------------------------
const ENDPOINT = 'https://api.scrape.do/plugin/google/hotels';
const CREDITS_PER_SEARCH = 10;                // counted the same way as flights (assumed equal; unverified)
const PARAM = {
  query: 'q', checkin: 'check_in_date', checkout: 'check_out_date',
  currency: 'currency', gl: 'gl', hl: 'hl', adults: 'adults',
} as const;
const ADULTS = '2';
// --------------------------------------------------------------------------------------------------------

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

export function hotelRequestUrl(token: string, q: HotelQuery) {
  const params = new URLSearchParams({
    token,
    [PARAM.query]: q.query, [PARAM.checkin]: q.checkin, [PARAM.checkout]: addDays(q.checkin, q.nights),
    [PARAM.currency]: q.currency, [PARAM.gl]: q.gl, [PARAM.hl]: 'en', [PARAM.adults]: ADULTS,
  });
  return `${ENDPOINT}?${params}`;
}

export interface ScrapeDoHotelOptions {
  /** Called with every raw response body (hotels-once saves the first one to data/hotels-sample.json). */
  onRaw?: (body: string, q: HotelQuery) => void;
}

export function scrapeDoHotelSource(token: string, fetchImpl: typeof fetch = fetch, opts: ScrapeDoHotelOptions = {}): HotelSource {
  if (!token) throw new Error('SCRAPEDO_TOKEN is not set');
  return {
    name: 'scrapedo',
    async search(q: HotelQuery): Promise<HotelResult> {
      let res: Response;
      try {
        res = await fetchImpl(hotelRequestUrl(token, q), { signal: AbortSignal.timeout(90_000) });
      } catch (e) {
        throw new RetryableError(`network: ${(e as Error).message}`);
      }
      const text = await res.text();
      opts.onRaw?.(text, q);
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      if ([401, 402, 403].includes(res.status)) throw new FatalSourceError(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new Error(`not JSON: ${text.slice(0, 160)}`); }
      return parseGoogleHotels(data, q.nights, CREDITS_PER_SEARCH);
    },
  };
}

/** Number from 5100, "5100", "₹5,100" or "$1,234.50"; null when there's none. */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}
/** A price field that may be a number, a string, or an object like { extracted_lowest, lowest }. */
function price(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'object') return toNum(v.extracted_lowest) ?? toNum(v.lowest) ?? toNum(v.extracted_before_taxes_fees) ?? toNum(v.value) ?? toNum(v.amount);
  return toNum(v);
}

/** The list of hotels, wherever the response keeps it. */
function listOf(data: any): any[] {
  for (const k of ['properties', 'hotels', 'results']) if (Array.isArray(data?.[k])) return data[k];
  if (Array.isArray(data?.data?.properties)) return data.data.properties;
  return Array.isArray(data) ? data : [];
}

/** Google Hotels JSON -> offers. Ratings normalised to /10 (values <= 5 are treated as out of 5); per night = total / nights when a total is given. */
export function parseGoogleHotels(data: any, nights: number, credits = CREDITS_PER_SEARCH): HotelResult {
  const offers: HotelOffer[] = [];
  const seen = new Set<string>();
  for (const p of listOf(data)) {
    const name = p?.name ?? p?.title;
    if (!name || (p.type && !/hotel/i.test(String(p.type)))) continue;   // skip vacation rentals
    const perNightRaw = price(p.rate_per_night) ?? price(p.price_per_night) ?? price(p.price);
    const totalRaw = price(p.total_rate) ?? price(p.total_price);
    if ((perNightRaw == null || perNightRaw <= 0) && (totalRaw == null || totalRaw <= 0)) continue;   // no bookable rate
    const total = totalRaw ?? perNightRaw! * nights;
    const perNight = Math.round(totalRaw != null ? totalRaw / nights : perNightRaw!);
    const sourceId = String(p.property_token ?? p.hotel_id ?? p.id ?? `name:${name}`);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const stars = toNum(p.extracted_hotel_class) ?? toNum(p.hotel_class) ?? toNum(p.stars);
    const r = toNum(p.overall_rating) ?? toNum(p.rating);
    const rating = r == null ? null : Math.round((r <= 5 ? r * 2 : r) * 10) / 10;
    // The cheapest booking site, when the response lists them
    const sites = (Array.isArray(p.prices) ? p.prices : [])
      .map((x: any) => ({ source: x?.source, rate: price(x?.rate_per_night) }))
      .filter((x: any) => x.source && x.rate != null).sort((a: any, b: any) => a.rate - b.rate);
    offers.push({
      sourceId, name: String(name),
      stars: stars != null && stars >= 1 && stars <= 5 ? Math.round(stars) : null,
      rating, reviews: toNum(p.reviews),
      area: p.neighborhood ?? p.area ?? null,
      lat: toNum(p.gps_coordinates?.latitude), lng: toNum(p.gps_coordinates?.longitude),
      imageUrl: p.images?.[0]?.thumbnail ?? p.images?.[0]?.original_image ?? p.thumbnail ?? null,
      perNight, total: Math.round(total), provider: sites[0]?.source ?? p.source ?? null,
    });
  }
  return { offers, source: 'scrapedo', credits };
}
