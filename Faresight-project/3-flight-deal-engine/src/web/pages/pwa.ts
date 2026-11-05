// Installable web app: manifest, service worker, icons, push key, offline page.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config.ts';
import { json, send } from '../http.ts';
import { page, type P } from './common.ts';

const STATIC_DIR = join(import.meta.dirname, '..', 'static');
const TYPES: Record<string, string> = { png: 'image/png', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', json: 'application/json' };

export function manifest() {
  return {
    name: config.siteName, short_name: config.siteName, description: 'Flight deals from India, checked against each route\'s real normal price.',
    start_url: '/?source=pwa', scope: '/', display: 'standalone', background_color: '#F5F7FA', theme_color: '#1D4ED8',
    icons: [
      { src: '/static/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/static/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [{ name: 'Live deals', url: '/' }, { name: 'Explore', url: '/explore' }, { name: 'Saved deals', url: '/saved' }],
  };
}

export async function handlePwa(p: P): Promise<boolean> {
  const path = p.url.pathname;
  if (p.req.method !== 'GET' && p.req.method !== 'HEAD') return false;
  if (path === '/manifest.webmanifest') {
    send(p.res, 200, JSON.stringify(manifest()), 'application/manifest+json; charset=utf-8', { 'cache-control': 'public, max-age=3600' });
    return true;
  }
  if (path === '/sw.js') {
    send(p.res, 200, await readFile(join(STATIC_DIR, 'sw.js'), 'utf8'), TYPES.js, { 'cache-control': 'no-cache', 'service-worker-allowed': '/' });
    return true;
  }
  if (path === '/push/key') {
    json(p.res, 200, { key: config.vapidPublicKey || null });
    return true;
  }
  if (path === '/offline') {
    page(p, 'Offline', '<h1>You\'re offline</h1><p class="lead">Deals need a connection, because prices change all the time. Reconnect and try again.</p><p><a class="btn" href="/">Try again</a></p>');
    return true;
  }
  const m = path.match(/^\/static\/([a-z0-9-]+)\.(png|js|svg|json)$/);
  if (m) {
    let body: Buffer;
    try { body = await readFile(join(STATIC_DIR, `${m[1]}.${m[2]}`)); } catch { return false; }
    p.res.writeHead(200, { 'content-type': TYPES[m[2]], 'cache-control': 'public, max-age=86400', 'content-length': body.length });
    p.res.end(p.req.method === 'HEAD' ? undefined : body);
    return true;
  }
  return false;
}
