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

                                               исследовательский центр в двух светах и кейс (исходники — файл
                                               дизайнера Lt1mJ8XtEo7gOGrEmmcU5C, секция «исследовательский центр
                                               фон» 559:1145): v6/s3_lab.png, s3_lab_day.png, s3_case.png

assets-src/v7/raw/*  ->  assets-src/v7/*.png   мобильные экраны 01–04 по слоям (кадры «61», «59», «64», «63» дизайнера):
                                               крыша с вырезанным экраном ноутбука, поле без машины и дерева,
                                               центр в солнечном свете; тени, лампы дата-центра и прочие
                                               исходники из v7/raw идут как есть (см. mobile7)
assets-src/v8/raw/* ->  assets-src/v8/*.png   мобильные офис и город по слоям (кадры «65», «68», «66» дизайнера):
                                               офис и город в двух светах, приведённые друг к другу, окна облаков
assets-src/v9/raw/* ->  assets-src/v9/*.png   мобильная улица по слоям (кадр «72» дизайнера): дальний план, дом,
                                               машина, столб перед её полосой, облака (см. mobile9); маски остекления
                                               для бликов на телефоне (mobile_flare_masks)
assets-src/v10/raw/* -> assets-src/v10/*.png  мобильная квартира по слоям (кадр «75» файла заказчика): комната в двух
                                               светах, пылесос с тенью, цветок и пуф на переднем плане (см. mobile10)

Запуск: python3 scripts/bake-figma.py [v3] [v4] [v5] [v6] [v7] [v8] [v9] [v10]   (нужны numpy и Pillow; без аргументов — всё)
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


def trim(a, pad=8, share=0.08):
    """Обрезать прозрачные поля спрайта. Возвращает (спрайт, [x0, y0, x1, y1] в долях исходника)."""
    ys, xs = np.where(a[..., 3] > 2 / 255)
    h, w = a.shape[:2]
    x0, x1 = max(0, xs.min() - pad), min(w, xs.max() + 1 + pad)
    y0, y1 = max(0, ys.min() - pad), min(h, ys.max() + 1 + pad)
    return feather(a[y0:y1, x0:x1].copy(), share), (x0 / w, y0 / h, x1 / w, y1 / h)



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


def dc_lights():
    """Огни стоек дата-центра (узел image 2090011692 кадра 26, [774, 45, 1075×974]) без одного огонька: в слое
    дизайнера он стоит в (1187, 709) — на штанине техника, а не на стойке, и мигал бы на ней вместе с остальными."""
    print('04 огни стоек: без огонька на технике')
    a = arr(load4('s4_led.png'))
    k = a.shape[1] / 1075
    cx, cy = (1186.9 - 774) * k, (709.4 - 45) * k
    yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    d = np.hypot(xx - cx, yy - cy) / k                 # расстояние до огонька в px макета
    a *= np.clip((d - 20) / 8, 0, 1)[..., None]        # ближе 20 px — пусто, к 28 px — как было
    save4(a, 's4_led.png')


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
    """Улица 07: дальний план, дом и машины — из файла дизайнера (Lt1mJ8XtEo7gOGrEmmcU5C), все идут как есть.
    Дальний план — заливка узла image 2090011746 кадра «58» (617:1267), 4000×1697: без нарисованного дыма над
    трубами (дым на сайте живой: scenes.ts, smoke), без ближних машин на дороге (они теперь отдельные спрайты)
    и с исправленной разметкой. Цветокоррекция в неё уже запечена: на месте узла [0, 389, 1920×814] картинка
    без обработки совпадает с рендером кадра. У узла две заливки; вторая — прежняя картинка с машинами,
    в макете её не видно.
    Машины — группы «Машина 1» и «Машина 2» того же кадра, экспорт ×4: картинка машины и размытые тени под ней
    одним спрайтом (тени в макете — чёрные векторы с размытием, обычное наложение).
    Дом — экспорт фрейма 2896×2168 (597:2674), уже с цветокоррекцией. В прежней картинке дома у двух ближних
    фонарей вдоль дорожки были случайно вырезаны прямоугольники — сквозь них просвечивал дальний план;
    в этой версии плафоны на месте."""
    print('07 улица: дальний план, дом и машины — как есть')
    for src, out in (('s7_fg_cars_off_raw.png', 's7_fg.png'), ('s7_house_fixed_raw.png', 's7_house.png'),
                     ('s7_car_1_x4.png', 's7_car_1.png'), ('s7_car_2_x4.png', 's7_car_2.png')):
        save6(arr(Image.open(RAW6 / src).convert('RGBA')), out)


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
    """Город 06 с вырезанным небом в двух светах — секция «Город фоны» файла дизайнера (Lt1mJ8XtEo7gOGrEmmcU5C,
    572:1246): image 2090011776 — ровный свет, image 2090008240 — низкое солнце, длинные тени и блик на окнах дома.
    Оба — рендеры узлов 1920×1079 в 2×, идут как есть: цветокоррекция уже в них, кадрирование то же, что у прежнего
    слоя города (проверено регистрацией: расхождение меньше 1 px макета), между собой совпадают до 0.3 px.
    Небо и облака в макете — отдельные слои."""
    print('06 город с прозрачным небом: ровный свет и солнце')
    for src, name in (('s6_city_shade_raw.png', 's6_city.png'), ('s6_city_sun_raw.png', 's6_city_sun.png')):
        save6(arr(Image.open(RAW6 / src).convert('RGBA')), name)
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


def box_blur(a, r):
    """Среднее по окну (2r+1)² с учётом краёв; три прохода подряд близки к размытию по Гауссу."""
    for axis in (0, 1):
        c = np.cumsum(np.pad(a, [(r + 1, r) if i == axis else (0, 0) for i in range(a.ndim)], mode='edge'), axis=axis, dtype=np.float64)
        n = a.shape[axis]
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        a = ((hi - lo) / (2 * r + 1)).astype(np.float32)
    return a


def lab6():
    """Исследовательский центр в двух светах и кейс отдельным спрайтом.

    Тёплый рендер (закат, тени на стене, экраны мониторов вырезаны, кейса нет) и прежний дневной (рендер кадра 18)
    — одна и та же сцена: статичные предметы совпадают до долей пикселя. Преобразование тёплого в px дневного
    найдено регистрацией по контурам (корреляция по блокам, остаток 0.2 px) и записано константами.

    v6/s3_lab.png     — тёплый как есть; слева и сверху ему не хватает нескольких px до края кадра — дополнен
                        зеркально, чтобы не увеличивать картинку и не сдвигать её относительно ламп и модели.
    v6/s3_lab_day.png — дневной с теми же вырезами экранов и без нарисованного кейса: его место заполнено тёплой
                        картинкой, приведённой к дневному свету (отношение размытых яркостей вокруг).
    v6/s3_case.png    — кейс; он въезжает в кадр справа (scenes.ts).
    """
    print('03 исследовательский центр: тёплый свет, дневной без кейса, кейс')
    warm = Image.open(RAW6 / 's3_lab_warm_raw.png').convert('RGBA')      # 4096×2286
    day = arr(Image.open(OUT / 's3_lab.png').convert('RGB'))             # 3840×2160 — кадр 18 в 2×
    SX, SY, TX, TY = 0.940073, 0.940791, 6.764, 16.758                    # x_day = SX · x_warm + TX
    PAD_L, PAD_T = 8, 18                                                  # px тёплого: до края кадра слева и сверху
    save6(np.pad(arr(warm), ((PAD_T, 0), (PAD_L, 0), (0, 0)), mode='reflect'), 's3_lab.png')

    h, w = day.shape[:2]
    to_day = (1 / SX, 0, -TX / SX, 0, 1 / SY, -TY / SY)
    wd = arr(warm.transform((w, h), Image.AFFINE, to_day, Image.BICUBIC))
    # вырезы: за пределами тёплой картинки (полоски у края) дневная остаётся непрозрачной
    holes = arr(Image.fromarray(255 - np.asarray(warm)[..., 3]).transform((w, h), Image.AFFINE, to_day, Image.BICUBIC))
    out = day.copy()

    def relight(x0, y0, x1, y1, m=380):
        """Прямоугольник дневного рендера заменить тёплой картинкой, приведённой к дневному свету; кромка мягкая."""
        cx0, cy0, cx1, cy1 = max(0, x0 - m), max(0, y0 - m), min(w, x1 + m), min(h, y1 + m)   # с полями: по ним считается свет
        d, t = day[cy0:cy1, cx0:cx1], wd[cy0:cy1, cx0:cx1]
        box = (slice(y0 - cy0, y1 - cy0), slice(x0 - cx0, x1 - cx0))
        ok = np.ones(d.shape[:2], np.float32)
        ok[box] = 0                                                       # сам прямоугольник в расчёте света не участвует
        ok *= (t[..., 3] > 0.99)

        def light(r):
            """Отношение дневного света к тёплому, усреднённое по окрестности, и доля окрестности в деле"""
            num, den, part = d * ok[..., None], t[..., :3] * ok[..., None], ok
            for _ in range(3):
                num, den, part = box_blur(num, r), box_blur(den, r), box_blur(part, r)
            return num / np.maximum(den, 1e-4), part

        # у краёв прямоугольника свет берётся по ближней окрестности, в глубине, куда она не достаёт, — по широкой
        near, part = light(22)
        far, _ = light(120)
        k = np.clip(part * 2.5 - 0.5, 0, 1)[..., None]
        relit = np.clip(t[..., :3] * (near * k + far * (1 - k)), 0, 1)
        mask = np.zeros(d.shape[:2], np.float32)
        mask[box] = 1
        for _ in range(3):
            mask = box_blur(mask, 6)
        out[cy0:cy1, cx0:cx1] = out[cy0:cy1, cx0:cx1] * (1 - mask[..., None]) + relit * mask[..., None]

    relight(3596, 1326, w, 1684)      # кейс с отражением в полу
    relight(3822, 0, w, 1700)         # полоска у правого края рендера: в ней край другого слоя кадра, в тёплой его нет
    save6(np.concatenate([out, 1 - holes[..., None]], -1), 's3_lab_day.png')

    case = Image.open(RAW6 / 's3_case_raw.png').convert('RGBA')
    case.save(OUT6 / 's3_case.png', optimize=True)
    print(f'  -> v6/s3_case.png  {case.width}x{case.height}')
    case_shadow()


def case_shadow():
    """Тени под кейсом — четыре вектора группы 2136137213 (секция «исследовательский центр фон»): чёрные пятна
    с прозрачностью, растущей сверху вниз (0.1 → 1), размытие 2.58 px, непрозрачность 0.69, режим plus-darker.
    Растеризуются в один спрайт; координаты — от угла узла кейса (146.25×195), спрайт занимает в них [0, 140, 190×45]."""
    from PIL import ImageDraw
    K, S = 4, 3                                        # px спрайта на px макета; запас на сглаживание кромки
    box = (0, 140, 190, 45)
    pad = 5.15625                                      # поле под размытие в координатах SVG
    shapes = {
        'a': ([(5.15625, 13.4658), (30.5413, 13.9342), (82.1746, 13.3721), (85.6277, 7.37628), (89.0809, 1.38044), (33.4189, 8.93769), (5.15625, 13.4658)], 13.5938),
        'b': ([(5.15625, 14.2113), (26.1301, 14.9986), (67.7694, 14.8254), (66.5357, 7.83492), (65.3019, 0.844468), (25.102, 9.17318), (5.15625, 14.2113)], 14.5312),
    }
    nodes = [('a', 13.125, 162.2516), ('b', 31.40625, 152.8766), ('a', 100.3125, 165.0), ('b', 118.59375, 155.625)]
    w, h = box[2] * K, box[3] * K
    total = np.zeros((h, w), np.float32)
    ys = (np.arange(h, dtype=np.float32) + 0.5) / K + box[1]          # y строки в координатах узла кейса
    for kind, nx, ny in nodes:
        pts, y_full = shapes[kind]
        poly = []
        for i in (0, 3):                               # две кубические кривые Безье
            p0, p1, p2, p3 = pts[i:i + 4]
            for t in np.linspace(0, 1, 40, endpoint=False):
                q = [(1 - t) ** 3 * p0[j] + 3 * (1 - t) ** 2 * t * p1[j] + 3 * (1 - t) * t * t * p2[j] + t ** 3 * p3[j] for j in (0, 1)]
                poly.append(((q[0] - pad + nx - box[0]) * K * S, (q[1] - pad + ny - box[1]) * K * S))
        mask = Image.new('L', (w * S, h * S), 0)
        ImageDraw.Draw(mask).polygon(poly, fill=255)
        m = arr(mask.resize((w, h), Image.LANCZOS))
        grad = 0.1 + 0.9 * np.clip((ys - ny) / (y_full - pad), 0, 1)   # прозрачность растёт сверху вниз
        m = m * grad[:, None]
        for _ in range(3):
            m = box_blur(m, 10)                        # три прохода ≈ гауссово размытие с σ = 2.58 px макета
        total += m * 0.69
    alpha = np.clip(total, 0, 1)
    out = np.zeros((h, w, 4), np.float32)
    out[..., 3] = alpha
    save6(out, 's3_case_shadow.png')



def bezier_path(segments, n=40):
    """Точки контура из кубических кривых Безье: segments — список четвёрок точек (p0, p1, p2, p3)."""
    pts = []
    for p0, p1, p2, p3 in segments:
        for t in np.linspace(0, 1, n, endpoint=False):
            pts.append(tuple((1 - t) ** 3 * p0[j] + 3 * (1 - t) ** 2 * t * p1[j] + 3 * (1 - t) * t * t * p2[j] + t ** 3 * p3[j] for j in (0, 1)))
    return pts


def van_shadow():
    """Тени под машиной на поле 02 — четыре вектора группы 2136137211 кадра 09 (в файле дизайнера кадр «53»):
    длинная тень под кузовом (Vector 10433, 208.5×11.3 в точке (1234.4, 933): от заднего колеса до вагончика,
    непрозрачность 0.45, размытие 1.5 px) и три пятна под колёсами (18×4, 16×3.75, 18×4; непрозрачность 0.8,
    размытие 2 px). Режим plus-darker. Растеризуются в один спрайт, который занимает [1226, 924, 226×28] кадра
    (VAN_SHADOW в scenes.ts). Раньше длинная тень была эллипсом — её правый конец, под передом машины, терялся."""
    from PIL import ImageDraw
    print('02 тени под машиной: контуры макета')
    K, S = 4, 3                                        # px спрайта на px макета; запас на сглаживание кромки
    box = (1226, 924, 226, 28)
    long = [((58, 10.7688), (46.4, 16.3688), (16.5, 13.1021), (3, 10.7688)),
            ((3, 10.7688), (5.4, 7.16896), (40.6667, 7.26871), (58, 7.76855)),
            ((58, 7.76855), (68, 5.36837), (128.167, 3.76863), (157, 3.26878)),
            ((157, 3.26878), (161, 1.66878), (195, 7.60211), (211.5, 10.7688)),
            ((211.5, 10.7688), (203.9, 17.1688), (106, 13.4354), (58, 10.7688))]
    wheel16 = [((4, 4), (6.83333, 6.83333), (14, 10.8), (20, 4))]
    wheel18 = [((4, 4), (7.1875, 7.01849), (15.25, 11.2444), (22, 4))]
    # контур, угол узла в кадре, поле SVG под размытие, непрозрачность, радиус окна размытия (три прохода)
    shapes = [(long, (1234.4, 933), 3, 0.45, 6), (wheel18, (1277.4, 938), 4, 0.8, 8),
              (wheel16, (1328.4, 931), 4, 0.8, 8), (wheel18, (1367.4, 933), 4, 0.8, 8)]
    w, h = box[2] * K, box[3] * K
    total = np.zeros((h, w), np.float32)
    for segs, (nx, ny), pad, opacity, r in shapes:
        poly = [((x - pad + nx - box[0]) * K * S, (y - pad + ny - box[1]) * K * S) for x, y in bezier_path(segs)]
        mask = Image.new('L', (w * S, h * S), 0)
        ImageDraw.Draw(mask).polygon(poly, fill=255)
        m = arr(mask.resize((w, h), Image.LANCZOS))
        for _ in range(3):
            m = box_blur(m, r)
        total += m * opacity
    out = np.zeros((h, w, 4), np.float32)
    out[..., 3] = np.clip(total, 0, 1)
    save6(out, 's2_van_shadow.png')


def flare_mask():
    """Маска окон трёх высоток первого экрана — для бликов (слои s1-flare-*): свет виден только на остеклении,
    на стены и небо не заходит. Область маски — [560, 650, 380×200] кадра-заголовка (FLARE_MASK_AT в scenes.ts).
    У каждого дома в маске один фасад — тот, что повёрнут к солнцу, и своё правило «окно или стена»:
      центральный — стена светлая и голубоватая (яркость 0.66–0.72, синего больше красного на 0.14–0.17); окна либо
                    темнее (рамы, тёмное стекло), либо нейтрального цвета (светлые стёкла) — окно всё, что не стена;
      левый       — дом в дымке, окна просто темнее стены;
      правый      — кирпичный фасад: простенки рыжие, окна синеватые.
    Мелкие дыры внутри оконных полос закрываются. Крыши, освещённые кромки, соседние фасады, небо и дымка
    за домами в маску не входят."""
    from PIL import ImageFilter
    print('01 маска окон высоток для бликов')
    im = Image.open(RAW / 's1_city_raw.png').convert('RGBA')
    home = (0.07, 338.07, 1919.78, 1096.66)            # узел города в кадре-заголовке
    at = (560, 650, 380, 200)
    k = im.width / home[2]
    box = tuple(round(v) for v in ((at[0] - home[0]) * k, (at[1] - home[1]) * k, (at[0] + at[2] - home[0]) * k, (at[1] + at[3] - home[1]) * k))
    a = arr(im.crop(box))
    rgb, alpha = a[..., :3], a[..., 3]
    lum, blue = rgb.mean(-1), rgb[..., 2] - rgb[..., 0]
    sm = lambda x, lo, hi: (lambda t: t * t * (3 - 2 * t))(np.clip((x - lo) / (hi - lo), 0, 1))
    h, w = lum.shape
    # координаты кадра для каждого пикселя области
    fx = at[0] + (np.arange(w, dtype=np.float32)[None, :] + 0.5) / k
    fy = at[1] + (np.arange(h, dtype=np.float32)[:, None] + 0.5) / k
    span = lambda v, lo, hi: sm(v, lo - 1, lo + 1) * (1 - sm(v, hi - 1, hi + 1))

    def closed(m, size):
        """закрыть светлые стёкла и узкие простенки внутри оконных полос"""
        img = Image.fromarray((np.clip(box_blur(m, 1), 0, 1) * 255).astype(np.uint8))
        return arr(img.filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.MinFilter(size)))

    centre = closed(1 - sm(lum, 0.60, 0.66) * sm(blue, 0.085, 0.125), 9) * span(fx, 714, 757) * (fy > 691)
    left = closed(1 - sm(lum, 0.655, 0.70), 5) * span(fx, 574, 636) * (fy > 738)
    right = closed(sm(blue, 0.02, 0.07), 5) * span(fx, 853, 884) * (fy > 751)
    mask = np.maximum(np.maximum(centre, left), right) * (box_blur(alpha, 2) > 0.985)
    mask = box_blur(mask, 1)
    save6(np.repeat(mask[..., None], 3, -1), 's1_flare_mask.png')


def apartment6():
    """Квартира 08 по слоям (кадр «55» файла дизайнера, 587:1426): комната без дивана и цветка, диван, цветок.
    Все три — экспорты узлов из Figma, идут как есть; у экспорта узел обрезан кадром, поэтому комната и диван —
    ровно кадр 1920×1080 в 2×, а цветок — свой узел [597, 298, 293×401] в 4×.

    Диван — экспорт группы целиком, вместе с тенями: мягкая тень на стене и на полу слева, полоска тени под
    сиденьем и два пятнышка под ножками. В макете у теней режим color burn, а заливка чёрная: чёрный в color burn
    даёт чёрный при любом фоне, то есть тень просто затемняет то, что под ней, пропорционально своей плотности —
    ровно так ложится полупрозрачный чёрный в обычном режиме. Поэтому тени запечены в альфу спрайта дивана.
    Справа диван обрезан маской дизайнера — там, где его перекрывает стол.
    Спрайт дивана обрезан по содержимому: [380, 520, 830×560] кадра (см. APT_SOFA в scenes.ts).

    На колонке в новой комнате нет нарисованных цифр — подложка под часы больше не нужна, время пишет оверлей
    (Experience.astro, .clock)."""
    print('08 квартира по слоям: комната, диван с тенями, цветок')
    save6(arr(Image.open(RAW6 / 's8_room_raw.png').convert('RGBA')), 's8_apt.png')
    sofa = arr(Image.open(RAW6 / 's8_sofa_raw.png').convert('RGBA'))
    box = (760, 1040, 2420, 2160)                      # px экспорта 2×
    ys, xs = np.nonzero(sofa[..., 3] > 0)
    assert xs.min() >= box[0] + 8 and xs.max() <= box[2] - 8 and ys.min() >= box[1] + 8, 'диван с тенями вышел за окно спрайта'
    save6(sofa[box[1]:box[3], box[0]:box[2]], 's8_sofa.png')
    save6(arr(Image.open(RAW6 / 's8_plant_raw.png').convert('RGBA')), 's8_plant.png')


# ───────────────────────── мобильные экраны 1–4 по слоям: assets-src/v7 ─────────────────────────
# Кадры «61», «59», «64», «63» файла дизайнера (Lt1mJ8XtEo7gOGrEmmcU5C, страница «Разработка»), 2026-10-14.
# Исходники — картинки из SVG-экспорта кадров: в SVG Figma кладёт заливку целиком (узел не обрезан кадром) и уже
# с цветокоррекцией, а кадрирование — матрицей паттерна; из неё и взяты окна ниже. Векторные слои (тени, лампы)
# растеризованы из того же SVG в Chrome — режим наложения у них снят, его делает сцена.
RAW7 = ROOT / 'assets-src' / 'v7' / 'raw'
OUT7 = ROOT / 'assets-src' / 'v7'


def save7(a, name):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(OUT7 / name, optimize=True)
    print(f'  -> v7/{name}  {a.shape[1]}x{a.shape[0]}')


def mobile7():
    """Мобильные локации 01–03 и дата-центр по слоям.

    v7/m_s1_roof.png  — крыша 01 из двух узлов «первый план»: верх (мачта) — прежний исходник 1024×1536, низ — новый
                        2048×3072 с вырезанным экраном ноутбука. Обе картинки стоят в одном прямоугольнике
                        [-25, 136, 426×639] кадра; верхний узел показывает строки до y 479 кадра, нижний — от 475.2,
                        и в полоске, где они перекрываются, сверху нижний.
    v7/m_s2_near.png  — плита поля 02 без машины и дерева; узел показывает только низ картинки (с y 470.1 кадра) —
                        выше она всё равно прозрачная, обрезана по нему.
    v7/m_s2_tree.png  — дерево: окно листа дерева [0, 562, 311×311], с полями под качание на ветру.
    v7/m_s3_lab_light.png — центр 03 в солнечном свете (картинка под кадром «64»), приведённая к сетке основной:
                        x = 0.81565·x′ + 7.62, y = 0.81595·y′ − 0.51 (регистрация по контурам, остаток меньше 1 px).
                        Там, куда она не достаёт (полоски у краёв), прозрачна — под ней та же сцена.
    """
    print('мобильные 01–04 по слоям (кадры 61, 59, 64, 63 дизайнера)')
    OUT7.mkdir(parents=True, exist_ok=True)
    top = Image.open(RAW / 'm_s1_roof_raw.png').convert('RGBA').resize((2048, 3072), Image.LANCZOS)
    low = arr(Image.open(RAW7 / 'm_s1_roof_2x_raw.png').convert('RGBA'))
    t = arr(top)
    cut_top, cut_low = 1937, 1919                      # строки 2048×3072: конец верхнего узла и начало нижнего
    t[cut_top:] = 0
    low[:cut_low] = 0
    # нижний поверх верхнего (альфа не премультиплицирована)
    la, ta = low[..., 3:4], t[..., 3:4]
    out_a = la + ta * (1 - la)
    rgb = (low[..., :3] * la + t[..., :3] * ta * (1 - la)) / np.maximum(out_a, 1e-6)
    save7(np.concatenate([rgb, out_a], -1), 'm_s1_roof.png')

    near = Image.open(RAW7 / 'm_s2_near_raw.png').convert('RGBA')
    save7(arr(near.crop((0, 2302, near.width, near.height))), 'm_s2_near.png')

    tree = arr(Image.open(RAW7 / 'm_s2_tree_raw.png').convert('RGBA').crop((0, 562, 311, 873)))
    save7(np.pad(tree, ((0, 0), (40, 29), (0, 0))), 'm_s2_tree.png')

    lab = Image.open(RAW7 / 'm_s3_lab_raw.png').convert('RGBA')
    light = Image.open(RAW7 / 'm_s3_lab_light_raw.png').convert('RGBA')
    KX, TX, KY, TY = 0.81565, 7.62, 0.81595, -0.51
    inv = (1 / KX, 0, -TX / KX, 0, 1 / KY, -TY / KY)
    warped = arr(light.transform(lab.size, Image.AFFINE, inv, Image.BICUBIC))
    cover = arr(Image.new('L', light.size, 255).transform(lab.size, Image.AFFINE, inv, Image.BILINEAR))
    for _ in range(3):
        cover = box_blur(cover, 2)
    cover = np.clip((cover - 0.5) * 2, 0, 1)
    warped[..., 3] *= cover
    save7(warped, 'm_s3_lab_light.png')


# ───────────────────────── мобильные экраны 5–6 по слоям: assets-src/v8 ─────────────────────────
# Кадры «65» (офис) и «68», «66» (город) файла дизайнера, 2026-10-15. Исходники — картинки из SVG-экспорта кадров,
# как в v7. Офис: верхняя картинка кадра — мягкий свет (она и видна), нижняя — солнце. Город: «68» — ровный свет,
# «66» — тот же вид в низком солнце; небо, солнце и облака в обоих кадрах одинаковые и идут отдельными слоями.
RAW8 = ROOT / 'assets-src' / 'v8' / 'raw'
OUT8 = ROOT / 'assets-src' / 'v8'


def save8(a, name):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(OUT8 / name, optimize=True)
    print(f'  -> v8/{name}  {a.shape[1]}x{a.shape[0]}')


def onto(src, size, k):
    """Картинку src (RGBA) — в сетку другой картинки размера size: x_src = kx·x + tx, y_src = ky·y + ty"""
    kx, tx, ky, ty = k
    return arr(src.transform(size, Image.AFFINE, (kx, 0, tx, 0, ky, ty), Image.BICUBIC))


def mobile8():
    """Мобильные офис и город по слоям.

    v8/raw/m_s5_office_raw.png — офис в мягком свете (4072×2762) идёт как есть. Это прежний исходник 4096×2803
                        (v5/m_s5_office.png), обрезанный на 24.1 px слева и 19.9 сверху, но с вырезанными экранами
                        мониторов и ноутбуков: под ними ролики (scenes.ts).
    v8/m_s5_office_sun.png — офис в солнце (нижняя картинка кадра «65»), приведённый к сетке мягкого:
                        x′ = 0.992875·x + 23.738, y′ = 0.993911·y + 9.966 (регистрация по контурам, остаток 0.5 px).
                        В кадре дизайнера обе стоят в одном прямоугольнике и к краям расходятся на 6 px макета —
                        при смене света двоилось бы.
    v8/m_s6_city.png  — город ровного света (кадр «68»); у него альфа домов 254 — доведена до 255, иначе сквозь
                        дома проступало бы небо.
    v8/m_s6_city_sun.png — город в низком солнце (кадр «66»), приведённый к сетке ровного:
                        x′ = 0.975814·x − 0.161, y′ = 0.976062·y + 95.091 (остаток 0.3 px). Дизайнер поставил их
                        в кадры по-разному, на месте они расходились бы на 1%.
    v8/m_s6_clouds_a.png, m_s6_clouds_b.png — окна листов облаков a и b, которые показывают узлы кадра «68»
                        (листы те же, что у десктопного города, v6/raw). Два других узла — окна листа c, ровно те же,
                        что у десктопных спрайтов s6-clouds-c1 и c2: спрайты общие.
    """
    print('мобильные 05–06 по слоям (кадры 65, 68, 66 дизайнера)')
    OUT8.mkdir(parents=True, exist_ok=True)
    office = Image.open(RAW8 / 'm_s5_office_raw.png')
    sun = Image.open(RAW8 / 'm_s5_office_sun_raw.png').convert('RGBA')
    save8(onto(sun, office.size, (0.992875, 23.738, 0.993911, 9.966)), 'm_s5_office_sun.png')

    city = arr(Image.open(RAW8 / 'm_s6_city_raw.png').convert('RGBA'))
    city[..., 3] = np.where(city[..., 3] > 0.98, 1, city[..., 3])
    save8(city, 'm_s6_city.png')
    sun = Image.open(RAW8 / 'm_s6_city_sun_raw.png').convert('RGBA')
    save8(onto(sun, (city.shape[1], city.shape[0]), (0.975814, -0.161, 0.976062, 95.091)), 'm_s6_city_sun.png')

    # окна листов 1672×941 в px (x0, y0, x1, y1) — из матриц паттернов SVG; по срезанным сторонам альфа сводится в ноль
    for key, (x0, y0, x1, y1) in (('a', (0, 602, 1672, 941)), ('b', (561, 565, 1672, 834))):
        sheet = arr(Image.open(RAW6 / f's6_clouds_{key}.png').convert('RGBA'))
        h, w = sheet.shape[:2]
        part = sheet[y0:y1, x0:x1].copy()
        ph, pw = part.shape[:2]
        fx, fy = max(8, pw // 14), max(8, ph // 14)
        ramp_x = np.ones(pw, np.float32); ramp_y = np.ones(ph, np.float32)
        if x0 > 0: ramp_x[:fx] = np.linspace(0, 1, fx)
        if x1 < w: ramp_x[-fx:] = np.linspace(1, 0, fx)
        if y0 > 0: ramp_y[:fy] = np.linspace(0, 1, fy)
        if y1 < h: ramp_y[-fy:] = np.linspace(1, 0, fy)
        part[..., 3] *= ramp_y[:, None] * ramp_x[None, :]
        save8(part, f'm_s6_clouds_{key}.png')


# ───────────────────────── мобильная улица по слоям: assets-src/v9 ─────────────────────────
# Кадр «72» файла дизайнера (узел 670:1568), 2026-10-15: небо-градиент, «светило», семь облаков, дальний план, машина,
# дом и фонарики. Исходники — картинки из SVG-экспорта кадра. Координаты ниже — px макета 393×852.
RAW9 = ROOT / 'assets-src' / 'v9' / 'raw'
OUT9 = ROOT / 'assets-src' / 'v9'
# небо кадра «72»: те же стопы, что у десктопного (SUNSET), но на высоту 712; солнце — размытый круг в plus-lighter
M_DUSK_H = 712.0
M_DUSK_SUN = dict(cx=22.4044, cy=388.285, r=190.596, sigma=82.0, color=(254, 188, 44), opacity=0.51)


def save9(a, name):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(OUT9 / name, optimize=True)
    print(f'  -> v9/{name}  {a.shape[1]}x{a.shape[0]}')


def mobile_dusk_backdrop(x, y):
    """Цвет неба кадра «72» в точках (x, y) макета: градиент плюс солнце"""
    t = np.clip(y / M_DUSK_H, 0, 1)
    pos = np.array([p for p, _ in SUNSET]); col = np.array([c for _, c in SUNSET], np.float32) / 255
    sky = np.stack([np.interp(t, pos, col[:, i]) for i in range(3)], -1)
    s = M_DUSK_SUN
    glow = blurred_disc(np.hypot(x - s['cx'], y - s['cy']), s['r'], s['sigma'])
    return np.clip(sky + glow[..., None] * s['opacity'] * np.array(s['color'], np.float32) / 255, 0, 1)


def gauss(a, sigma):
    """Размытие по Гауссу (premultiplied RGBA), по осям"""
    n = int(sigma * 3) + 1
    k = np.exp(-np.arange(-n, n + 1) ** 2 / (2 * sigma * sigma)); k /= k.sum()
    pm = np.concatenate([a[..., :3] * a[..., 3:], a[..., 3:]], -1)
    pm = np.pad(pm, ((n, n), (n, n), (0, 0)))
    pm = np.apply_along_axis(lambda v: np.convolve(v, k, 'valid'), 0, pm)
    pm = np.apply_along_axis(lambda v: np.convolve(v, k, 'valid'), 1, pm)
    al = pm[..., 3:]
    return np.concatenate([np.where(al > 1e-4, pm[..., :3] / np.maximum(al, 1e-4), 0), al], -1)


def bbox(a):
    """Непрозрачная часть картинки без растушёвки краёв (для планов): (картинка, [x0, y0, x1, y1] в px)"""
    ys, xs = np.where(a[..., 3] > 2 / 255)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    return a[y0:y1, x0:x1], (x0, y0, x1, y1)


def mobile9():
    """Мобильная улица по слоям (кадр «72» дизайнера).

    v9/m_s7_far.png   — дальний план (2251×4000 в узле [-0.127, 60.398, 365.568×649.617]) без прозрачного неба.
                        Дыма над трубами в нём нет — он живой, как на десктопе. Машин на дорогах тоже нет, кроме одной
                        (отдельный спрайт).
    v9/m_s7_pole.png  — фонарный столб у обочины из того же плана, только на высоте полосы машины: машина подъезжает
                        из-за деревьев дома и проходит за ним. Пиксели — те же, что в плане, альфа — насколько пиксель
                        темнее дороги вокруг: поверх плана слой невидим, поверх машины закрывает её столбом.
    v9/m_s7_house.png — дом (1536×2752 в узле [-0.054, 10.056, 392.554×703.327]) без прозрачных полей.
    v9/m_s7_house_sun.png — «маска»: тот же дом в закатном свете, приведённый к сетке дома, та же обрезка.
    v9/m_s7_car.png   — группа «Машина 1»: картинка машины и размытые чёрные тени под ней; рендер группы ×20
                        (raw/m_s7_car_x20.png, окно макета x 126…151, y 526…547), здесь — ×8.
    v9/m_s7_cloud_N.png — семь облаков: окна листов 1672×941 по матрицам паттернов SVG. Листы 1, 3 и 4 — те же файлы,
                        что у десктопных облаков 8, 5 и 6 (v4/raw); 2, 5, 6, 7 — новые. Облака 5 и 6 лежат в режиме
                        soft-light (60% и 70%, у пятого ещё размытие 1 px) — смешивание запекается по небу кадра,
                        как у десктопных (clouds_sunset). Остальные — в обычном режиме, как есть.
    Шум в 15% soft-light поверх неба (тайл 1600×1080) не переносится: это зерно в ±2–3 уровня яркости.
    """
    print('мобильная улица по слоям (кадр 72 дизайнера)')
    OUT9.mkdir(parents=True, exist_ok=True)
    rects = {}

    def plane(src, node, name):
        a = arr(Image.open(RAW9 / src).convert('RGBA'))
        H, W = a.shape[:2]
        part, (x0, y0, x1, y1) = bbox(a)
        save9(part, name)
        sx, sy = node[2] / W, node[3] / H
        rects[name] = (node[0] + x0 * sx, node[1] + y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy)
        return a

    FAR = (-0.126953, 60.3975, 365.568, 649.617)
    far = plane('m_s7_far_raw.png', FAR, 'm_s7_far.png')
    house = plane('m_s7_house_raw.png', (-0.0544434, 10.0557, 392.554, 703.327), 'm_s7_house.png')
    # Маска — тот же дом в закатном свете (узел «первый план» под кадром «72» в файле заказчика, 41:16975; видимая
    # заливка — вторая). Сдвинута относительно дома на 1–4 px: приведена к его сетке, x′ = 1.002706·x − 1.144,
    # y′ = 1.001237·y − 3.541 (регистрация по контурам, остаток 0.3 px); альфа — от дома, обрезка — та же.
    sun = onto(Image.open(RAW9 / 'm_s7_house_sun_raw.png').convert('RGBA'), (house.shape[1], house.shape[0]), (1.002706, -1.144, 1.001237, -3.541))
    sun[..., 3] = house[..., 3]
    _, (x0, y0, x1, y1) = bbox(house)
    save9(sun[y0:y1, x0:x1], 'm_s7_house_sun.png')

    # столб: колонки 933…944 листа плана (сам столб — 935…942), строки — полоса машины (y макета 516…554)
    H, W = far.shape[:2]
    sx, sy = FAR[2] / W, FAR[3] / H
    x0, x1 = 933, 945
    y0, y1 = round((516 - FAR[1]) / sy), round((554 - FAR[1]) / sy)
    band = far[y0:y1, 920:956]
    lum = band[..., 0] * 0.3 + band[..., 1] * 0.59 + band[..., 2] * 0.11
    road = np.median(np.concatenate([lum[:, :7], lum[:, 29:]], 1), 1)[:, None]
    pole = far[y0:y1, x0:x1].copy()
    pole[..., 3] = np.clip((road - lum[:, x0 - 920:x1 - 920]) / np.maximum(road - 0.02, 0.05), 0, 1) ** 0.8
    save9(pole, 'm_s7_pole.png')
    rects['m_s7_pole.png'] = (FAR[0] + x0 * sx, FAR[1] + y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy)

    car = arr(Image.open(RAW9 / 'm_s7_car_x20.png').convert('RGBA'))
    part, (cx0, cy0, cx1, cy1) = bbox(car)
    part = car[max(0, cy0 - 4):cy1 + 4, max(0, cx0 - 4):cx1 + 4]
    h, w = part.shape[:2]
    small = Image.fromarray((part * 255 + 0.5).astype(np.uint8)).resize((round(w * 0.4), round(h * 0.4)), Image.LANCZOS)
    save9(arr(small), 'm_s7_car.png')
    rects['m_s7_car.png'] = (126 + max(0, cx0 - 4) / 20, 526 + max(0, cy0 - 4) / 20, w / 20, h / 20)

    clouds = {
        1: (RAW4 / 's7_cloud_8_raw.png', (3.9126, 361.719, 610.502, 89.8645), (0.00067522, 0.00458716, -0.128967, -2.69266), 1.0, False, 0),
        2: (RAW9 / 'm_s7_clouds_2_raw.png', (-168.913, 233.587, 192.92, 112.949), (0.00213675, 0.00364964, 0, -1.39781), 1.0, False, 0),
        3: (RAW4 / 's7_cloud_5_raw.png', (-218.414, 410.808, 408.1, 84.0934), (0.0010101, 0.00490196, 0, -3.61274), 1.0, False, 0),
        4: (RAW4 / 's7_cloud_6_raw.png', (97.7603, 437.19, 409.337, 75.8489), (0.00100705, 0.00543478, -0.683786, -4.11413), 1.0, False, 0),
        5: (RAW9 / 'm_s7_clouds_5_raw.png', (127.854, 331.077, 379.245, 71.3145), (0.00108696, 0.00578035, -0.817391, -2.98266), 0.6, True, 1.0),
        6: (RAW9 / 'm_s7_clouds_6_raw.png', (-16.0142, 117.306, 523.11, 240.738), (0.000788022, 0.00171233, -0.317573, 0), 0.7, True, 0),
        7: (RAW9 / 'm_s7_clouds_7_raw.png', (-216.764, 107, 217.653, 181.378), (0.00189394, 0.00227273, 0, 0), 1.0, False, 0),
    }
    for key, (path, (rx, ry, rw, rh), (ka, kd, ke, kf), opacity, soft, blur) in clouds.items():
        sheet = arr(Image.open(path).convert('RGBA'))
        H, W = sheet.shape[:2]
        # узел показывает окно листа: u = a·x + e, v = d·y + f в долях прямоугольника узла
        wx0, wx1 = max(0, int(np.floor(-ke / ka))), min(W, int(np.ceil((1 - ke) / ka)))
        wy0, wy1 = max(0, int(np.floor(-kf / kd))), min(H, int(np.ceil((1 - kf) / kd)))
        a = sheet[wy0:wy1, wx0:wx1].copy()
        node = (rx + (ka * wx0 + ke) * rw, ry + (kd * wy0 + kf) * rh, ka * (wx1 - wx0) * rw, kd * (wy1 - wy0) * rh)
        if blur:
            a = gauss(a, blur / (ka * rw))
        sprite, frac = trim(a)
        rect = rect_of(node, frac)
        if soft:
            h, w = sprite.shape[:2]
            gx = rect[0] + (np.arange(w, dtype=np.float32) + 0.5) / w * rect[2]
            gy = rect[1] + (np.arange(h, dtype=np.float32) + 0.5) / h * rect[3]
            sxs, sys_ = gx[::8], gy[::8]
            sky = mobile_dusk_backdrop(np.broadcast_to(sxs[None, :], (len(sys_), len(sxs))), np.broadcast_to(sys_[:, None], (len(sys_), len(sxs))))
            sky = np.asarray(Image.fromarray((sky * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)).astype(np.float32) / 255
            sprite = np.concatenate([soft_light(sky, sprite[..., :3]), sprite[..., 3:]], -1)
        sprite[..., 3] *= opacity
        save9(sprite, f'm_s7_cloud_{key}.png')
        rects[f'm_s7_cloud_{key}.png'] = tuple(rect)
    for name, r in rects.items():
        print(f'     {name}: [{", ".join(f"{v:.3f}" for v in r)}] (y макета; в сцене — минус 60)')


def mobile_flare_masks():
    """Маски остекления для бликов на телефоне (правки дизайнера 2026-10-15) — как flare_mask у десктопа: ролик блика
    кладётся светом поверх картинки и виден только на стёклах. Область каждой маски — прямоугольник кадра (px макета,
    без статус-бара), он же в scenes.ts.
      v9/m_s1_flare_mask.png — высотки за станцией (m-s1-city, 1024×1536 в [0, 76, 430×646]), область [15, 445, 145×100].
          Картинка мелкая, окна в ней по 2–3 px, поэтому маска попиксельная, без закрытия дыр. У каждого дома, как
          на десктопе, один фасад — повёрнутый к солнцу: у центральной высотки и левой — светлые стены, окна темнее;
          у кирпичной — простенки рыжие, окна синеватые.
      v9/m_s6_flare_mask.png — большой дом справа в городе (m-s6-city, 2286×4000 в [−2.495, −53.149, 404.464×713.228]),
          область — окно картинки x 1700…2286, y 480…2620. Стёкла здесь то голубые (в них небо), то тёмные, поэтому
          маска — всё, кроме стен (светлые и тёплые) и зелени на балконах; тёмный цоколь — вне маски.
      v9/m_s7_flare_mask.png — стёкла дома на улице (m-s7-house, 1536×2752 в [−0.054, −49.944, 392.554×703.327]),
          окно картинки x 720…1536, y 820…1790: перила крыши и стеклянные ограждения балконов, размеченные
          четырёхугольниками по картинке; тёмные рамы внутри них — вне маски."""
    from PIL import ImageDraw
    print('мобильные маски остекления для бликов')
    sm = lambda x, lo, hi: (lambda t: t * t * (3 - 2 * t))(np.clip((x - lo) / (hi - lo), 0, 1))
    span = lambda v, lo, hi: sm(v, lo - 0.5, lo + 0.5) * (1 - sm(v, hi - 0.5, hi + 0.5))

    im = Image.open(ROOT / 'assets-src' / 'v3' / 'raw' / 'm_s1_city_raw.png').convert('RGBA')
    home, at = (0, 76, 430, 646), (15, 445, 145, 100)
    k = im.width / home[2]
    box = tuple(round(v) for v in ((at[0] - home[0]) * k, (at[1] - home[1]) * k, (at[0] + at[2] - home[0]) * k, (at[1] + at[3] - home[1]) * k))
    a = arr(im.crop(box))
    rgb, alpha = a[..., :3], a[..., 3]
    lum, blue = rgb.mean(-1), rgb[..., 2] - rgb[..., 0]
    h, w = lum.shape
    fx = at[0] + (np.arange(w, dtype=np.float32)[None, :] + 0.5) / k
    fy = at[1] + (np.arange(h, dtype=np.float32)[:, None] + 0.5) / k
    centre = (1 - sm(lum, 0.5, 0.66)) * span(fx, 80.5, 99.3) * span(fy, 452, 519)
    left = (1 - sm(lum, 0.6, 0.72)) * span(fx, 33.6, 46) * span(fy, 466, 514)
    right = sm(blue, 0.03, 0.08) * span(fx, 129.2, 145.7) * span(fy, 470, 531)
    mask = np.maximum(np.maximum(centre, left), right) * (box_blur(alpha, 1) > 0.985)
    save9(np.repeat(mask[..., None], 3, -1), 'm_s1_flare_mask.png')

    im = Image.open(OUT8 / 'm_s6_city.png').convert('RGBA')
    box = (1700, 480, 2286, 2620)
    a = arr(im.crop(box))
    rgb, alpha = a[..., :3], a[..., 3]
    lum = rgb.mean(-1)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    wall = sm(lum, 0.42, 0.55) * sm(r - b, 0.02, 0.07)
    plant = sm(g - np.maximum(r, b), 0.0, 0.05)
    X = np.arange(a.shape[1])[None, :] + box[0]
    Y = np.arange(a.shape[0])[:, None] + box[1]
    face = ((X > 1725) & (X < 2014) & (Y > 1010) & (Y < 2340)) | ((X > 2016) & (Y > 530) & (Y < 2480))
    mask = (1 - wall) * (1 - plant) * (alpha > 0.98) * face
    save9(np.repeat(box_blur(mask, 1)[..., None], 3, -1), 'm_s6_flare_mask.png')

    im = Image.open(RAW9 / 'm_s7_house_raw.png').convert('RGBA')
    box = (720, 820, 1536, 1790)
    a = arr(im.crop(box))
    quads = [  # px картинки дома: левый верх, правый верх, правый низ, левый низ
        [(860, 975), (1040, 835), (1040, 920), (860, 1050)],      # перила крыши слева
        [(1040, 832), (1250, 842), (1250, 935), (1040, 920)],     # перила крыши спереди
        [(1250, 1005), (1536, 815), (1536, 965), (1255, 1145)],   # ограждение верхнего балкона справа
        [(1010, 1175), (1165, 1080), (1165, 1215), (1010, 1290)], # балкон посередине, верхний
        [(730, 1295), (860, 1220), (860, 1280), (730, 1302)],     # перила низкого крыла слева
        [(1245, 1520), (1510, 1460), (1510, 1650), (1245, 1670)], # большой балкон справа
        [(1010, 1570), (1165, 1540), (1165, 1690), (1010, 1705)], # балкон посередине, нижний
        [(825, 1660), (945, 1625), (945, 1750), (825, 1780)],     # балкон слева внизу
    ]
    ss = 4  # многоугольники рисуются вчетверо крупнее и ужимаются — края мягкие
    poly = Image.new('L', ((box[2] - box[0]) * ss, (box[3] - box[1]) * ss), 0)
    d = ImageDraw.Draw(poly)
    for q in quads:
        d.polygon([((x - box[0]) * ss, (y - box[1]) * ss) for x, y in q], fill=255)
    poly = arr(poly.resize((box[2] - box[0], box[3] - box[1]), Image.BOX))
    lum = a[..., :3].mean(-1)
    mask = poly * sm(lum, 0.06, 0.14) * (a[..., 3] > 0.98)
    save9(np.repeat(mask[..., None], 3, -1), 'm_s7_flare_mask.png')


# ───────────────────────── мобильная квартира по слоям: assets-src/v10 ─────────────────────────
# Кадр «75» в файле заказчика (AGJMz0OKAVwgcjI1P4bYWG, узел 41:13311), 2026-10-15, и «маска» под ним (41:13361) —
# та же комната в солнце. Исходники — заливки узлов (Figma MCP, download_assets / SVG-экспорт кадра).
RAW10 = ROOT / 'assets-src' / 'v10' / 'raw'
OUT10 = ROOT / 'assets-src' / 'v10'


def save10(a, name):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(OUT10 / name, optimize=True)
    print(f'  -> v10/{name}  {a.shape[1]}x{a.shape[0]}')


def mobile10():
    """Мобильная квартира по слоям (кадр «75»).

    raw/m_s8_room_raw.png — комната 1882×3344 с прозрачным окном (за ним улица), в узле [−4.0625, −1.014, 401.283×713.014];
                        идёт как есть. Окно — на том же месте, что у прежней картинки 941×1672.
    v10/m_s8_room_sun.png — «маска»: та же комната в солнце. У дизайнера она на 0.9% крупнее и сдвинута — приведена
                        к сетке комнаты: x′ = 1.009088·x − 13.587, y′ = 1.008249·y − 11.602 (регистрация по контурам,
                        остаток 0.3 px). Вырез окна — от комнаты: у маски он тот же, а картинка в нём съехала бы.
    v10/m_s8_robot.png — пылесос (узел image 2090011812 — окно картинки, строки 628…1230) и его тень (эллипс
                        с центром (202.43, 667.94), полуоси 63.4×34.93, чёрный 70%, размытие 3.5) одним спрайтом;
                        область — [128.5, 609.7, 147.9×103.7] макета.
    v10/m_s8_plant.png, m_s8_pouf.png — цветок и пуф на переднем плане (узлы 2090011814 и 2090011813) без пустых
                        полей; размытие (1.5 и 1 px макета) — в сцене."""
    print('мобильная квартира по слоям (кадр 75)')
    OUT10.mkdir(parents=True, exist_ok=True)
    rects = {}
    room = Image.open(RAW10 / 'm_s8_room_raw.png').convert('RGBA')
    sun = onto(Image.open(RAW10 / 'm_s8_room_sun_raw.png').convert('RGBA'), room.size, (1.009088, -13.587, 1.008249, -11.602))
    sun[..., 3] = arr(room)[..., 3]
    save10(sun, 'm_s8_room_sun.png')

    # пылесос и тень: рисуются в сетке 6.941 px на px макета (как картинка пылесоса), потом вдвое мельче
    src = arr(Image.open(RAW10 / 'm_s8_robot_raw.png').convert('RGBA'))
    node = (133, 609.711, 135.57, 94.28)
    k = src.shape[1] / node[2]
    y0, y1 = 628, 1230
    box = (128.5, 609.7, 276.4, 713.4)
    W, H = round((box[2] - box[0]) * k), round((box[3] - box[1]) * k)
    canvas = np.zeros((H, W, 4), np.float32)
    gx = box[0] + (np.arange(W, dtype=np.float32) + 0.5) / k
    gy = box[1] + (np.arange(H, dtype=np.float32) + 0.5) / k
    ell = (((gx[None, :] - 202.43) / 63.3984) ** 2 + ((gy[:, None] - 667.939) / 34.9341) ** 2 <= 1).astype(np.float32)
    shadow = gauss(np.concatenate([np.zeros_like(ell)[..., None].repeat(3, -1), ell[..., None]], -1), 3.5 * k)[..., 3] * 0.7
    canvas[..., 3] = shadow
    part = src[y0:y1]
    ox, oy = round((node[0] - box[0]) * k), round((node[1] - box[1]) * k)
    ph, pw = part.shape[:2]
    reg = canvas[oy:oy + ph, ox:ox + pw]
    a = part[..., 3:4]
    reg[..., :3] = part[..., :3] * a + reg[..., :3] * reg[..., 3:4] * (1 - a)
    reg[..., 3:4] = a + reg[..., 3:4] * (1 - a)
    reg[..., :3] = np.where(reg[..., 3:4] > 1e-4, reg[..., :3] / np.maximum(reg[..., 3:4], 1e-4), 0)
    small = Image.fromarray((np.clip(canvas, 0, 1) * 255 + 0.5).astype(np.uint8)).resize((W // 2, H // 2), Image.LANCZOS)
    save10(arr(small), 'm_s8_robot.png')
    rects['m_s8_robot.png'] = (box[0], box[1], box[2] - box[0], box[3] - box[1])

    for src_name, out, node, rows in (('m_s8_plant_raw.png', 'm_s8_plant.png', (-4.0625, 488.312, 189.707, 337.078), None),
                                      ('m_s8_pouf_raw.png', 'm_s8_pouf.png', (98.5, 500.882, 421.199, 358.202), (39, 1024))):
        a = arr(Image.open(RAW10 / src_name).convert('RGBA'))
        if rows:  # узел показывает окно картинки по высоте
            a = a[rows[0]:rows[1]]
        H, W = a.shape[:2]
        part, (x0, y0, x1, y1) = bbox(a)
        save10(part, out)
        sx, sy = node[2] / W, node[3] / H
        rects[out] = (node[0] + x0 * sx, node[1] + y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy)
    for name, r in rects.items():
        print(f'     {name}: [{", ".join(f"{v:.3f}" for v in r)}] (y макета; в сцене — минус 60)')


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    OUT4.mkdir(parents=True, exist_ok=True)
    only = sys.argv[1:]  # python3 scripts/bake-figma.py v4 — только слои финального макета
    if not only or 'v3' in only:
        sky_a(); roof(); airship(); sky_b(); far(); lab(); model()
        mobile_sky_b(); mobile_far()
    if not only or 'v4' in only:
        clouds_day(); rack(); dc_lights(); city(); facade(); street(); clouds_sunset()
    if not only or 'v5' in only:
        mobile_dc_lights()
    if not only or 'v6' in only:
        roof6(); flare_mask(); field_sprites(); van_shadow(); city6(); lab6(); apartment6()
    if not only or 'v7' in only:
        mobile7()
    if not only or 'v8' in only:
        mobile8()
    if not only or 'v9' in only:
        mobile9(); mobile_flare_masks()
    if not only or 'v10' in only:
        mobile10()
    print('готово. Без обработки идут: v3/raw/s1_city_raw.png, s2_near_raw.png, мобильные m_s1_*_raw.png, m_s2_near_raw.png, '
          'm_s3_lab_raw.png и v4/raw/s4_dc.png, s4_logo.png, s5_office.png')
