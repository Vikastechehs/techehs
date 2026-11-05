// WhatsApp Cloud API messages. WhatsApp allows free text only within 24 hours of the person's last message to us
// (notification_channels.last_inbound_at, kept by the /webhooks/whatsapp handler); outside that window only
// templates approved in Meta WhatsApp Manager can be sent. The template texts to submit are in docs/whatsapp-templates.md.
//
// Every marketing/utility template carries the footer "Reply STOP to stop"; the webhook turns STOP into an unsubscribe.
import { config } from '../config.ts';
import type { Db, Row } from '../db.ts';
import { dealSummary, money } from '../engine/notify.ts';
import { hotelDealSummary } from './hotels.ts';
import { endedReason, hotelEndedReason, hotelPlace, monthWindow, route } from './render.ts';

export type TemplateKind = 'deal' | 'hotel' | 'ended' | 'digest' | 'code';

export interface TemplateDef {
  kind: TemplateKind;
  /** Name in WhatsApp Manager (read from config each time so tests and env changes apply). */
  name: () => string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  /** Body parameters in order: {{1}}, {{2}}, ... */
  params: string[];
  /** url: dynamic URL button `${publicUrl}${base}{{1}}`; static: fixed URL, no parameter; copy_code: authentication button. */
  button: { type: 'url'; base: string } | { type: 'static'; path: string } | { type: 'copy_code' };
}

export const TEMPLATES: Record<TemplateKind, TemplateDef> = {
  deal: {
    kind: 'deal', name: () => config.whatsappTemplateDeal, category: 'MARKETING',
    params: ['from city', 'to city', 'price', 'normal price', 'percent below', 'month window'],
    button: { type: 'url', base: '/deal/' },
  },
  hotel: {
    kind: 'hotel', name: () => config.whatsappTemplateHotel, category: 'MARKETING',
    params: ['hotel name', 'stars', 'city', 'price a night', 'normal price a night', 'percent below', 'month window'],
    button: { type: 'url', base: '/hotel-deal/' },
  },
  ended: {
    kind: 'ended', name: () => config.whatsappTemplateEnded, category: 'UTILITY',
    params: ['what ended', 'reason'],
    button: { type: 'url', base: '/' },          // suffix deal/123 or hotel-deal/45 (the page shows it as ended)
  },
  digest: {
    kind: 'digest', name: () => config.whatsappTemplateDigest, category: 'MARKETING',
    params: ['count line', 'top deals'],
    button: { type: 'static', path: '/' },
  },
  code: {
    kind: 'code', name: () => config.whatsappTemplateCode, category: 'AUTHENTICATION',
    params: ['code'],
    button: { type: 'copy_code' },
  },
};

/** Meta limit for one text parameter (body parameters must also be non-empty and contain no newlines/tabs or >4 spaces). */
const PARAM_MAX = 1000;

/** Makes a value safe as a template parameter: no newlines or tabs, no runs of spaces, never empty. */
export function sanitizeParam(v: unknown, max = PARAM_MAX): string {
  let s = String(v ?? '').replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s || '-';
}

export interface TemplateData {
  /** Phone number; any non-digits are removed. */
  to: string;
  /** Body parameters in the template's order. */
  params: unknown[];
  /** Suffix for a dynamic URL button (deal id, "deal/123"), or the code for the authentication button. */
  button?: string | number;
}

/** The Cloud API JSON for a template message. */
export function buildTemplatePayload(kind: TemplateKind, data: TemplateData) {
  const def = TEMPLATES[kind];
  if (!def) throw new Error(`unknown WhatsApp template kind ${kind}`);
  if (data.params.length !== def.params.length) throw new Error(`template ${kind} needs ${def.params.length} parameters, got ${data.params.length}`);
  // Authentication codes: digits/letters only, max 15 characters
  const params = kind === 'code' ? data.params.map(p => String(p ?? '').replace(/[^0-9A-Za-z]/g, '').slice(0, 15) || '-') : data.params.map(p => sanitizeParam(p));
  const components: Record<string, unknown>[] = [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }];
  if (def.button.type === 'url' || def.button.type === 'copy_code') {
    const suffix = def.button.type === 'copy_code' ? params[0] : sanitizeParam(data.button ?? '', 200).replace(/ /g, '');
    // Meta sends the copy-code button as a URL button whose parameter is the code
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: suffix }] });
  }
  return {
    messaging_product: 'whatsapp' as const,
    recipient_type: 'individual' as const,
    to: String(data.to).replace(/\D/g, ''),
    type: 'template' as const,
    template: { name: def.name(), language: { code: config.whatsappTemplateLang }, components },
  };
}

