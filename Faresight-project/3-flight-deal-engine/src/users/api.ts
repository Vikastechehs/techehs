// JSON API /api/v1 for the website and the Android app (owned by the accounts module).
// Web clients authenticate with the fs_session cookie, the app with "Authorization: Bearer <token>".
import type { IncomingMessage } from 'node:http';
import { config } from '../config.ts';
import { clientIp, HttpError, json, readJson, setCookie, type Ctx, type Handler } from '../web/http.ts';
import * as U from './service.ts';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const secure = config.publicUrl.startsWith('https');
const sessionCookie = (token: string) => setCookie(U.SESSION_COOKIE, token, { maxAgeSec: config.sessionDays * 86400, secure });
const clearCookie = () => setCookie(U.SESSION_COOKIE, '', { maxAgeSec: 0, secure });

/** Cookie-authenticated writes must come from our own pages: Origin (when sent) has to match Host or PUBLIC_URL. */
function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || host === new URL(config.publicUrl).host;
  } catch { return false; }
}

const meta = (req: IncomingMessage, body: Record<string, any>): U.SessionMeta =>
  ({ userAgent: String(req.headers['user-agent'] ?? ''), ip: clientIp(req), kind: body.client === 'app' ? 'app' : 'web' });

export const handleUserApi: Handler = async (ctx) => {
  const m = ctx.url.pathname.match(/^\/api\/v1\/(.+?)\/?$/);
  if (!m) return false;
  try { return await route(ctx, m[1], ctx.req.method ?? 'GET'); }
  catch (e) {
    if (e instanceof U.UserError || e instanceof HttpError) { json(ctx.res, e.status, { error: e.message }); return true; }
    throw e;
  }
};

