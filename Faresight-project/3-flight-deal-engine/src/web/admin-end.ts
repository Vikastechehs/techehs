// "End deal" by hand from the admin pages: the reason choices, the plain text users see, and the small form.
import { esc } from './html.ts';

type Kind = 'flight' | 'hotel';
const REASONS: Record<string, Record<Kind, string>> = {
  sold_out: { flight: 'Sold out / airline withdrew the fare', hotel: 'Sold out / hotel withdrew the rate' },
  price_up: { flight: 'Price went up', hotel: 'Price went up' },
  site_error: { flight: 'Booking site error', hotel: 'Booking site error' },
  other: { flight: 'Other', hotel: 'Other' },
};

/**
 * The reason stored on the deal and shown to users in the "Ended: …" message (src/notify/render.ts turns
 * "price rose to N" into "Price rose to ₹N"). `note` is the admin's optional free text: for "Price went up" a new price.
 */
export function manualEndReason(kind: Kind, code: string, note = ''): string {
  const text = note.replace(/\s+/g, ' ').trim().slice(0, 200);
  const withNote = (base: string) => (text ? `${base.replace(/\.$/, '')}. ${text}` : base);
  switch (code) {
    case 'sold_out': return withNote(kind === 'flight' ? 'sold out: the airline withdrew this fare' : 'the hotel withdrew this rate');
    case 'price_up': {
      const n = Number(/\d[\d,]*(\.\d+)?/.exec(text)?.[0]?.replace(/,/g, '') ?? NaN);
      return Number.isFinite(n) && n > 0 ? `price rose to ${n}` : 'the price went up';
    }
    case 'site_error': return withNote('the booking site showed this price in error');
    default: return text || 'withdrawn after a manual check';
  }
}

/** Reason select + optional text + button, posting `reason` and `note` to `action`. */
export function endDealForm(kind: Kind, action: string): string {
  return `<form method="post" action="${esc(action)}" style="display:flex;gap:6px;flex-wrap:wrap;margin:0">
    <select name="reason" aria-label="Why">${Object.entries(REASONS).map(([k, v]) => `<option value="${k}">${esc(v[kind])}</option>`).join('')}</select>
    <input name="note" maxlength="200" placeholder="New price or note (optional)" aria-label="Note" style="width:12em">
    <button class="btn secondary">End deal</button></form>`;
}
