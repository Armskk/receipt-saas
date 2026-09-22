"""Synthetic receipts for manually regression-testing AgentService's
discountTotal handling (Order 120.5). All data is made up."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "fixtures")
os.makedirs(OUT, exist_ok=True)

LATIN = "/System/Library/Fonts/Supplemental/Courier New.ttf"


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


# a: a plain "Discount" line on top of the item prices. Sanity check —
# items sum 500.00, discount 100.00, total 400.00.
render("a_explicit_discount.jpg", [
    ("SYNTHETIC MART", ""), ("Date: 2026-09-20", ""), ("-" * 32, ""),
    ("Rice 5kg", "200.00"), ("Cooking Oil", "150.00"), ("Detergent", "150.00"),
    ("-" * 32, ""),
    ("Subtotal", "500.00"), ("Discount", "-100.00"),
    ("-" * 32, ""),
    ("TOTAL", "400.00"), ("CASH", "400.00"),
])


# b: per-item "was / now" markdown pricing, original price struck through,
# no separate discount line anywhere. This is the case that broke before the
# discountTotal schema/prompt fix in agent.service.ts: Claude correctly used
# the sale prices for items (sum 850.00 = total), but also reported the
# markdown itself as discountTotal (850.00), making
# itemsSum - discountTotal (0.00) disagree with total (850.00). Correct
# behavior: discountTotal null/omitted, since the markdown is already priced
# into the items.
def render_strikethrough(name, items, total_line, font_path=LATIN, size=26, width=640):
    f = font(font_path, size)
    pad, lh = 30, size + 14
    lines_count = 3 + len(items) + 2
    img = Image.new("RGB", (width, pad * 2 + lh * lines_count), "white")
    d = ImageDraw.Draw(img)
    y = pad
    for text in ["SYNTHETIC OUTLET STORE", "Date: 2026-09-20", "-" * 32]:
        d.text((pad, y), text, fill="black", font=f)
        y += lh
    for desc, was, now in items:
        d.text((pad, y), desc, fill="black", font=f)
        was_w = d.textlength(was, font=f)
        now_w = d.textlength(now, font=f)
        was_x = width - pad - now_w - 20 - was_w
        d.text((was_x, y), was, fill="black", font=f)
        d.line([(was_x, y + size / 2), (was_x + was_w, y + size / 2)], fill="black", width=2)
        d.text((width - pad - now_w, y), now, fill="black", font=f)
        y += lh
    d.text((pad, y), "-" * 32, fill="black", font=f)
    y += lh
    left, right = total_line
    d.text((pad, y), left, fill="black", font=f)
    w = d.textlength(right, font=f)
    d.text((width - pad - w, y), right, fill="black", font=f)
    img.save(os.path.join(OUT, name), quality=92)


render_strikethrough("b_markdown_pricing.jpg", [
    ("Jacket", "1200.00", "600.00"),
    ("T-Shirt", "350.00", "175.00"),
    ("Socks", "150.00", "75.00"),
], ("TOTAL", "850.00"))

print(sorted(f for f in os.listdir(OUT) if f.endswith(".jpg")))
