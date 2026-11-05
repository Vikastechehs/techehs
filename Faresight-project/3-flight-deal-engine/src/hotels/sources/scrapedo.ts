// Scrape.do Google Hotels plugin.
//
// UNVERIFIED: unlike the flights plugin (src/sources/scrapedo.ts, tested on ~5,000 searches), this endpoint,
// its parameters and its response shape have NOT been checked against live Scrape.do. The request mirrors the
// flights plugin (same host, token, currency/gl/hl, same error handling) and the parser expects a
// SerpApi-style Google Hotels response: { properties: [{ name, property_token, extracted_hotel_class,
// overall_rating (out of 5), reviews, rate_per_night, total_rate, gps_coordinates, images, prices }] }.
// Run `node src/cli.ts hotels-once 5` with a real token and compare before relying on it.
import { FatalSourceError, RetryableError } from '../../sources/types.ts';
import type { HotelOffer, HotelQuery, HotelResult, HotelSource } from '../contract.ts';

const ENDPOINT = 'https://api.scrape.do/plugin/google/hotels';
const CREDITS_PER_SEARCH = 10;   // assumed equal to the flights plugin; unverified
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

export function scrapeDoHotelSource(token: string, fetchImpl: typeof fetch = fetch): HotelSource {
  if (!token) throw new Error('SCRAPEDO_TOKEN is not set');
  return {
    name: 'scrapedo',
    async search(q: HotelQuery): Promise<HotelResult> {
      const params = new URLSearchParams({
        token, q: q.query, check_in_date: q.checkin, check_out_date: addDays(q.checkin, q.nights),
        currency: q.currency, gl: q.gl, hl: 'en', adults: '2',
      });
      let res: Response;
      try {
        res = await fetchImpl(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(90_000) });
      } catch (e) {
        throw new RetryableError(`network: ${(e as Error).message}`);
      }
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      if ([401, 402, 403].includes(res.status)) throw new FatalSourceError(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      return parseGoogleHotels(JSON.parse(text), q.nights, CREDITS_PER_SEARCH);
    },
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** SerpApi-style Google Hotels JSON -> offers. Ratings are normalised to /10; per night = total / nights when a total is given. */
export function parseGoogleHotels(data: any, nights: number, credits = CREDITS_PER_SEARCH): HotelResult {
  const offers: HotelOffer[] = [];
  const seen = new Set<string>();
  for (const p of (Array.isArray(data?.properties) ? data.properties : []) as any[]) {
    if (!p?.name || (p.type && p.type !== 'hotel')) continue;   // skip vacation rentals
    const perNightRaw = num(p.rate_per_night?.extracted_lowest);
    const totalRaw = num(p.total_rate?.extracted_lowest);
    if (perNightRaw == null && totalRaw == null) continue;      // no bookable rate for these dates
    const total = totalRaw ?? perNightRaw! * nights;
    const perNight = Math.round(totalRaw != null ? totalRaw / nights : perNightRaw!);
    const sourceId = String(p.property_token ?? `name:${p.name}`);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const classText = typeof p.hotel_class === 'string' ? p.hotel_class.match(/(\d)/)?.[1] : null;
    const stars = num(p.extracted_hotel_class) ?? (classText ? Number(classText) : null);
    const rating = num(p.overall_rating);
    // The cheapest booking site, when the response lists them
    const prices = (Array.isArray(p.prices) ? p.prices : [])
      .map((x: any) => ({ source: x?.source, rate: num(x?.rate_per_night?.extracted_lowest) }))
      .filter((x: any) => x.source && x.rate != null).sort((a: any, b: any) => a.rate - b.rate);
    offers.push({
      sourceId, name: String(p.name), stars,
      rating: rating != null ? Math.round(rating * 20) / 10 : null,
      reviews: num(p.reviews),
      area: p.neighborhood ?? p.area ?? null,
      lat: num(p.gps_coordinates?.latitude), lng: num(p.gps_coordinates?.longitude),
      imageUrl: p.images?.[0]?.thumbnail ?? p.images?.[0]?.original_image ?? null,
      perNight, total: Math.round(total), provider: prices[0]?.source ?? null,
    });
  }
  return { offers, source: 'scrapedo', credits };
}
