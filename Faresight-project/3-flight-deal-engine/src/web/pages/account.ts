// /account: profile, password, alerts, channels, watches, saved deals, sessions, data export and account deletion.
import { config } from '../../config.ts';
import { money } from '../../engine/notify.ts';
import {
  addChannel, deleteAccount, deleteAlert, deleteHotelAlert, exportUserData, listAlerts, listChannels, listHotelAlerts, listSaved,
  listSavedHotels, listWatches, logoutEverywhere, removeChannel, removeWatch, setPassword, updateChannel, updateProfile, upsertAlert,
  upsertHotelAlert, UserError, type Channel,
} from '../../users/service.ts';
import { telegramConnectLink } from '../../notify/telegram.ts';
import { esc, fmtDate } from '../html.ts';
import { HttpError, readJson, send, json } from '../http.ts';
import { attempt, checkCsrf, clearSession, csrfField, csrfToken, flash, go, opt, page, postForm, requireUser, type P } from './common.ts';
import { hotelCities, origins } from './data.ts';
import { normalisePhone } from './alerts.ts';

const KIND_NAMES: Record<Channel['kind'], string> = { email: 'Email', telegram: 'Telegram', whatsapp: 'WhatsApp', push: 'App notifications' };
const day = (ts: string) => fmtDate(new Date(ts).toISOString().slice(0, 10));

