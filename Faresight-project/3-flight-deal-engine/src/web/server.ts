// Website, admin and booking redirect. Plain Node http; no framework needed for the MVP.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from '../config.ts';
import { getSettings, type Db } from '../db.ts';
import { reviewDeal, type Notify } from '../engine/deals.ts';
import { bookingUrl, partnerName } from '../engine/links.ts';
import { money } from '../engine/notify.ts';
import { creditsThisMonth, queueStats } from '../scheduler.ts';
import { ago, dealCard, esc, fmtDate, layout } from './html.ts';
import type { Ctx } from './http.ts';
import { HttpError } from './http.ts';
import { handleUserApi } from '../users/api.ts';
import { handleAccountPages } from './account.ts';
import { handleAdminUsers } from './admin-users.ts';

const DEAL_LIST_SQL = `
  SELECT d.*, r.origin, r.destination, r.max_stops, ao.city AS from_city, ad.city AS to_city,
         (SELECT count(*)::int FROM deal_dates WHERE deal_id = d.id AND depart >= current_date + 1) AS pairs,
         (SELECT min(depart)::text FROM deal_dates WHERE deal_id = d.id AND depart >= current_date + 1) AS first_date,
         (SELECT max(depart)::text FROM deal_dates WHERE deal_id = d.id) AS last_date
  FROM deals d JOIN routes r ON r.id = d.route_id
  JOIN airports ao ON ao.iata = r.origin JOIN airports ad ON ad.iata = r.destination`;

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
}
const notFound = (res: ServerResponse) => send(res, 404, layout('Not found', '<h1>Not found</h1><p><a href="/">See live deals</a></p>'));

function isAdmin(req: IncomingMessage) {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return user === 'admin' && pass === config.adminPassword && config.adminPassword !== '';
}
async function readForm(req: IncomingMessage) {
  let body = ''; for await (const c of req) { body += c; if (body.length > 1e5) break; }
  return new URLSearchParams(body);
}

