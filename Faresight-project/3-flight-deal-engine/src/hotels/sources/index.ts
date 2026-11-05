import { config } from '../../config.ts';
import type { HotelSource } from '../contract.ts';
import { mockHotelSource } from './mock.ts';
import { scrapeDoHotelSource } from './scrapedo.ts';

/** Picks the hotel source from HOTEL_SOURCE / SCRAPEDO_TOKEN. */
export function makeHotelSource(): HotelSource {
  if (config.hotelSource === 'scrapedo') return scrapeDoHotelSource(config.scrapedoToken);
  return mockHotelSource();
}
export { mockHotelSource, scrapeDoHotelSource };
