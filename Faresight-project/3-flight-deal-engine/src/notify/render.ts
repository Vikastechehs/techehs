// Message text for each channel. Every message carries the deal link and a one-tap stop link for that channel.
import { config } from '../config.ts';
import { money, telegramText } from '../engine/notify.ts';
import type { OutChannel } from './outbox.ts';
import { unsubscribeToken } from './unsubscribe.ts';

export type NoticeKind = 'deal_live' | 'route_watch' | 'deal_ended';
export type HotelNoticeKind = 'hotel_live' | 'hotel_ended';
/** Anything that can appear in a digest: flight notices (d = dealSummary) and hotel notices (d = hotelDealSummary). */
export type DigestKind = NoticeKind | HotelNoticeKind;
/** Where a message goes: the channel row (id, owner and kind). */
export interface Target { id: number; user_id: number; kind: OutChannel }
/** Rendered message, ready for enqueue(). Email HTML and the push payload travel in meta / body. */
export interface Rendered { subject: string; body: string; meta: Record<string, unknown> }

export const dealUrl = (dealId: number) => `${config.publicUrl}/deal/${dealId}`;
export const hotelDealUrl = (hotelDealId: number) => `${config.publicUrl}/hotel-deal/${hotelDealId}`;
export const unsubscribeUrl = (userId: number, channelId: number) =>
  `${config.publicUrl}/unsubscribe?t=${encodeURIComponent(unsubscribeToken(userId, channelId))}`;

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pct = (n: number) => `${Math.round(Number(n))}%`;
export const route = (d: any) => `${d.from_city} → ${d.to_city}`;

/** Plain-language reason a deal ended, from deals.reason. */
export function endedReason(d: any): string {
  const r = String(d.reason ?? '');
  const rose = /price rose to ([\d.]+)/i.exec(r);
  if (rose) return `Price rose to ${money(Number(rose[1]), d.currency)}.`;
  if (/no flights found/i.test(r)) return 'No seats were left at this price when we re-checked.';
  if (/all dates passed/i.test(r)) return 'All the travel dates have passed.';
  if (/rejected by admin/i.test(r)) return 'We withdrew this deal after a manual check.';
  return r ? r.charAt(0).toUpperCase() + r.slice(1) + (r.endsWith('.') ? '' : '.') : 'The fare is no longer available.';
}

/** Title (subject / push title) and the text lines of one notice. */
export function noticeLines(kind: NoticeKind, d: any): { title: string; lines: string[] } {
  if (kind === 'deal_ended') {
    return { title: `Ended: ${route(d)}`, lines: [`Ended: ${route(d)}. ${endedReason(d)}`] };
  }
  const lines = telegramText(d).split('\n').slice(0, 3).filter(l => l.trim() && !l.trim().startsWith('·'));
  if (kind === 'route_watch') {
    return { title: `Your watched route: ${route(d)} now ${money(d.price, d.currency)}`, lines: ['A route you watch has a deal:', ...lines] };
  }
  return { title: `${pct(d.saving_pct)} below normal: ${route(d)} from ${money(d.price, d.currency)}`, lines };
}

function finish(ch: Target, title: string, lines: string[], url: string, tag: string): Rendered {
  const stop = unsubscribeUrl(ch.user_id, ch.id);
  const meta: Record<string, unknown> = { unsubscribe_url: stop, url };
  if (ch.kind === 'push') {
    return { subject: title, body: JSON.stringify({ title, body: lines.join('\n'), url, tag }), meta };
  }
  const text = [...lines, url, '', `Stop these alerts: ${stop}`].join('\n');
  if (ch.kind === 'email') {
    meta.html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">`
      + lines.map(l => `<p style="margin:0 0 6px">${esc(l)}</p>`).join('')
      + `<p style="margin:14px 0"><a href="${esc(url)}" style="background:#0b6;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none">See the deal</a></p>`
      + `<p style="color:#777;font-size:12px;margin-top:20px">You get this because you set up a ${esc(config.siteName)} alert. <a href="${esc(stop)}">Stop these alerts</a></p></div>`;
  }
  return { subject: title, body: text, meta };
}

/** A single notice (deal live, watched route, deal ended) for one channel. `d` is dealSummary(). */
export function renderNotice(kind: NoticeKind, d: any, ch: Target): Rendered {
  const { title, lines } = noticeLines(kind, d);
  return finish(ch, title, lines, dealUrl(d.id), `deal-${d.id}`);
}