/** The free-text message (only allowed within 24 hours of the person's last message). */
export function buildTextPayload(to: string, body: string) {
  return { messaging_product: 'whatsapp' as const, recipient_type: 'individual' as const, to: String(to).replace(/\D/g, ''),
    type: 'text' as const, text: { preview_url: true, body } };
}

// --- Template data from deals ---
const pct = (n: unknown) => `${Math.round(Number(n))}%`;
const starsText = (n: unknown) => Number(n) >= 1 ? `${Math.min(5, Math.round(Number(n)))}-star` : 'Unrated';

export function dealTemplateData(to: string, d: any): TemplateData {
  return { to, params: [d.from_city, d.to_city, money(d.price, d.currency), money(d.normal_price, d.currency), pct(d.saving_pct),
    monthWindow(d.first_date, d.last_date, d.month) || 'Next months'], button: d.id };
}
export function hotelTemplateData(to: string, d: any): TemplateData {
  return { to, params: [d.hotel_name, starsText(d.stars), d.city_name, money(d.per_night, d.currency), money(d.normal_per_night, d.currency),
    pct(d.saving_pct), monthWindow(d.first_checkin, d.last_checkin, d.month) || 'Next months'], button: d.id };
}
export function endedTemplateData(to: string, kind: 'deal_ended' | 'hotel_ended', d: any): TemplateData {
  return kind === 'hotel_ended'
    ? { to, params: [`${hotelPlace(d)} hotel deal`, hotelEndedReason(d)], button: `hotel-deal/${d.id}` }
    : { to, params: [`${route(d)} flight deal`, endedReason(d)], button: `deal/${d.id}` };
}
/** One short digest line (no link: the button opens the site). */
export function digestLine(kind: string, d: any): string {
  if (kind === 'deal_ended') return `Ended: ${route(d)}`;
  if (kind === 'hotel_ended') return `Ended: ${hotelPlace(d)}`;
  if (kind === 'hotel_live') return `${hotelPlace(d)} ${money(d.per_night, d.currency)}/night (${pct(d.saving_pct)} below)`;
  return `${route(d)} ${money(d.price, d.currency)} (${pct(d.saving_pct)} below)`;
}
export function digestTemplateData(to: string, countLine: string, lines: string[]): TemplateData {
  const top = lines.slice(0, 3).join(' | ') + (lines.length > 3 ? ` | +${lines.length - 3} more` : '');
  return { to, params: [countLine, top] };
}
export function codeTemplateData(to: string, code: string): TemplateData {
  return { to, params: [code], button: code };
}

// --- Choosing text or template for an outbox row ---
const WINDOW_MS = 24 * 3600 * 1000;

/** When the person last wrote to us on this WhatsApp number (null = never / unknown). */
export async function lastInbound(db: Db, m: Row): Promise<Date | null> {
  const meta = m.meta ?? {};
  const rows = meta.channel_id
    ? await db.query(`SELECT last_inbound_at FROM notification_channels WHERE id = $1`, [meta.channel_id])
    : await db.query(`SELECT max(last_inbound_at) AS last_inbound_at FROM notification_channels
        WHERE kind = 'whatsapp' AND regexp_replace(address, '\\D', '', 'g') = $1`, [String(m.to_address).replace(/\D/g, '')]);
  const t = rows[0]?.last_inbound_at;
  return t ? new Date(t) : null;
}
export const withinWindow = (last: Date | null, now = Date.now()) => !!last && now - last.getTime() < WINDOW_MS;