export async function handleAccount(p: P): Promise<boolean> {
  const path = p.url.pathname, post = p.req.method === 'POST';
  if (path !== '/account' && !path.startsWith('/account/')) return false;
  const user = requireUser(p);
  if (!user) return true;

  if (path === '/account' && !post) {
    const [alerts, channels, watches, saved, os, hotelAlerts, savedHotels, hcs] = await Promise.all([
      listAlerts(p.db, user.id), listChannels(p.db, user.id), listWatches(p.db, user.id), listSaved(p.db, user.id), origins(p.db),
      listHotelAlerts(p.db, user.id), listSavedHotels(p.db, user.id), hotelCities(p.db)]);
    const starsSel = (v: number | null) => `<select name="min_stars" aria-label="Hotel class"><option value="">Any class</option>${[3, 4, 5].map(n => opt(String(n), `${n}★ and up`, v)).join('')}</select>`;
    const f = csrfField(p);
    const pctSel = (v: number) => `<select name="pct">${[25, 35, 50].map(n => opt(String(n), `${n}% below`, v)).join('')}</select>`;
    const body = `<h1>Your account</h1><p class="lead">${esc(user.email)}${user.email_verified_at ? '' : ' (not verified yet)'}</p>
    <nav class="row" style="margin-bottom:16px"><a href="#alerts">Alerts</a><a href="#hotel-alerts">Hotel alerts</a><a href="#channels">Channels</a><a href="#watches">Watches</a><a href="/saved">Saved deals</a><a href="#privacy">Your data</a></nav>

    <section class="panel" id="profile"><h2>Profile</h2><form method="post" action="/account/profile">${f}
      <label for="name">Name</label><input id="name" type="text" name="name" maxlength="100" value="${esc(user.name ?? '')}" autocomplete="name">
      <label for="phone">Mobile (for WhatsApp)</label><input id="phone" type="tel" name="phone" value="${esc(user.phone ?? '')}" placeholder="+91 98123 45678" autocomplete="tel">
      <label for="home">Home airport</label><select id="home" name="home_airport" class="wide"><option value="">Not set</option>${os.map(o => opt(o.origin, `${o.city} (${o.origin})`, user.home_airport)).join('')}</select>
      <label for="locale">Language</label><select id="locale" name="locale" class="wide">${opt('en', 'English', user.locale)}${opt('hi', 'हिन्दी (Hindi)', user.locale)}</select>
      <label class="inline"><input type="checkbox" name="marketing_consent" value="1"${user.marketing_consent ? ' checked' : ''}> Send me occasional news and offers (separate from deal alerts)</label>
      <p><button class="btn">Save profile</button></p></form></section>

    <section class="panel" id="password"><h2>${user.has_password ? 'Change password' : 'Set a password'}</h2>
      <p class="meta">${user.has_password ? 'You can also always sign in with an email code.' : 'Optional: you can keep signing in with an email code.'}</p>
      <form method="post" action="/account/password">${f}
      <label for="pw">New password</label><input id="pw" type="password" name="password" minlength="8" required autocomplete="new-password">
      <label for="pw2">Repeat it</label><input id="pw2" type="password" name="password2" minlength="8" required autocomplete="new-password">
      <p><button class="btn">${user.has_password ? 'Change password' : 'Set password'}</button></p></form></section>

    <section class="panel" id="alerts"><h2>My alerts</h2>
      ${alerts.length ? `<ul class="list">${alerts.map(a => `<li><form method="post" action="/account/alert" class="row">${f}<input type="hidden" name="origin" value="${esc(a.origin)}">
        <b style="min-width:140px">From ${esc(a.city)}</b> ${pctSel(a.min_saving_pct)}
        <input type="number" name="max_price" min="0" step="500" placeholder="Max ₹ (any)" value="${a.max_price ?? ''}" style="width:130px" aria-label="Maximum price">
        <label class="inline"><input type="checkbox" name="active" value="1"${a.active ? ' checked' : ''}> On</label>
        <button class="btn secondary">Save</button><button class="btn secondary" name="delete" value="1">Delete</button></form></li>`).join('')}</ul>`
        : '<p>No alerts yet.</p>'}
      <form method="post" action="/account/alert" class="row" style="margin-top:12px">${f}
        <select name="origin" aria-label="Airport">${os.filter(o => !alerts.some(a => a.origin === o.origin)).map(o => opt(o.origin, `From ${o.city}`, user.home_airport)).join('')}</select>
        ${pctSel(25)}<input type="hidden" name="active" value="1"><button class="btn">Add alert</button></form></section>

    <section class="panel" id="hotel-alerts"><h2>Hotel alerts</h2>
      ${hotelAlerts.length ? `<ul class="list">${hotelAlerts.map(a => `<li><form method="post" action="/account/hotel-alert" class="row">${f}<input type="hidden" name="city" value="${esc(a.city)}">
        <b style="min-width:140px">Hotels in ${esc(a.city_name)}</b> ${pctSel(a.min_saving_pct)} ${starsSel(a.min_stars)}
        <input type="number" name="max_per_night" min="0" step="500" placeholder="Max ₹/night (any)" value="${a.max_per_night ?? ''}" style="width:150px" aria-label="Maximum price per night">
        <label class="inline"><input type="checkbox" name="active" value="1"${a.active ? ' checked' : ''}> On</label>
        <button class="btn secondary">Save</button><button class="btn secondary" name="delete" value="1">Delete</button></form></li>`).join('')}</ul>`
        : '<p>No hotel alerts yet.</p>'}
      ${hcs.some(c => !hotelAlerts.some(a => a.city === c.code)) ? `<form method="post" action="/account/hotel-alert" class="row" style="margin-top:12px">${f}
        <select name="city" aria-label="City">${hcs.filter(c => !hotelAlerts.some(a => a.city === c.code)).map(c => opt(c.code, `Hotels in ${c.name}`, null)).join('')}</select>
        ${pctSel(25)} ${starsSel(null)}<input type="hidden" name="active" value="1"><button class="btn">Add hotel alert</button></form>` : ''}</section>

    <section class="panel" id="channels"><h2>Where we send them</h2>
      ${channels.length ? `<ul class="list">${channels.map(c => `<li><form method="post" action="/account/channel/${c.id}" class="row">${f}
        <b style="min-width:150px">${KIND_NAMES[c.kind]}</b><span class="meta" style="margin:0;min-width:160px">${esc(c.kind === 'push' ? 'this browser or phone' : c.address)}${c.active ? '' : ' · paused'}</span>
        <select name="frequency" aria-label="How often">${opt('instant', 'Every deal', c.frequency)}${opt('daily', 'Daily summary', c.frequency)}</select>
        <button class="btn secondary">Save</button>
        <button class="btn secondary" name="active" value="${c.active ? '0' : '1'}">${c.active ? 'Pause' : 'Resume'}</button>
        <button class="btn secondary" name="remove" value="1">Remove</button></form></li>`).join('')}</ul>` : '<p>No channels yet.</p>'}
      <div class="row" style="margin-top:12px">
        <a class="btn secondary" href="${esc(telegramConnectLink(user.id))}" rel="noopener">Connect Telegram</a>
        <button class="btn secondary" type="button" data-push data-csrf="${esc(csrfToken(p))}">Turn on app notifications</button><span class="meta" data-push-status></span>
      </div>
      <form method="post" action="/account/whatsapp" class="row" style="margin-top:12px">${f}
        <input type="tel" name="phone" placeholder="+91 98123 45678" aria-label="WhatsApp number" value="${esc(user.phone ?? '')}" style="max-width:220px"><button class="btn secondary">Add WhatsApp</button></form>
      <script src="/static/push.js" defer></script></section>

    <section class="panel" id="watches"><h2>Route watches</h2>
      ${watches.length ? `<ul class="list">${watches.map(w => `<li class="row"><a href="/route/${esc(w.origin)}-${esc(w.destination)}" style="min-width:200px">${esc(w.from_city)} → ${esc(w.to_city)}</a>
        <span class="meta" style="margin:0">${w.max_price ? `under ${money(w.max_price, user.currency)}` : 'any deal'}${w.live_deal_id ? ` · <a href="/deal/${w.live_deal_id}">live deal ${money(w.live_price ?? 0, user.currency)}</a>` : ''}</span>
        <form method="post" action="/account/watch/${w.id}/remove">${f}<button class="btn secondary">Remove</button></form></li>`).join('')}</ul>` : '<p>Not watching any routes.</p>'}
      <p><a class="btn secondary" href="/watch">Watch a route</a></p></section>

    <section class="panel" id="saved"><h2>Saved deals</h2>
      ${saved.length ? `<ul class="list">${saved.slice(0, 5).map(s => `<li><a href="/deal/${s.deal_id}">${esc(s.from_city)} → ${esc(s.to_city)}</a> · ${money(s.price, s.currency)}${s.status === 'live' ? '' : ` <span class="tag">${esc(s.status)}</span>`}</li>`).join('')}</ul>` : '<p>No saved deals.</p>'}
      <p><a href="/saved">All saved deals</a></p></section>

    <section class="panel" id="saved-hotels"><h2>Saved hotel deals</h2>
      ${savedHotels.length ? `<ul class="list">${savedHotels.slice(0, 5).map(s => `<li><a href="/hotel-deal/${s.hotel_deal_id}">${esc(s.hotel_name)}, ${esc(s.city_name)}</a> · ${money(s.per_night, s.currency)}/night${s.status === 'live' ? '' : ` <span class="tag">${esc(s.status)}</span>`}</li>`).join('')}</ul>` : '<p>No saved hotel deals.</p>'}
      <p><a href="/saved#hotels">All saved hotel deals</a></p></section>

    <section class="panel" id="sessions"><h2>Signed-in devices</h2><p class="meta">Lost a phone or used a shared computer? Sign out everywhere, including here.</p>
      <form method="post" action="/account/logout-all">${f}<button class="btn secondary">Sign out everywhere</button></form>
      <form method="post" action="/signout" style="margin-top:8px">${f}<button class="btn secondary">Sign out</button></form></section>

    <section class="panel" id="privacy"><h2>Your data</h2>
      <p><a class="btn secondary" href="/account/export">Download my data</a> <span class="meta">A JSON file with everything we store about you.</span></p>
      <h3>Delete my account</h3><p class="meta">This removes your alerts (flights and hotels), channels, watches, saved deals and personal details. It can't be undone.</p>
      <form method="post" action="/account/delete">${f}<label for="confirm">Type DELETE to confirm</label>
        <input id="confirm" type="text" name="confirm" autocomplete="off" required style="max-width:200px"> <button class="btn danger">Delete my account</button></form></section>
    <p class="meta">Member since ${day(user.created_at)}.</p>`;
    page(p, 'Your account', body);
    return true;
  }

  if (path === '/account/export' && !post) {
    const data = await exportUserData(p.db, user.id);
    send(p.res, 200, JSON.stringify(data, null, 2), 'application/json; charset=utf-8',
      { 'content-disposition': `attachment; filename="${config.siteName.replace(/[^\w-]+/g, '-').toLowerCase()}-my-data.json"` });
    return true;
  }

  if (path === '/account/push' && post) {
    const b = await readJson(p.req);
    checkCsrf(p, b.csrf ?? p.req.headers['x-csrf-token']);
    const sub = b.subscription ?? {};
    if (typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) throw new HttpError(400, 'Invalid push subscription');
    try {
      const c = await addChannel(p.db, user.id, { kind: 'push', address: sub.endpoint, meta: { keys: sub.keys ?? {} } });
      json(p.res, 200, { ok: true, id: c.id });
    } catch (e) { if (e instanceof UserError) return json(p.res, e.status, { error: e.message }), true; throw e; }
    return true;
  }

  if (!post) return false;
  const f = await postForm(p);
  const back = (hash: string) => `/account#${hash}`;

  if (path === '/account/profile') {
    await attempt(p, back('profile'), async () => {
      const phone = (f.get('phone') ?? '').trim();
      await updateProfile(p.db, user.id, {
        name: (f.get('name') ?? '').trim() || null, phone: phone ? normalisePhone(phone) : null,
        home_airport: f.get('home_airport') || null, locale: f.get('locale') === 'hi' ? 'hi' : 'en', marketing_consent: f.get('marketing_consent') === '1',
      });
      flash(p, 'Profile saved.');
    });
    return true;
  }
  if (path === '/account/password') {
    await attempt(p, back('password'), async () => {
      const pw = f.get('password') ?? '';
      if (pw !== f.get('password2')) throw new UserError('The two passwords are different.');
      await setPassword(p.db, user.id, pw);
      flash(p, 'Password saved.');
    });
    return true;
  }
  if (path === '/account/alert') {
    await attempt(p, back('alerts'), async () => {
      const origin = f.get('origin') ?? '';
      if (f.get('delete')) { await deleteAlert(p.db, user.id, origin); flash(p, 'Alert deleted.'); return; }
      const max = Number(f.get('max_price'));
      await upsertAlert(p.db, user.id, { origin, min_saving_pct: Number(f.get('pct')) || 25, max_price: max > 0 ? max : null, active: f.get('active') === '1' });
      flash(p, 'Alert saved.');
    });
    return true;
  }
  if (path === '/account/hotel-alert') {
    await attempt(p, back('hotel-alerts'), async () => {
      const city = f.get('city') ?? '';
      if (f.get('delete')) { await deleteHotelAlert(p.db, user.id, city); flash(p, 'Hotel alert deleted.'); return; }
      const max = Number(f.get('max_per_night'));
      const stars = Number(f.get('min_stars'));
      await upsertHotelAlert(p.db, user.id, { city, min_saving_pct: Number(f.get('pct')) || 25, max_per_night: max > 0 ? max : null,
        min_stars: stars >= 1 && stars <= 5 ? stars : null, active: f.get('active') === '1' });
      flash(p, 'Hotel alert saved.');
    });
    return true;
  }
  const ch = path.match(/^\/account\/channel\/(\d+)$/);
  if (ch) {
    await attempt(p, back('channels'), async () => {
      const id = Number(ch[1]);
      if (f.get('remove')) { await removeChannel(p.db, user.id, id); flash(p, 'Removed.'); return; }
      const freq = f.get('frequency') === 'daily' ? 'daily' : 'instant';
      const active = f.get('active');
      await updateChannel(p.db, user.id, id, active == null ? { frequency: freq } : { frequency: freq, active: active === '1' });
      flash(p, active === '0' ? 'Paused.' : 'Saved.');
    });
    return true;
  }
  if (path === '/account/whatsapp') {
    await attempt(p, back('channels'), async () => {
      await addChannel(p.db, user.id, { kind: 'whatsapp', address: normalisePhone(f.get('phone') ?? ''), frequency: 'instant' });
      flash(p, 'WhatsApp added.');
    });
    return true;
  }
  const w = path.match(/^\/account\/watch\/(\d+)\/remove$/);
  if (w) {
    await attempt(p, back('watches'), async () => { await removeWatch(p.db, user.id, Number(w[1])); flash(p, 'Stopped watching.'); });
    return true;
  }
  if (path === '/account/logout-all') {
    await logoutEverywhere(p.db, user.id);
    clearSession(p);
    flash(p, 'Signed out on every device.');
    go(p, '/signin');
    return true;
  }
  if (path === '/account/delete') {
    if ((f.get('confirm') ?? '').trim() !== 'DELETE') { flash(p, 'Type DELETE in capitals to confirm.', 'error'); go(p, back('privacy')); return true; }
    await deleteAccount(p.db, user.id);
    clearSession(p);
    p.user = null;
    page(p, 'Account deleted', `<h1>Your account is deleted</h1><p class="lead">We've removed your personal details, alerts and saved deals. Sorry to see you go.</p><p><a href="/">See live deals</a></p>`);
    return true;
  }
  return false;
}
