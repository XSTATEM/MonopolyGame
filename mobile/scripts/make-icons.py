"""Генерирует иконки приложения из фирменного знака (стиль-гайд v2/v3):
squircle с мягким градиентом и четыре «столбика» графика в шалфейно-зелёном.

    python3 mobile/scripts/make-icons.py

Пишет PWA-иконки в server/public/ и исходники для @capacitor/assets в mobile/resources/.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "server" / "public"
RES = ROOT / "mobile" / "resources"
SS = 4  # суперсэмплинг для сглаживания

TOP, BOTTOM = (255, 255, 255), (214, 233, 223)   # градиент подложки
BAR = (76, 122, 107)                              # #4C7A6B
BARS = [(0.16, 0.75), (0.28, 1.0), (0.12, 0.6), (0.22, 1.0)]  # (высота/размер знака, непрозрачность) — как .brand-mark
DARK_BG = (20, 15, 11)                            # #140F0B, фон стола
LIGHT_BG = (239, 232, 218)                        # #EFE8DA, фон меню


def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = c
    return img


def squircle_mask(size, radius_frac=0.235):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=round(size * radius_frac), fill=255)
    return m


def draw_bars(canvas, box_size, origin=(0, 0), scale=1.0):
    """Четыре столбика внутри квадрата box_size (пропорции .brand-mark 64px: столбик 7px, зазор 5px)."""
    d = ImageDraw.Draw(canvas, "RGBA")
    unit = box_size / 64 * scale
    bar_w, gap = 7 * unit, 5 * unit
    total_w = 4 * bar_w + 3 * gap
    ox = origin[0] + (box_size - total_w) / 2
    # группа центрируется по вертикали по самому высокому столбику
    max_h = 28 * unit
    base = origin[1] + box_size / 2 + max_h / 2 + 2 * unit
    for i, (h_frac, alpha) in enumerate(BARS):
        h = h_frac * 64 * unit
        x0 = ox + i * (bar_w + gap)
        d.rounded_rectangle([x0, base - h, x0 + bar_w, base], radius=bar_w * 0.57, fill=BAR + (round(255 * alpha),))


def render(size, full_bleed, mark_scale=1.0, bg="light"):
    big = size * SS
    if bg == "light":
        base = gradient(big, TOP, BOTTOM).convert("RGBA")
    elif bg == "dark":
        base = Image.new("RGBA", (big, big), DARK_BG + (255,))
    else:
        base = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_bars(base, big, scale=mark_scale)
    if not full_bleed:
        out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        out.paste(base, (0, 0), squircle_mask(big))
        base = out
    return base.resize((size, size), Image.LANCZOS)


def splash(size, bg):
    img = Image.new("RGBA", (size, size), bg + (255,))
    tile = render(size * 28 // 100, full_bleed=False, mark_scale=0.95)
    img.paste(tile, ((size - tile.width) // 2, (size - tile.height) // 2), tile)
    return img


def main():
    RES.mkdir(parents=True, exist_ok=True)
    render(192, full_bleed=False, mark_scale=0.95).save(PUBLIC / "icon-192.png")
    render(512, full_bleed=False, mark_scale=0.95).save(PUBLIC / "icon-512.png")
    render(512, full_bleed=True, mark_scale=0.75).save(PUBLIC / "icon-maskable-512.png")
    render(180, full_bleed=True, mark_scale=0.95).convert("RGB").save(PUBLIC / "apple-touch-icon.png")
    render(1024, full_bleed=True, mark_scale=0.95).convert("RGB").save(RES / "icon-only.png")
    render(1024, full_bleed=True, mark_scale=0.7, bg="none").save(RES / "icon-foreground.png")
    gradient(1024, TOP, BOTTOM).save(RES / "icon-background.png")
    # Сплэш в цвет первого экрана (главное меню светлое), иначе при запуске видна вспышка.
    splash(2732, LIGHT_BG).convert("RGB").save(RES / "splash.png")
    splash(2732, DARK_BG).convert("RGB").save(RES / "splash-dark.png")
    print("ok")


if __name__ == "__main__":
    main()
