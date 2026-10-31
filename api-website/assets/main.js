/* Techehs API — shared site script */
(function () {
  "use strict";

  var BRAND = "Techehs API";
  var page = document.body.getAttribute("data-page") || "";

  var navItems = [
    { href: "index.html#products", label: "Products", key: "products" },
    { href: "pricing.html", label: "Pricing", key: "pricing" },
    { href: "docs.html", label: "Docs", key: "docs" },
    { href: "index.html#integrations", label: "Integrations", key: "integrations" },
    { href: "index.html#faq", label: "FAQ", key: "faq" }
  ];

  function signedIn() {
    try { return localStorage.getItem("techehs_demo_session") === "1"; } catch (e) { return false; }
  }
  function ctaHtml() {
    if (signedIn()) {
      return '<a class="btn btn-primary btn-sm" href="dashboard.html">Dashboard</a>';
    }
    return '<a class="btn btn-ghost btn-sm" href="login.html">Log in</a>' +
      '<a class="btn btn-primary btn-sm" href="signup.html">Get API key</a>';
  }

  function renderHeader() {
    var el = document.getElementById("site-header");
    if (!el) return;
    var links = navItems.map(function (n) {
      var active = n.key === page ? ' class="active" aria-current="page"' : "";
      return '<li><a href="' + n.href + '"' + active + ">" + n.label + "</a></li>";
    }).join("");
    el.className = "site-header";
    el.innerHTML =
      '<div class="container nav">' +
        '<a class="brand" href="index.html"><span class="brand-mark">T</span>' + BRAND + "</a>" +
        '<div class="nav-menu" id="nav-menu">' +
          '<ul class="nav-links">' + links + "</ul>" +
          '<div class="nav-cta">' + ctaHtml() + "</div>" +
        "</div>" +
        '<button class="menu-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="nav-menu">☰</button>' +
      "</div>";
    var toggle = el.querySelector(".menu-toggle");
    toggle.addEventListener("click", function () {
      var open = el.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "✕" : "☰";
    });
    el.querySelectorAll(".nav-menu a").forEach(function (a) {
      a.addEventListener("click", function () {
        el.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "☰";
      });
    });
  }

  function renderFooter() {
    var el = document.getElementById("site-footer");
    if (!el) return;
    var year = new Date().getFullYear();
    el.className = "site-footer";
    el.innerHTML =
      '<div class="container">' +
        '<div class="footer-grid">' +
          "<div>" +
            '<a class="brand" href="index.html"><span class="brand-mark">T</span>' + BRAND + "</a>" +
            '<p style="font-size:14px;max-width:320px">Real-time B2B data API for profiles, companies, jobs and posts. Fast, reliable and priced per result.</p>' +
          "</div>" +
          "<div><h4>Products</h4><ul>" +
            '<li><a href="docs.html#profile">Profile API</a></li>' +
            '<li><a href="docs.html#company">Company API</a></li>' +
            '<li><a href="docs.html#jobs">Jobs API</a></li>' +
            '<li><a href="docs.html#posts">Posts API</a></li>' +
            '<li><a href="docs.html#search">Search API</a></li>' +
          "</ul></div>" +
          "<div><h4>Developers</h4><ul>" +
            '<li><a href="docs.html">Documentation</a></li>' +
            '<li><a href="docs.html#authentication">Authentication</a></li>' +
            '<li><a href="docs.html#errors">Error codes</a></li>' +
            '<li><a href="docs.html#sdks">SDKs</a></li>' +
            '<li><a href="docs.html#rate-limits">Rate limits</a></li>' +
          "</ul></div>" +
          "<div><h4>Company</h4><ul>" +
            '<li><a href="pricing.html">Pricing</a></li>' +
            '<li><a href="contact.html">Contact</a></li>' +
            '<li><a href="index.html#faq">FAQ</a></li>' +
            '<li><a href="dashboard.html">Dashboard</a></li>' +
          "</ul></div>" +
          "<div><h4>Legal</h4><ul>" +
            '<li><a href="legal.html#terms">Terms of Service</a></li>' +
            '<li><a href="legal.html#privacy">Privacy Policy</a></li>' +
            '<li><a href="legal.html#acceptable-use">Acceptable Use</a></li>' +
          "</ul></div>" +
        "</div>" +
        '<div class="footer-bottom">' +
          "<span>© " + year + " Techehs. All rights reserved.</span>" +
          '<span><span class="status-dot"></span>All systems operational</span>' +
        "</div>" +
      "</div>";
  }

  // Toast
  var toastEl;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove("show"); }, 1800);
  }
  window.TechToast = toast;

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy") ? resolve() : reject(new Error("copy failed")); }
      catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }
  window.TechCopy = copyText;

  // Code tabs: .code-window with .code-tab[data-tab] and .code-pane[data-pane]
  function initCodeWindows() {
    document.querySelectorAll(".code-window").forEach(function (win) {
      var tabs = win.querySelectorAll(".code-tab");
      var panes = win.querySelectorAll(".code-pane");
      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
          tabs.forEach(function (t) { t.classList.toggle("active", t === tab); });
          panes.forEach(function (p) {
            p.classList.toggle("active", p.getAttribute("data-pane") === tab.getAttribute("data-tab"));
          });
        });
      });
      var btn = win.querySelector(".copy-btn");
      if (btn) {
        btn.addEventListener("click", function () {
          var active = win.querySelector(".code-pane.active") || win.querySelector("pre");
          copyText(active.innerText).then(function () { toast("Copied to clipboard"); },
            function () { toast("Copy failed — select and copy manually"); });
        });
      }
    });
  }

  // Docs: highlight current section in sidebar
  function initDocsSpy() {
    var nav = document.querySelector(".docs-nav");
    if (!nav || !("IntersectionObserver" in window)) return;
    var links = {};
    nav.querySelectorAll('a[href^="#"]').forEach(function (a) { links[a.getAttribute("href").slice(1)] = a; });
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting && links[e.target.id]) {
          Object.keys(links).forEach(function (k) { links[k].classList.remove("active"); });
          links[e.target.id].classList.add("active");
        }
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    document.querySelectorAll(".docs-content section[id]").forEach(function (s) { obs.observe(s); });
  }

  renderHeader();
  renderFooter();
  initCodeWindows();
  initDocsSpy();
})();
