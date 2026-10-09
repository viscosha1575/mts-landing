#!/usr/bin/env python3
"""
Подготовка слоёв из исходников Figma (файл AGJMz0OKAVwgcjI1P4bYWG).

assets-src/v3/raw/*  ->  assets-src/v3/*.png   локации 01–03: слои прежней выгрузки (исходники в финальном
                                               макете те же) и мобильная раскадровка
assets-src/v4/raw/*  ->  assets-src/v4/*.png   финальный макет (секция Desktop, кадры 01–45): облака отдельными
                                               слоями и локации 04–08
assets-src/v5/m_s4_dc.png -> v5/m_s4_lights.png  мобильная раскадровка (секция 25:196, кадры 113–134): свет
                                               дата-центра отдельным слоем; остальные вертикальные исходники
                                               (m_s4_dc, m_s5_office, m_s6_city, m_s7_street, m_s8_apt) идут
                                               как есть — в макете у них нет ни цветокоррекции, ни кропа
Дальше картинки жмёт scripts/build-images.mjs.

Зачем отдельный шаг. MCP отдаёт три вида картинок, и ни один не годится как есть:
  *_raw        — исходник заливки: полный размер и альфа, но без цветокоррекции и кропа из Figma;
  *_graded1024 — заливка с цветокоррекцией и кропом, но ужатая до 1024 px;
  *_export2x   — рендер узла: точный цвет, но альфа залита фоном #faf4f0 и узел обрезан кадром.
Поэтому для вырезок цветокоррекция снимается с пары (исходник → эталон) и переносится на полный
исходник, а непрозрачные фоны берутся рендером.

Геометрия кропов получена регистрацией исходников с эталонами (окно: доля исходника, которую
показывает узел) и записана константами ниже.

assets-src/v6/raw/*  ->  assets-src/v6/*.png   правки октября 2026 (план анимаций): крыша с вырезанным экраном
                                               ноутбука, поле 02 без дерева и машины — они отдельными спрайтами
                                               вместе с кустами (качаются на ветру); офис с вырезанными экранами
                                               идёт как есть (v6/s5_office.png), плита поля — тоже (v6/s2_near.png)

Запуск: python3 scripts/bake-figma.py [v3] [v4] [v5] [v6]   (нужны numpy и Pillow; без аргументов — всё)
"""
import sys
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


# ───────────────────────── финальный макет: assets-src/v4 ─────────────────────────
RAW4 = ROOT / 'assets-src' / 'v4' / 'raw'
OUT4 = ROOT / 'assets-src' / 'v4'


def load4(name, mode='RGBA'):
    return Image.open(RAW4 / name).convert(mode)


def save4(a, name):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(OUT4 / name, optimize=True)
    print(f'  -> v4/{name}  {a.shape[1]}x{a.shape[0]}')


def trim(a, pad=8):
    """Обрезать прозрачные поля спрайта. Возвращает (спрайт, [x0, y0, x1, y1] в долях исходника)."""
    ys, xs = np.where(a[..., 3] > 2 / 255)
    h, w = a.shape[:2]
    x0, x1 = max(0, xs.min() - pad), min(w, xs.max() + 1 + pad)
    y0, y1 = max(0, ys.min() - pad), min(h, ys.max() + 1 + pad)
    return feather(a[y0:y1, x0:x1].copy()), (x0 / w, y0 / h, x1 / w, y1 / h)


def feather(a, share=0.08):
    """Облако, срезанное краем листа или окном узла, в кадре стоит у кромки, и срез не виден. Но облака
    дрейфуют: срез въезжает в кадр ровной вертикалью. Поэтому там, где облако доходит до края спрайта,
    альфа плавно сводится в ноль."""
    h, w = a.shape[:2]
    alpha = a[..., 3]
    def ramp(n, size):
        k = np.clip(np.arange(size, dtype=np.float32) / max(1, n), 0, 1)
        return k * k * (3 - 2 * k)
    nx, ny = max(16, int(w * share)), max(12, int(h * share))
    if alpha[:, 0].max() > 0.02: alpha *= ramp(nx, w)[None, :]
    if alpha[:, -1].max() > 0.02: alpha *= ramp(nx, w)[::-1][None, :]
    if alpha[0].max() > 0.02: alpha *= ramp(ny, h)[:, None]
    if alpha[-1].max() > 0.02: alpha *= ramp(ny, h)[::-1][:, None]
    return a


