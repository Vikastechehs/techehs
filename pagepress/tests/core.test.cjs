const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/core.js');

test('ranges and quality settings reject missing, reversed, and unsupported pages', () => {
  const config = { from: 1, to: 21, zoom: 2 };
  assert.equal(core.validate(config, 21).to, 21);
  assert.throws(() => core.validate({ ...config, to: 22 }, 21));
  assert.throws(() => core.validate({ ...config, from: 5, to: 2 }, 21));
  assert.throws(() => core.validate({ ...config, zoom: .5 }, 21));
  assert.throws(() => core.validate({ ...config, to: 201 }, 201));
  assert.equal(core.validate(config, 201).to, 21);
});
test('PDF assembly requires every requested page and sorts by document order', () => {
  const job = { from: 2, to: 4 };
  assert.deepEqual(core.missingPages(job, [{ number: 2 }, { number: 4 }]), [3]);
  assert.throws(() => core.orderedPages(job, [{ number: 2 }, { number: 4 }]), /Missing page: 3/);
  assert.deepEqual(core.orderedPages(job, [{ number: 4 }, { number: 2 }, { number: 3 }]).map((p) => p.number), [2, 3, 4]);
});
test('each document sheet retains its original aspect ratio', () => {
  assert.equal(core.pageSize(1584, 2244).orientation, 'portrait');
  const wide = core.pageSize(1584, 568);
  assert.equal(wide.orientation, 'landscape');
  assert.ok(Math.abs(wide.height / wide.width - 568 / 1584) < 1e-10);
  assert.throws(() => core.pageSize(0, 100));
});
test('filenames cannot escape Downloads or create Windows reserved names', () => {
  assert.equal(core.filename('../../bad:name.pdf'), '..-..-bad-name.pdf');
  assert.equal(core.filename('CON.pdf'), 'document-CON.pdf');
  assert.equal(core.filename(''), 'document.pdf');
  assert.equal(core.filename('Report.pdf'), 'Report.pdf');
});
test('output formats preserve the base name and order individual JPEG pages', () => {
  assert.equal(core.filename('Report.pdf', 'jpeg'), 'Report.zip');
  assert.equal(core.filename('Report.zip', 'pdf'), 'Report.pdf');
  assert.equal(core.imageFilename('Report.zip', 13), 'Report-page-013.jpg');
  assert.equal(core.imageFilename('Report.pdf', 1), 'Report-page-001.jpg');
  assert.throws(() => core.imageFilename('Report', 0));
  assert.equal(core.validate({ from: 1, to: 2, zoom: 2 }, 2).format, 'pdf');
  assert.equal(core.validate({ from: 1, to: 2, zoom: 2, format: 'jpeg' }, 2).format, 'jpeg');
  assert.throws(() => core.validate({ from: 1, to: 2, zoom: 2, format: 'png' }, 2));
});
