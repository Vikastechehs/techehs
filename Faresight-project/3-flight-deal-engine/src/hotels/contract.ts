// Hotels: shared types and the functions other modules call. CONTRACT: names and signatures are fixed.
// The hotel engine module implements them in src/hotels/*.ts and re-exports them from here.
export interface HotelQuery { city: string; query: string; checkin: string; nights: number; currency: string; gl: string }
export interface HotelOffer {
  sourceId: string; name: string; stars: number | null; rating: number | null; reviews: number | null;
  area: string | null; lat: number | null; lng: number | null; imageUrl: string | null;
  perNight: number; total: number; provider: string | null;
}
export interface HotelResult { offers: HotelOffer[]; source: string; credits: number }
export interface HotelSource { name: string; search(q: HotelQuery): Promise<HotelResult> }

/** Called when a hotel deal goes live / ends. Set by main.ts. */
export type HotelNotify = (hotelDealId: number) => Promise<void>;

// Implementations (re-exported so other modules can import everything hotel-related from here)
export { reviewHotelDeal, hotelPasses, setHotelDealEndedHook } from './deals.ts';
export { hotelBookingUrl, hotelPartnerName } from './links.ts';
