(function () {
  if (globalThis.PagePressCapture) return;
  const CHANNEL = 'pagepress-capture-v1';
  let running = null;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function findViewer(doc = document, depth = 0) {
    const viewer = doc.querySelector('#viewer.pdfViewer, #viewer:has(.page[data-page-number]), .pdfViewer:has(.page[data-page-number])');
    if (viewer) return { doc, viewer, container: doc.querySelector('#viewerContainer') || viewer.parentElement };
    if (depth < 2) for (const iframe of doc.querySelectorAll('iframe')) {
      try { if (iframe.contentDocument) { const found = findViewer(iframe.contentDocument, depth + 1); if (found) return found; } } catch { /* Cross-origin frames require their own tab. */ }
    }
    return null;
  }
  function inspect() {
    const found = findViewer();
    if (!found) throw new Error('No supported document viewer found. Open the document viewer tab, then click PagePress. Chrome\'s built-in PDF viewer is not supported.');
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
    const response = await chrome.runtime.sendMessage({ channel: CHANNEL, jobId: job.config.id, type, ...payload });
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
    return { signature: `${canvas.width}:${canvas.height}:${hash}`, blank: max - min < 2 };
  }
  async function waitForPage(found, number, job) {
    const start = performance.now(); let last = '', stableAt = start;
    while (performance.now() - start < job.config.timeoutMs) {
      check(job);
      const page = found.viewer.querySelector(`.page[data-page-number="${number}"]`);
      const canvas = page?.querySelector('canvas');
      const ready = page && canvas?.width >= 1200 && canvas.height > 0 && page.getAttribute('data-loaded') === 'true';
      if (ready) {
        let probe;
        try { probe = fingerprint(canvas); } catch { throw new Error(`Page ${number} cannot be read because the site restricts canvas access.`); }
        const signature = probe.signature + ':' + page.childElementCount;
        if (last !== signature) { last = signature; stableAt = performance.now(); }
        if (performance.now() - stableAt >= job.config.settleMs) return { page, canvas, blank: probe.blank };
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
  async function capturePage(found, number, job) {
    const { page, canvas: source, blank } = await waitForPage(found, number, job);
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
    const warning = /not available|unavailable|उपलब्ध\s*नहीं/i.test(text) ? 'The source viewer reports unavailable content.' : blank ? 'This source page appears blank.' : '';
    let data;
    try { data = output.toDataURL('image/png'); } catch { throw new Error(`Page ${number} has protected or cross-origin content and cannot be exported.`); }
    if (!data.startsWith('data:image/png;base64,')) throw new Error('The browser could not allocate a page image. Retry at 200% quality.');
    const result = { number, width: output.width, height: output.height, data, warning, layered, capturedAt: new Date().toISOString() };
    output.width = 1; output.height = 1;
    return result;
  }
  async function run(job) {
    let found, original, failure = null;
    try {
      found = findViewer(); if (!found) throw new Error('The document viewer is no longer available.');
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
        const captured = await capturePage(found, number, job);
        await notify(job, 'page', { page: captured });
        check(job);
      }
    } catch (error) { failure = error.message; }
    finally {
      if (found && original && location.href === job.config.sourceUrl) {
        try {
          if (original.zoom) zoom(found, original.zoom);
          navigate(found, original.page);
          await sleep(250);
          found.container.scrollTo({ left: original.left, top: original.top, behavior: 'instant' });
          found.doc.defaultView.scrollTo({ left: original.windowX, top: original.windowY, behavior: 'instant' });
        } catch { /* A user can close or replace the document during restoration. */ }
      }
      running = null;
      try { await notify(job, 'finished', { error: failure, cancelled: job.cancelled }); } catch { /* Saved page data remains in extension storage. */ }
    }
  }
  const api = {
    inspect,
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
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.channel !== CHANNEL || message.type !== 'cancel') return;
    respond(api.cancel(message.jobId));
  });
})();
