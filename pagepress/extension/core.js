(function (root) {
  function filename(input, format = 'pdf') {
    const extension = { pdf: 'pdf', jpeg: 'zip', jpg: 'jpg' }[format];
    if (!extension) throw new Error('Choose PDF or JPEG output.');
    const name = String(input || 'document').replace(/\.(pdf|zip|jpe?g)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[.\s]+$/g, '').trim().slice(0, 110);
    return (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? 'document-' + name : name || 'document') + '.' + extension;
  }
  function imageFilename(input, page) {
    if (!Number.isInteger(page) || page < 1) throw new Error('Invalid image page number.');
    return filename(input, 'jpg').replace(/\.jpg$/, '') + '-page-' + String(page).padStart(3, '0') + '.jpg';
  }
  function validate(config, total) {
    const from = Number(config.from), to = Number(config.to), zoom = Number(config.zoom);
    if (!Number.isInteger(total) || total < 1 || total > 10000) throw new Error('Cannot read a supported document page count.');
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > total) throw new Error(`Choose a page range between 1 and ${total}.`);
    if (to - from + 1 > 200) throw new Error('Capture at most 200 pages at a time. Choose a smaller page range.');
    if (![2, 3].includes(zoom)) throw new Error('Select 200% or 300% capture quality.');
    const format = config.format || 'pdf';
    if (!['pdf', 'jpeg'].includes(format)) throw new Error('Choose PDF or JPEG output.');
    return { ...config, format, from, to, zoom, settleMs: Math.max(600, Math.min(3000, Number(config.settleMs) || 800)), timeoutMs: Math.max(10000, Math.min(60000, Number(config.timeoutMs) || 30000)) };
  }
  function expectedPages(job) { return Array.from({ length: job.to - job.from + 1 }, (_, i) => job.from + i); }
  function missingPages(job, pages) {
    const saved = new Set(pages.map((p) => p.number));
    return expectedPages(job).filter((n) => !saved.has(n));
  }
  function orderedPages(job, pages) {
    const missing = missingPages(job, pages);
    if (missing.length) throw new Error(`Capture is incomplete. Missing page${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);
    const map = new Map(pages.map((p) => [p.number, p]));
    return expectedPages(job).map((n) => map.get(n));
  }
  function pageSize(width, height) {
    if (!(width > 0 && height > 0)) throw new Error('Invalid captured page dimensions.');
    const w = 595.276;
    return { width: w, height: w * height / width, orientation: width > height ? 'landscape' : 'portrait' };
  }
  function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  root.PagePressCore = { filename, imageFilename, validate, expectedPages, missingPages, orderedPages, pageSize, escape };
  if (typeof module !== 'undefined') module.exports = root.PagePressCore;
})(globalThis);
