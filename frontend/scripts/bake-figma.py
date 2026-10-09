#!/usr/bin/env python3
"""
Подготовка слоёв локаций 01–03 из исходников Figma (файл AGJMz0OKAVwgcjI1P4bYWG:
десктопные кадры 22–37 и секция Mobile, кадры 01–21).

assets-src/v3/raw/*  ->  assets-src/v3/*.png   (дальше их жмёт scripts/build-images.mjs)

Зачем отдельный шаг. MCP отдаёт три вида картинок, и ни один не годится как есть:
  *_raw        — исходник заливки: полный размер и альфа, но без цветокоррекции и кропа из Figma;
  *_graded1024 — заливка с цветокоррекцией и кропом, но ужатая до 1024 px;
  *_export2x   — рендер узла: точный цвет, но альфа залита фоном #faf4f0 и узел обрезан кадром.
Поэтому для вырезок цветокоррекция снимается с пары (исходник → эталон) и переносится на полный
исходник, а непрозрачные фоны берутся рендером.

Геометрия кропов получена регистрацией исходников с эталонами (окно: доля исходника, которую
показывает узел) и записана константами ниже.

Запуск: python3 scripts/bake-figma.py   (нужны numpy и Pillow)
"""
from pathlib import Path
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'assets-src' / 'v3' / 'raw'
OUT = ROOT / 'assets-src' / 'v3'


def load(name, mode='RGBA'):
    return Image.open(RAW / name).convert(mode)


def arr(im):
    return np.asarray(im).astype(np.float32) / 255


def save(a, name):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(OUT / name, optimize=True)
    print(f'  -> v3/{name}  {a.shape[1]}x{a.shape[0]}')


