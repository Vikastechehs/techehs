// Mockup interactions: mobile menu, demo form, index filter.
(function () {
  var h = document.querySelector('.site-header');
  var t = document.querySelector('.menu-toggle');
  if (h && t) t.addEventListener('click', function () {
    var open = h.classList.toggle('open');
    t.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.querySelectorAll('form[data-demo]').forEach(function (f) {
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (f.querySelector('.ok')) return;
      var ok = document.createElement('p');
      ok.className = 'ok';
      ok.textContent = 'Request received (mockup). On the live site this goes to the sales CRM.';
      f.appendChild(ok);
    });
  });
  var q = document.getElementById('q');
  if (q) {
    var filter = '';
    var apply = function () {
      var term = q.value.trim().toLowerCase();
      document.querySelectorAll('.idx-group').forEach(function (g) {
        var typeOk = !filter || g.dataset.type === filter;
        var any = false;
        g.querySelectorAll('.idx-row').forEach(function (r) {
          var show = typeOk && (!term || r.dataset.q.indexOf(term) > -1);
          r.hidden = !show; if (show) any = true;
        });
        g.hidden = !any;
      });
    };
    q.addEventListener('input', apply);
    document.querySelectorAll('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () {
        filter = b.dataset.filter;
        document.querySelectorAll('[data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        apply();
      });
    });
  }
})();
