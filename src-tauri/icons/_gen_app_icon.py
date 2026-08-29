"""Generate Chatterino RT app icon (original C-ring + RT)."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 1024
OUT_DIR = Path(__file__).resolve().parent
OUT_PNG = OUT_DIR / "app-icon-1024.png"
OUT_SVG = OUT_DIR / "app-icon.svg"

OUTER_R = 360
INNER_R = 210
GAP_DEG = 48
STEPS = 160
CX = CY = SIZE // 2


def polar(deg: float, r: float) -> tuple[float, float]:
    rad = math.radians(deg)
    return CX + r * math.cos(rad), CY + r * math.sin(rad)


def ring_points() -> list[tuple[float, float]]:
    start = GAP_DEG
    end = 360 - GAP_DEG
    pts: list[tuple[float, float]] = []
    for i in range(STEPS + 1):
        t = i / STEPS
        ang = start + (end - start) * t
        pts.append(polar(ang, OUTER_R))
    for i in range(STEPS + 1):
        t = i / STEPS
        ang = end - (end - start) * t
        pts.append(polar(ang, INNER_R))
    return pts


def path_d(pts: list[tuple[float, float]]) -> str:
    parts: list[str] = []
    for i, (x, y) in enumerate(pts):
        cmd = "M" if i == 0 else "L"
        parts.append(f"{cmd} {x:.2f} {y:.2f}")
    parts.append("Z")
    return " ".join(parts)


def main() -> None:
    pts = ring_points()

    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=220, fill=(20, 24, 32, 255))

    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon(pts, fill=(0, 0, 0, 95))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    # Offset shadow slightly downward
    shifted = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    shifted.alpha_composite(shadow, (0, 10))
    img = Image.alpha_composite(img, shifted)

    light = (168, 228, 255, 255)
    deep = (90, 168, 216, 255)
    grad = Image.new("L", (SIZE, SIZE), 0)
    gd = ImageDraw.Draw(grad)
    for y in range(SIZE):
        gd.line([(0, y), (SIZE, y)], fill=int(255 * (y / (SIZE - 1))))

    c_mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(c_mask).polygon(pts, fill=255)
    blended = Image.composite(
        Image.new("RGBA", (SIZE, SIZE), deep),
        Image.new("RGBA", (SIZE, SIZE), light),
        grad,
    )
    c_colored = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    c_colored.paste(blended, (0, 0), c_mask)
    img = Image.alpha_composite(img, c_colored)
    draw = ImageDraw.Draw(img)

    font = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 290)
    text = "RT"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = CX - tw // 2 - 36
    ty = CY - th // 2 - bbox[1] - 8
    draw.text((tx + 3, ty + 5), text, font=font, fill=(0, 0, 0, 110))
    draw.text((tx, ty), text, font=font, fill=(244, 251, 255, 255))

    img.save(OUT_PNG, "PNG")
    print(f"wrote {OUT_PNG}")

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
  <!-- Chatterino RT app mark: original C-ring + RT. Not stock Chatterino artwork. -->
  <rect width="1024" height="1024" rx="220" fill="#141820"/>
  <defs>
    <linearGradient id="cGrad" x1="512" y1="152" x2="512" y2="872" gradientUnits="userSpaceOnUse">
      <stop stop-color="#A8E4FF"/>
      <stop offset="1" stop-color="#5AA8D8"/>
    </linearGradient>
  </defs>
  <path fill="url(#cGrad)" d="{path_d(pts)}"/>
  <text x="476" y="610" text-anchor="middle" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="290" font-weight="700" letter-spacing="-8" fill="#F4FBFF">RT</text>
</svg>
"""
    OUT_SVG.write_text(svg, encoding="utf-8")
    print(f"wrote {OUT_SVG}")


if __name__ == "__main__":
    main()
