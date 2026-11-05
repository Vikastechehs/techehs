// Hotel booking links: a Booking.com search for the hotel and exact stay, wrapped in the affiliate link when one is set.
import { config } from '../config.ts';

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

export function bookingComUrl(hotelName: string, cityName: string, checkin: string, nights: number) {
  const q = new URLSearchParams({
    ss: `${hotelName}, ${cityName}`, checkin, checkout: addDays(checkin, nights),
    group_adults: '2', no_rooms: '1', selected_currency: 'INR',
  });
  return `https://www.booking.com/searchresults.html?${q}`;
}

/** Where /go/h/:id sends people: Booking.com search for this hotel and stay (affiliate-wrapped via HOTEL_AFFILIATE_URL_TEMPLATE, {url} = encoded URL). */
export function hotelBookingUrl(hotelName: string, cityName: string, checkin: string, nights: number) {
  const url = bookingComUrl(hotelName, cityName, checkin, nights);
  return config.hotelAffiliateTemplate ? config.hotelAffiliateTemplate.replace('{url}', encodeURIComponent(url)) : url;
}

export function hotelPartnerName() { return config.hotelAffiliateTemplate ? 'booking-affiliate' : 'booking'; }
