/* Techehs API — front-end demo auth.
 * There is no backend in this static site. Accounts are kept in localStorage
 * so the sign-up → dashboard flow can be demoed. Replace submitSignup/submitLogin
 * with real API calls when a backend is available. */
(function () {
  "use strict";

  var STORE = "techehs_demo_user";
  var SESSION = "techehs_demo_session";

  function safeGet() {
    try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { return null; }
  }
  function safeSet(v) {
    try { localStorage.setItem(STORE, JSON.stringify(v)); return true; } catch (e) { return false; }
  }

  function randomKey() {
    var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var out = "tk_live_";
    var arr = new Uint32Array(32);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(arr);
    else for (var j = 0; j < arr.length; j++) arr[j] = Math.floor(Math.random() * 1e9);
    for (var i = 0; i < arr.length; i++) out += chars[arr[i] % chars.length];
    return out;
  }

  function setInvalid(field, msg) {
    var wrap = field.closest(".field");
    if (!wrap) return;
    wrap.classList.toggle("invalid", !!msg);
    var err = wrap.querySelector(".error");
    if (err && msg) err.textContent = msg;
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function showMsg(form, type, text) {
    var m = form.querySelector(".form-msg");
    if (!m) return;
    m.className = "form-msg " + type;
    m.textContent = text;
  }

  function setSession(on) {
    try { on ? localStorage.setItem(SESSION, "1") : localStorage.removeItem(SESSION); } catch (e) { /* ignore */ }
  }
  function hasSession() {
    try { return localStorage.getItem(SESSION) === "1"; } catch (e) { return false; }
  }

  window.TechAuth = {
    // Returns the signed-in user, or null when signed out.
    current: function () { return hasSession() ? safeGet() : null; },
    logout: function () {
      setSession(false);
      window.location.href = "login.html";
    },
    save: safeSet,
    newKey: randomKey,

    initSignup: function (form) {
      var params = new URLSearchParams(window.location.search);
      var plan = params.get("plan");
      var planSel = form.querySelector("#plan");
      if (plan && planSel && planSel.querySelector('option[value="' + plan + '"]')) planSel.value = plan;

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var name = form.querySelector("#name");
        var email = form.querySelector("#email");
        var pw = form.querySelector("#password");
        var terms = form.querySelector("#terms");
        var ok = true;
        setInvalid(name, name.value.trim().length < 2 ? "Please enter your name." : "");
        if (name.value.trim().length < 2) ok = false;
        setInvalid(email, EMAIL_RE.test(email.value.trim()) ? "" : "Please enter a valid email address.");
        if (!EMAIL_RE.test(email.value.trim())) ok = false;
        setInvalid(pw, pw.value.length >= 8 ? "" : "Password must be at least 8 characters.");
        if (pw.value.length < 8) ok = false;
        if (!terms.checked) { showMsg(form, "err", "Please accept the Terms of Service."); ok = false; }
        if (!ok) return;

        var selected = planSel ? planSel.value : "free";
        var credits = { free: 100, starter: 10000, growth: 30000, business: 100000 }[selected] || 100;
        var saved = safeSet({
          name: name.value.trim(),
          email: email.value.trim().toLowerCase(),
          plan: selected,
          credits: credits,
          creditsTotal: credits,
          apiKey: randomKey(),
          created: new Date().toISOString()
        });
        if (!saved) { showMsg(form, "err", "Your browser blocked local storage, so the demo account could not be created."); return; }
        setSession(true);
        showMsg(form, "ok", "Account created. Redirecting to your dashboard…");
        setTimeout(function () { window.location.href = "dashboard.html"; }, 700);
      });
    },

    initLogin: function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var email = form.querySelector("#email");
        var pw = form.querySelector("#password");
        var valid = EMAIL_RE.test(email.value.trim());
        setInvalid(email, valid ? "" : "Please enter a valid email address.");
        setInvalid(pw, pw.value ? "" : "Please enter your password.");
        if (!valid || !pw.value) return;
        var user = safeGet();
        if (!user || user.email !== email.value.trim().toLowerCase()) {
          showMsg(form, "err", "No account found for this email. Create one first.");
          return;
        }
        setSession(true);
        showMsg(form, "ok", "Signed in. Redirecting…");
        setTimeout(function () { window.location.href = "dashboard.html"; }, 500);
      });
    }
  };
})();
