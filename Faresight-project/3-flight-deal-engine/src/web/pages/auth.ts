// Sign in (email code or password), sign up, sign out.
import { clientIp } from '../http.ts';
import { esc } from '../html.ts';
import {
  loginWithPassword, logout, registerWithPassword, requestLoginCode, SESSION_COOKIE, verifyLoginCode, UserError, type SessionMeta,
} from '../../users/service.ts';
import { attempt, clearSession, csrfField, flash, go, page, postForm, safeNext, setSession, type P } from './common.ts';
import { applyPendingAlerts } from './alerts.ts';

const meta = (p: P): SessionMeta => ({ userAgent: String(p.req.headers['user-agent'] ?? '').slice(0, 300), ip: clientIp(p.req), kind: 'web' });
const q = (next: string) => `next=${encodeURIComponent(next)}`;

export async function handleAuth(p: P): Promise<boolean> {
  const path = p.url.pathname, post = p.req.method === 'POST';
  const next = safeNext(p.url.searchParams.get('next'));

  if (path === '/signin' && !post) {
    if (p.user) { go(p, next); return true; }
    const tab = p.url.searchParams.get('tab') === 'password' ? 'password' : 'code';
    const tabs = `<div class="tabs"><a class="${tab === 'code' ? 'on' : ''}" href="/signin?${q(next)}">Email me a code</a><a class="${tab === 'password' ? 'on' : ''}" href="/signin?tab=password&${q(next)}">Password</a></div>`;
    const form = tab === 'code'
      ? `<form method="post" action="/signin/code-request?${q(next)}">${csrfField(p)}
          <label for="email">Email</label><input id="email" type="email" name="email" required autocomplete="email" inputmode="email">
          <p><button class="btn">Send me a code</button></p><p class="meta">We'll email you a 6-digit code. No password needed.</p></form>`
      : `<form method="post" action="/signin/password?${q(next)}">${csrfField(p)}
          <label for="email">Email</label><input id="email" type="email" name="email" required autocomplete="email">
          <label for="password">Password</label><input id="password" type="password" name="password" required autocomplete="current-password">
          <p><button class="btn">Sign in</button></p></form>`;
    page(p, 'Sign in', `<div class="narrow"><h1>Sign in</h1><p class="lead">Save deals, watch routes and manage your alerts.</p>${tabs}
      <div class="panel">${form}</div><p>New here? <a href="/signup?${q(next)}">Create an account</a> or just sign in with a code: we'll create one for you.</p></div>`);
    return true;
  }

  if (path === '/signin/code-request' && post) {
    const f = await postForm(p);
    const email = (f.get('email') ?? '').trim();
    await attempt(p, `/signin?${q(next)}`, async () => {
      await requestLoginCode(p.db, email);
      return `/signin/code?email=${encodeURIComponent(email)}&${q(next)}`;
    });
    return true;
  }

  if (path === '/signin/code' && !post) {
    const email = p.url.searchParams.get('email') ?? '';
    page(p, 'Enter your code', `<div class="narrow"><h1>Check your email</h1>
      <p class="lead">We sent a 6-digit code to <b>${esc(email)}</b>. It works for 10 minutes.</p>
      <div class="panel"><form method="post" action="/signin/code?${q(next)}">${csrfField(p)}<input type="hidden" name="email" value="${esc(email)}">
        <label for="code">Code</label><input id="code" type="text" name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7">
        <p><button class="btn">Sign in</button></p></form></div>
      <p class="meta">Didn't get it? Check spam, or <a href="/signin?${q(next)}">send a new code</a>.</p></div>`);
    return true;
  }

  if (path === '/signin/code' && post) {
    const f = await postForm(p);
    const email = (f.get('email') ?? '').trim(), code = (f.get('code') ?? '').replace(/\s/g, '');
    const back = `/signin/code?email=${encodeURIComponent(email)}&${q(next)}`;
    await attempt(p, back, async () => {
      const auth = await verifyLoginCode(p.db, email, code, meta(p));
      if (!auth) throw new UserError('That code is wrong or has expired. Try again or ask for a new one.');
      setSession(p, auth.token);
      await applyPendingAlerts(p, auth.user.id);
      return next;
    });
    return true;
  }

  if (path === '/signin/password' && post) {
    const f = await postForm(p);
    await attempt(p, `/signin?tab=password&${q(next)}`, async () => {
      const auth = await loginWithPassword(p.db, (f.get('email') ?? '').trim(), f.get('password') ?? '', meta(p));
      if (!auth) throw new UserError('Email or password is wrong. You can also sign in with an email code.');
      setSession(p, auth.token);
      await applyPendingAlerts(p, auth.user.id);
      return next;
    });
    return true;
  }

  if (path === '/signup' && !post) {
    if (p.user) { go(p, next); return true; }
    page(p, 'Create an account', `<div class="narrow"><h1>Create an account</h1><p class="lead">Free. Save deals, watch routes and choose how we tell you about new ones.</p>
      <div class="panel"><form method="post" action="/signup?${q(next)}">${csrfField(p)}
        <label for="name">Name (optional)</label><input id="name" type="text" name="name" autocomplete="name" maxlength="100">
        <label for="email">Email</label><input id="email" type="email" name="email" required autocomplete="email">
        <label for="password">Password</label><input id="password" type="password" name="password" required minlength="8" autocomplete="new-password">
        <p class="meta">At least 8 characters.</p><p><button class="btn">Create account</button></p></form></div>
      <p>Already have one? <a href="/signin?${q(next)}">Sign in</a></p></div>`);
    return true;
  }

  if (path === '/signup' && post) {
    const f = await postForm(p);
    await attempt(p, `/signup?${q(next)}`, async () => {
      const auth = await registerWithPassword(p.db, { email: (f.get('email') ?? '').trim(), password: f.get('password') ?? '', name: (f.get('name') ?? '').trim() || undefined }, meta(p));
      setSession(p, auth.token);
      await applyPendingAlerts(p, auth.user.id);
      flash(p, 'Welcome! Your account is ready. Check your inbox: tap the link we sent to confirm your email for alerts.');
      return next;
    });
    return true;
  }

  if (path === '/signout' && post) {
    await postForm(p);
    const token = p.ck[SESSION_COOKIE];
    if (token) await logout(p.db, token);
    clearSession(p);
    flash(p, 'You are signed out.');
    go(p, '/');
    return true;
  }
  return false;
}