/** One digest message grouping several notices (flights and hotels) for a daily channel. */
export function renderDigest(items: { kind: DigestKind; d: any }[], ch: Target): Rendered {
  const isHotel = (k: DigestKind) => k === 'hotel_live' || k === 'hotel_ended';
  const flights = items.filter(i => i.kind !== 'deal_ended' && !isHotel(i.kind)).length;
  const hotels = items.filter(i => i.kind === 'hotel_live').length;
  const n = (k: number, what: string) => `${k} ${what}${k === 1 ? '' : 's'}`;
  const title = flights || hotels
    ? `${[flights ? n(flights, 'flight deal') : '', hotels ? n(hotels, 'hotel deal') : ''].filter(Boolean).join(' and ')} for you today`
    : `Update on ${n(items.length, 'deal')} you were following`;
  const lines: string[] = [];
  for (const { kind, d } of items) {
    const link = ch.kind === 'push' ? '' : isHotel(kind) ? hotelDealUrl(d.id) : dealUrl(d.id);
    if (kind === 'deal_ended') lines.push(`• Ended: ${route(d)}. ${endedReason(d)}`);
    else if (kind === 'hotel_ended') lines.push(`• Ended: ${hotelPlace(d)}. ${hotelEndedReason(d)}`);
    else if (kind === 'hotel_live') lines.push(`• 🏨 ${hotelPlace(d)}: ${money(d.per_night, d.currency)}/night (normally ${money(d.normal_per_night, d.currency)}, ${pct(d.saving_pct)} below) ${link}`.trimEnd());
    else lines.push(`• ${route(d)}: ${money(d.price, d.currency)} (normally ${money(d.normal_price, d.currency)}, ${pct(d.saving_pct)} below) ${link}`.trimEnd());
  }
  const only = items.length === 1 ? (isHotel(items[0].kind) ? hotelDealUrl(items[0].d.id) : dealUrl(items[0].d.id)) : `${config.publicUrl}/`;
  return finish(ch, title, [title, ...lines], only, 'digest');
}

// --- Hotels ---
const stars = (n: unknown) => Number(n) >= 1 ? ' ' + '★'.repeat(Math.min(5, Math.round(Number(n)))) : '';
export const hotelPlace = (d: any) => `${d.hotel_name}, ${d.city_name}`;
const monthName = (s: string) => new Date(String(s).slice(0, 10) + 'T00:00:00Z').toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "Mar 2027" or "Mar 2027 – May 2027" from the first and last travel date; falls back to the deal month. */
export function monthWindow(first: unknown, last: unknown, month?: unknown): string {
  const f = first ? String(first) : '', l = last ? String(last) : '';
  if (f && l && monthName(f) !== monthName(l)) return `${monthName(f)} – ${monthName(l)}`;
  if (f) return monthName(f);
  if (month) return monthName(month instanceof Date ? month.toISOString() : String(month));
  return '';
}

/** Plain-language reason a hotel deal ended, from hotel_deals.reason. */
export function hotelEndedReason(d: any): string {
  const r = String(d.reason ?? '');
  const rose = /price rose to ([\d.]+)/i.exec(r);
  if (rose) return `The rate rose to ${money(Number(rose[1]), d.currency)} a night.`;
  if (/no (rooms|rates|offers|availability)|sold out|not found/i.test(r)) return 'No rooms were left at this rate when we re-checked.';
  if (/all dates passed|dates passed/i.test(r)) return 'All the stay dates have passed.';
  if (/rejected by admin/i.test(r)) return 'We withdrew this deal after a manual check.';
  return r ? r.charAt(0).toUpperCase() + r.slice(1) + (r.endsWith('.') ? '' : '.') : 'The rate is no longer available.';
}

/** The text of a live hotel deal: name, stars and city; price; dates; (the link is added by finish). */
export function hotelDealText(d: any): string[] {
  const window = monthWindow(d.first_checkin, d.last_checkin, d.month);
  const dates = Number(d.dates ?? 0);
  return [
    `🏨 ${d.hotel_name}${stars(d.stars)} · ${d.city_name}`,
    `${money(d.per_night, d.currency)}/night · normally ${money(d.normal_per_night, d.currency)} · ${pct(d.saving_pct)} below`,
    [window, dates ? `${dates} date${dates === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
  ].filter(l => l.trim());
}

export function hotelNoticeLines(kind: HotelNoticeKind, d: any): { title: string; lines: string[] } {
  if (kind === 'hotel_ended') return { title: `Ended: ${hotelPlace(d)}`, lines: [`Ended: ${hotelPlace(d)}. ${hotelEndedReason(d)}`] };
  return { title: `${pct(d.saving_pct)} below normal: ${hotelPlace(d)} from ${money(d.per_night, d.currency)}/night`, lines: hotelDealText(d) };
}

/** A single hotel notice (live or ended) for one channel. `d` is hotelDealSummary() from notify/hotels.ts. */
export function renderHotelNotice(kind: HotelNoticeKind, d: any, ch: Target): Rendered {
  const { title, lines } = hotelNoticeLines(kind, d);
  return finish(ch, title, lines, hotelDealUrl(d.id), `hotel-deal-${d.id}`);
}
