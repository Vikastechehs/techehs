// Per-night price calendar for a hotel city: one cell per check-in date, coloured against the month's normal price.
import { money } from '../../engine/notify.ts';
import { esc, fmtDate } from '../html.ts';
import { level } from '../pages/explore.ts';

export const monthName = (ym: string) => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** ₹4.2k style label for small calendar cells. */
export function shortMoney(n: number, cur: string) {
  const sym = money(0, cur).replace(/[\d.,\s]/g, '');
  return n >= 1000 ? `${sym}${(n / 1000).toFixed(n < 100000 ? 1 : 0)}k` : money(n, cur);
}

export function monthCalendar(ym: string, prices: Map<string, number>, normal: number | null, currency: string) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;                     // Monday first
  const cells: string[] = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<div class="hd">${d}</div>`);
  for (let i = 0; i < lead; i++) cells.push('<div></div>');
  for (let d = 1; d <= days; d++) {
    const iso = `${ym}-${String(d).padStart(2, '0')}`, pr = prices.get(iso);
    cells.push(pr == null ? `<div class="d">${d}</div>`
      : `<div class="d ${level(pr, normal)}" title="Check in ${esc(fmtDate(iso))}: ${esc(money(pr, currency))} a night">${d}<b>${esc(shortMoney(pr, currency))}</b></div>`);
  }
  return `<div class="cal"><h3>${esc(monthName(ym))}</h3><div class="meta" style="margin:0 0 6px">${normal ? `Normally ${money(normal, currency)} a night` : ''}</div><div class="wk">${cells.join('')}</div></div>`;
}
