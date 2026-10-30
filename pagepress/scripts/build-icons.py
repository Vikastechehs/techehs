"""Generate the extension's existing P brand mark at Chrome icon sizes."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

target = Path(__file__).resolve().parents[1] / "extension/icons"
target.mkdir(parents=True, exist_ok=True)
image = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((4, 4, 252, 252), radius=42, fill="#203e33")
font = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 178)
box = draw.textbbox((0, 0), "P", font=font)
draw.text(((256 - (box[2] - box[0])) / 2 - box[0], (256 - (box[3] - box[1])) / 2 - box[1] - 2), "P", fill="white", font=font)
for size in (16, 32, 48, 128):
    image.resize((size, size), Image.Resampling.LANCZOS).save(target / f"{size}.png")
print("Built Chrome extension icons.")
