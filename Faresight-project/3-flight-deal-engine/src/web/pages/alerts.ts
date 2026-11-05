// "Never miss a real deal": choose airports, channels and a threshold. Works signed out: the choices are kept in a
// signed cookie while the visitor confirms their email with a code, then saved.
import { config } from '../../config.ts';
import { addChannel, listAlerts, listChannels, requestLoginCode, updateChannel, upsertAlert, UserError } from '../../users/service.ts';
import { telegramConnectLink } from '../../notify/telegram.ts';
import { esc } from '../html.ts';
import { setCookie } from '../http.ts';
import { attempt, csrfField, csrfToken, flash, page, postForm, secure, signValue, unsignValue, type P } from './common.ts';
import { origins } from './data.ts';

const PENDING_COOKIE = 'fs_pending';
export interface Choices { origins: string[]; pct: number; whatsapp: string | null; telegram: boolean; push: boolean; email: 'instant' | 'daily' | null }

/** Indian mobile numbers may be typed without +91. */
export function normalisePhone(raw: string) {
  const d = raw.replace(/[\s()-]/g, '');
  if (/^[6-9]\d{9}$/.test(d)) return '+91' + d;
  if (/^0[6-9]\d{9}$/.test(d)) return '+91' + d.slice(1);
  if (/^\+[1-9]\d{7,14}$/.test(d)) return d;
  throw new UserError('Enter your WhatsApp number with country code, e.g. +91 98123 45678.');
}

function readChoices(f: URLSearchParams, valid: Set<string>): Choices {
  const os = [...new Set(f.getAll('origin'))].filter(o => valid.has(o));
  if (!os.length) throw new UserError('Pick at least one airport.');
  const pct = [25, 35, 50].includes(Number(f.get('pct'))) ? Number(f.get('pct')) : 25;
  const whatsapp = f.get('ch_whatsapp') ? normalisePhone(f.get('phone') ?? '') : null;
  const email = f.get('ch_email') ? (f.get('email_freq') === 'instant' ? 'instant' : 'daily') : null;
  const c: Choices = { origins: os, pct, whatsapp, telegram: !!f.get('ch_telegram'), push: !!f.get('ch_push'), email };
  if (!c.whatsapp && !c.telegram && !c.push && !c.email) throw new UserError('Pick at least one way to get your alerts.');
  return c;
}

export async function applyChoices(p: P, userId: number, c: Choices) {
  for (const o of c.origins) await upsertAlert(p.db, userId, { origin: o, min_saving_pct: c.pct, active: true });
  if (c.whatsapp) await addChannel(p.db, userId, { kind: 'whatsapp', address: c.whatsapp, frequency: 'instant' });
  const emails = (await listChannels(p.db, userId)).filter(ch => ch.kind === 'email');
  for (const ch of emails) {
    if (c.email) await updateChannel(p.db, userId, ch.id, { active: true, frequency: c.email });
    else if (c.whatsapp || c.telegram || c.push) await updateChannel(p.db, userId, ch.id, { active: false });
  }
  if (!emails.length && c.email && p.user) await addChannel(p.db, userId, { kind: 'email', address: p.user.email, frequency: c.email });
}

/** Called right after sign-in: saves alert choices made while signed out. */
export async function applyPendingAlerts(p: P, userId: number) {
  const c = unsignValue<Choices>(p.ck[PENDING_COOKIE]);
  if (!c) return;
  p.out.push(setCookie(PENDING_COOKIE, '', { maxAgeSec: 0, secure }));
  try { await applyChoices(p, userId, c); }
  catch (e) { if (e instanceof UserError) { flash(p, e.message, 'error'); return; } throw e; }
  p.out.push(setCookie('fs_done', JSON.stringify({ telegram: c.telegram, push: c.push }), { maxAgeSec: 600, secure }));
}