async function route({ db, req, res, url }: Ctx, path: string, method: string): Promise<boolean> {
  const tok = U.tokenFromRequest(req);
  if (!SAFE.has(method) && tok?.via !== 'bearer' && !sameOrigin(req)) throw new HttpError(403, 'Cross-site request refused');
  const ok = (data: unknown = { ok: true }, status = 200) => { json(res, status, data); return true; };

  // Public lists
  if (method === 'GET' && path === 'airports') {
    return ok({ airports: await db.query(`SELECT a.iata, a.city, a.country,
      EXISTS (SELECT 1 FROM routes r WHERE r.origin = a.iata AND r.active) AS is_origin FROM airports a ORDER BY a.city`) });
  }
  if (method === 'GET' && path === 'routes') {
    const from = url.searchParams.get('from')?.toUpperCase() || null;
    return ok({ routes: await db.query(`SELECT r.id, r.origin, r.destination, ao.city AS from_city, ad.city AS to_city, ad.country AS to_country, r.haul
      FROM routes r JOIN airports ao ON ao.iata = r.origin JOIN airports ad ON ad.iata = r.destination
      WHERE r.active AND ($1::text IS NULL OR r.origin = $1) ORDER BY ao.city, ad.city`, [from]) });
  }

  if (method === 'GET' && path === 'hotel-cities') {
    return ok({ cities: await db.query(`SELECT code, name, country, region FROM hotel_cities WHERE active ORDER BY region NULLS LAST, priority DESC, name`) });
  }

  // Sign-in
  if (path.startsWith('auth/') && method === 'POST') {
    const body = await readJson(req);
    const signedIn = (a: U.Auth, status = 200) => {
      json(res, status, { user: a.user, token: a.token }, body.client === 'app' ? {} : { 'set-cookie': sessionCookie(a.token) });
      return true;
    };
    switch (path) {
      case 'auth/code': return ok(await U.requestLoginCode(db, body.email));
      case 'auth/verify': {
        const a = await U.verifyLoginCode(db, body.email, String(body.code ?? ''), meta(req, body));
        return a ? signedIn(a) : ok({ error: 'That code is wrong or has expired' }, 400);
      }
      case 'auth/register': return signedIn(await U.registerWithPassword(db, { email: body.email, password: body.password, name: body.name }, meta(req, body)), 201);
      case 'auth/login': {
        const a = await U.loginWithPassword(db, body.email, String(body.password ?? ''), meta(req, body));
        return a ? signedIn(a) : ok({ error: 'Wrong email or password' }, 401);
      }
      case 'auth/logout':
        if (tok) await U.logout(db, tok.token);
        json(res, 200, { ok: true }, { 'set-cookie': clearCookie() }); return true;
    }
  }

  if (!(path === 'me' || path.startsWith('me/') || path === 'auth/logout-all')) return false;
  const user = tok ? await U.userFromToken(db, tok.token) : null;
  if (!user) return ok({ error: 'Sign in required' }, 401);
  const uid = user.id;
  const body = SAFE.has(method) ? {} : await readJson(req);

  if (path === 'auth/logout-all' && method === 'POST') {
    await U.logoutEverywhere(db, uid);
    json(res, 200, { ok: true }, { 'set-cookie': clearCookie() }); return true;
  }

  // Profile and privacy
  if (path === 'me') {
    if (method === 'GET') return ok({ user });
    if (method === 'PATCH') {
      const patch: U.ProfilePatch = {};
      for (const k of ['name', 'phone', 'home_airport', 'locale', 'marketing_consent'] as const) if (k in body) (patch as any)[k] = body[k];
      return ok({ user: await U.updateProfile(db, uid, patch) });
    }
    if (method === 'DELETE') {
      if (body.confirm !== 'DELETE') throw new U.UserError('Send {"confirm":"DELETE"} to delete your account');
      await U.deleteAccount(db, uid);
      json(res, 200, { ok: true }, { 'set-cookie': clearCookie() }); return true;
    }
  }
  if (path === 'me/password' && method === 'POST') {
    if (user.has_password && !(await U.checkUserPassword(db, uid, String(body.current_password ?? ''))))
      throw new U.UserError('Current password is wrong', 403);
    await U.setPassword(db, uid, body.password);
    return ok();
  }
  if (path === 'me/export' && method === 'GET') {
    json(res, 200, await U.exportUserData(db, uid), { 'content-disposition': `attachment; filename="faresight-data-${uid}.json"` });
    return true;
  }

  // Alerts, channels, watches, saved deals
  if (path === 'me/alerts') {
    if (method === 'GET') return ok({ alerts: await U.listAlerts(db, uid) });
    if (method === 'POST') return ok({ alert: await U.upsertAlert(db, uid, body as any) });
  }
  let p = path.match(/^me\/alerts\/([A-Za-z]{3})$/);
  if (p && method === 'DELETE') { await U.deleteAlert(db, uid, p[1]); return ok(); }

  if (path === 'me/channels') {
    if (method === 'GET') return ok({ channels: await U.listChannels(db, uid) });
    if (method === 'POST') return ok({ channel: await U.addChannel(db, uid, body as any) }, 201);
  }
  p = path.match(/^me\/channels\/(\d+)$/);
  if (p && method === 'PATCH') return ok({ channel: await U.updateChannel(db, uid, Number(p[1]), { active: body.active, frequency: body.frequency }) });
  if (p && method === 'DELETE') { await U.removeChannel(db, uid, Number(p[1])); return ok(); }
  // Confirmation: send a code (email also gets a one-tap link), then check it
  p = path.match(/^me\/channels\/(\d+)\/(verify|confirm)$/);
  if (p && method === 'POST' && p[2] === 'verify') return ok(await U.startChannelVerification(db, uid, Number(p[1])));
  if (p && method === 'POST' && p[2] === 'confirm') {
    const c = await U.confirmChannel(db, uid, Number(p[1]), String(body.code ?? ''));
    return c ? ok({ channel: c }) : ok({ error: 'That code is wrong or has expired' }, 400);
  }

  if (path === 'me/watches') {
    if (method === 'GET') return ok({ watches: await U.listWatches(db, uid) });
    if (method === 'POST') return ok({ watch: await U.addWatch(db, uid, body as any) }, 201);
  }
  p = path.match(/^me\/watches\/(\d+)$/);
  if (p && method === 'DELETE') { await U.removeWatch(db, uid, Number(p[1])); return ok(); }

  if (path === 'me/saved' && method === 'GET') return ok({ saved: await U.listSaved(db, uid) });
  p = path.match(/^me\/saved\/(\d+)$/);
  if (p && method === 'PUT') { await U.saveDeal(db, uid, Number(p[1])); return ok(); }
  if (p && method === 'DELETE') { await U.unsaveDeal(db, uid, Number(p[1])); return ok(); }

  // Hotel alerts and saved hotel deals
  if (path === 'me/hotel-alerts') {
    if (method === 'GET') return ok({ hotel_alerts: await U.listHotelAlerts(db, uid) });
    if (method === 'POST') return ok({ hotel_alert: await U.upsertHotelAlert(db, uid, body as any) });
  }
  p = path.match(/^me\/hotel-alerts\/([A-Za-z0-9]{2,10})$/);
  if (p && method === 'DELETE') { await U.deleteHotelAlert(db, uid, p[1]); return ok(); }

  if (path === 'me/saved-hotels' && method === 'GET') return ok({ saved_hotels: await U.listSavedHotels(db, uid) });
  p = path.match(/^me\/saved-hotels\/(\d+)$/);
  if (p && method === 'PUT') { await U.saveHotelDeal(db, uid, Number(p[1])); return ok(); }
  if (p && method === 'DELETE') { await U.unsaveHotelDeal(db, uid, Number(p[1])); return ok(); }

  return ok({ error: 'Not found' }, 404);
}
