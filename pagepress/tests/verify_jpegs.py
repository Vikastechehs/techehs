"""Independently decode browser exports and verify original page dimensions."""
import io
import json
from pathlib import Path
from zipfile import ZipFile

from PIL import Image

artifacts = Path(__file__).resolve().parents[2] / 'test-results' / 'pagepress'
checks = []
for archive, numbers in [('pagepress-21-jpegs.zip', range(1, 22)),
                         ('pagepress-resumed-range.zip', range(2, 5))]:
    with ZipFile(artifacts / archive) as bundle:
        names = bundle.namelist()
        assert len(names) == len(numbers)
        for name, number in zip(names, numbers):
            assert name.endswith(f'-page-{number:03}.jpg'), name
            with Image.open(io.BytesIO(bundle.read(name))) as image:
                image.load()
                assert image.format == 'JPEG'
                expected = (1200, 420 if number == 13 else 1700)
                assert image.size == expected, (name, image.size)
                if number == 5:
                    # The bottom-right red stamp survives export without clipping.
                    pixel = image.getpixel((image.width - 60, image.height - 60))
                    assert all(abs(a - b) < 12 for a, b in zip(pixel, (195, 58, 41))), pixel
                checks.append({'archive': archive, 'page': number, 'dimensions': image.size})

with Image.open(artifacts / 'pagepress-page-013.jpg') as single:
    single.load()
    assert single.format == 'JPEG' and single.size == (1200, 420)
with ZipFile(artifacts / 'pagepress-21-jpegs.zip') as bundle:
    assert (artifacts / 'pagepress-page-013.jpg').read_bytes() == bundle.read('pagepress-21-pages-page-013.jpg')

(artifacts / 'jpeg-verification.json').write_text(json.dumps(checks, indent=2))
print('PASS: 24 ordered JPEGs decode at original dimensions; individual JPEG matches; source stamp retained.')