export async function handleAlerts(p: P): Promise<boolean> {
  const path = p.url.pathname, post = p.req.method === 'POST';
  if (path === '/alerts' && !post) {
    const os = await origins(p.db);
    const mine = p.user ? await listAlerts(p.db, p.user.id) : [];
    const chosen = new Set(mine.length ? mine.map(a => a.origin) : p.user?.home_airport ? [p.user.home_airport] : []);
    const pct = mine[0]?.min_saving_pct ?? 25;
    const chip = (name: string, value: string, label: string, on: boolean, extra = '') =>
      `<label class="chip"><input type="checkbox" name="${name}" value="${esc(value)}"${on ? ' checked' : ''}> ${label}${extra}</label>`;
    const body = `<h1>Never miss a real deal</h1>
      <p class="lead">Tell us where you fly from. We'll message you only when a fare is genuinely cheap and still bookable. Free, and you can stop any time.</p>
      <form method="post" action="/alerts" class="panel">${csrfField(p)}
        <h2>1. Your airports</h2><div class="chips">${os.map(o => chip('origin', o.origin, `${esc(o.city)} (${esc(o.origin)})`, chosen.has(o.origin))).join('')}</div>
        <h2 style="margin-top:20px">2. Where should we send them?</h2>
        <div class="chips">
          ${chip('ch_whatsapp', '1', 'WhatsApp', !!p.user?.phone, ' <span class="meta" style="margin:0">Most people pick this</span>')}
          ${chip('ch_telegram', '1', 'Telegram', false)}
          ${chip('ch_push', '1', 'App notifications', false, ' <span class="meta" style="margin:0">No number needed</span>')}
          ${chip('ch_email', '1', 'Email', !p.user?.phone)}
        </div>
        <label for="phone">WhatsApp number</label><input id="phone" type="tel" name="phone" autocomplete="tel" placeholder="+91 98123 45678" value="${esc(p.user?.phone ?? '')}">
        <label for="email_freq">Email</label><select id="email_freq" name="email_freq" class="wide"><option value="daily">Daily summary</option><option value="instant">Every deal as it's found</option></select>
        <h2 style="margin-top:20px">3. Only tell me about deals at least…</h2>
        <div class="chips">${[25, 35, 50].map(n => `<label class="chip"><input type="radio" name="pct" value="${n}"${n === pct ? ' checked' : ''}> ${n}% below normal</label>`).join('')}</div>
        <p class="meta">About 3–5 messages a week per airport at 25%; fewer at 35% and 50%.</p>
        ${p.user ? `<p class="meta">Signed in as ${esc(p.user.email)}.</p>`
          : `<label for="email">Your email</label><input id="email" type="email" name="email" required autocomplete="email"><p class="meta">We'll send a code to confirm it's you.</p>`}
        <p><button class="btn">Start my free alerts</button></p>
        <p class="meta">We'll never share your number or email. Every message has a one-tap stop link.</p>
      </form>
      <div class="panel"><h2>What you'll get</h2><p>Two kinds of message: a new deal, and a deal ending. That's all.</p>
        <p class="meta">✈ Delhi → Bangkok, return · ₹19,550 · normally ₹32,570 · 40% below normal</p></div>`;
    page(p, 'Set up deal alerts', body);
    return true;
  }

  if (path === '/alerts' && post) {
    const f = await postForm(p);
    const valid = new Set((await origins(p.db)).map(o => o.origin));
    await attempt(p, '/alerts', async () => {
      const c = readChoices(f, valid);
      if (p.user) {
        await applyChoices(p, p.user.id, c);
        p.out.push(setCookie('fs_done', JSON.stringify({ telegram: c.telegram, push: c.push }), { maxAgeSec: 600, secure }));
        return '/alerts/done';
      }
      const email = (f.get('email') ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError('Enter your email address.');
      await requestLoginCode(p.db, email);
      p.out.push(setCookie(PENDING_COOKIE, signValue(c), { maxAgeSec: 3600, secure }));
      return `/signin/code?email=${encodeURIComponent(email)}&next=${encodeURIComponent('/alerts/done')}`;
    });
    return true;
  }

  if (path === '/alerts/done' && !post) {
    if (!p.user) { page(p, 'Alerts', '<h1>Almost there</h1><p><a href="/alerts">Set up your alerts</a></p>'); return true; }
    let done: { telegram?: boolean; push?: boolean } = {};
    try { done = JSON.parse(p.ck.fs_done ?? '{}'); } catch {}
    const alerts = await listAlerts(p.db, p.user.id);
    const steps: string[] = [];
    if (done.telegram) steps.push(`<p><a class="btn" href="${esc(telegramConnectLink(p.user.id))}" rel="noopener">Connect Telegram</a> <span class="meta">Opens Telegram; tap Start.</span></p>`);
    if (done.push) steps.push(`<p><button class="btn" type="button" data-push data-csrf="${esc(csrfToken(p))}">Turn on app notifications</button> <span class="meta" data-push-status></span></p>
      <script src="/static/push.js" defer></script>`);
    page(p, 'Your alerts are on', `<h1>Your alerts are on</h1>
      <p class="lead">We'll tell you about deals at least ${alerts[0]?.min_saving_pct ?? 25}% below normal from ${esc(alerts.map(a => a.city).join(', ') || 'your airports')}.</p>
      ${steps.length ? `<div class="panel"><h2>One more step</h2>${steps.join('')}</div>` : ''}
      <p><a href="/account#alerts">Change your alerts</a> · <a href="/">See live deals</a></p>`);
    return true;
  }
  return false;
}

export const pushConfigured = () => !!config.vapidPublicKey;
