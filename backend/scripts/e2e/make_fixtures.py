"""Synthetic receipts for the e2e run. All data is made up."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "fixtures")
os.makedirs(OUT, exist_ok=True)

LATIN = "/System/Library/Fonts/Supplemental/Courier New.ttf"
THAI = "/System/Library/Fonts/Supplemental/Ayuthaya.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def render(name, lines, font_path=LATIN, size=26, width=640):
    f = font(font_path, size)
    pad, lh = 30, size + 14
    img = Image.new("RGB", (width, pad * 2 + lh * len(lines)), "white")
    d = ImageDraw.Draw(img)
    for i, (left, right) in enumerate(lines):
        y = pad + i * lh
        d.text((pad, y), left, fill="black", font=f)
        if right:
            w = d.textlength(right, font=f)
            d.text((width - pad - w, y), right, fill="black", font=f)
    img.save(os.path.join(OUT, name), quality=92)


# A: single simple receipt. total 214.50
render("a_mart.jpg", [
    ("SYNTHETIC MART", ""), ("Date: 2026-09-14", ""), ("-" * 32, ""),
    ("Milk 1L x2", "90.00"), ("Bread", "35.00"), ("Eggs 12pcs", "89.50"),
    ("-" * 32, ""), ("TOTAL", "214.50"), ("CASH", "214.50"),
])

# B: Thai receipt. total 70.00
render("b_thai.jpg", [
    ("ร้านทดสอบ อาหารตามสั่ง", ""), ("วันที่ 2026-09-15", ""), ("-" * 28, ""),
    ("ข้าวผัดกุ้ง", "60.00"), ("น้ำเปล่า", "10.00"),
    ("-" * 28, ""), ("รวมทั้งสิ้น", "70.00"),
], font_path=THAI, size=24)

# C: ONE long receipt shot in two photos; "Croissant" and "Cookie" appear in both.
# Merged expected: 6 items, total 465.00 (double-counting would give 575).
render("c_cafe_1.jpg", [
    ("SYNTHETIC CAFE", ""), ("Date: 2026-09-16", ""), ("-" * 32, ""),
    ("Latte", "85.00"), ("Mocha", "95.00"), ("Croissant", "65.00"), ("Cookie", "45.00"),
])
render("c_cafe_2.jpg", [
    ("Croissant", "65.00"), ("Cookie", "45.00"),
    ("Sandwich", "120.00"), ("Tea", "55.00"), ("-" * 32, ""), ("TOTAL", "465.00"),
])

# D / E: small extras (concurrency + kill-worker test)
render("d_pharmacy.jpg", [
    ("SYNTHETIC PHARMACY", ""), ("Date: 2026-09-17", ""), ("-" * 32, ""),
    ("Vitamin C", "100.00"), ("Bandage", "50.00"), ("-" * 32, ""), ("TOTAL", "150.00"),
])
render("e_kiosk.jpg", [
    ("SYNTHETIC KIOSK", ""), ("Date: 2026-09-18", ""), ("-" * 32, ""),
    ("Newspaper", "40.00"), ("Water", "60.00"), ("-" * 32, ""), ("TOTAL", "100.00"),
])

# Corrupt "image" + a non-image, for the FAILED / rejected paths
with open(os.path.join(OUT, "bad.png"), "wb") as fh:
    fh.write(b"this is not really a png")
with open(os.path.join(OUT, "notes.txt"), "w") as fh:
    fh.write("not an image")

print(sorted(os.listdir(OUT)))
