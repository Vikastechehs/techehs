"""Check the real downloaded PDFs without decoding/resampling their images."""
from pathlib import Path
import json

import pypdfium2 as pdfium
from pypdf import PdfReader
from pypdf.generic import ContentStream
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2] / "test-results/pagepress"
cases = [("pagepress-21-pages.pdf", 21, 1200), ("pagepress-resumed-range.pdf", 3, 1200), ("pagepress-real-pdfjs.pdf", 6, 1500), ("pagepress-image-viewer.pdf", 4, 1240), ("pagepress-pager.pdf", 3, 1250)]
results = []
contact = Image.new("RGB", (1000, 720), "#e8eeea")
draw = ImageDraw.Draw(contact)
preview_number = 0
for filename, expected_count, min_width in cases:
    file = root / filename
    reader = PdfReader(file)
    assert len(reader.pages) == expected_count, (filename, len(reader.pages))
    widths = []
    for page in reader.pages:
        resources = page["/Resources"]["/XObject"]
        used = [operands[0] for operands, operator in ContentStream(page.get_contents(), reader).operations if operator == b"Do"]
        images = [resources[name].get_object() for name in used if resources[name].get_object().get("/Subtype") == "/Image"]
        main = max(images, key=lambda image: image["/Width"] * image["/Height"])
        widths.append(main["/Width"])
        assert main["/Width"] >= min_width
        source_ratio = main["/Height"] / main["/Width"]
        output_ratio = float(page.mediabox.height) / float(page.mediabox.width)
        assert abs(source_ratio - output_ratio) < .005, (filename, source_ratio, output_ratio)
    document = pdfium.PdfDocument(file)
    picks = [0, 4, 12, 20] if expected_count == 21 else [0] if expected_count == 3 else [3]
    for index in picks:
        page = document[index]
        bitmap = page.render(scale=1)
        image = bitmap.to_pil().convert("RGB")
        image.save(root / f"verified-{expected_count}-page-{index + 1}.png")
        image.thumbnail((310, 315))
        x, y = (preview_number % 3) * 330 + 10, (preview_number // 3) * 355 + 25
        contact.paste(image, (x, y))
        draw.text((x, y - 18), f"{expected_count}-page PDF / page {index + 1}", fill="#203e33")
        preview_number += 1
        bitmap.close()
        page.close()
    document.close()
    results.append({"file": filename, "pages": expected_count, "minimum_embedded_width": min(widths), "bytes": file.stat().st_size})
contact.save(root / "pdf-verification-contact.png")
(root / "pdf-verification.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
print(json.dumps(results, indent=2))
