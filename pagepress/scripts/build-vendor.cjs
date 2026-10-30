const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'extension/vendor');
fs.mkdirSync(target, { recursive: true });
for (const [source, destination] of [
  ['jspdf/dist/jspdf.umd.min.js', 'jspdf.umd.min.js'],
  ['html2canvas/dist/html2canvas.min.js', 'html2canvas.min.js'],
  ['fflate/umd/index.js', 'fflate.min.js'],
  ['fflate/LICENSE', 'fflate-LICENSE.txt'],
  ['jspdf/LICENSE', 'jspdf-LICENSE.txt'],
  ['html2canvas/LICENSE', 'html2canvas-LICENSE.txt']
]) {
  fs.copyFileSync(path.join(root, 'node_modules', source), path.join(target, destination));
}
console.log('Bundled local PDF and document-rendering libraries.');
