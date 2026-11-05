// "Turn on app notifications": subscribes this browser to web push and saves it as a channel.
(function () {
  function b64ToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  document.querySelectorAll('[data-push]').forEach(function (btn) {
    const status = btn.parentElement.querySelector('[data-push-status]') || btn;
    const say = function (t) { if (status !== btn) status.textContent = t; };
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      btn.disabled = true; say('This browser can\'t show notifications. On iPhone, add this site to your Home Screen first.'); return;
    }
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      try {
        const k = await (await fetch('/push/key')).json();
        if (!k.key) { say('App notifications aren\'t set up on this server yet.'); return; }
        if (await Notification.requestPermission() !== 'granted') { say('Notifications are blocked. Allow them in your browser settings.'); btn.disabled = false; return; }
        const reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.key) });
        const res = await fetch('/account/push', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': btn.dataset.csrf },
          body: JSON.stringify({ csrf: btn.dataset.csrf, subscription: sub.toJSON() }), credentials: 'same-origin',
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save');
        say('App notifications are on for this device.');
        if (location.pathname === '/account') setTimeout(() => location.reload(), 800);
      } catch (e) { say('Something went wrong: ' + e.message); btn.disabled = false; }
    });
  });
})();
