(function () {
  if (globalThis.PagePressCapture) return;
  const CHANNEL = 'pagepress-capture-v1';
  // Extension messages are capped at 64 MiB, so large PNG data URLs are sent in parts.
  const CHUNK_CHARS = 8 * 1048576;
  let running = null;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Same-origin frames up to two levels deep; cross-origin frames are unreadable by design.
  function documents(doc = document, depth = 0, list = []) {
    list.push(doc);
    if (depth < 2) for (const iframe of doc.querySelectorAll('iframe, frame')) {
      try { if (iframe.contentDocument) documents(iframe.contentDocument, depth + 1, list); } catch { /* Cross-origin frames require their own tab. */ }
    }
    return list;
  }
  function findPdfJs(doc) {
    const viewer = doc.querySelector('#viewer.pdfViewer, #viewer:has(.page[data-page-number]), .pdfViewer:has(.page[data-page-number])');
    return viewer ? { type: 'pdfjs', doc, viewer, container: doc.querySelector('#viewerContainer') || viewer.parentElement } : null;
  }

  // Generic page-list viewers: a run of large, page-shaped <img> or <canvas> elements in document order, as many
  // portals show scanned sheets. Each page is saved at the element's own pixels (an image's natural resolution).
  const MIN_SOURCE = 800;
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-url'];
  const sourceSize = (el) => (el.tagName === 'IMG' ? { width: el.naturalWidth, height: el.naturalHeight } : { width: el.width, height: el.height });
  // An image that has not loaded yet but holds a page slot: a lazy-loading placeholder, native loading="lazy", or
  // an image still downloading inside a page-sized box.
  function isLazy(el) {
    if (el.tagName !== 'IMG' || (el.complete && el.naturalWidth >= MIN_SOURCE)) return false;
    if (LAZY_ATTRS.some((a) => el.hasAttribute(a)) && el.naturalWidth < MIN_SOURCE) return true;
    if (el.complete && el.naturalWidth > 0) return false;
    const rect = el.getBoundingClientRect();
    return el.loading === 'lazy' || (rect.width >= 120 && rect.height >= 80);
  }
  function pageShaped(el) {
    if (isLazy(el)) return true;
    const { width, height } = sourceSize(el), rect = el.getBoundingClientRect();
    return width >= MIN_SOURCE && height >= 200 && height / width > 0.25 && height / width < 4 && rect.width >= 120 && rect.height >= 80;
  }
  function findPageList(doc) {
    const candidates = [...doc.querySelectorAll('img, canvas')].filter((el) => pageShaped(el) && !inCarousel(el));
    if (!candidates.length) return null;
    // Group by parent, or by grandparent when each page sits in its own wrapper; take the largest group.
    const groups = new Map();
    for (const el of candidates) for (const key of [el.parentElement, el.parentElement?.parentElement]) if (key) groups.set(key, [...(groups.get(key) || []), el]);
    let container = null, best = [];
    for (const [key, members] of groups) if (members.length > best.length || (members.length === best.length && key.contains(container))) { container = key; best = members; }
    const tag = best.filter((el) => el.tagName === 'IMG').length * 2 >= best.length ? 'IMG' : 'CANVAS';
    if (!best.some((el) => el.tagName === tag && !isLazy(el))) return null;
    const pages = () => [...container.querySelectorAll(tag.toLowerCase())].filter((el) => pageShaped(el) && !inCarousel(el));
    return { type: 'pagelist', doc, container, tag, pages, scroller: scrollParent(best[0]) };
  }
  function scrollParent(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY + style.overflowX) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) return node;
    }
    return el.ownerDocument.scrollingElement || el.ownerDocument.documentElement;
  }
  // Single-image pagers: one large page image or canvas, Next/Previous controls, and a visible page counter
  // ("Page 3 of 12", "3 / 12", a page-number box, or a page drop-down). Pages are reached through the viewer's
  // own controls and saved at the image's native resolution.
  // A label matches by its words with arrows and punctuation removed ("Next ›", "‹ Previous"), or as a bare arrow.
  // Marks (\p{M}) are kept so Devanagari words such as आगे keep their vowel signs. » and « usually mean First/Last.
  const NEXT = { words: /^(next( page)?|आगे|अगला( पृष्ठ)?)$/i, arrows: /^[›>→▶⟩]$/ }, PREV = { words: /^(prev(ious)?( page)?|back|पीछे|पिछला( पृष्ठ)?)$/i, arrows: /^[‹<←◀⟨]$/ };
  const labelIs = (label, kind) => { const core = label.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim(); return core ? kind.words.test(core) : kind.arrows.test(label.replace(/\s+/g, '')); };
  const NEXT_HINT = /(^|[\s_-])next([\s_-]|$)|nextpage|arrow-?right|chevron-?right/i, PREV_HINT = /(^|[\s_-])prev(ious)?([\s_-]|$)|prevpage|arrow-?left|chevron-?left/i;
  // Carousels and banner sliders on portal home pages have their own Next buttons and "1 / 5" counters.
  const CAROUSEL = /carousel|slider|slick|swiper|splide|glide|owl-|banner|marquee|ticker/i;
  const inCarousel = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { if (CAROUSEL.test(`${n.id} ${n.className?.baseVal ?? n.className}`) || n.getAttribute('aria-roledescription') === 'carousel') return true; } return false; };
  const COUNTER = /^\s*(?:page|pg\.?|पृष्ठ)?\s*(\d{1,5})\s*(?:of|\/|से|में से)\s*(\d{1,5})\s*$/i;
  const TOTAL_AFTER = /(?:^|[^\d/])(?:of|\/|से|में से)\s*(\d{1,5})(?![\d/.-])/i;
  const centre = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const distance = (a, b) => { const [ax, ay] = centre(a), [bx, by] = centre(b); return Math.hypot(ax - bx, ay - by); };
  const nearest = (list, target) => list.sort((a, b) => distance(a.el || a, target) - distance(b.el || b, target))[0] || null;
  function controlLabel(el) {
    return [el.textContent, el.getAttribute('aria-label'), el.title, el.value, el.querySelector?.('img')?.alt].map((v) => String(v || '').trim()).filter(Boolean);
  }
  const unavailable = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true';
  // Find the Next or Previous control nearest the page. A disabled one still counts for detection (a viewer opened
  // on its last page has a disabled Next), but only an enabled one is pressed.
  function findControl(doc, kind, hint, near) {
    const candidates = [...doc.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="image"], input[type="submit"]')].filter((el) => {
      if (!el.getClientRects().length || inCarousel(el)) return false;
      const labels = controlLabel(el);
      return labels.some((l) => l.length <= 24 && labelIs(l, kind)) || hint.test(`${el.id} ${el.className?.baseVal ?? el.className} ${el.getAttribute('aria-label') || ''} ${el.title || ''}`);
    });
    return nearest(candidates, near);
  }
  // Controls that load another web page cannot be followed: the capture runs inside the current page. This covers
  // ordinary links, ASP.NET __doPostBack links, and explicit submit buttons.
  function reloads(el) {
    if (!el) return false;
    if (el.tagName === 'A') {
      const href = (el.getAttribute('href') || '').trim();
      if (/^javascript:\s*__doPostBack/i.test(href)) return true;
      return !!href && !/^(#|javascript:)/i.test(href) && new URL(el.href, location.href).href.split('#')[0] !== el.ownerDocument.location.href.split('#')[0];
    }
    if (el.matches('input[type="submit"], input[type="image"], button[type="submit"]')) return !!el.form;
    return false;
  }
  function counters(doc) {
    const list = [];
    for (const select of doc.querySelectorAll('select')) {
      const values = [...select.options].map((o) => Number(o.value || o.textContent));
      if (values.length >= 2 && values.every((v, i) => v === i + 1) && select.getClientRects().length && !inCarousel(select)) list.push({ kind: 'select', el: select, read: () => ({ current: Number(select.value), total: select.options.length }) });
    }
    for (const input of doc.querySelectorAll('input:not([type]), input[type="text"], input[type="number"], input[type="tel"]')) {
      const totalOf = () => Number(TOTAL_AFTER.exec((input.parentElement?.textContent || '') + ' ' + (input.nextElementSibling?.textContent || ''))?.[1]);
      if (totalOf() && /^\d{1,5}$/.test(input.value.trim()) && input.getClientRects().length && !inCarousel(input)) list.push({ kind: 'input', el: input, read: () => ({ current: Number(input.value), total: totalOf() }) });
    }
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.childElementCount > 2 || el.textContent.length > 40 || !COUNTER.test(el.textContent) || !el.getClientRects().length || inCarousel(el)) continue;
      // Keep the innermost element showing the counter, not every wrapper around it.
      if (list.some((c) => c.kind === 'text' && el.contains(c.el))) continue;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === 'text' && list[i].el.contains(el)) list.splice(i, 1);
      list.push({ kind: 'text', el, read: () => { const m = COUNTER.exec(el.textContent) || []; return { current: Number(m[1]), total: Number(m[2]) }; } });
    }
    return list.filter((c) => { const { current, total } = c.read(); return total >= 1 && total <= 10000 && current >= 1 && current <= total; });
  }
  function findPager(doc) {
    const main = () => [...doc.querySelectorAll('img, canvas')].filter((el) => !isLazy(el) && pageShaped(el) && !inCarousel(el))
      .sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; })[0] || null;
    const first = main();
    if (!first) return null;
    const next = findControl(doc, NEXT, NEXT_HINT, first), prev = findControl(doc, PREV, PREV_HINT, first);
    if (!next && !prev) return null;
    // The counter that belongs to this viewer is the one nearest its Next/Previous controls.
    const all = counters(doc), counter = nearest(all, next || prev);
    if (!counter) return null;
    // A visible text counter is the viewer's own report of the page; a page box or drop-down may only echo what
    // PagePress typed into it, so navigation is also confirmed by the picture changing.
    const display = counter.kind === 'text' ? counter : nearest(all.filter((c) => c.kind === 'text'), next || prev);
    const control = (forward) => { const el = findControl(doc, forward ? NEXT : PREV, forward ? NEXT_HINT : PREV_HINT, main() || first) || (forward ? next : prev); return el && !unavailable(el) ? el : null; };
    return { type: 'pager', doc, main, control, counter, display, tag: first.tagName, reloads: reloads(next) || reloads(prev), scroller: scrollParent(first) };
  }
  function findViewer() {
    const docs = documents();
    for (const doc of docs) { const found = findPdfJs(doc); if (found) return found; }
    let single = null;
    for (const doc of docs) {
      const list = findPageList(doc);
      if (list && list.pages().length >= 2) return list;
      // One page image: a pager if it has Next/Previous controls and a counter, otherwise a one-page document.
      const pager = findPager(doc);
      if (pager) return pager;
      single ||= list;
    }
    return single;
  }
  function inspect() {
    const found = findViewer();
    if (!found) throw new Error('No supported document viewer found. Open the document viewer tab, then click PagePress. Chrome\'s built-in PDF viewer is not supported.');
    if (found.type === 'pager') {
      if (found.reloads) throw new Error('This viewer loads a new web page for each page, which PagePress cannot follow. Capture is not supported here.');
      const { current, total } = (found.display || found.counter).read();
      return { title: document.title, url: location.href, total, current, zoomControl: false, fixedResolution: true, sample: sourceSize(found.main()),
        viewer: found.tag === 'IMG' ? 'Single-page image viewer' : 'Single-page canvas viewer' };
    }
    if (found.type === 'pagelist') {
      const pages = found.pages(), first = pages.find((el) => !isLazy(el));
      const top = pages.findIndex((el) => el.getBoundingClientRect().bottom > 0);
      return { title: document.title, url: location.href, total: pages.length, current: Math.max(1, top + 1), zoomControl: false, fixedResolution: true,
        sample: first && sourceSize(first), viewer: found.tag === 'IMG' ? 'Image page viewer' : 'Canvas page viewer' };
    }
    const input = found.doc.querySelector('#pageNumber');
    const counter = found.doc.querySelector('#numPages');
    const numbers = [...found.viewer.querySelectorAll('.page[data-page-number]')].map((p) => Number(p.dataset.pageNumber));
    const total = Number(input?.max) || Number(counter?.textContent.match(/\d+/g)?.pop()) || Math.max(0, ...numbers);
    if (!total || total > 10000) throw new Error('Cannot determine a supported document page count.');
    return { title: document.title, url: location.href, total, current: Number(input?.value) || numbers[0] || 1, zoomControl: !!found.doc.querySelector('#scaleSelect'), viewer: 'PDF.js-compatible viewer' };
  }
  // The document is identified by its address without the #fragment, which viewers often update per page.
  const sameDocument = (a, b) => String(a).split('#')[0] === String(b).split('#')[0];
  function check(job) {
    if (job.cancelled) throw new Error('Capture stopped. Saved pages are retained.');
    if (job.abortAt && performance.now() > job.abortAt) throw new Error('Restoring the viewer took too long.');
    if (!sameDocument(location.href, job.config.sourceUrl)) throw new Error('The source tab navigated to another document. Capture stopped.');
  }
  async function notify(job, type, payload = {}) {
    // PagePressTransport lets the compatibility checker run this engine outside the extension. Page scripts cannot
    // set it for the extension, whose content scripts run in an isolated world with their own globals.
    const message = { channel: CHANNEL, jobId: job.config.id, type, ...payload };
    const response = await (globalThis.PagePressTransport ? globalThis.PagePressTransport(message) : chrome.runtime.sendMessage(message));
    if (!response?.ok) throw new Error(response?.error || 'The PagePress panel is closed. Reopen it to retry from the saved pages.');
  }
  function zoom(found, value) {
    const select = found.doc.querySelector('#scaleSelect');
    if (!select) return;
    if (![...select.options].some((o) => o.value === String(value))) {
      const option = found.doc.createElement('option'); option.value = String(value); option.textContent = `${Math.round(Number(value) * 100)}%`; select.append(option);
    }
    select.value = String(value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function navigate(found, number) {
    const input = found.doc.querySelector('#pageNumber');
    if (input) { input.value = String(number); input.dispatchEvent(new Event('change', { bubbles: true })); }
    const page = found.viewer.querySelector(`.page[data-page-number="${number}"]`);
    if (page) page.scrollIntoView({ block: 'start', inline: 'start', behavior: 'instant' });
    if (!input && !page) throw new Error(`Page ${number} is not available in this viewer.`);
  }
  function fingerprint(canvas) {
    const probe = canvas.ownerDocument.createElement('canvas'); probe.width = 40; probe.height = 40;
    const ctx = probe.getContext('2d', { willReadFrequently: true }); ctx.drawImage(canvas, 0, 0, 40, 40);
    const pixels = ctx.getImageData(0, 0, 40, 40).data;
    let hash = 2166136261, min = 255, max = 0;
    for (let i = 0; i < pixels.length; i += 4) { const v = Math.round((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3); min = Math.min(min, v); max = Math.max(max, v); hash = Math.imul(hash ^ v, 16777619); }
    const size = sourceSize(canvas);
    return { signature: `${size.width}:${size.height}:${hash}`, blank: max - min < 2 };
  }
  async function waitForPage(found, number, job) {
    const start = performance.now(); let last = '', stableAt = start;
    while (performance.now() - start < job.config.timeoutMs) {
      check(job);
      const page = found.viewer.querySelector(`.page[data-page-number="${number}"]`);
      const canvas = page?.querySelector('canvas');
      const loaded = page && canvas?.width >= 1200 && canvas.height > 0 && page.getAttribute('data-loaded') === 'true';
      // A canvas smaller than its displayed size is either a stale render being CSS-stretched during a zoom
      // change or a viewer-imposed canvas cap. Wait for the full render; accept a capped canvas only later, flagged.
      const sharp = loaded && canvas.width >= Math.floor(canvas.getBoundingClientRect().width * (canvas.ownerDocument.defaultView.devicePixelRatio || 1) * 0.97);
      const ready = loaded && (sharp || performance.now() - start > job.config.timeoutMs / 2);
      if (ready) {
        let probe;
        try { probe = fingerprint(canvas); } catch { throw new Error(`Page ${number} cannot be read because the site restricts canvas access.`); }
        const signature = probe.signature + ':' + page.childElementCount;
        if (last !== signature) { last = signature; stableAt = performance.now(); }
        if (performance.now() - stableAt >= job.config.settleMs) return { page, canvas, blank: probe.blank, reduced: !sharp };
      } else { last = ''; stableAt = performance.now(); }
      await sleep(150);
    }
    throw new Error(`Page ${number} did not finish rendering at high resolution. Keep the document tab active and retry with Slow viewer timing.`);
  }
  function hasExtraLayers(page) {
    if (page.querySelectorAll('canvas').length > 1) return true;
    const visible = (e) => { const s = getComputedStyle(e); return !e.hidden && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0; };
    for (const node of [page, ...page.querySelectorAll('.canvasWrapper')]) {
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(node, pseudo).content;
        if (content && !['none', 'normal', '""'].includes(content)) return true;
      }
    }
    return [...page.children].some((e) => !e.matches('.canvasWrapper,.textLayer') && visible(e) && (e.childElementCount || e.textContent.trim()));
  }
  async function renderLayers(page, source, job) {
    if (typeof html2canvas !== 'function') throw new Error('Document layer renderer is unavailable. Reload the extension.');
    for (const image of page.querySelectorAll('img')) {
      const style = getComputedStyle(image);
      if (image.hidden || style.display === 'none' || style.visibility === 'hidden') continue;
      if (!image.complete || !image.naturalWidth) throw new Error('A visible document image has not finished loading. Retry after it loads.');
      const probe = page.ownerDocument.createElement('canvas'); probe.width = 1; probe.height = 1;
      try { const ctx = probe.getContext('2d'); ctx.drawImage(image, 0, 0, 1, 1); ctx.getImageData(0, 0, 1, 1); }
      catch { throw new Error('A visible document image is blocked by browser origin rules and cannot be preserved.'); }
    }
    const rect = page.getBoundingClientRect();
    const token = `pp-${crypto.randomUUID()}`;
    page.setAttribute('data-pagepress-target', token);
    const scale = Math.max(1, source.width / Math.max(1, rect.width));
    const variables = [...getComputedStyle(page)].filter((name) => name.startsWith('--')).map((name) => [name, getComputedStyle(page).getPropertyValue(name)]);
    try {
      const task = html2canvas(page, {
        scale, width: rect.width, height: rect.height, logging: false, backgroundColor: '#fff',
        useCORS: true, allowTaint: false, imageTimeout: job.config.timeoutMs, removeContainer: true,
        onclone: (cloned) => {
          const target = cloned.querySelector(`[data-pagepress-target="${token}"]`);
          if (!target) throw new Error('Document page changed during layer capture.');
          for (let parent = target.parentElement; parent; parent = parent.parentElement) {
            parent.style.setProperty('overflow', 'visible', 'important');
            parent.style.setProperty('contain', 'none', 'important');
            parent.style.setProperty('transform', 'none', 'important');
          }
          target.style.setProperty('width', rect.width + 'px', 'important');
          target.style.setProperty('height', rect.height + 'px', 'important');
          for (const [name, value] of variables) target.style.setProperty(name, value);
        }
      });
      let timer;
      try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Document layers took too long to capture.')), job.config.timeoutMs); })]); }
      finally { clearTimeout(timer); }
    } finally { page.removeAttribute('data-pagepress-target'); }
  }
  // Identity of what an image or canvas currently shows, to tell a newly loaded page from the previous one.
  function identity(el) {
    if (!el) return '';
    if (el.tagName === 'IMG') return `${el.currentSrc || el.src}|${el.naturalWidth}x${el.naturalHeight}`;
    try { return fingerprint(el).signature; } catch { return `${el.width}x${el.height}`; }
  }
  function press(el) {
    el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    el.click();
  }
  async function until(test, ms) {
    const start = performance.now();
    while (performance.now() - start < ms) { if (test()) return true; await sleep(100); }
    return test();
  }
  // The page the viewer reports: its visible text counter when there is one, otherwise the page box or drop-down.
  const pageOf = (found) => (found.display || found.counter).read().current;
  // Reach page `number` through the viewer's own controls: type it into a page box or pick it from a drop-down
  // when the viewer has one, otherwise step with Next/Previous. Every move must show up both in the counter and in
  // the picture, so a box that only echoes what was typed, or a counter that runs ahead of slow images, cannot
  // put the wrong page under a number. Returns the picture shown just before the final move (null if no move).
  async function goToPage(found, number, job) {
    if (pageOf(found) === number) return null;
    const { kind, el } = found.counter, half = job.config.timeoutMs / 2;
    if (kind === 'input' || kind === 'select') {
      const before = identity(found.main()), previous = el.value, view = el.ownerDocument.defaultView;
      if (kind === 'input') { el.focus(); el.value = String(number); el.dispatchEvent(new view.Event('input', { bubbles: true })); }
      else el.value = String(number);
      el.dispatchEvent(new view.Event('change', { bubbles: true }));
      if (kind === 'input') for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new view.KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      if (await until(() => { check(job); return (!found.display || found.display.read().current === number) && identity(found.main()) !== before; }, half)) return before;
      // The viewer did not act on the typed value: put the box back and step with Next/Previous instead.
      el.value = previous;
    }
    let before = null;
    for (let steps = 0; pageOf(found) !== number; steps++) {
      check(job);
      const current = pageOf(found), forward = current < number, control = found.control(forward);
      if (!control || steps > (found.display || found.counter).read().total + 2) throw new Error(`Could not reach page ${number} with the viewer's ${forward ? 'Next' : 'Previous'} button.`);
      before = identity(found.main());
      press(control);
      if (!await until(() => { check(job); return pageOf(found) !== current; }, job.config.timeoutMs)) throw new Error(`The viewer did not move past page ${current}. Retry with Slow viewer timing.`);
      // Let this page's picture arrive before the next step (two identical pages in a row give up after a while).
      await until(() => { check(job); return identity(found.main()) !== before; }, half);
    }
    return before;
  }
  async function capturePagerItem(found, number, job) {
    const before = await goToPage(found, number, job);
    const moved = performance.now(); let duplicate = false;
    const page = await captureElement(number, job, () => {
      if (pageOf(found) !== number) throw new Error(`The viewer left page ${number} during capture.`);
      const el = found.main();
      if (!el || before === null || identity(el) !== before) return el;
      // The picture never changed: either two identical pages, or a viewer that ignored the move. Save it with a
      // warning rather than silently.
      if (performance.now() - moved > job.config.timeoutMs / 2) { duplicate = true; return el; }
      return null;
    }, found.doc);
    return duplicate ? { ...page, warning: 'This page looks identical to the previous one. Check it before relying on the export.' } : page;
  }
  async function capturePageListItem(found, number, job) {
    // The page list is fixed when the capture starts, so later loading or hiding of images cannot renumber pages.
    const el = found.frozen[number - 1];
    if (!el) throw new Error(`Page ${number} is not in this viewer.`);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return captureElement(number, job, () => {
      if (!el.isConnected) throw new Error('The viewer replaced its pages during capture. Reload the document and retry.');
      return el;
    }, found.doc);
  }
  // Wait until pick() returns a loaded, stable page element, then save its native pixels.
  async function captureElement(number, job, pick, doc) {
    const start = performance.now(); let last = '', stableAt = start, el, previous;
    while (performance.now() - start < job.config.timeoutMs) {
      check(job);
      el = pick();
      if (el !== previous) { previous = el; last = ''; stableAt = performance.now(); }
      // Lazy placeholders are tiny; anything 200 px or wider that has loaded is the page itself.
      const size = el ? sourceSize(el) : { width: 0, height: 0 }, ready = el && (el.tagName !== 'IMG' || el.complete) && size.width >= 200 && size.height >= 200;
      if (ready) {
        let probe;
        try { probe = fingerprint(el); } catch {
          const host = el.tagName === 'IMG' ? new URL(el.currentSrc || el.src, location.href).host : '';
          throw new Error(`Page ${number} ${host ? `is an image from ${host}, which` : ''} the browser does not let extensions read. This viewer is not supported.`);
        }
        if (last !== probe.signature) { last = probe.signature; stableAt = performance.now(); }
        if (performance.now() - stableAt >= job.config.settleMs) {
          if (size.width * size.height > 32000000) throw new Error(`Page ${number} is too large to export (over 32 million pixels).`);
          const output = doc.createElement('canvas'); output.width = size.width; output.height = size.height;
          const ctx = output.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size.width, size.height); ctx.drawImage(el, 0, 0, size.width, size.height);
          let data;
          try { data = output.toDataURL('image/png'); } catch { throw new Error(`Page ${number} has protected or cross-origin content and cannot be exported.`); }
          output.width = 1; output.height = 1;
          const warning = probe.blank ? 'This source page appears blank.' : size.width < 1200 ? `The source image is ${size.width.toLocaleString()} x ${size.height.toLocaleString()} px. It was saved at its original resolution, not upscaled.` : '';
          return { number, width: size.width, height: size.height, data, warning, layered: false, capturedAt: new Date().toISOString() };
        }
      } else { last = ''; stableAt = performance.now(); }
      await sleep(150);
    }
    throw new Error(`Page ${number} did not finish loading. Keep the document tab active and retry with Slow viewer timing.`);
  }
  async function capturePage(found, number, job) {
    const { page, canvas: source, blank, reduced } = await waitForPage(found, number, job);
    check(job);
    const rect = source.getBoundingClientRect();
    if (source.width < 1200) throw new Error(`Page ${number} did not render at the requested resolution. Increase the viewer zoom or retry after it finishes zooming.`);
    if (source.width * source.height > 32000000) throw new Error('This sheet is too large. Retry at 200% quality.');
    let output;
    const layered = hasExtraLayers(page);
    if (layered) output = await renderLayers(page, source, job);
    else {
      output = found.doc.createElement('canvas'); output.width = source.width; output.height = source.height;
      const ctx = output.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, output.width, output.height); ctx.drawImage(source, 0, 0);
    }
    check(job);
    if (!found.viewer.contains(page) || Number(page.dataset.pageNumber) !== number) throw new Error('The viewer changed pages during capture.');
    const text = page.textContent;
    const warning = /not available|unavailable|उपलब्ध\s*नहीं/i.test(text) ? 'The source viewer reports unavailable content.' : blank ? 'This source page appears blank.' :
      reduced ? `The viewer rendered this sheet below its displayed size (${source.width.toLocaleString()} px wide). It was kept at native resolution, not upscaled.` : '';
    let data;
    try { data = output.toDataURL('image/png'); } catch { throw new Error(`Page ${number} has protected or cross-origin content and cannot be exported.`); }
    if (!data.startsWith('data:image/png;base64,')) throw new Error('The browser could not allocate a page image. Retry at 200% quality.');
    const result = { number, width: output.width, height: output.height, data, warning, layered, capturedAt: new Date().toISOString() };
    output.width = 1; output.height = 1;
    return result;
  }
  async function deliver(job, number, { data, ...captured }) {
    const parts = Math.ceil(data.length / CHUNK_CHARS);
    for (let index = 0; index < parts; index++) {
      check(job);
      await notify(job, 'chunk', { number, index, parts, data: data.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS) });
    }
    await notify(job, 'page', { page: { ...captured, parts } });
    check(job);
  }
  async function run(job) {
    let found, original, failure = null;
    try {
      found = findViewer(); if (!found) throw new Error('The document viewer is no longer available.');
      if (found.type !== 'pdfjs') {
        if (found.reloads) throw new Error('This viewer loads a new web page for each page, which PagePress cannot follow.');
        original = { page: found.type === 'pager' ? pageOf(found) : null, left: found.scroller.scrollLeft, top: found.scroller.scrollTop, windowX: found.doc.defaultView.scrollX, windowY: found.doc.defaultView.scrollY };
        if (found.type === 'pagelist') found.frozen = found.pages();
        for (const number of job.config.pages) {
          check(job); job.current = number;
          await notify(job, 'progress', { number, phase: 'loading' });
          await deliver(job, number, await (found.type === 'pager' ? capturePagerItem(found, number, job) : capturePageListItem(found, number, job)));
        }
        return;
      }
      const select = found.doc.querySelector('#scaleSelect');
      let oldZoom = select?.value;
      if (oldZoom === 'custom') oldZoom = String(parseFloat(select.selectedOptions[0].textContent.replace(/[^\d.]/g, '')) / 100);
      original = { page: Number(found.doc.querySelector('#pageNumber')?.value) || 1, zoom: oldZoom, left: found.container.scrollLeft, top: found.container.scrollTop, windowX: found.doc.defaultView.scrollX, windowY: found.doc.defaultView.scrollY };
      // Already at the target zoom: step away first so the viewer redraws every page at full size (needed after
      // the panel lifts the PDF.js 5+ screen-size canvas limit).
      if (select && select.value === String(job.config.zoom)) { zoom(found, '1'); await sleep(250); }
      zoom(found, job.config.zoom);
      for (const number of job.config.pages) {
        check(job); job.current = number;
        await notify(job, 'progress', { number, phase: 'loading' });
        navigate(found, number);
        await sleep(180);
        await deliver(job, number, await capturePage(found, number, job));
      }
    } catch (error) { failure = error.message; }
    finally {
      if (found && original && sameDocument(location.href, job.config.sourceUrl)) {
        try {
          // Pagers return to the original page; page lists have no zoom or page control, only a scroll position.
          // Restoring is capped at 15 seconds so a stopped capture always finishes promptly.
          if (found.type === 'pager' && original.page) await goToPage(found, original.page, { cancelled: false, abortAt: performance.now() + 15000, config: { ...job.config, timeoutMs: 5000 } });
          if (found.type === 'pdfjs') {
            if (original.zoom) zoom(found, original.zoom);
            navigate(found, original.page);
            await sleep(250);
          }
          (found.type === 'pdfjs' ? found.container : found.scroller).scrollTo({ left: original.left, top: original.top, behavior: 'instant' });
          found.doc.defaultView.scrollTo({ left: original.windowX, top: original.windowY, behavior: 'instant' });
        } catch { /* A user can close or replace the document during restoration. */ }
      }
      running = null;
      try { await notify(job, 'finished', { error: failure, cancelled: job.cancelled }); } catch { /* Saved page data remains in extension storage. */ }
    }
  }
  // Read-only compatibility report for the current page, used by tools/compat-check.cjs. Changes nothing on the page.
  function diagnose() {
    const report = { url: location.href, title: document.title, verdict: 'unsupported', viewer: null, pages: 0, sample: null, readable: null, notes: [] };
    if (document.contentType === 'application/pdf' || document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]')) {
      report.notes.push('Uses the browser\'s built-in PDF viewer. Use its own download button instead.');
    }
    const blocked = [...document.querySelectorAll('iframe, frame')].filter((f) => { try { return !f.contentDocument; } catch { return true; } });
    if (blocked.length) report.notes.push(`Has ${blocked.length} cross-origin frame(s) PagePress cannot read: ${[...new Set(blocked.map((f) => { try { return new URL(f.src, location.href).host; } catch { return 'unknown'; } }))].join(', ')}. Opening the frame's address in its own tab may work.`);
    let found;
    try { found = findViewer(); Object.assign(report, (({ viewer, total, zoomControl }) => ({ viewer, pages: total, zoomControl }))(inspect())); }
    catch (error) { report.notes.push(error.message); return report; }
    const sampleEl = found.type === 'pdfjs' ? found.viewer.querySelector('.page[data-page-number] canvas') : found.type === 'pager' ? found.main() : found.pages().find((el) => !isLazy(el));
    if (!sampleEl) { report.notes.push('No page has finished rendering yet. Wait for the first page, then check again.'); report.verdict = 'partial'; return report; }
    report.sample = sourceSize(sampleEl);
    try { fingerprint(sampleEl); report.readable = true; } catch { report.readable = false; report.notes.push('Page pixels are blocked by browser origin rules (cross-origin or protected content).'); return report; }
    if (found.type === 'pagelist' && found.pages().some(isLazy)) report.notes.push('Some pages load only when scrolled into view; PagePress scrolls to each page during capture.');
    if (found.type === 'pager') report.notes.push(`Single-page viewer: PagePress moves through pages with its ${found.counter.kind === 'text' ? 'Next/Previous buttons' : `page ${found.counter.kind === 'select' ? 'drop-down' : 'number box'}`}.`);
    if (found.type === 'pdfjs' && !report.zoomControl) report.notes.push('No zoom control: pages are captured at the viewer\'s current zoom.');
    const sharp = report.sample.width >= 1200;
    if (!sharp && !(found.type === 'pdfjs' && report.zoomControl)) report.notes.push(`Sample page is ${report.sample.width} x ${report.sample.height} px, below the 1,200 px clear-print guide. ${found.type === 'pdfjs' ? 'Try a higher zoom.' : 'This is the source image\'s own resolution.'}`);
    // PDF.js pages below 1,200 px are refused at capture unless the viewer zooms; page lists keep native pixels with a warning.
    report.verdict = found.type === 'pdfjs' ? (report.zoomControl || sharp ? 'supported' : 'partial') : sharp ? 'supported' : 'partial';
    return report;
  }
  const api = {
    inspect,
    diagnose,
    status: () => running ? { id: running.config.id, current: running.current } : null,
    start(config) {
      if (running) throw new Error('A capture is already running in this tab.');
      const info = inspect();
      if (!Array.isArray(config.pages) || !config.pages.length || config.pages.length > 200 || config.pages.some((n) => !Number.isInteger(n) || n < 1 || n > info.total)) throw new Error('Invalid document page range.');
      if (![2, 3].includes(config.zoom) || !sameDocument(config.sourceUrl, location.href)) throw new Error('Capture settings do not match this document.');
      running = { config, current: null, cancelled: false };
      void run(running);
      return { started: true };
    },
    cancel(id) { if (running?.config.id === id) running.cancelled = true; return { stopped: true }; }
  };
  globalThis.PagePressCapture = api;
  if (globalThis.chrome?.runtime?.onMessage) chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.channel !== CHANNEL || message.type !== 'cancel') return;
    respond(api.cancel(message.jobId));
  });
})();