# ───────────────────────── цветокоррекция ─────────────────────────
def feats(rgb):
    """Кубический полином от RGB: фильтры Figma (экспозиция, контраст, насыщенность, температура) —
    попиксельные функции цвета, такой базис описывает их с ошибкой около 1/255."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    one = np.ones_like(r)
    return np.stack([one, r, g, b, r * r, g * g, b * b, r * g, r * b, g * b,
                     r * r * r, g * g * g, b * b * b, r * r * g, r * r * b, g * g * r, g * g * b, b * b * r, b * b * g, r * g * b], -1)


def fit_color(src, dst, mask, label):
    """src, dst — выровненные RGB одного размера; mask — где оба непрозрачны."""
    X = feats(src[mask].astype(np.float64))
    Y = dst[mask].astype(np.float64)
    coef = np.linalg.lstsq(X, Y, rcond=None)[0]
    before = np.abs(src[mask] - dst[mask]).mean() * 255
    after = np.abs(X @ coef - Y).mean() * 255
    print(f'  цвет {label}: расхождение {before:.2f} -> {after:.2f} (из 255) по {mask.sum()} px')
    return coef.astype(np.float32)


def apply_color(rgb, coef, chunk=512):
    out = np.empty_like(rgb)
    for y in range(0, rgb.shape[0], chunk):
        out[y:y + chunk] = feats(rgb[y:y + chunk]) @ coef
    return np.clip(out, 0, 1)


def window(im, p, size, resample=Image.BICUBIC):
    """Окно исходника raw(a*x+b, c*y+d), x,y ∈ [0,1], приведённое к size."""
    a, b, c, d = p
    W, H = im.size
    return im.transform(size, Image.EXTENT, (b * W, d * H, (a + b) * W, (c + d) * H), resample)


def grade_from(raw, ref, p, label, box=4):
    """Цветокоррекция по паре «окно исходника → эталон». Сравниваем после усреднения box×box,
    чтобы разница в ресемплинге мелких деталей не мешала."""
    w, h = ref.size[0] // box * box, ref.size[1] // box * box
    small = (w // box, h // box)
    r = arr(window(raw, p, (w, h)).resize(small, Image.BOX))
    e = arr(ref.crop((0, 0, w, h)).resize(small, Image.BOX))
    # у части вырезок «непрозрачная» альфа — 252–254, поэтому порог ниже единицы
    mask = (r[..., 3] > 0.97) & (e[..., 3] > 0.97)
    return fit_color(r[..., :3], e[..., :3], mask, label)


# ───────────────────────── геометрия аэростата ─────────────────────────
# В Figma слой аэростата растянут и скошен: rotate(8°) · scaleY(0.99) · skewX(8°).
_c, _s, _t = np.cos(np.radians(8)), np.sin(np.radians(8)), np.tan(np.radians(8))
SHEAR = np.array([[_c, _c * _t - 0.99 * _s], [_s, _s * _t + 0.99 * _c]])


def sheared(rgba, inner_aspect, out_w):
    """Растянуть картинку до inner_aspect, применить SHEAR и вернуть содержимое габаритного бокса."""
    m = SHEAR
    w_in = out_w / (m[0, 0] + abs(m[0, 1]) / inner_aspect)
    h_in = w_in / inner_aspect
    bw = int(round(abs(m[0, 0]) * w_in + abs(m[0, 1]) * h_in))
    bh = int(round(abs(m[1, 0]) * w_in + abs(m[1, 1]) * h_in))
    inv = np.linalg.inv(m)
    sh, sw = rgba.shape[:2]
    kx, ky = sw / w_in, sh / h_in
    # выход (X, Y) -> вход: p = inv · (P − c_out) + c_in, затем в пиксели исходника
    a, b = inv[0, 0] * kx, inv[0, 1] * kx
    d, e = inv[1, 0] * ky, inv[1, 1] * ky
    c0 = (w_in / 2 - inv[0, 0] * bw / 2 - inv[0, 1] * bh / 2) * kx
    f0 = (h_in / 2 - inv[1, 0] * bw / 2 - inv[1, 1] * bh / 2) * ky
    pm = rgba.copy()
    pm[..., :3] *= pm[..., 3:]  # премультиплицируем, иначе по краю тянется цвет из прозрачных пикселей
    chans = [np.asarray(Image.fromarray(pm[..., i], 'F').transform((bw, bh), Image.AFFINE, (a, b, c0, d, e, f0), Image.BICUBIC))
             for i in range(4)]
    out = np.stack(chans, -1)
    alpha = np.clip(out[..., 3:], 0, 1)
    out[..., :3] = np.where(alpha > 1e-4, out[..., :3] / np.maximum(alpha, 1e-4), 0)
    out[..., 3:] = alpha
    return np.clip(out, 0, 1)


# ───────────────────────── слои ─────────────────────────
def sky_a():
    print('01 небо: рендер узла (заливка + градиент hard-light)')
    save(arr(load('s1_sky_export2x.png', 'RGB')), 's1_sky.png')


def roof():
    print('01 крыша со станцией: исходник + цветокоррекция по рендеру')
    raw = load('s1_roof_raw.png')
    ex = load('s1_roof_export2x.png')
    # рендер обрезан низом кадра: узел 1080.39 px высотой, в кадре видно 973.9 px
    coef = grade_from(raw, ex, (1, 0, ex.size[1] / 2 / 1080.39, 0), 'крыша')
    a = arr(raw)
    a[..., :3] = apply_color(a[..., :3], coef)
    save(a, 's1_roof.png')


def airship():
    print('аэростат: окно исходника, цветокоррекция, растяжение и скос')
    raw = load('airship_raw.png')
    ref = load('airship_graded1024.png')
    p = (1.0, 0.0, 0.88848, 0.09556)
    coef = grade_from(raw, ref, p, 'аэростат', box=2)
    W, H = raw.size
    a = arr(raw.crop((0, round(p[3] * H), W, round((p[2] + p[3]) * H))))
    a[..., :3] = apply_color(a[..., :3], coef)
    save(sheared(a, 291.005 / 168.517, 2048), 'airship.png')


def model():
    print('03 модель аэростата на столе: тёплая коррекция, растяжение и скос')
    raw = load('s3_model_raw.png')
    ref = load('s3_model_graded1024.png')
    coef = grade_from(raw, ref, (0.99721, 0.00141, 1, 0), 'модель', box=2)
    a = arr(raw)
    a[..., :3] = apply_color(a[..., :3], coef)
    save(sheared(a, 1103.651 / 696.168, 2048), 's3_model.png')


def sky_b():
    print('02 небо: исходник + цветокоррекция + градиент hard-light по геометрии кадра 28')
    raw = load('s2_sky_raw.png')
    ref = load('s2_sky_graded1024.png')
    coef = grade_from(raw, ref.crop((0, 0, ref.size[0], ref.size[1] - 1)), (1, 0, 1 - 1 / ref.size[1], 0), 'небо 02')
    # небо мягкое: удваиваем размер бикубиком, чтобы при зуме ×4 не было видно пикселей исходника
    big = raw.resize((raw.size[0] * 2, raw.size[1] * 2), Image.BICUBIC)
    cb = apply_color(arr(big)[..., :3], coef)
    Hh, Ww = cb.shape[:2]
    # Узел кадра 28 показывает исходник, сдвинутый вверх на 17.94% высоты; градиент привязан к узлу:
    # linear-gradient(180.69deg, rgba(40,76,118,.82) 0.94%, rgba(255,255,255,.82) 119.07%)
    BW, BH, SHIFT = 1954.41, 1222.43, 0.1794
    ang = np.radians(180.68845)
    dx, dy = np.sin(ang), -np.cos(ang)
    L = abs(BW * np.sin(ang)) + abs(BH * np.cos(ang))
    v = (np.arange(Hh, dtype=np.float32) + 0.5) / Hh
    u = (np.arange(Ww, dtype=np.float32) + 0.5) / Ww
    x = (u[None, :] - 0.5) * BW
    y = (v[:, None] - SHIFT - 0.5) * BH
    t = (x * dx + y * dy) / L + 0.5
    t = np.clip((t - 0.0094247) / (1.1907 - 0.0094247), 0, 1)[..., None]
    cs = (np.array([40, 76, 118], np.float32) / 255) * (1 - t) + 1.0 * t
    hard = np.where(cs <= 0.5, 2 * cb * cs, 1 - 2 * (1 - cb) * (1 - cs))
    save(cb * (1 - 0.82) + hard * 0.82, 's2_sky.png')


def far():
    print('02 дальний план: исходник + цветокоррекция')
    raw = load('s2_far_raw.png')
    ref = load('s2_far_graded1024.png')
    coef = grade_from(raw, ref, (1, 0, 0.52789, 0.47233), 'дальний план')
    a = arr(raw)
    a[..., :3] = apply_color(a[..., :3], coef)
    save(a, 's2_far.png')


def lab():
    print('03 исследовательский центр: рендер узла кадра 37')
    save(arr(load('s3_lab_export2x.png', 'RGB')), 's3_lab.png')


# ───────────────────────── мобильные слои (секция Mobile, кадры 01–21) ─────────────────────────
def mobile_sky_b():
    print('моб. 02 небо: окно исходника (узел показывает его со сдвигом вправо) + цветокоррекция')
    raw = load('m_s2_sky_raw.png', 'RGB')
    ref = load('m_s2_sky_graded.png')
    p = (1.08511, -0.11467, 0.96448, 0.00071)
    # слева у эталона пустая полоса (окно выходит за исходник) — в подгонку цвета она не попадает
    r = arr(window(raw.convert('RGBA'), p, ref.size))
    e = arr(ref)
    mask = (e[..., 3] > 0.995) & (r[..., 3] > 0.995)
    coef = fit_color(r[..., :3], e[..., :3], mask, 'моб. небо 02')
    # за краем исходника тянем крайний столбец, чтобы у кромки экрана не было щели
    W, H = raw.size
    a, b, c, d = p
    xs = np.clip(((np.arange(W) + 0.5) / W * a + b) * W - 0.5, 0, W - 1)
    ys = np.clip(((np.arange(H) + 0.5) / H * c + d) * H - 0.5, 0, H - 1)
    src = arr(raw)
    x0 = np.floor(xs).astype(int); x1 = np.minimum(x0 + 1, W - 1); fx = (xs - x0)[None, :, None]
    y0 = np.floor(ys).astype(int); y1 = np.minimum(y0 + 1, H - 1); fy = (ys - y0)[:, None, None]
    top = src[y0][:, x0] * (1 - fx) + src[y0][:, x1] * fx
    bot = src[y1][:, x0] * (1 - fx) + src[y1][:, x1] * fx
    save(apply_color(top * (1 - fy) + bot * fy, coef), 'm_s2_sky.png')


def mobile_far():
    print('моб. 02 дальний план: исходник + цветокоррекция')
    raw = load('m_s2_far_raw.png')
    coef = grade_from(raw, load('m_s2_far_graded.png'), (1, 0, 1, 0), 'моб. дальний план', box=2)
    a = arr(raw)
    a[..., :3] = apply_color(a[..., :3], coef)
    save(a, 'm_s2_far.png')


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    sky_a(); roof(); airship(); sky_b(); far(); lab(); model()
    mobile_sky_b(); mobile_far()
    print('готово. Без обработки идут: v3/raw/s1_city_raw.png, s2_near_raw.png и мобильные m_s1_*_raw.png, m_s2_near_raw.png, m_s3_lab_raw.png')
