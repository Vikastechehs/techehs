// Fixture viewers for page-list (image/canvas) capture and the compatibility checker.
// PNGs are generated here so no binary fixtures are stored in the repository.
const zlib = require('node:zlib');

// Minimal RGB PNG encoder. draw(x, y) returns [r, g, b].
function png(width, height, draw) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0, o = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) { const [r, g, b] = draw(x, y); raw[o++] = r; raw[o++] = g; raw[o++] = b; }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A scanned-sheet stand-in: dark header band, one bar per page number (so order can be verified),
// and coloured corner markers to prove edges are intact.
const cache = new Map();
function pageImage(number, { landscape = false, small = false } = {}) {
  const key = `${number}:${landscape}:${small}`;
  if (cache.has(key)) return cache.get(key);
  let width = small ? 900 : 1240, height = small ? 1273 : 1754;
  if (landscape) [width, height] = [height, width];
  const image = png(width, height, (x, y) => {
    if (x < 24 && y < 24) return [23, 101, 75];
    if (x >= width - 24 && y >= height - 24) return [195, 58, 41];
    if (y > 40 && y < 140 && x > 40 && x < width - 40) return [22, 60, 49];
    for (let bar = 0; bar < number; bar++) { const top = 220 + bar * 60; if (y >= top && y < top + 30 && x > 60 && x < 600) return [30, 30, 30]; }
    return (y % 48 === 0 && x > 40 && x < width - 40) ? [220, 229, 223] : [255, 255, 255];
  });
  cache.set(key, image);
  return image;
}
const html = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
body{margin:0;background:#3b3d41;font-family:Arial}header{height:44px;background:#222;color:#fff;padding:12px;box-sizing:border-box}
#scroller{position:absolute;top:44px;bottom:0;left:0;right:0;overflow:auto}.sheet{margin:16px auto;width:600px;background:#fff}
.sheet img,.sheet canvas{display:block;width:100%;height:auto}.sheet.landscape{width:820px}.logo{width:32px;height:32px}
</style></head><body><header><img class="logo" src="/page-image/1.png" alt="">Document viewer</header><div id="scroller">${body}</div><script>${script}</script></body></html>`;

// Returns true when it handled the request.
function handle(req, res, otherOrigin) {
  const url = new URL(req.url, 'http://localhost');
  const send = (type, body) => { res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': url.searchParams.get('cors') ? '*' : '' }); res.end(body); return true; };
  const image = /^\/page-image\/(\d+)\.png$/.exec(url.pathname);
  if (image) return send('image/png', pageImage(Number(image[1]), { landscape: url.searchParams.has('landscape'), small: url.searchParams.has('small') }));
  if (url.pathname === '/image-viewer') {
    // Pages 1-2 load eagerly; later pages are lazy (placeholder src + data-src, loaded when scrolled near), like many portals.
    const total = Number(url.searchParams.get('pages') || 6), small = url.searchParams.has('small') ? '?small=1' : '';
    const base = url.searchParams.has('cross') ? otherOrigin : '';
    const sheets = Array.from({ length: total }, (_, i) => {
      const n = i + 1, landscape = n === 3 && !small, src = `${base}/page-image/${n}.png${landscape ? '?landscape=1' : small}`;
      return `<div class="sheet${landscape ? ' landscape' : ''}">${n <= 2 ? `<img src="${src}" alt="Page ${n}">` : `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="${src}" alt="Page ${n}" style="min-height:400px">`}</div>`;
    }).join('');
    return send('text/html', html('Image page viewer', sheets, `
      const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting && e.target.dataset.src) { const t = e.target; setTimeout(() => { t.src = t.dataset.src; t.removeAttribute('data-src'); t.style.minHeight = ''; }, 300); io.unobserve(t); } }), { root: document.getElementById('scroller') });
      document.querySelectorAll('img[data-src]').forEach((img) => io.observe(img));`));
  }
  if (url.pathname === '/canvas-viewer') {
    const sheets = Array.from({ length: 4 }, (_, i) => `<div class="sheet"><canvas width="1300" height="1840" data-n="${i + 1}"></canvas></div>`).join('');
    return send('text/html', html('Canvas page viewer', sheets, `
      document.querySelectorAll('canvas').forEach((c) => { const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#163c31'; x.fillRect(40, 40, c.width - 80, 120); x.font = '64px Arial'; x.fillStyle = '#111'; x.fillText('CANVAS SHEET ' + c.dataset.n, 60, 320); });`));
  }
  if (url.pathname === '/pdf-embed') return send('text/html', html('Built-in PDF', '<embed type="application/pdf" src="/missing.pdf" width="800" height="600">'));
  if (url.pathname === '/framed-cross-origin') return send('text/html', html('Framed document', `<iframe src="${otherOrigin}/image-viewer?pages=2" width="900" height="700"></iframe>`));
  return false;
}
module.exports = { handle, pageImage, png };
