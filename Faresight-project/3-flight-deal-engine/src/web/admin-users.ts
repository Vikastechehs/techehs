// /admin/users pages: user list with search and counts, user detail with admin actions, and the message outbox.
// Called by server.ts only after the admin login check, for paths starting with /admin/users.
import type { Db } from '../db.ts';
import { deleteAccount } from '../users/service.ts';
import { ago, esc, layout } from './html.ts';
import { readForm, redirect, send, type Handler } from './http.ts';

const stat = (label: string, v: unknown) => `<span class="stat"><b>${esc(v)}</b>${esc(label)}</span>`;
const when = (ts: unknown) => (ts ? `<span title="${esc(new Date(ts as string).toISOString())}">${esc(ago(ts as string))}</span>` : '<span class="meta">never</span>');
const nav = `<p class="meta"><a href="/admin">← Admin</a> · <a href="/admin/users">Users</a> · <a href="/admin/users/outbox">Outbox</a></p>`;
const table = (head: string[], rows: string[], empty = 'None.') => rows.length
  ? `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
  : `<p class="meta">${esc(empty)}</p>`;
const short = (s: unknown, n = 80) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };

/** Records an admin action in the user's audit trail (plain SQL so it never depends on other modules). */
async function audit(db: Db, userId: number, kind: string) {
  await db.query(`INSERT INTO user_events (user_id, kind, data) VALUES ($1, $2, $3)`, [userId, kind, JSON.stringify({ by: 'admin' })]);
}

async function listPage(db: Db, q: string) {
  const [c] = await db.query(`SELECT
      count(*) FILTER (WHERE status <> 'deleted')::int AS total,
      count(*) FILTER (WHERE status = 'active')::int AS active,
      count(*) FILTER (WHERE status = 'disabled')::int AS disabled,
      count(*) FILTER (WHERE status <> 'deleted' AND created_at > now() - interval '7 days')::int AS week,
      (SELECT count(DISTINCT a.user_id)::int FROM alert_subscriptions a JOIN users u ON u.id = a.user_id WHERE a.active AND u.status = 'active') AS with_alerts
    FROM users`);
  const kinds = await db.query(`SELECT c.kind, count(*)::int AS n FROM notification_channels c JOIN users u ON u.id = c.user_id
    WHERE c.active AND u.status = 'active' GROUP BY c.kind ORDER BY c.kind`);
  const params: unknown[] = [];
  let where = `WHERE u.status <> 'deleted'`;
  if (q) { params.push(`%${q.toLowerCase()}%`); where += ` AND (lower(u.email) LIKE $1 OR lower(coalesce(u.name, '')) LIKE $1)`; }
  const users = await db.query(`
    SELECT u.id, u.email, u.name, u.home_airport, u.role, u.status, u.created_at, u.last_login_at,
      (SELECT count(*)::int FROM alert_subscriptions a WHERE a.user_id = u.id AND a.active) AS alerts,
      (SELECT string_agg(DISTINCT c.kind, ', ') FROM notification_channels c WHERE c.user_id = u.id AND c.active) AS channels
    FROM users u ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT 200`, params);
  const body = `<h1>Users</h1>${nav}
    <div>${stat('users', c.total)}${stat('active', c.active)}${stat('disabled', c.disabled)}${stat('signed up last 7 days', c.week)}${stat('with alerts', c.with_alerts)}</div>
    <div>${kinds.length ? kinds.map(k => stat(`${k.kind} channels`, k.n)).join('') : '<p class="meta">No active notification channels yet.</p>'}</div>
    <form class="filters" method="get" action="/admin/users"><input name="q" value="${esc(q)}" placeholder="Search email or name" aria-label="Search email or name">
      <button class="btn">Search</button>${q ? ' <a href="/admin/users">Clear</a>' : ''}</form>
    ${table(['Email', 'Name', 'Home', 'Alerts', 'Channels', 'Created', 'Last login', 'Status'], users.map(u => `<tr>
      <td><a href="/admin/users/${u.id}">${esc(u.email)}</a>${u.role === 'admin' ? ' <span class="tag">admin</span>' : ''}</td>
      <td>${esc(u.name ?? '')}</td><td>${esc(u.home_airport ?? '')}</td><td>${u.alerts}</td><td>${esc(u.channels ?? '')}</td>
      <td>${when(u.created_at)}</td><td>${when(u.last_login_at)}</td><td>${esc(u.status)}</td></tr>`), q ? 'No users match.' : 'No users yet.')}
    ${users.length === 200 ? '<p class="meta">Showing the newest 200. Search to narrow down.</p>' : ''}`;
  return layout('Users', body, { admin: true });
}

async function detailPage(db: Db, id: number) {
  const [u] = await db.query(`SELECT *, password_hash IS NOT NULL AS has_password FROM users WHERE id = $1`, [id]);
  if (!u) return null;
  const alerts = await db.query(`SELECT a.*, ap.city FROM alert_subscriptions a LEFT JOIN airports ap ON ap.iata = a.origin WHERE a.user_id = $1 ORDER BY a.created_at`, [id]);
  const channels = await db.query(`SELECT * FROM notification_channels WHERE user_id = $1 ORDER BY created_at`, [id]);
  const watches = await db.query(`SELECT w.*, r.origin, r.destination FROM route_watches w JOIN routes r ON r.id = w.route_id WHERE w.user_id = $1 ORDER BY w.created_at`, [id]);
  const saved = await db.query(`SELECT s.created_at, d.id, d.status, d.price, d.currency, r.origin, r.destination
    FROM saved_deals s JOIN deals d ON d.id = s.deal_id JOIN routes r ON r.id = d.route_id WHERE s.user_id = $1 ORDER BY s.created_at DESC`, [id]);
  const notes = await db.query(`SELECT n.*, c.kind AS channel_kind FROM notifications n LEFT JOIN notification_channels c ON c.id = n.channel_id
    WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 30`, [id]);
  const events = await db.query(`SELECT kind, data, created_at FROM user_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);
  const [sess] = await db.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND expires_at > now()`, [id]);
  const action = (name: string, label: string, confirm?: string, secondary = true) =>
    `<form method="post" action="/admin/users/${id}/${name}" style="display:inline"${confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : ''}><button class="btn${secondary ? ' secondary' : ''}">${esc(label)}</button></form> `;
  const deleted = u.status === 'deleted';
  const body = `<h1>${esc(u.email)}</h1>${nav}
    <table><tbody>
      <tr><th>Name</th><td>${esc(u.name ?? '')}</td></tr><tr><th>Phone</th><td>${esc(u.phone ?? '')}</td></tr>
      <tr><th>Home airport</th><td>${esc(u.home_airport ?? '')}</td></tr><tr><th>Market</th><td>${esc(u.market)} · ${esc(u.currency)} · ${esc(u.locale)}</td></tr>
      <tr><th>Role</th><td>${esc(u.role)}</td></tr><tr><th>Status</th><td><b>${esc(u.status)}</b></td></tr>
      <tr><th>Email verified</th><td>${when(u.email_verified_at)}</td></tr><tr><th>Password</th><td>${u.has_password ? 'set' : 'none (code sign-in only)'}</td></tr>
      <tr><th>Marketing consent</th><td>${u.marketing_consent ? 'yes' : 'no'}</td></tr>
      <tr><th>Created</th><td>${when(u.created_at)}</td></tr><tr><th>Last login</th><td>${when(u.last_login_at)}</td></tr>
      <tr><th>Active sessions</th><td>${sess.n}</td></tr>
    </tbody></table>
    ${deleted ? '<p class="meta">This account was deleted; personal data has been erased.</p>' : `<p>
      ${u.status === 'active' ? action('disable', 'Disable', 'Disable this account and sign it out?') : action('enable', 'Enable', undefined, false)}
      ${action('logout-all', 'Sign out everywhere', 'Sign this user out on every device?')}
      ${action('delete', 'Delete account', 'Permanently erase this user\'s personal data? This cannot be undone.')}</p>`}
    <h2>City alerts (${alerts.length})</h2>
    ${table(['From', 'Min saving', 'Max price', 'Regions', 'Active', 'Created'], alerts.map(a => `<tr><td>${esc(a.origin)} <span class="meta">${esc(a.city ?? '')}</span></td>
      <td>${a.min_saving_pct}%</td><td>${esc(a.max_price ?? '')}</td><td>${esc((a.regions ?? []).join(', ') || 'all')}</td><td>${a.active ? 'yes' : 'no'}</td><td>${when(a.created_at)}</td></tr>`))}
    <h2>Channels (${channels.length})</h2>
    ${table(['Kind', 'Address', 'Frequency', 'Verified', 'Active', 'Created'], channels.map(c => `<tr><td>${esc(c.kind)}</td><td>${esc(short(c.address, 60))}</td>
      <td>${esc(c.frequency)}</td><td>${when(c.verified_at)}</td><td>${c.active ? 'yes' : 'no'}</td><td>${when(c.created_at)}</td></tr>`))}
    <h2>Route watches (${watches.length})</h2>
    ${table(['Route', 'Max price', 'Created'], watches.map(w => `<tr><td>${esc(w.origin)} → ${esc(w.destination)}</td><td>${esc(w.max_price ?? '')}</td><td>${when(w.created_at)}</td></tr>`))}
    <h2>Saved deals (${saved.length})</h2>
    ${table(['Deal', 'Status', 'Price', 'Saved'], saved.map(s => `<tr><td><a href="/deal/${s.id}">${esc(s.origin)} → ${esc(s.destination)}</a></td><td>${esc(s.status)}</td>
      <td>${esc(Math.round(s.price))} ${esc(s.currency)}</td><td>${when(s.created_at)}</td></tr>`))}
    <h2>Recent notifications</h2>
    ${table(['Kind', 'Deal', 'Channel', 'Status', 'Attempts', 'Error', 'Created', 'Sent'], notes.map(n => `<tr><td>${esc(n.kind)}</td>
      <td>${n.deal_id ? `<a href="/deal/${n.deal_id}">${n.deal_id}</a>` : ''}</td><td>${esc(n.channel_kind ?? '')}</td><td>${esc(n.status)}</td><td>${n.attempts}</td>
      <td class="meta">${esc(short(n.error))}</td><td>${when(n.created_at)}</td><td>${when(n.sent_at)}</td></tr>`))}
    <h2>Account events</h2>
    ${table(['Event', 'Details', 'When'], events.map(e => `<tr><td>${esc(e.kind)}</td><td class="meta">${esc(short(e.data == null ? '' : typeof e.data === 'string' ? e.data : JSON.stringify(e.data), 120))}</td><td>${when(e.created_at)}</td></tr>`))}`;
  return layout(`User ${u.email}`, body, { admin: true });
}

async function outboxPage(db: Db) {
  const rows = await db.query(`SELECT id, channel, to_address, subject, body, status, attempts, error, created_at, sent_at FROM outbox ORDER BY id DESC LIMIT 100`);
  const byStatus = await db.query(`SELECT status, count(*)::int AS n FROM outbox GROUP BY status ORDER BY status`);
  const stats = await db.query(`SELECT kind, status, count(*)::int AS n FROM notifications WHERE created_at > now() - interval '24 hours' GROUP BY kind, status ORDER BY kind, status`);
  const body = `<h1>Outbox</h1>${nav}
    <p class="lead">Every outgoing message (sign-in codes, deal alerts) is written here first, then delivered. "logged" means no provider is set up, so the message was only stored.</p>
    <div>${byStatus.length ? byStatus.map(s => stat(`${s.status} (all time)`, s.n)).join('') : '<p class="meta">Outbox is empty.</p>'}</div>
    <h2>Notifications, last 24 hours</h2>
    ${table(['Kind', 'Status', 'Count'], stats.map(s => `<tr><td>${esc(s.kind)}</td><td>${esc(s.status)}</td><td>${s.n}</td></tr>`), 'No notifications in the last 24 hours.')}
    <h2>Latest 100 messages</h2>
    ${table(['#', 'Channel', 'To', 'Subject / text', 'Status', 'Attempts', 'Error', 'Created', 'Sent'], rows.map(r => `<tr><td>${r.id}</td><td>${esc(r.channel)}</td>
      <td>${esc(short(r.to_address, 40))}</td><td>${esc(short(r.subject || r.body, 70))}</td><td>${esc(r.status)}</td><td>${r.attempts}</td>
      <td class="meta">${esc(short(r.error))}</td><td>${when(r.created_at)}</td><td>${when(r.sent_at)}</td></tr>`))}`;
  return layout('Outbox', body, { admin: true });
}

export const handleAdminUsers: Handler = async ({ db, req, res, url }) => {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (p === '/admin/users') { send(res, 200, await listPage(db, (url.searchParams.get('q') ?? '').trim())); return true; }
    if (p === '/admin/users/outbox') { send(res, 200, await outboxPage(db)); return true; }
    const m = p.match(/^\/admin\/users\/(\d+)$/);
    if (m) {
      const html = await detailPage(db, Number(m[1]));
      if (!html) return false;
      send(res, 200, html); return true;
    }
    return false;
  }
  const act = p.match(/^\/admin\/users\/(\d+)\/(disable|enable|logout-all|delete)$/);
  if (req.method !== 'POST' || !act) return false;
  const id = Number(act[1]);
  await readForm(req);   // drain the (empty) form body
  const [u] = await db.query(`SELECT id, status FROM users WHERE id = $1`, [id]);
  if (!u) return false;
  if (u.status !== 'deleted') {
    if (act[2] === 'disable') {
      await db.query(`UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1 AND status = 'active'`, [id]);
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      await audit(db, id, 'admin_disable');
    } else if (act[2] === 'enable') {
      await db.query(`UPDATE users SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'disabled'`, [id]);
      await audit(db, id, 'admin_enable');
    } else if (act[2] === 'logout-all') {
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      await audit(db, id, 'admin_logout_all');
    } else {
      await audit(db, id, 'admin_delete');
      await deleteAccount(db, id);
    }
  }
  redirect(res, `/admin/users/${id}`);
  return true;
};
