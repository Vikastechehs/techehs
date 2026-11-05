// Website pages for visitors and signed-in users: sign in, alerts, account, saved deals, watches, route pages,
// explore, unsubscribe and the installable web app (manifest, service worker, push).
import type { Handler } from './http.ts';
import { makeP } from './pages/common.ts';
import { handleAuth } from './pages/auth.ts';
import { handleAlerts } from './pages/alerts.ts';
import { handleAccount } from './pages/account.ts';
import { handleSaved } from './pages/saved.ts';
import { handleExplore } from './pages/explore.ts';
import { handlePwa } from './pages/pwa.ts';

const MINE = /^\/(signin|signup|signout|alerts|account|saved|watch|unsubscribe|confirm|route|explore|manifest\.webmanifest|sw\.js|push|offline|static)(\/|$)|^\/deal\/\d+\/(save|unsave)$/;

export const handleAccountPages: Handler = async ctx => {
  if (!MINE.test(ctx.url.pathname)) return false;
  const light = /^\/(static\/|sw\.js$|manifest\.webmanifest$|push\/key$)/.test(ctx.url.pathname);
  const p = await makeP(ctx, !light);
  for (const h of [handlePwa, handleAuth, handleAlerts, handleAccount, handleSaved, handleExplore]) if (await h(p)) return true;
  return false;
};
