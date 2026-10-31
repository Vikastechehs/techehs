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
  const isLazy = (el) => el.tagName === 'IMG' && sourceSize(el).width < MIN_SOURCE && LAZY_ATTRS.some((a) => el.hasAttribute(a));
  function pageShaped(el) {
    if (isLazy(el)) return true;
    const { width, height } = sourceSize(el), rect = el.getBoundingClientRect();
    return width >= MIN_SOURCE && height >= 200 && height / width > 0.25 && height / width < 4 && rect.width >= 120 && rect.height >= 80;
  }
  function findPageList(doc) {
    const candidates = [...doc.querySelectorAll('img, canvas')].filter(pageShaped);
    if (!candidates.length) return null;
    // Group by parent, or by grandparent when each page sits in its own wrapper; take the largest group.
    const groups = new Map();
    for (const el of candidates) for (const key of [el.parentElement, el.parentElement?.parentElement]) if (key) groups.set(key, [...(groups.get(key) || []), el]);
    let container = null, best = [];
    for (const [key, members] of groups) if (members.length > best.length || (members.length === best.length && key.contains(container))) { container = key; best = members; }
    const tag = best.filter((el) => el.tagName === 'IMG').length * 2 >= best.length ? 'IMG' : 'CANVAS';
    if (!best.some((el) => el.tagName === tag && !isLazy(el))) return null;
    const pages = () => [...container.querySelectorAll(tag.toLowerCase())].filter(pageShaped);
    return { type: 'pagelist', doc, container, tag, pages, scroller: scrollParent(best[0]) };
  }
  function scrollParent(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY + style.overflowX) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) return node;
    }
    return el.ownerDocument.scrollingElement || el.ownerDocument.documentElement;
  }
  function findViewer() {
    const docs = documents();
    for (const doc of docs) { const found = findPdfJs(doc); if (found) return found; }
    for (const doc of docs) { const found = findPageList(doc); if (found) return found; }
    return null;
  }
  function inspect() {
    const found = findViewer();
    if (!found) throw new Error('No supported document viewer found. Open the document viewer tab, then click PagePress. Chrome\'s built-in PDF viewer is not supported.');
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
  function check(job) {
    if (job.cancelled) throw new Error('Capture stopped. Saved pages are retained.');
    if (location.href !== job.config.sourceUrl) throw new Error('The source tab navigated to another document. Capture stopped.');
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
  async function capturePageListItem(found, number, job) {
    const start = performance.now(); let last = '', stableAt = start, el;
    while (performance.now() - start < job.config.timeoutMs) {
      check(job);
      const pages = found.pages();
      if (pages.length < number) throw new Error(`Page ${number} is no longer in this viewer. Reload the document and retry.`);
      if (el !== pages[number - 1]) { el = pages[number - 1]; el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); last = ''; stableAt = performance.now(); }
      const size = sourceSize(el), ready = (el.tagName !== 'IMG' || el.complete) && size.width >= MIN_SOURCE && size.height > 0;
      if (ready) {
        let probe;
        try { probe = fingerprint(el); } catch {
          const host = el.tagName === 'IMG' ? new URL(el.currentSrc || el.src, location.href).host : '';
          throw new Error(`Page ${number} ${host ? `is an image from ${host}, which` : ''} the browser does not let extensions read. This viewer is not supported.`);
        }
        if (last !== probe.signature) { last = probe.signature; stableAt = performance.now(); }
        if (performance.now() - stableAt >= job.config.settleMs) {
          if (size.width * size.height > 32000000) throw new Error(`Page ${number} is too large to export (over 32 million pixels).`);
          const output = found.doc.createElement('canvas'); output.width = size.width; output.height = size.height;
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
      if (found.type === 'pagelist') {
        original = { left: found.scroller.scrollLeft, top: found.scroller.scrollTop, windowX: found.doc.defaultView.scrollX, windowY: found.doc.defaultView.scrollY };
        for (const number of job.config.pages) {
          check(job); job.current = number;
          await notify(job, 'progress', { number, phase: 'loading' });
          await deliver(job, number, await capturePageListItem(found, number, job));
        }
        return;
      }
      const select = found.doc.querySelector('#scaleSelect');
      let oldZoom = select?.value;
      if (oldZoom === 'custom') oldZoom = String(parseFloat(select.selectedOptions[0].textContent.replace(/[^\d.]/g, '')) / 100);
      original = { page: Number(found.doc.querySelector('#pageNumber')?.value) || 1, zoom: oldZoom, left: found.container.scrollLeft, top: found.container.scrollTop, windowX: found.doc.defaultView.scrollX, windowY: found.doc.defaultView.scrollY };
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
      if (found && original && location.href === job.config.sourceUrl) {
        try {
          // Page lists have no zoom or page control; only their scroll position is restored.
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
    const sampleEl = found.type === 'pdfjs' ? found.viewer.querySelector('.page[data-page-number] canvas') : found.pages().find((el) => !isLazy(el));
    if (!sampleEl) { report.notes.push('No page has finished rendering yet. Wait for the first page, then check again.'); report.verdict = 'partial'; return report; }
    report.sample = sourceSize(sampleEl);
    try { fingerprint(sampleEl); report.readable = true; } catch { report.readable = false; report.notes.push('Page pixels are blocked by browser origin rules (cross-origin or protected content).'); return report; }
    if (found.type === 'pagelist' && found.pages().some(isLazy)) report.notes.push('Some pages load only when scrolled into view; PagePress scrolls to each page during capture.');
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
      if (![2, 3].includes(config.zoom) || config.sourceUrl !== location.href) throw new Error('Capture settings do not match this document.');
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
