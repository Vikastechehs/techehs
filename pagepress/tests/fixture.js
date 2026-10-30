(() => {
  const params = new URLSearchParams(location.search);
  const total = Number(params.get('pages') || 21);
  const delay = Number(params.get('delay') || 350);
  const fail = Number(params.get('fail') || 0);
  const input = document.getElementById('pageNumber'), select = document.getElementById('scaleSelect');
  input.max = total; input.value = Math.min(4, total);
  document.getElementById('numPages').textContent = 'of ' + total;
  let generation = 0;
  function render() {
    const current = Math.max(1, Math.min(total, Number(input.value)));
    input.value = current;
    const scale = Number(select.value), width = 600, height = current === 13 ? 210 : 850;
    const page = document.createElement('div'); page.className = 'page'; page.dataset.pageNumber = current;
    page.style.width = width * scale + 'px'; page.style.height = height * scale + 'px';
    page.dataset.loaded = 'false';
    const wrapper = document.createElement('div'); wrapper.className = 'canvasWrapper';
    const canvas = document.createElement('canvas'); canvas.width = width * scale; canvas.height = height * scale;
    canvas.style.width = width * scale + 'px'; canvas.style.height = height * scale + 'px';
    wrapper.append(canvas); page.append(wrapper);
    const text = document.createElement('div'); text.className = 'textLayer'; text.innerHTML = '<div class="endOfContent"></div>';
    if (current === 17) text.textContent = 'Source file unavailable';
    page.append(text);
    if (current === 5) {
      const watermark = document.createElement('div'); watermark.className = 'watermark'; watermark.textContent = 'VIEW COPY'; page.append(watermark);
      const approval = document.createElement('div'); approval.className = 'approval'; approval.textContent = 'Visible approval layer'; page.append(approval);
    }
    document.getElementById('viewer').replaceChildren(page);
    document.getElementById('viewerContainer').scrollTo(0, 0);
    const token = ++generation;
    setTimeout(() => {
      if (token !== generation || fail === current) return;
      const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#163c31'; ctx.fillRect(24, 24, width - 48, 60);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 24px Arial'; ctx.fillText('DOCUMENT PAGE ' + current, 40, 63);
      ctx.fillStyle = '#25352d'; ctx.font = '16px Arial';
      for (let y = 130; y < height - 70; y += 35) { ctx.fillText('Readable source text / sheet ' + current + ' / line ' + y, 32, y); ctx.strokeStyle = '#dce5df'; ctx.strokeRect(25, y + 5, width - 50, 20); }
      if (current === 17) { ctx.fillStyle = '#ae302a'; ctx.fillText('Source file unavailable', 32, 110); }
      ctx.fillStyle = '#c33a29'; ctx.fillRect(width - 36, height - 36, 12, 12);
      ctx.fillStyle = '#17654b'; ctx.fillRect(24, height - 36, 12, 12);
      ctx.font = '12px Arial'; ctx.fillStyle = '#222'; ctx.fillText('END OF PAGE ' + current, 50, height - 25);
      page.dataset.loaded = 'true';
    }, delay);
  }
  input.addEventListener('change', render); select.addEventListener('change', render); render();
})();
