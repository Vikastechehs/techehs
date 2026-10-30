const pdfjs = await import('/pdfjs/legacy/build/pdf.mjs');
globalThis.pdfjsLib = pdfjs;
const { PDFViewer, EventBus, PDFLinkService } = await import('/pdfjs/legacy/web/pdf_viewer.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/legacy/build/pdf.worker.mjs';
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
// Match the portal's full-sheet canvas rendering rather than newer viewport-only detail canvases.
const viewer = new PDFViewer({ container: document.getElementById('viewerContainer'), viewer: document.getElementById('viewer'), eventBus, linkService, textLayerMode: 1, capCanvasAreaFactor: -1, enableDetailCanvas: false });
linkService.setViewer(viewer);
const pageNumber = document.getElementById('pageNumber'), scale = document.getElementById('scaleSelect');
pageNumber.addEventListener('change', () => { viewer.currentPageNumber = Number(pageNumber.value); });
scale.addEventListener('change', () => { viewer.currentScaleValue = scale.value; });
eventBus.on('pagechanging', ({ pageNumber: number }) => { pageNumber.value = number; });
eventBus.on('pagesinit', () => {
  pageNumber.max = viewer.pagesCount;
  document.getElementById('numPages').textContent = 'of ' + viewer.pagesCount;
  viewer.scrollMode = 3;
  viewer.currentScaleValue = '0.5';
  viewer.currentPageNumber = 3;
});
const pdf = await pdfjs.getDocument({ url: '/real-document.pdf', standardFontDataUrl: '/pdfjs/standard_fonts/', useSystemFonts: true, isEvalSupported: false }).promise;
viewer.setDocument(pdf);
linkService.setDocument(pdf);
