// Message text for each channel. Every message carries the deal link and a one-tap stop link for that channel.
import { config } from '../config.ts';
import { money, telegramText } from '../engine/notify.ts';
import type { OutChannel } from './outbox.ts';
import { unsubscribeToken } from './unsubscribe.ts';

export type NoticeKind = 'deal_live' | 'route_watch' | 'deal_ended';
/** Where a message goes: the channel row (id, owner and kind). */
export interface Target { id: number; user_id: number; kind: OutChannel }
/** Rendered message, ready for enqueue(). Email HTML and the push payload travel in meta / body. */
export interface Rendered { subject: string; body: string; meta: Record<string, unknown> }

export const dealUrl = (dealId: number) => `${config.publicUrl}/deal/${dealId}`;
export const unsubscribeUrl = (userId: number, channelId: number) =>
  `${config.publicUrl}/unsubscribe?t=${encodeURIComponent(unsubscribeToken(userId, channelId))}`;

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pct = (n: number) => `${Math.round(Number(n))}%`;
const route = (d: any) => `${d.from_city} → ${d.to_city}`;

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

/** One digest message grouping several notices for a daily channel. */
export function renderDigest(items: { kind: NoticeKind; d: any }[], ch: Target): Rendered {
  const live = items.filter(i => i.kind !== 'deal_ended').length;
  const title = live
    ? `${live} flight deal${live === 1 ? '' : 's'} for you today`
    : `Update on ${items.length} deal${items.length === 1 ? '' : 's'} you were following`;
  const lines: string[] = [];
  for (const { kind, d } of items) {
    if (kind === 'deal_ended') lines.push(`• Ended: ${route(d)}. ${endedReason(d)}`);
    else lines.push(`• ${route(d)}: ${money(d.price, d.currency)} (normally ${money(d.normal_price, d.currency)}, ${pct(d.saving_pct)} below) ${ch.kind === 'push' ? '' : dealUrl(d.id)}`.trimEnd());
  }
  return finish(ch, title, [title, ...lines], items.length === 1 ? dealUrl(items[0].d.id) : `${config.publicUrl}/`, 'digest');
}
