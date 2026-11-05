// Public hotel pages (owned by the hotel website module). Returns false for paths it does not handle.
import type { Handler } from "./http.ts";
import { makeP } from "./pages/common.ts";
import { cityPage } from "./hotels/city.ts";
import { apiDeals, dealPage, goBooking, listPage, saveAction } from "./hotels/pages.ts";

const MINE = /^\/(hotels(\/|$)|hotel-deal\/|go\/h\/|api\/hotel-deals$)/;

export const handleHotelPages: Handler = async ctx => {
  const path = ctx.url.pathname, get = ctx.req.method === 'GET' || ctx.req.method === 'HEAD';
  if (!MINE.test(path)) return false;
  const p = await makeP(ctx, path !== '/api/hotel-deals');

  if (path === '/api/hotel-deals' && get) { await apiDeals(p); return true; }
  if ((path === '/hotels' || path === '/hotels/') && get) { await listPage(p, false); return true; }
  if (path === '/hotels/expired' && get) { await listPage(p, true); return true; }

  const cm = path.match(/^\/hotels\/([A-Za-z]{3})$/);
  if (cm && get) {
    const code = cm[1].toUpperCase();
    if (code !== cm[1]) { p.res.writeHead(301, { location: `/hotels/${code}` }); p.res.end(); return true; }
    return cityPage(p, code);
  }

  const dm = path.match(/^\/hotel-deal\/(\d{1,9})$/);
  if (dm && get) { await dealPage(p, Number(dm[1])); return true; }

  const sm = path.match(/^\/hotel-deal\/(\d{1,9})\/(save|unsave)$/);
  if (sm) { await saveAction(p, Number(sm[1]), sm[2] as 'save' | 'unsave'); return true; }

  const gm = path.match(/^\/go\/h\/(\d{1,12})$/);
  if (gm && get) { await goBooking(p, Number(gm[1])); return true; }
  return false;
};
