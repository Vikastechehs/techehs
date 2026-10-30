/* global PagePressCore, PagePressStore, PagePressBilling, jspdf, fflate, chrome */
(async function () {
  const $ = (id) => document.getElementById(id);
  const core = PagePressCore, store = PagePressStore, esc = core.escape;
  const CHANNEL = 'pagepress-capture-v1';
  const enabled = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  let source = null, sourceTabId = null, job = null, pages = [], busy = false, detecting = false;
  let download = null, activity = [], authorizing = false;
  const stateNames = { ready: 'Ready', capturing: 'Capturing', captured: 'Captured', building: 'Preparing file', downloading: 'Saving', complete: 'Saved', failed: 'Needs attention', cancelled: 'Stopped' };
  function notice(text, error = false) { $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); }
  function log(text) {
    activity.unshift({ text, time: new Date().toLocaleTimeString() }); activity = activity.slice(0, 60);
    $('activity-list').innerHTML = activity.map((a) => `<li><time>${esc(a.time)}</time>${esc(a.text)}</li>`).join('');
  }
  function setState(state) { $('state').textContent = stateNames[state] || state; $('state').className = 'badge ' + state; }
  function controls() {
    const locked = busy || detecting || authorizing || !!download;
    PagePressBilling.setBusy(locked);
    for (const id of ['format', 'quality', 'timing', 'from', 'to', 'filename', 'save-as']) $(id).disabled = locked;
    $('detect').disabled = locked;
    $('capture').disabled = locked || !source;
    $('capture').textContent = job ? 'New capture' : source ? `Capture ${Math.max(1, Number($('to').value) - Number($('from').value) + 1)} pages` : 'Capture all pages';
    $('stop').hidden = job?.status !== 'capturing';
    $('clear').disabled = locked || !job;
    const missing = job ? core.missingPages(job, pages) : [];
    $('resume').hidden = !job || locked || !missing.length || !['failed', 'cancelled'].includes(job.status);
    $('save').hidden = !job || locked || !!missing.length;
    $('save').textContent = $('format').value === 'jpeg' ? 'Download JPEG ZIP' : 'Download PDF';
    document.querySelectorAll('[data-jpeg]').forEach((button) => button.disabled = locked);
  }
  function syncFormat() {
    $('filename').value = core.filename($('filename').value, $('format').value);
    $('format-detail').textContent = $('format').value === 'jpeg' ? 'One JPEG per page' : 'Separate PDF pages';
    controls();
  }
  function renderPages() {
    const list = $('page-list');
    list.className = pages.length ? '' : 'empty';
    list.innerHTML = pages.length ? [...pages].sort((a, b) => a.number - b.number).map((p) => `<article class="page-row"><img src="${esc(p.thumbnail)}" alt="Document sheet ${p.number}"><div class="details"><strong>Page ${p.number}</strong><p>${p.width.toLocaleString()} x ${p.height.toLocaleString()} px / source</p>${p.warning ? `<p class="warning">${esc(p.warning)}</p>` : ''}</div><div class="page-actions"><span class="badge ${p.warning ? 'capturing' : 'ready'}">${p.warning ? 'Review' : 'Captured'}</span><button class="text-button" data-jpeg="${p.number}" title="Download page ${p.number} as JPEG">Save JPEG</button></div></article>`).join('') : '<div class="paper-symbol" aria-hidden="true"></div><p>No captured pages yet</p>';
    $('progress-count').textContent = `${pages.length}${job ? ' / ' + core.expectedPages(job).length : ''} pages saved`;
    $('progress').max = job ? core.expectedPages(job).length : 1;
    $('progress').value = pages.length;
    $('storage-state').textContent = job ? `${(pages.reduce((sum, p) => sum + p.bytes, 0) / 1048576).toFixed(1)} MB / stored locally` : 'Stored only in this browser';
    controls();
  }
  async function confirmReplace(text) {
    $('confirm-text').textContent = text;
    $('confirm').returnValue = 'cancel'; $('confirm').showModal();
    return await new Promise((resolve) => $('confirm').addEventListener('close', () => resolve($('confirm').returnValue === 'confirm'), { once: true }));
  }
  function showSource(info) {
    $('source-title').textContent = info.title || 'Document viewer'; $('source-url').textContent = info.url;
    $('total').textContent = info.total; $('viewer-kind').textContent = info.viewer;
    $('to').max = info.total; $('from').max = info.total;
  }
  async function target() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (/^https?:/.test(active?.url || '')) return active;
    const own = await chrome.tabs.getCurrent();
    if (own?.id === active?.id) {
      const { pagepressTabId } = await chrome.storage.local.get('pagepressTabId');
      if (pagepressTabId) { const tab = await chrome.tabs.get(pagepressTabId).catch(() => null); if (/^https?:/.test(tab?.url || '')) return tab; }
    }
    throw new Error('Open the document website and click the PagePress toolbar icon to grant access.');
  }
  async function inject(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['vendor/html2canvas.min.js', 'capture.js'] });
  }
  async function inspectTab(tabId) {
    await inject(tabId);
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      try { return { info: globalThis.PagePressCapture.inspect(), running: globalThis.PagePressCapture.status() }; }
      catch (error) { return { error: error.message }; }
    } });
    if (!result?.result) throw new Error('Could not inspect the document tab. Reopen it and click the PagePress toolbar icon.');
    if (result.result.error) throw new Error(result.result.error);
    return result.result;
  }
  async function detect() {
    if (!enabled) { notice('Load the PagePress extension in Chrome to connect to a document viewer.'); return; }
    detecting = true; controls();
    try {
      const tab = await target(); const result = await inspectTab(tab.id);
      source = result.info; sourceTabId = tab.id;
      await chrome.storage.local.set({ pagepressTabId: tab.id });
      showSource(source);
      if (!job) { $('from').value = 1; $('to').value = Math.min(source.total, PagePressBilling.pageLimit); $('filename').value = core.filename(source.title, $('format').value); setState('ready'); }
      if (result.running && job?.id !== result.running.id) throw new Error('Another capture is already running in this tab.');
      if (result.running && job?.id === result.running.id) { job.status = 'capturing'; busy = true; await store.saveJob(job); setState('capturing'); }
      log(`Connected: ${source.total} document pages.`); notice('');
    } catch (error) { source = null; notice(error.message, true); if (!job) setState('Not connected'); }
    finally { detecting = false; controls(); }
  }
  async function launchCapture(resume = false) {
    if (busy || authorizing || download || !enabled) return;
    authorizing = true; controls();
    try {
      const count = resume ? job.to - job.from + 1 : Number($('to').value) - Number($('from').value) + 1;
      const access = await PagePressBilling.authorize(count);
      if (!access.allowed) { notice(access.error, true); PagePressBilling.openPlans(); return; }
      const tab = resume ? await chrome.tabs.get(job.tabId) : await target();
      const inspected = await inspectTab(tab.id);
      if (inspected.running) throw new Error('A capture is already running. Wait for it to finish or stop it first.');
      if (resume && (inspected.info.url !== job.sourceUrl || inspected.info.total !== job.total)) throw new Error('The original document has changed. Start a new capture.');
      let config;
      if (!resume) {
        config = core.validate({ from: $('from').value, to: $('to').value, zoom: $('quality').value, format: $('format').value, settleMs: $('timing').value, timeoutMs: 30000 }, inspected.info.total);
        if (job && !await confirmReplace('Replace the current saved capture? Previously downloaded files are kept.')) return;
        job = { ...config, id: crypto.randomUUID(), sourceUrl: inspected.info.url, title: inspected.info.title, total: inspected.info.total, tabId: tab.id, filename: core.filename($('filename').value, config.format), askSaveAs: $('save-as').checked, status: 'capturing', createdAt: new Date().toISOString() };
        pages = []; await store.reset(job); activity = []; log(`Started pages ${job.from}-${job.to} at ${job.zoom * 100}%.`);
      } else {
        const retrySettings = core.validate({ ...job, zoom: $('quality').value, settleMs: $('timing').value }, inspected.info.total);
        job.zoom = retrySettings.zoom; job.settleMs = retrySettings.settleMs;
        job.status = 'capturing'; await store.saveJob(job); log('Retrying missing pages with the selected quality and timing.');
      }
      source = inspected.info; sourceTabId = tab.id; showSource(source);
      busy = true; setState('capturing'); renderPages(); notice('');
      const missing = core.missingPages(job, pages);
      const [started] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (config) => {
        try { return globalThis.PagePressCapture.start(config); }
        catch (error) { return { error: error.message }; }
      }, args: [{ ...job, pages: missing }] });
      if (!started?.result?.started) throw new Error(started?.result?.error || 'The source tab could not start capture.');
    } catch (error) {
      busy = false;
      if (job) { job.status = 'failed'; job.error = error.message; await store.saveJob(job).catch(() => {}); }
      notice(error.message, true); setState('failed'); controls();
    } finally { authorizing = false; controls(); }
  }
  async function thumbnail(data) {
    const image = new Image(); image.src = data; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 140; canvas.height = Math.max(1, Math.round(140 * image.height / image.width));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .75);
  }
  async function receive(message, sender) {
    if (!job || message.jobId !== job.id || sender.tab?.id !== job.tabId) throw new Error('The capture session no longer matches this panel.');
    if (message.type === 'progress') {
      $('progress-detail').textContent = `Loading page ${message.number} of ${job.total}...`;
      return;
    }
    if (message.type === 'page') {
      const page = message.page;
      if (!Number.isInteger(page.number) || page.number < job.from || page.number > job.to || !page.data?.startsWith('data:image/png;base64,') || !(page.width > 0 && page.height > 0)) throw new Error('The viewer returned an invalid page image.');
      const bytes = Math.round(page.data.length * .75);
      if (pages.filter((p) => p.number !== page.number).reduce((sum, p) => sum + p.bytes, bytes) > 150 * 1048576) throw new Error('Capture reached the 150 MB limit. Use a smaller page range or 200% quality.');
      page.thumbnail = await thumbnail(page.data); page.bytes = bytes;
      await store.savePage(page);
      const { data, ...metadata } = page;
      pages = [...pages.filter((p) => p.number !== page.number), metadata];
      await store.saveJob(job);
      renderPages(); $('progress-detail').textContent = `Captured page ${page.number} at ${page.width.toLocaleString()} x ${page.height.toLocaleString()} pixels.`;
      log(`Page ${page.number} captured${page.warning ? ': ' + page.warning : '.'}`);
      return;
    }
    if (message.type === 'finished') {
      busy = false;
      const missing = core.missingPages(job, pages);
      job.status = message.cancelled ? 'cancelled' : message.error || missing.length ? 'failed' : 'captured';
      job.error = message.error || (missing.length ? 'The capture did not include every requested page.' : '');
      await store.saveJob(job); setState(job.status); renderPages();
      if (job.status !== 'captured') { notice(job.error || 'Capture stopped. Saved pages are retained.', job.status === 'failed'); log(job.error || 'Capture stopped.'); }
      else { log(`All ${pages.length} pages captured. Preparing download.`); $('progress-detail').textContent = 'All pages captured. Preparing download...'; }
    }
  }
  if (enabled) chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.channel !== CHANNEL || !['page', 'progress', 'finished'].includes(message.type)) return;
    receive(message, sender).then(() => {
      respond({ ok: true });
      if (message.type === 'finished' && job?.status === 'captured') void saveOutput();
    }).catch((error) => { notice(error.message, true); respond({ ok: false, error: error.message }); });
    return true;
  });
  async function jpegBlob(page) {
    const image = new Image(); image.src = page.data; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0);
    try {
      return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob?.type === 'image/jpeg' ? resolve(blob) : reject(new Error('The browser could not encode this page as JPEG.')), 'image/jpeg', .95));
    } finally { canvas.width = 1; canvas.height = 1; }
  }
  async function saveOutput(pageNumber = null) {
    if (busy || download || !job) return;
    const previousStatus = job.status;
    const format = pageNumber === null ? $('format').value : 'jpg';
    let objectUrl;
    try {
      busy = true; job.status = 'building'; await store.saveJob(job); setState('building'); controls(); notice('');
      const retained = await store.getPages();
      const all = pageNumber === null ? core.orderedPages(job, retained) : retained.filter((p) => p.number === pageNumber);
      if (!all.length) throw new Error('This page is no longer saved.');
      let blob;
      if (format === 'pdf') {
        let pdf;
        for (let i = 0; i < all.length; i++) {
          const page = all[i], size = core.pageSize(page.width, page.height);
          if (!pdf) pdf = new jspdf.jsPDF({ orientation: size.orientation, unit: 'pt', format: [size.width, size.height], compress: true });
          else pdf.addPage([size.width, size.height], size.orientation);
          pdf.addImage(page.data, 'PNG', 0, 0, size.width, size.height, `page-${page.number}`, 'FAST');
          pdf.outline?.add(null, `Page ${page.number}`, { pageNumber: i + 1 });
          $('progress-detail').textContent = `Preparing PDF page ${i + 1} of ${all.length}...`;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (pdf.getNumberOfPages() !== all.length) throw new Error('PDF page count does not match the capture.');
        pdf.setProperties({ title: job.title || 'Captured document', subject: `${all.length} separate document pages`, creator: 'PagePress' });
        blob = pdf.output('blob');
      } else if (format === 'jpg') {
        $('progress-detail').textContent = `Preparing page ${pageNumber} as JPEG...`;
        blob = await jpegBlob(all[0]);
      } else if (format === 'jpeg') {
        const files = {};
        for (let i = 0; i < all.length; i++) {
          $('progress-detail').textContent = `Preparing JPEG ${i + 1} of ${all.length}...`;
          files[core.imageFilename($('filename').value, all[i].number)] = new Uint8Array(await (await jpegBlob(all[i])).arrayBuffer());
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        blob = new Blob([fflate.zipSync(files, { level: 0 })], { type: 'application/zip' });
      } else {
        throw new Error('Choose PDF or JPEG output.');
      }
      objectUrl = URL.createObjectURL(blob);
      const outputName = format === 'jpg' ? core.imageFilename($('filename').value || job.filename, pageNumber) : core.filename($('filename').value || job.filename, format);
      if (pageNumber === null) { job.format = format; job.filename = outputName; }
      const id = await chrome.downloads.download({ url: objectUrl, filename: outputName, saveAs: $('save-as').checked, conflictAction: 'uniquify' });
      download = { id, url: objectUrl, jobId: job.id, format, filename: outputName, count: all.length, pageNumber, previousStatus };
      job.status = 'downloading'; await store.saveJob(job);
      setState('downloading'); $('progress-detail').textContent = `Saving ${outputName} (${(blob.size / 1048576).toFixed(1)} MB)...`;
      log(`Saving ${outputName}.`);
      const [item] = await chrome.downloads.search({ id });
      if (item?.state === 'complete') await finishDownload('complete');
      else if (item?.state === 'interrupted') await finishDownload('interrupted', item.error);
    } catch (error) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      job.status = 'failed'; job.error = error.message; await store.saveJob(job).catch(() => {});
      setState('failed'); notice('Download could not be saved. Captured pages are retained. ' + error.message, true); log(error.message);
    } finally { busy = false; controls(); }
  }
  async function finishDownload(state, error) {
    if (!download) return;
    const completed = download; download = null; URL.revokeObjectURL(completed.url);
    if (job?.id !== completed.jobId) return;
    job.status = state === 'complete' ? completed.pageNumber !== null && ['failed', 'cancelled'].includes(completed.previousStatus) ? completed.previousStatus : 'complete' : 'failed';
    await store.saveJob(job); setState(job.status);
    if (state === 'complete') {
      const detail = completed.format === 'pdf' ? `Saved one PDF with ${completed.count} separate pages.` : completed.format === 'jpeg' ? `Saved ${completed.count} separate JPEG images in one ZIP.` : `Saved page ${completed.pageNumber} as JPEG.`;
      $('progress-detail').textContent = detail; notice(`Saved ${completed.filename}. ${detail}`); log('Download completed.');
    } else { notice(`Download cancelled or interrupted${error ? ': ' + error : ''}. Captured pages are retained; choose Download again.`, true); log('Download interrupted.'); }
    controls();
  }
  if (enabled) chrome.downloads.onChanged.addListener((delta) => {
    if (delta.id === download?.id && ['complete', 'interrupted'].includes(delta.state?.current)) void finishDownload(delta.state.current, delta.error?.current);
  });
  $('detect').addEventListener('click', detect);
  $('capture').addEventListener('click', () => launchCapture(false));
  $('resume').addEventListener('click', () => launchCapture(true));
  $('save').addEventListener('click', () => saveOutput());
  $('format').addEventListener('change', syncFormat);
  $('page-list').addEventListener('click', (event) => { const button = event.target.closest('[data-jpeg]'); if (button) void saveOutput(Number(button.dataset.jpeg)); });
  for (const id of ['from', 'to']) $(id).addEventListener('input', controls);
  $('stop').addEventListener('click', async () => {
    try { await chrome.tabs.sendMessage(job.tabId, { channel: CHANNEL, type: 'cancel', jobId: job.id }); $('progress-detail').textContent = 'Stopping and restoring the document view...'; }
    catch (error) { busy = false; job.status = 'cancelled'; await store.saveJob(job); setState('cancelled'); notice(error.message, true); controls(); }
  });
  $('clear').addEventListener('click', async () => {
    if (busy || download || !await confirmReplace('Remove captured page images from this browser? Downloaded files are kept.')) return;
    await store.clear(); job = null; pages = []; activity = []; $('activity-list').replaceChildren();
    setState(source ? 'ready' : 'Not connected'); renderPages(); notice('Capture cleared.'); $('progress-detail').textContent = 'Ready for a new capture.';
  });
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.view').forEach((view) => view.hidden = view.id !== button.dataset.view);
    document.querySelectorAll('[data-view]').forEach((b) => { b.classList.toggle('active', b === button); if (b === button) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  }));
  try {
    await PagePressBilling.ready;
    job = await store.getJob() || null;
    if (job) {
      pages = (await store.getPages()).map(({ data, ...page }) => page);
      $('format').value = job.format || 'pdf'; $('filename').value = job.filename; syncFormat(); $('quality').value = job.zoom; $('timing').value = job.settleMs;
      $('from').value = job.from; $('to').value = job.to; $('save-as').checked = !!job.askSaveAs;
      showSource({ title: job.title, url: job.sourceUrl, total: job.total, viewer: 'Saved document capture' });
      if (['capturing', 'building', 'downloading'].includes(job.status)) { job.status = 'failed'; job.error = 'Capture interrupted. Retry missing pages or download the saved pages again.'; await store.saveJob(job); notice(job.error); }
      setState(job.status); renderPages(); $('progress-detail').textContent = `${pages.length} captured pages retained in this browser.`;
    }
    if (enabled) await detect(); else notice('Install PagePress in Chrome to capture a document.');
  } catch (error) { notice('Local capture storage is unavailable. ' + error.message, true); }
  controls();
})();