def rect_of(node, frac):
    """Прямоугольник обрезанного спрайта в кадре: node — (x, y, w, h) картинки в кадре, frac — из trim()."""
    x, y, w, h = node
    return [round(float(v), 2) for v in (x + frac[0] * w, y + frac[1] * h, (frac[2] - frac[0]) * w, (frac[3] - frac[1]) * h)]


def clouds_day():
    """Облака локаций 01 и 02. В макете это слои screen 80% поверх градиента неба — так же они
    смешиваются и в сцене, поэтому здесь только вырезаются спрайты."""
    print('01 облака: три окна одного листа 1672×941 (узлы 2090011676 / 678 / 680)')
    sheet = arr(load4('s1_clouds_raw.png'))
    H, W = sheet.shape[:2]
    # узел в кадре и положение всего листа (1672×941 px макета) относительно узла
    nodes = {
        'a': ((35, 0, 518, 941), (0, 0)),
        'b': ((575, 162, 706, 508), (-562, -259)),
        'c': ((1303, 315, 542, 422), (-1130, -519)),
    }
    for key, (node, off) in nodes.items():
        x0, y0 = -off[0], -off[1]
        crop = sheet[round(y0 * H / 941):round((y0 + node[3]) * H / 941), round(x0 * W / 1672):round((x0 + node[2]) * W / 1672)]
        sprite, frac = trim(crop)
        save4(sprite, f's1_cloud_{key}.png')
        print(f'     rect в кадре 02: {rect_of(node, frac)}')

    print('02 облака: пять узлов группы «облака» (картинка узла растянута на его прямоугольник)')
    nodes = {1: (1139, 444, 344, 141), 2: (1090, -98, 831, 542), 3: (1696, 511, 225, 120), 4: (817, 570, 770, 203), 5: (373, 455, 335, 318)}
    for key, node in nodes.items():
        sprite, frac = trim(arr(load4(f's2_cloud_{key}.png')))
        save4(sprite, f's2_cloud_{key}.png')
        print(f'     rect в кадре 09: {rect_of(node, frac)}')


def rack():
    print('04 стойка у правого края: рендер узла (размыт 6 px), альфа — по левой кромке')
    e = arr(load4('s4_strip_export.png', 'RGB'))
    h, w = e.shape[:2]
    # рендер залит фоном канваса #444 там, где узел прозрачен: слева от кромки стойки (x < 24 px)
    ramp = np.clip((np.arange(w, dtype=np.float32) - 22) / 40, 0, 1)
    alpha = np.broadcast_to((ramp * ramp * (3 - 2 * ramp))[None, :, None], (h, w, 1))
    bg = 68 / 255
    rgb = np.where(alpha > 0.02, (e - bg * (1 - alpha)) / np.maximum(alpha, 0.02), 0)
    save4(np.concatenate([np.clip(rgb, 0, 1), alpha], -1), 's4_rack.png')


def facade():
    print('06 → 07 фасад, который проходит перед камерой: исходник + цветокоррекция')
    raw = load4('s6_facade_raw.png')
    coef = grade_from(raw, load4('s6_facade_graded.png'), (1, 0, 1, 0), 'фасад', box=2)
    a = arr(raw)
    a[..., :3] = apply_color(a[..., :3], coef)
    save4(a, 's6_facade.png')


# Небо локации 07: градиент и свечение солнца. Те же параметры — у слоёв s7-sky и s7-sun в scenes.ts.
SUNSET = [(0.0, (55, 107, 174)), (0.30459, (130, 109, 130)), (0.59872, (193, 121, 111)), (0.85422, (226, 108, 61)), (1.0, (240, 68, 55))]
SUN = dict(cx=438.45, cy=652.0, r=495.0, sigma=237.0, color=(254, 188, 44), opacity=0.51)


