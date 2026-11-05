// Small HTML helpers: escaping, layout and the deal card.
import { config } from '../config.ts';
import { money } from '../engine/notify.ts';

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function ago(ts: string | Date | null) {
  if (!ts) return 'not yet';
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.round(h / 24)} days ago`;
}

export const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthYear = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** `user`: undefined = unknown (nav shows "Account"), null = signed out ("Sign in"), object = signed in. */
export function layout(title: string, body: string, opts: { admin?: boolean; user?: { name: string | null; email: string } | null } = {}) {
  const who = opts.user === null ? '<a href="/signin">Sign in</a>' : `<a href="/account">${opts.user?.name ? esc(opts.user.name.split(' ')[0]) : 'Account'}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(config.siteName)}</title><meta name="description" content="Flight deals from India, checked every few hours against each route's real normal price.">
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1D4ED8"><link rel="apple-touch-icon" href="/static/apple-touch-icon.png"><link rel="icon" href="/static/icon-192.png">
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--quiet:#6b6b66;--line:#e4e3de;--accent:#1a5fd0;--good:#1f7a3a;--bad:#a33}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#21211f;--ink:#f0efea;--quiet:#a3a29c;--line:#34332f;--accent:#7aa7ff;--good:#6fcf8a;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}header,main,footer{max-width:960px;margin:0 auto;padding:16px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}header a.brand{font-weight:700;font-size:20px;color:var(--ink);text-decoration:none}
.lead{color:var(--quiet);margin:0 0 16px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;display:block;color:inherit;text-decoration:none}
.card h2{font-size:18px;margin:0 0 4px}.price{font-size:26px;font-weight:700}.norm{color:var(--quiet)}.save{color:var(--good);font-weight:600}
.meta{color:var(--quiet);font-size:14px;margin-top:8px}.tag{display:inline-block;font-size:12px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;margin-right:6px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:15px}th{color:var(--quiet);font-weight:600}
.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer;text-decoration:none}
.btn.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}.expired{background:#fff3f3;color:var(--bad);border:1px solid #f0caca;border-radius:8px;padding:10px 12px}
@media (prefers-color-scheme:dark){.expired{background:#3a2222;border-color:#5a3333}}
form.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}select,input{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
footer{color:var(--quiet);font-size:13px}.stat{display:inline-block;margin:0 24px 12px 0}.stat b{display:block;font-size:22px}
nav a{white-space:nowrap}nav a.cta{font-weight:600}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 16px}.panel h2{margin:0 0 8px;font-size:19px}
.narrow{max-width:460px}label{display:block;margin:10px 0 4px;font-weight:600;font-size:15px}label.inline{display:inline-flex;gap:6px;align-items:center;font-weight:400;margin:4px 12px 4px 0}
input[type=text],input[type=email],input[type=password],input[type=tel],input[type=number],select.wide{width:100%;max-width:420px;padding:10px;min-height:44px}
.btn{min-height:40px}.btn.danger{background:var(--bad)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:8px 14px;background:var(--card);cursor:pointer}
.chip:has(input:checked){border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--card))}
.flash{border-radius:8px;padding:10px 12px;margin:0 0 16px;border:1px solid var(--line);background:var(--card)}.flash.error{color:var(--bad);border-color:var(--bad)}.flash.ok{color:var(--good);border-color:var(--good)}
.tabs{display:flex;gap:4px;margin:0 0 12px}.tabs a{padding:8px 14px;border-radius:8px;text-decoration:none;border:1px solid var(--line);color:var(--ink)}.tabs a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.list{list-style:none;padding:0;margin:0}.list li{padding:10px 0;border-bottom:1px solid var(--line)}.list li:last-child{border-bottom:0}
.months{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}.cal{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.cal h3{margin:0 0 8px;font-size:16px}.cal .wk{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}.cal .d{min-height:42px;border-radius:6px;font-size:11px;padding:3px;color:var(--quiet)}
.cal .d b{display:block;font-size:12px;color:var(--ink)}.cal .hd{font-size:11px;color:var(--quiet);text-align:center}
.lv-deal{background:#cdebd5}.lv-low{background:#e6f4ea}.lv-mid{background:color-mix(in srgb,var(--line) 60%,var(--card))}.lv-high{background:#f7dede}
@media (prefers-color-scheme:dark){.lv-deal{background:#1e4a2b}.lv-low{background:#233a2a}.lv-high{background:#4a2626}}
.legend span{display:inline-block;width:14px;height:14px;border-radius:4px;vertical-align:middle;margin:0 4px 0 12px}
@media (max-width:600px){th,td{padding:8px;font-size:14px}header{gap:8px}.cal .d{min-height:36px}}
</style></head><body><header><a class="brand" href="/">${esc(config.siteName)}</a><nav>${opts.admin ? '<a href="/admin">Admin</a> · ' : ''}<a href="/">Live deals</a> · <a href="/explore">Explore</a> · <a class="cta" href="/alerts">Get free alerts</a> · ${who}</nav></header>
<main>${body}</main><footer>Every deal is re-checked every few hours. "Normally" is the median price for that route and season over the last 30 days. Prices can change at any moment; the booking site shows the final price. <a href="/expired">Expired deals</a></footer>
<script>if('serviceWorker' in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}))</script></body></html>`;
}

export function dealCard(d: any) {
  const stops = d.max_stops === 0 ? 'nonstop' : 'up to 1 stop';
  const window = d.first_date ? (monthYear(d.first_date) === monthYear(d.last_date) ? monthYear(d.first_date) : `${monthYear(d.first_date)} – ${monthYear(d.last_date)}`) : '';
  return `<a class="card" href="/deal/${d.id}">
  <h2>${esc(d.from_city)} → ${esc(d.to_city)}</h2>
  <div class="meta">Return · ${stops}</div>
  <div class="price">${money(d.price, d.currency)}</div>
  <div><span class="norm">normally ${money(d.normal_price, d.currency)}</span> · <span class="save">${d.saving_pct}% below</span></div>
  <div class="meta">${esc(window)} · ${d.pairs} date pairs · verified ${ago(d.last_verified)}</div></a>`;
}
