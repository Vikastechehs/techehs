// Posts a deal to Telegram when it goes live (only if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set).
import { config } from '../config.ts';
import type { Db } from '../db.ts';

export const money = (n: number, cur = 'INR') =>
  new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n);

const monthName = (d: string) => new Date(d + 'T00:00:00Z').toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export async function dealSummary(db: Db, dealId: number) {
  const [d] = await db.query(`
    SELECT d.*, r.origin, r.destination, r.max_stops, ao.city AS from_city, ad.city AS to_city,
           (SELECT count(*)::int FROM deal_dates WHERE deal_id = d.id AND depart >= current_date + 1) AS pairs,
           (SELECT min(depart)::text FROM deal_dates WHERE deal_id = d.id AND depart >= current_date + 1) AS first_date,
           (SELECT max(depart)::text FROM deal_dates WHERE deal_id = d.id) AS last_date
    FROM deals d JOIN routes r ON r.id = d.route_id
    JOIN airports ao ON ao.iata = r.origin JOIN airports ad ON ad.iata = r.destination
    WHERE d.id = $1`, [dealId]);
  return d;
}

export function telegramText(d: any) {
  const stops = d.max_stops === 0 ? 'nonstop' : 'up to 1 stop';
  const window = d.first_date && d.last_date && monthName(d.first_date) !== monthName(d.last_date)
    ? `${monthName(d.first_date)} – ${monthName(d.last_date)}` : d.first_date ? monthName(d.first_date) : '';
  return [
    `✈️ ${d.from_city} → ${d.to_city}, return, ${stops}`,
    `${money(d.price, d.currency)} · normally ${money(d.normal_price, d.currency)} · ${d.saving_pct}% below`,
    `${window} · ${d.pairs} date pairs`,
    `${config.publicUrl}/deal/${d.id}`,
  ].join('\n');
}

export function makeNotifier(db: Db, log: (m: string) => void = console.log) {
  return async (dealId: number) => {
    if (!config.telegramToken || !config.telegramChat) return;
    const d = await dealSummary(db, dealId);
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.telegramChat, text: telegramText(d), disable_web_page_preview: false }),
      });
      if (!res.ok) log(`telegram: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    } catch (e) { log(`telegram: ${(e as Error).message}`); }
  };
}