def blurred_disc(dist, r, sigma, n=48):
    """Яркость круга радиуса r, размытого по Гауссу (sigma), на расстоянии dist от центра."""
    rho = (np.arange(n) + 0.5) / n * r
    th = (np.arange(n) + 0.5) / n * 2 * np.pi
    d2 = rho[:, None] ** 2 + dist[..., None, None] ** 2 - 2 * rho[:, None] * dist[..., None, None] * np.cos(th)[None, :]
    k = np.exp(-d2 / (2 * sigma * sigma)) * rho[:, None]
    return k.sum((-1, -2)) * (r / n) * (2 * np.pi / n) / (2 * np.pi * sigma * sigma)


def sunset_backdrop(x, y):
    """Цвет неба кадра 41 в точках (x, y) кадра 1920×1080: вертикальный градиент плюс солнце (plus-lighter)."""
    t = np.clip(y / 1080, 0, 1)
    pos = np.array([p for p, _ in SUNSET]); col = np.array([c for _, c in SUNSET], np.float32) / 255
    sky = np.stack([np.interp(t, pos, col[:, i]) for i in range(3)], -1)
    glow = blurred_disc(np.hypot(x - SUN['cx'], y - SUN['cy']), SUN['r'], SUN['sigma'])
    return np.clip(sky + glow[..., None] * SUN['opacity'] * np.array(SUN['color'], np.float32) / 255, 0, 1)


def soft_light(b, s):
    d = np.where(b <= 0.25, ((16 * b - 12) * b + 4) * b, np.sqrt(b))
    return np.where(s <= 0.5, b - (1 - 2 * s) * b * (1 - b), b + (2 * s - 1) * (d - b))