/** The template message for an outbox row, from its meta (kind + deal id), or an error when it can't be built. */
export async function templateFor(db: Db, m: Row): Promise<{ payload: ReturnType<typeof buildTemplatePayload> } | { error: string }> {
  const meta = m.meta ?? {};
  const to = String(m.to_address);
  if (meta.template === 'code') {
    const code = Array.isArray(meta.params) ? String(meta.params[0] ?? '') : '';
    if (!code) return { error: 'whatsapp: code template without a code' };
    return { payload: buildTemplatePayload('code', codeTemplateData(to, code)) };
  }
  switch (meta.kind) {
    case 'deal_live': case 'route_watch': case 'deal_ended': {
      const d = meta.deal_id ? await dealSummary(db, Number(meta.deal_id)) : null;
      if (!d) return { error: `whatsapp: deal ${meta.deal_id ?? '?'} not found for template` };
      return { payload: meta.kind === 'deal_ended' ? buildTemplatePayload('ended', endedTemplateData(to, 'deal_ended', d))
        : buildTemplatePayload('deal', dealTemplateData(to, d)) };
    }
    case 'hotel_live': case 'hotel_ended': {
      const d = meta.hotel_deal_id ? await hotelDealSummary(db, Number(meta.hotel_deal_id)) : null;
      if (!d) return { error: `whatsapp: hotel deal ${meta.hotel_deal_id ?? '?'} not found for template` };
      return { payload: meta.kind === 'hotel_ended' ? buildTemplatePayload('ended', endedTemplateData(to, 'hotel_ended', d))
        : buildTemplatePayload('hotel', hotelTemplateData(to, d)) };
    }
    case 'digest': {
      const ids = Array.isArray(meta.notification_ids) ? meta.notification_ids.map(Number) : [];
      const ns = ids.length ? await db.query(`SELECT kind, deal_id, hotel_deal_id FROM notifications
        WHERE id = ANY($1::bigint[]) AND kind <> 'digest' ORDER BY id`, [ids]) : [];
      const lines: string[] = [];
      for (const n of ns) {
        const d = n.deal_id != null ? await dealSummary(db, n.deal_id) : n.hotel_deal_id != null ? await hotelDealSummary(db, n.hotel_deal_id) : null;
        if (d) lines.push(digestLine(n.kind, d));
      }
      if (!lines.length) return { error: 'whatsapp: digest has no deals left for the template' };
      const countLine = m.subject || `${lines.length} deal${lines.length === 1 ? '' : 's'} for you today`;
      return { payload: buildTemplatePayload('digest', digestTemplateData(to, countLine, lines)) };
    }
    default:
      return { error: `whatsapp: no template for message kind ${meta.kind ?? '(none)'} outside the 24-hour window` };
  }
}

// --- Meta errors ---
/** Meta error codes that won't succeed on retry (template missing/paused/wrong parameters, window closed, bad number). */
const PERMANENT = new Set([100, 131008, 131009, 131021, 131026, 131047, 131051, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069, 470]);
const EXPLAIN: Record<number, string> = {
  131047: 'more than 24 hours since the person last wrote; a template is needed',
  132001: 'template not found or not approved in this language',
  132000: 'template parameter count does not match',
  132012: 'template parameter format does not match',
  132015: 'template is paused', 132016: 'template is disabled',
  131026: 'message undeliverable (number not on WhatsApp or old app)',
};

export interface MetaError { code: number; message: string; permanent: boolean }
/** Reads a Cloud API error reply ({error:{code, message, error_data:{details}}}). */
export function metaError(status: number, body: any): MetaError {
  const e = body?.error ?? {};
  const code = Number(e.code) || 0;
  const detail = [e.message, e.error_data?.details].filter(Boolean).join(': ');
  const message = `whatsapp: HTTP ${status}${code ? ` error ${code}` : ''}${EXPLAIN[code] ? ` (${EXPLAIN[code]})` : ''}${detail ? ` ${detail}` : ''}`.slice(0, 300);
  const permanent = PERMANENT.has(code) || (status >= 400 && status < 500 && status !== 429 && !code);
  return { code, message, permanent };
}
