import { config } from '../config.ts';
import { mockSource } from './mock.ts';
import { scrapeDoSource } from './scrapedo.ts';
import type { FareSource } from './types.ts';

/** Picks the fare source from FARE_SOURCE / SCRAPEDO_TOKEN. New sources (e.g. a cached affiliate API) plug in here. */
export function makeSource(): FareSource {
  if (config.source === 'scrapedo') return scrapeDoSource(config.scrapedoToken);
  return mockSource();
}