def clouds_sunset():
    """Облака локации 07 лежат в макете в режиме soft-light. В WebGL у слоя нет доступа к тому, что под ним,
    поэтому смешивание запекается: цвет спрайта — soft-light облака с небом на его месте в кадре,
    альфа — альфа облака × непрозрачность узла. Небо под облаком меняется плавно, и при медленном
    дрейфе облака разница незаметна."""
    print('07 облака: семь слоёв группы 2136137202, soft-light запечён по небу кадра 41')
    # ключ: (файл, прямоугольник всей картинки в кадре, видимое окно узла или None, непрозрачность)
    full = lambda node: (node, None)
    nodes = {
        5: ('s7_cloud_5_raw.png', (-284, -178, 1824.0, 1026.5), (-284, 626, 1080, 222.545), 1.0),
        6: ('s7_cloud_6_raw.png', (-188, -130, 1824.0, 1026.5), (552.73, 695.82, 1083.273, 200.727), 1.0),
        8: ('s7_cloud_8_raw.png', (95.97, -144.31, 1824.05, 1026.5), (304.37, 496.09, 1615.636, 237.818), 1.0),
        10: ('s7_cloud_10.png', (-153, 157, 510.545, 298.909), None, 1.0),
        11: ('s7_cloud_11.png', (632.37, 415, 1003.636, 188.727), None, 0.6),
        12: ('s7_cloud_12.png', (251.63, -150.73, 1384.364, 637.091), None, 0.7),
        13: ('s7_cloud_13.png', (-279.63, -178, 576, 480), None, 1.0),
    }
    for key, (name, img, win, opacity) in nodes.items():
        a = arr(load4(name))
        H, W = a.shape[:2]
        if win:  # оставить только окно узла
            x0 = round((win[0] - img[0]) / img[2] * W); x1 = round((win[0] + win[2] - img[0]) / img[2] * W)
            y0 = round((win[1] - img[1]) / img[3] * H); y1 = round((win[1] + win[3] - img[1]) / img[3] * H)
            a = a[max(0, y0):min(H, y1), max(0, x0):min(W, x1)]
            node = win
        else:
            node = img
        sprite, frac = trim(a)
        rect = rect_of(node, frac)
        h, w = sprite.shape[:2]
        gx = rect[0] + (np.arange(w, dtype=np.float32) + 0.5) / w * rect[2]
        gy = rect[1] + (np.arange(h, dtype=np.float32) + 0.5) / h * rect[3]
        # небо меняется плавно — считаем его на редкой сетке
        sx, sy = gx[::8], gy[::8]
        sky = sunset_backdrop(np.broadcast_to(sx[None, :], (len(sy), len(sx))), np.broadcast_to(sy[:, None], (len(sy), len(sx))))
        sky = np.asarray(Image.fromarray((sky * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)).astype(np.float32) / 255
        out = np.concatenate([soft_light(sky, sprite[..., :3]), sprite[..., 3:] * opacity], -1)
        save4(out, f's7_cloud_{key}.png')
        print(f'     rect в кадре 41: {rect}')


def street():
    print('07 дальний план и дом: исходники + цветокоррекция')
    for name, label in (('s7_fg', 'дальний план'), ('s7_house', 'дом')):
        raw = load4(f'{name}_raw.png')
        coef = grade_from(raw, load4(f'{name}_graded.png'), (1, 0, 1, 0), label, box=2)
        a = arr(raw)
        a[..., :3] = apply_color(a[..., :3], coef)
        save4(a, f'{name}.png')


def city():
    print('06 город: рендер узла кадра 36')
    save4(arr(load4('s6_city_export2x.png', 'RGB')), 's6_city.png')


# ───────────────────────── мобильная раскадровка, локации 04–08: assets-src/v5 ─────────────────────────
OUT5 = ROOT / 'assets-src' / 'v5'


def mobile_dc_lights():
    """Свет дата-центра отдельным слоем. В мобильном макете (кадры 116–117) в темноте сначала загораются
    потолочные лампы и блики на полу, и только потом проступает зал; отдельных слоёв света в макете нет —
    там это векторные пятна поверх картинки. Здесь свет вырезан из самой картинки по яркости, с мягким
    ореолом: он ложится точно на свои лампы при любом положении камеры."""
    from PIL import ImageFilter
    src = Image.open(OUT5 / 'm_s4_dc.png').convert('RGB')
    src = src.resize((src.width // 2, src.height // 2), Image.LANCZOS)
    a = arr(src)
    luma = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    core = np.clip((luma - 0.5) / 0.35, 0, 1)
    core = core * core * (3 - 2 * core)
    lit = a * core[..., None]

    def blur(x, r):
        im = Image.fromarray((np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8))
        return arr(im.filter(ImageFilter.GaussianBlur(r)))
    # ореол: размытый свет поверх собственного ядра; цвет ореола — цвет лампы, а не тёмного зала вокруг
    halo_rgb, halo_a = blur(lit, 9) * 1.6, blur(core, 9) * 1.6
    alpha = np.clip(np.maximum(core, halo_a), 0, 1)
    rgb_pm = np.maximum(lit, np.clip(halo_rgb, 0, 1))
    rgb = np.where(alpha[..., None] > 1e-3, rgb_pm / np.maximum(alpha[..., None], 1e-3), 0)
    out = np.concatenate([np.clip(rgb, 0, 1), alpha[..., None]], -1)
    Image.fromarray((out * 255 + 0.5).astype(np.uint8)).save(OUT5 / 'm_s4_lights.png', optimize=True)
    print(f'  -> v5/m_s4_lights.png  {out.shape[1]}x{out.shape[0]}, светится {float((alpha > 0.5).mean()) * 100:.1f}% кадра')


# ───────────────────────── правки октября 2026: assets-src/v6 ─────────────────────────
RAW6 = ROOT / 'assets-src' / 'v6' / 'raw'
OUT6 = ROOT / 'assets-src' / 'v6'


def save6(a, name):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(OUT6 / name, optimize=True)
    print(f'  -> v6/{name}  {a.shape[1]}x{a.shape[0]}')


def roof6():
    """Крыша 01 с вырезанным экраном ноутбука: тот же исходник, цветокоррекция снимается с прежнего рендера."""
    print('01 крыша (экран ноутбука вырезан): исходник + цветокоррекция по рендеру')
    raw = Image.open(RAW6 / 's1_roof_raw.png').convert('RGBA')
    ex = load('s1_roof_export2x.png')
    coef = grade_from(raw, ex, (1, 0, ex.size[1] / 2 / 1080.39, 0), 'крыша')
    a = arr(raw)
    a[..., :3] = apply_color(a[..., :3], coef)
    save6(a, 's1_roof.png')


# Спрайты поля 02. Исходники — листы 4000×2232, вырезанные из одной картинки с плитой поля (v6/s2_near.png).
# Плита стоит в кадре как в макете: узел [0.1, 699.7, 1919.9×686.7], картинка по ширине (cover) — масштаб 0.48.
# Кусты в кадр макета не поставлены (лежат на странице отдельно) — идут по той же сетке, что плита.
# Дерево и машина в макете поставлены своими узлами, чуть крупнее и со сдвигом: у каждого своя сетка.
FIELD_GRID = (0.13, 507.4, 1919.86 / 4000)
TREE_GRID = (38.0, 480.34, 2045.0 / 4000)
VAN_GRID = (-86.6, 486.04, 2021.33 / 4000)
FIELD_SPRITES = [
    # имя, лист, рамка острова в px листа, сетка
    ('s2_tree', 's2_tree.png', (4, 644, 292, 904), TREE_GRID),
    ('s2_van', 's2_bits.png', (2580, 712, 2940, 900), VAN_GRID),
    ('s2_bush_a', 's2_bits.png', (668, 788, 1244, 1192), FIELD_GRID),
    ('s2_bush_b', 's2_bits.png', (1384, 932, 1468, 1004), FIELD_GRID),
    ('s2_bush_c', 's2_bits.png', (2192, 772, 2476, 892), FIELD_GRID),
    ('s2_flowers', 's2_bits.png', (1740, 1000, 2432, 1332), FIELD_GRID),
    ('s2_grass', 's2_bits.png', (940, 1444, 1696, 1892), FIELD_GRID),
]


def field_sprites():
    """Каждый остров — отдельный спрайт с полями: верх спрайта качается на ветру и не должен обрезаться краем."""
    print('02 спрайты поля: дерево, машина, кусты (прямоугольник в кадре — для scenes.ts)')
    for name, sheet, (x0, y0, x1, y1), (gx, gy, k) in FIELD_SPRITES:
        im = Image.open(RAW6 / sheet).convert('RGBA')
        pad_x, pad_top = int((x1 - x0) * 0.14) + 8, int((y1 - y0) * 0.1) + 8
        box = (max(0, x0 - pad_x), max(0, y0 - pad_top), min(im.width, x1 + pad_x), min(im.height, y1 + 6))
        a = arr(im.crop(box))
        # соседние острова, попавшие в поля, убираем: остаётся только свой
        keep = np.zeros(a.shape[:2], bool)
        keep[y0 - box[1]:y1 - box[1] + 6, x0 - box[0]:x1 - box[0]] = True
        a[..., 3] *= keep
        save6(a, f'{name}.png')
        print(f'     [{gx + box[0] * k:.1f}, {gy + box[1] * k:.1f}, {(box[2] - box[0]) * k:.1f}, {(box[3] - box[1]) * k:.1f}]')


def city6():
    """Город 06 с вырезанным небом (узел image 2090008240 кадра 37, 1909×1074, cover): небо и облака в макете
    теперь отдельные слои. Цвет — по рендеру узла, кроп — как у узла: по высоте в размер, по ширине срез 0.8%."""
    print('06 город с прозрачным небом: исходник + цветокоррекция по рендеру')
    raw = Image.open(RAW6 / 's6_city_raw.png').convert('RGBA')
    ex = Image.open(RAW6 / 's6_city_export.png').convert('RGBA')
    wf = (1909 / 1074) / (raw.width / raw.height)
    p = (wf, (1 - wf) / 2, 1, 0)
    coef = grade_from(raw, ex, p, 'город')
    crop = raw.crop((round(p[1] * raw.width), 0, round((p[0] + p[1]) * raw.width), raw.height))
    a = arr(crop)
    a[..., :3] = apply_color(a[..., :3], coef)
    save6(a, 's6_city.png')
    # облака города: три листа 1672×941, в кадре каждый стоит своим прямоугольником (см. scenes.ts)
    for key in 'ab':
        save6(arr(Image.open(RAW6 / f's6_clouds_{key}.png').convert('RGBA')), f's6_clouds_{key}.png')
    # лист «c» в макете показан двумя окнами (левый верх и правая часть) — остальное в кадр не входит
    c = arr(Image.open(RAW6 / 's6_clouds_c.png').convert('RGBA'))
    h, w = c.shape[:2]
    for name, (x0, y0, x1, y1) in (('c1', (0, 0, 0.326, 0.529)), ('c2', (0.641, 0, 1, 0.624))):
        part = c[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)].copy()
        # срез окна проходит по облакам: у срезанных сторон альфа плавно сводится в ноль
        ph, pw = part.shape[:2]
        fx, fy = max(8, pw // 14), max(8, ph // 14)
        ramp_x = np.ones(pw, np.float32); ramp_y = np.ones(ph, np.float32)
        if x0 > 0: ramp_x[:fx] = np.linspace(0, 1, fx)
        if x1 < 1: ramp_x[-fx:] = np.linspace(1, 0, fx)
        ramp_y[-fy:] = np.linspace(1, 0, fy)
        part[..., 3] *= ramp_y[:, None] * ramp_x[None, :]
        save6(part, f's6_clouds_{name}.png')


def clock_plate():
    """Часы на колонке в квартире: кусок картинки [1157, 774, 58×26] (в кадре 45) без нарисованных цифр «20:00».
    Цифры закрашены по столбцам — плавным переходом от строки над ними к строке под ними; ткань колонки ровная,
    шва не видно. Поверх этой подложки оверлей пишет своё время (Experience.astro, .clock)."""
    print('08 часы: подложка без цифр')
    im = Image.open(RAW4 / 's8_apt.png').convert('RGB')
    kx, ky = im.width / 1927, im.height / 1085      # узел картинки в кадре: [-2.6, -2, 1927×1085]
    fx = lambda x: (x + 2.6) * kx
    fy = lambda y: (y + 2) * ky
    box = (round(fx(1157)), round(fy(774)), round(fx(1215)), round(fy(800)))
    a = arr(im.crop(box))
    x0, x1 = round(fx(1160.5)) - box[0], round(fx(1211.5)) - box[0]
    y0, y1 = round(fy(777)) - box[1], round(fy(797.2)) - box[1]
    top, bot = a[y0 - 2:y0].mean(axis=0), a[y1:y1 + 2].mean(axis=0)
    w = np.linspace(0, 1, y1 - y0, dtype=np.float32)[:, None, None]
    a[y0:y1, x0:x1] = (top[None] * (1 - w) + bot[None] * w)[:, x0:x1]
    out = ROOT / 'public' / 'clock-face.png'
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(out, optimize=True)
    print(f'  -> public/clock-face.png  {a.shape[1]}x{a.shape[0]}')


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    OUT4.mkdir(parents=True, exist_ok=True)
    only = sys.argv[1:]  # python3 scripts/bake-figma.py v4 — только слои финального макета
    if not only or 'v3' in only:
        sky_a(); roof(); airship(); sky_b(); far(); lab(); model()
        mobile_sky_b(); mobile_far()
    if not only or 'v4' in only:
        clouds_day(); rack(); city(); facade(); street(); clouds_sunset()
    if not only or 'v5' in only:
        mobile_dc_lights()
    if not only or 'v6' in only:
        roof6(); field_sprites(); city6(); clock_plate()
    print('готово. Без обработки идут: v3/raw/s1_city_raw.png, s2_near_raw.png, мобильные m_s1_*_raw.png, m_s2_near_raw.png, '
          'm_s3_lab_raw.png и v4/raw/s4_dc.png, s4_led.png, s4_logo.png, s5_office.png, s8_apt.png')
