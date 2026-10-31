// Booking links: a Skyscanner search for the exact date pair, wrapped in the affiliate link when one is set.
import { config } from '../config.ts';

const yymmdd = (d: string) => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);

export function skyscannerUrl(origin: string, destination: string, depart: string, ret: string, maxStops = 1) {
  const stops = maxStops === 0 ? '&stops=!oneStop,!twoPlusStops' : maxStops === 1 ? '&stops=!twoPlusStops' : '';
  return `https://www.skyscanner.co.in/transport/flights/${origin.toLowerCase()}/${destination.toLowerCase()}/${yymmdd(depart)}/${yymmdd(ret)}/?adultsv2=1&cabinclass=economy&rtn=1${stops}`;
}

export function bookingUrl(origin: string, destination: string, depart: string, ret: string, maxStops = 1) {
  const url = skyscannerUrl(origin, destination, depart, ret, maxStops);
  return config.affiliateTemplate ? config.affiliateTemplate.replace('{url}', encodeURIComponent(url)) : url;
}

export function partnerName() { return config.affiliateTemplate ? 'skyscanner-affiliate' : 'skyscanner'; }