export function startServer(db: Db, notify: Notify, port = config.port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;
      const ctx: Ctx = { db, req, res, url, notify };
      if (p.startsWith('/api/v1/') && await handleUserApi(ctx)) return;

      if (p === '/health') {
        const [d] = await db.query(`SELECT count(*) FILTER (WHERE status = 'live')::int AS live FROM deals`);
        return send(res, 200, JSON.stringify({ ok: true, live: d.live }), 'application/json');
      }

      if (p === '/' || p === '/expired') {
        const expired = p === '/expired';
        const from = url.searchParams.get('from') ?? '';
        const params: unknown[] = [];
        let where = expired ? `WHERE d.status = 'expired'` : `WHERE d.status = 'live'`;
        if (from) { params.push(from); where += ` AND r.origin = $${params.length}`; }
        const deals = await db.query(`${DEAL_LIST_SQL} ${where} ORDER BY ${expired ? 'd.expired_at DESC' : 'd.saving_pct DESC'} LIMIT 120`, params);
        const origins = await db.query(`SELECT DISTINCT r.origin, a.city FROM routes r JOIN airports a ON a.iata = r.origin WHERE r.active ORDER BY a.city`);
        const filter = `<form class="filters" method="get"><select name="from" onchange="this.form.submit()"><option value="">From any city</option>
          ${origins.map(o => `<option value="${esc(o.origin)}"${o.origin === from ? ' selected' : ''}>From ${esc(o.city)}</option>`).join('')}</select><noscript><button class="btn">Filter</button></noscript></form>`;
        const body = `<h1>${expired ? 'Expired deals' : 'Flight deals from India'}</h1>
          <p class="lead">${expired ? 'Deals that have ended, with the reason. We keep them so you can see how fares move.' : 'Only fares at least 25% below the route\'s normal price and bookable on 3 or more date pairs. Every deal is re-checked every 6 hours.'}</p>
          ${filter}${deals.length ? `<div class="grid">${deals.map(dealCard).join('')}</div>` : '<p>No deals right now. New ones appear as soon as the scanner finds them.</p>'}`;
        return send(res, 200, layout(expired ? 'Expired deals' : 'Flight deals from India', body));
      }

      const dealMatch = p.match(/^\/deal\/(\d+)$/);
      if (dealMatch) {
        const [d] = await db.query(`${DEAL_LIST_SQL} WHERE d.id = $1 AND d.status IN ('live','expired')`, [Number(dealMatch[1])]);
        if (!d) return notFound(res);
        const dates = await db.query(`SELECT id, depart::text AS depart, return_date::text AS return_date, price, normal_price, airlines, last_checked
                                      FROM deal_dates WHERE deal_id = $1 AND depart >= current_date + 1 ORDER BY price, depart LIMIT 60`, [d.id]);
        const status = d.status === 'expired'
          ? `<p class="expired">This deal has ended (${esc(d.reason ?? 'price changed')}). <a href="/">See live deals</a></p>` : '';
        const body = `${status}<h1>${esc(d.from_city)} → ${esc(d.to_city)}</h1>
          <p class="lead">Return · ${d.max_stops === 0 ? 'nonstop' : 'up to 1 stop'} · verified ${ago(d.last_verified)}</p>
          <p><span class="price">${money(d.price, d.currency)}</span> <span class="norm">normally ${money(d.normal_price, d.currency)}</span> · <span class="save">${d.saving_pct}% below</span></p>
          <p><a class="btn secondary" href="/deal/${d.id}/save">Save deal</a> <a class="btn secondary" href="/route/${esc(d.origin)}-${esc(d.destination)}">Price calendar &amp; watch this route</a></p>
          <h2>Dates that work</h2>
          <table><thead><tr><th>Depart</th><th>Return</th><th>Price</th><th></th></tr></thead><tbody>
          ${dates.map(x => `<tr><td>${fmtDate(x.depart)}</td><td>${fmtDate(x.return_date)}</td><td>${money(x.price, d.currency)}<div class="meta">${esc(x.airlines ?? '')}</div></td>
            <td>${d.status === 'live' ? `<a class="btn" rel="nofollow" href="/go/${x.id}">Book</a>` : ''}</td></tr>`).join('')}
          </tbody></table>
          <p class="meta">Prices were found on Google Flights for 1 adult in economy and checked ${ago(d.last_verified)}. The booking site shows the final price.</p>`;
        return send(res, 200, layout(`${d.from_city} to ${d.to_city} from ${money(d.price, d.currency)}`, body));
      }

      const goMatch = p.match(/^\/go\/(\d+)$/);
      if (goMatch) {
        const [x] = await db.query(`SELECT dd.id, dd.deal_id, dd.depart::text AS depart, dd.return_date::text AS return_date, r.origin, r.destination, r.max_stops
                                    FROM deal_dates dd JOIN deals d ON d.id = dd.deal_id JOIN routes r ON r.id = d.route_id WHERE dd.id = $1`, [Number(goMatch[1])]);
        if (!x) return notFound(res);
        await db.query(`INSERT INTO clicks (deal_id, deal_date_id, channel, partner) VALUES ($1,$2,$3,$4)`,
          [x.deal_id, x.id, url.searchParams.get('ch') ?? 'web', partnerName()]);
        res.writeHead(302, { location: bookingUrl(x.origin, x.destination, x.depart, x.return_date, x.max_stops) });
        return res.end();
      }

      if (p === '/api/deals') {
        const deals = await db.query(`${DEAL_LIST_SQL} WHERE d.status = 'live' ORDER BY d.saving_pct DESC LIMIT 200`);
        return send(res, 200, JSON.stringify(deals.map(d => ({ id: d.id, from: d.origin, to: d.destination, price: d.price, normal: d.normal_price,
          saving_pct: d.saving_pct, currency: d.currency, pairs: d.pairs, first_date: d.first_date, last_date: d.last_date,
          last_verified: d.last_verified, url: `${config.publicUrl}/deal/${d.id}` }))), 'application/json');
      }

      if (p.startsWith('/admin')) {
        if (!isAdmin(req)) return send(res, 401, 'Admin login required', 'text/plain', { 'www-authenticate': 'Basic realm="admin"' });
        const act = p.match(/^\/admin\/deal\/(\d+)\/(approve|reject)$/);
        if (act && req.method === 'POST') {
          await reviewDeal(db, Number(act[1]), act[2] === 'approve', notify);
          res.writeHead(303, { location: '/admin' }); return res.end();
        }
        if (p === '/admin/settings' && req.method === 'POST') {
          const form = await readForm(req);
          for (const [k, v] of form) await db.query(`UPDATE settings SET value = $2 WHERE key = $1`, [k, v.trim()]);
          res.writeHead(303, { location: '/admin#settings' }); return res.end();
        }
        if (p.startsWith('/admin/users') && await handleAdminUsers(ctx)) return;
        if (p !== '/admin') return notFound(res);
        const s = await getSettings(db);
        const [counts] = await db.query(`SELECT
            count(*) FILTER (WHERE status = 'live')::int AS live, count(*) FILTER (WHERE status = 'review')::int AS review,
            count(*) FILTER (WHERE status = 'candidate')::int AS candidate, count(*) FILTER (WHERE status = 'expired')::int AS expired,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected FROM deals`);
        const [obs] = await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE observed_at > now() - interval '24 hours')::int AS day FROM price_observations`);
        const [clk] = await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE clicked_at > now() - interval '24 hours')::int AS day FROM clicks`);
        const credits = await creditsThisMonth(db);
        const queue = await queueStats(db);
        const review = await db.query(`${DEAL_LIST_SQL} WHERE d.status = 'review' ORDER BY d.saving_pct DESC`);
        const recent = await db.query(`${DEAL_LIST_SQL} WHERE d.status IN ('live','expired','rejected') ORDER BY coalesce(d.expired_at, d.published_at, d.first_seen) DESC LIMIT 15`);
        const stat = (label: string, v: unknown) => `<span class="stat"><b>${esc(v)}</b>${esc(label)}</span>`;
        const body = `<h1>Admin</h1>
          <p><a href="/admin/users">Users</a> · <a href="/admin/users/outbox">Outbox</a></p>
          <div>${stat('live deals', counts.live)}${stat('waiting for review', counts.review)}${stat('in deep check', counts.candidate)}${stat('expired', counts.expired)}${stat('rejected', counts.rejected)}</div>
          <div>${stat('prices stored', obs.n.toLocaleString('en-IN'))}${stat('prices last 24 h', obs.day.toLocaleString('en-IN'))}${stat(`credits this month of ${Number(s.raw.monthly_credit_budget).toLocaleString('en-IN')}`, credits.toLocaleString('en-IN'))}${stat('booking clicks, 24 h', clk.day)}</div>
          <p class="meta">Fare source: <b>${esc(config.source)}</b>${config.source === 'mock' ? ' (simulated fares; add SCRAPEDO_TOKEN to .env for real ones)' : ''} · auto-approve: <b>${esc(s.raw.auto_approve)}</b></p>
          <h2>Waiting for review (${review.length})</h2>
          ${review.length ? `<table><thead><tr><th>Route</th><th>Price</th><th>Normal</th><th>Below</th><th>Dates</th><th></th></tr></thead><tbody>
            ${review.map(d => `<tr><td><a href="/deal/${d.id}">${esc(d.origin)} → ${esc(d.destination)}</a><div class="meta">${esc(d.from_city)} → ${esc(d.to_city)}</div></td>
              <td>${money(d.price, d.currency)}</td><td>${money(d.normal_price, d.currency)}</td><td>${d.saving_pct}%</td><td>${d.pairs}</td>
              <td><form method="post" action="/admin/deal/${d.id}/approve" style="display:inline"><button class="btn">Publish</button></form>
                  <form method="post" action="/admin/deal/${d.id}/reject" style="display:inline"><button class="btn secondary">Reject</button></form></td></tr>`).join('')}
            </tbody></table>` : '<p class="meta">Nothing waiting.</p>'}
          <h2>Recent decisions</h2>
          <table><thead><tr><th>Route</th><th>Status</th><th>Price</th><th>Below</th><th>Note</th></tr></thead><tbody>
          ${recent.map(d => `<tr><td>${esc(d.origin)} → ${esc(d.destination)}</td><td>${esc(d.status)}</td><td>${money(d.price, d.currency)}</td><td>${d.saving_pct}%</td><td class="meta">${esc(d.reason ?? (d.status === 'live' ? `verified ${ago(d.last_verified)}` : ''))}</td></tr>`).join('')}
          </tbody></table>
          <h2>Search queue</h2>
          <table><thead><tr><th>Kind</th><th>Status</th><th>Jobs</th></tr></thead><tbody>${queue.map(q => `<tr><td>${esc(q.kind)}</td><td>${esc(q.status)}</td><td>${q.n}</td></tr>`).join('')}</tbody></table>
          <h2 id="settings">Deal rules</h2>
          <form method="post" action="/admin/settings"><table><tbody>
          ${Object.entries(s.raw).map(([k, v]) => `<tr><td><label for="s-${esc(k)}">${esc(k)}</label></td><td><input id="s-${esc(k)}" name="${esc(k)}" value="${esc(v)}"></td></tr>`).join('')}
          </tbody></table><p><button class="btn">Save rules</button></p></form>`;
        return send(res, 200, layout('Admin', body, { admin: true }));
      }

      if (await handleAccountPages(ctx)) return;
      return notFound(res);
    } catch (e) {
      if (e instanceof HttpError) {
        if (res.headersSent) return res.end();
        const isApi = (req.url ?? '').startsWith('/api/');
        return isApi ? send(res, e.status, JSON.stringify({ error: e.message }), 'application/json')
                     : send(res, e.status, layout('Error', `<h1>${esc(e.message)}</h1>`));
      }
      console.error(e);
      send(res, 500, layout('Error', '<h1>Something went wrong</h1>'));
    }
  });
  return new Promise<typeof server>(resolve => server.listen(port, () => resolve(server)));
}
