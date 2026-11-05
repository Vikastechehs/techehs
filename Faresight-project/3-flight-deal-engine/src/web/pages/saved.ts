// Saved deals, route watches, "save this deal", and one-tap unsubscribe.
import { money } from '../../engine/notify.ts';
import { addWatch, listSaved, listSavedHotels, listWatches, saveDeal, unsaveDeal, unsaveHotelDeal } from '../../users/service.ts';
import { verifyUnsubscribeToken } from '../../notify/unsubscribe.ts';
import { esc } from '../html.ts';
import { readForm } from '../http.ts';
import { attempt, csrfField, flash, opt, page, postForm, requireUser, type P } from './common.ts';
import { origins } from './data.ts';

export async function handleSaved(p: P): Promise<boolean> {
  const path = p.url.pathname, post = p.req.method === 'POST';

  if (path === '/saved' && !post) {
    const user = requireUser(p); if (!user) return true;
    const saved = await listSaved(p.db, user.id);
    const hotels = await listSavedHotels(p.db, user.id);
    const f = csrfField(p);
    const stars = (n: number | null) => n ? ` <span class="meta" style="margin:0">${'★'.repeat(Math.min(5, n))}</span>` : '';
    page(p, 'Saved deals', `<h1>Saved deals</h1><p class="lead">Deals you saved. Ended deals stay here so you can see what you missed.</p>
      ${saved.length ? `<div class="grid">${saved.map(s => `<div class="card"><h2><a href="/deal/${s.deal_id}">${esc(s.from_city)} → ${esc(s.to_city)}</a></h2>
        <div class="price">${money(s.price, s.currency)}</div><div><span class="norm">normally ${money(s.normal_price, s.currency)}</span> · <span class="save">${Math.round(s.saving_pct)}% below</span></div>
        <div class="meta">${s.status === 'live' ? 'Live now' : `Ended`}</div>
        <form method="post" action="/deal/${s.deal_id}/unsave" style="margin-top:8px">${f}<button class="btn secondary">Remove</button></form></div>`).join('')}</div>`
        : hotels.length ? '<p>No saved flight deals.</p>' : '<p>Nothing saved yet. Open any deal and tap "Save deal".</p>'}
      ${hotels.length ? `<h2 id="hotels" style="margin-top:24px">Saved hotel deals</h2>
      <div class="grid">${hotels.map(s => `<div class="card"><h2><a href="/hotel-deal/${s.hotel_deal_id}">${esc(s.hotel_name)}</a>${stars(s.stars)}</h2>
        <div class="meta" style="margin:0">${esc(s.city_name)}</div>
        <div class="price">${money(s.per_night, s.currency)}<span class="meta" style="margin:0"> /night</span></div><div><span class="norm">normally ${money(s.normal_per_night, s.currency)}</span> · <span class="save">${Math.round(s.saving_pct)}% below</span></div>
        <div class="meta">${s.status === 'live' ? 'Live now' : 'Ended'}</div>
        <form method="post" action="/saved/hotel/${s.hotel_deal_id}/remove" style="margin-top:8px">${f}<button class="btn secondary">Remove</button></form></div>`).join('')}</div>` : ''}
      <p><a href="/">See live deals</a></p>`);
    return true;
  }

  const hm = path.match(/^\/saved\/hotel\/(\d{1,9})\/remove$/);
  if (hm && post) {
    const user = requireUser(p); if (!user) return true;
    await postForm(p);
    await attempt(p, '/saved#hotels', async () => { await unsaveHotelDeal(p.db, user.id, Number(hm[1])); flash(p, 'Removed.'); return '/saved'; });
    return true;
  }

  const dm = path.match(/^\/deal\/(\d+)\/(save|unsave)$/);
  if (dm) {
    const user = requireUser(p); if (!user) return true;
    const id = Number(dm[1]);
    if (!post) {
      const [d] = await p.db.query(`SELECT d.id, ao.city AS from_city, ad.city AS to_city, d.price, d.currency FROM deals d JOIN routes r ON r.id = d.route_id
        JOIN airports ao ON ao.iata = r.origin JOIN airports ad ON ad.iata = r.destination WHERE d.id = $1 AND d.status IN ('live','expired')`, [id]);
      if (!d) return false;
      page(p, 'Save deal', `<h1>Save ${esc(d.from_city)} → ${esc(d.to_city)}?</h1><p class="lead">${money(d.price, d.currency)} return. You'll find it under Saved deals.</p>
        <form method="post" action="/deal/${id}/${dm[2]}">${csrfField(p)}<button class="btn">${dm[2] === 'save' ? 'Save deal' : 'Remove'}</button> <a href="/deal/${id}">Back to the deal</a></form>`);
      return true;
    }
    await postForm(p);
    await attempt(p, `/deal/${id}`, async () => {
      if (dm[2] === 'save') { await saveDeal(p.db, user.id, id); flash(p, 'Saved. Find it under Saved deals.'); return `/deal/${id}`; }
      await unsaveDeal(p.db, user.id, id); flash(p, 'Removed.'); return '/saved';
    });
    return true;
  }

  if (path === '/watch') {
    const user = requireUser(p); if (!user) return true;
    if (post) {
      const f = await postForm(p);
      await attempt(p, '/watch', async () => {
        const max = Number(f.get('max_price'));
        const w = await addWatch(p.db, user.id, { origin: (f.get('origin') ?? '').toUpperCase(), destination: (f.get('destination') ?? '').toUpperCase(), max_price: max > 0 ? max : null });
        flash(p, `Watching ${w.from_city} → ${w.to_city}. We'll tell you when it has a deal.`);
        return '/account#watches';
      });
      return true;
    }
    const os = await origins(p.db);
    const o = (p.url.searchParams.get('origin') ?? user.home_airport ?? os[0]?.origin ?? '').toUpperCase();
    const dests = await p.db.query(`SELECT r.destination, a.city FROM routes r JOIN airports a ON a.iata = r.destination WHERE r.active AND r.origin = $1 ORDER BY a.city`, [o]);
    const dsel = (p.url.searchParams.get('destination') ?? '').toUpperCase();
    const watches = await listWatches(p.db, user.id);
    page(p, 'Watch a route', `<div class="narrow"><h1>Watch a route</h1><p class="lead">We'll message you as soon as this route has a deal, optionally only under your price.</p>
      <form method="get" action="/watch" class="row"><label for="o" class="inline">From</label><select id="o" name="origin" onchange="this.form.submit()">${os.map(x => opt(x.origin, `${x.city} (${x.origin})`, o)).join('')}</select><noscript><button class="btn secondary">Show</button></noscript></form>
      <form method="post" action="/watch" class="panel" style="margin-top:12px">${csrfField(p)}<input type="hidden" name="origin" value="${esc(o)}">
        <label for="d">To</label><select id="d" name="destination" class="wide">${dests.map(x => opt(x.destination, `${x.city} (${x.destination})`, dsel)).join('')}</select>
        <label for="mp">Only if under (₹, optional)</label><input id="mp" type="number" name="max_price" min="0" step="500" placeholder="Any deal">
        <p><button class="btn">Watch this route</button></p></form>
      <p class="meta">You're watching ${watches.length} route${watches.length === 1 ? '' : 's'}. <a href="/account#watches">Manage</a></p></div>`);
    return true;
  }

  if (path === '/unsubscribe') {
    const t = post ? ((await readForm(p.req)).get('t') ?? '') : (p.url.searchParams.get('t') ?? '');
    const v = t ? verifyUnsubscribeToken(t) : null;
    if (!v) { page(p, 'Link not valid', '<h1>This link is not valid</h1><p>It may be cut off or out of date. You can manage your messages from <a href="/account#channels">your account</a>.</p>', 400); return true; }
    const [c] = await p.db.query(`SELECT id, kind, address, active FROM notification_channels WHERE id = $1 AND user_id = $2`, [v.channelId, v.userId]);
    if (!c) { page(p, 'Already stopped', '<h1>Already stopped</h1><p>You won\'t get these messages any more.</p>'); return true; }
    const what = { email: 'emails', telegram: 'Telegram messages', whatsapp: 'WhatsApp messages', push: 'app notifications' }[c.kind as string] ?? 'messages';
    if (post) {
      await p.db.query(`UPDATE notification_channels SET active = false WHERE id = $1 AND user_id = $2`, [v.channelId, v.userId]);
      await p.db.query(`INSERT INTO user_events (user_id, kind, data) VALUES ($1, 'unsubscribe', $2)`, [v.userId, JSON.stringify({ channel_id: v.channelId })]);
      page(p, 'Stopped', `<h1>Done. No more deal ${esc(what)}.</h1><p class="lead">Changed your mind? Turn them back on from <a href="/account#channels">your account</a>.</p>`);
      return true;
    }
    page(p, 'Stop these messages', `<div class="narrow"><h1>Stop these messages?</h1>
      <p class="lead">You'll stop getting deal ${esc(what)}${c.kind === 'email' || c.kind === 'whatsapp' ? ` at <b>${esc(c.address)}</b>` : ''}.</p>
      ${c.active ? `<form method="post" action="/unsubscribe"><input type="hidden" name="t" value="${esc(t)}"><button class="btn">Stop these messages</button></form>` : '<p>They are already stopped.</p>'}</div>`);
    return true;
  }
  return false;
}
