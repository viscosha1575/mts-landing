/**
 * Таймлайн раскадровки.
 *
 * Единица времени — «кадр» раскадровки. Каждый кадр имеет вес — долю пути по сцене (длины прокрутки
 * или времени перехода); заголовочные кадры тяжелее, чтобы тексты успевали прочитаться. Дробный номер
 * кадра (9.5) — середина кадра 9. Все треки задаются ключами по кадрам и семплируются по глобальному
 * прогрессу t ∈ [0, 1].
 *
 * Раскадровок две, выбирается при загрузке по ширине экрана (макет AGJMz0OKAVwgcjI1P4bYWG):
 *  - desktop: кадры 0…44 — кадры 01…45 секции Desktop (все восемь локаций, фрейм 1920×1080), дальше три
 *    кадра финала (46…48) из секции «3 итерация»: кадры 1511, 1513, 1483 (фрейм 1479×832);
 *  - mobile:  секция 25:196, кадры 92…134 (все восемь локаций, фрейм 393×852) и те же три кадра финала.
 * Ключи десктопных сцен пишутся в номерах кадров макета через D(): D(18) — кадр «18». Ключи мобильных —
 * через M(): M(127) — кадр «127» мобильной секции; у локаций 01–03 кадр таймлайна — номер кадра минус 92.
 */

export type Rect = readonly [x: number, y: number, w: number, h: number];
export type Variant = 'desktop' | 'mobile';

export interface Key<T> {
  /** номер кадра раскадровки, может быть дробным */
  f: number;
  v: T;
  /** для прямоугольников: id сцены, в пространстве которой задан ключ (камера этой сцены его двигает) */
  in?: string;
}

/** Граница мобильной раскадровки. При её пересечении страница перезагружается (см. app.ts). */
export const MOBILE_QUERY = '(max-width: 767px)';
export const VARIANT: Variant = typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches ? 'mobile' : 'desktop';
/**
 * Как сцену ведут по таймлайну.
 * Десктоп и планшет — скроллом: t — доля прокрутки секции, остановили прокрутку — кадр стоит (app.ts).
 * Телефон — шагами: тап или свайп проигрывает переход до следующей остановки, страница не двигается (stepper.ts).
 */
export const STEPPED = VARIANT === 'mobile';

/** Опорная ширина/высота десктопного макета (фрейм Figma). */
export const REF_W = 1920;
export const REF_H = 1080;
/**
 * Мобильный фрейм 393×852 без статус-бара (60 px сверху) и панели Safari: видимая область кадра.
 * Координаты мобильных сцен и оверлея — в ней, то есть y макета минус 60.
 */
export const MOBILE_REF = [393, 645] as const;

/** сколько кадров в десктопной раскадровке: 45 кадров секции Desktop и три кадра финала */
const DESKTOP_FRAMES = 48;

/**
 * Мобильная раскадровка: кадры макета 92…134. Кадр таймлайна — не всегда один кадр макета:
 *  - у локаций 05–07 в макете один кадр-заголовок с одной плашкой, а плашек у локации три — на каждую свой
 *    кадр таймлайна, как в локациях 01–04 (кадры 122, 127, 131 занимают по три);
 *  - между 121 и 122 (дата-центр → офис) перехода в макете нет — под него два кадра после 121;
 *  - за последним кадром 134 идут три кадра финала.
 */
const MOBILE_FIRST = 92;
const MOBILE_LAST = 134;
const MOBILE_SPAN: Record<number, number> = { 121: 3, 122: 3, 127: 3, 131: 3, 134: 4 };
const mobileAt: number[] = [];
let mobileFrames = 0;
for (let n = MOBILE_FIRST; n <= MOBILE_LAST; n++) { mobileAt.push(mobileFrames); mobileFrames += MOBILE_SPAN[n] ?? 1; }
/** Кадр мобильной секции (92…134, можно дробный) → кадр таймлайна; у кадра на несколько плашек — первый из его кадров */
export const M = (n: number) => { const k = Math.max(MOBILE_FIRST, Math.min(MOBILE_LAST, Math.floor(n))); return mobileAt[k - MOBILE_FIRST] + (n - k); };

/**
 * Номер кадра секции Desktop (01…45, можно дробный) → кадр таймлайна. В мобильной раскадровке десктопных
 * кадров нет, кроме финала: кадр 45 (квартира) — её кадр 134, за ним 46…48. Сдвиг MOBILE_OUTRO_AT: остановка
 * на мобильном кадре стоит на 0.55 его длины, финал начинается после неё.
 */
const MOBILE_OUTRO_AT = 0.45;
export const D = (n: number) => (VARIANT === 'mobile' ? n - 45 + M(MOBILE_LAST) + MOBILE_OUTRO_AT : n - 1);
export const FRAME_COUNT = VARIANT === 'mobile' ? mobileFrames : DESKTOP_FRAMES;

/** Кадры-заголовки локаций в секции Desktop */
export const TITLE_FRAMES = [2, 9, 18, 26, 32, 37, 41, 45];
/** Финал после квартиры: комната гаснет, логотип из шапки вырастает в центр кадра, рядом — «Лидер технологий» */
export const OUTRO_FRAME = 48;
/** Кадры, на которых стоят остановки пошагового листания */
export const STOP_FRAMES = [...TITLE_FRAMES, OUTRO_FRAME];

/**
 * Раскладка кадра-заголовка. Камера приходит к его началу, заголовок к этому времени проявлен. С HOLD_FROM
 * до STOP_AT кадр стоит с текстом, сразу за STOP_AT текст гаснет, на LEAVE_AT камера трогается дальше.
 * При листании шагами на STOP_AT стоит остановка: она близко к приходу камеры, переход не заканчивается
 * секундой, в которую ничего не движется. В скролле окно HOLD_FROM…STOP_AT растянуто на TITLE_HOLD единиц
 * веса — больше экрана прокрутки. Камера на нём стоит, а плашки появляются по одной (holdAt): прокрутка
 * всё время что-то меняет на экране, и понятно, что листать нужно дальше.
 */
const HOLD_FROM = 0.04;
export const STOP_AT = 0.2;
export const LEAVE_AT = 0.3;
const TITLE_HOLD = STEPPED ? 0 : 3.6;
/** Кадр внутри удержания кадра-заголовка: p = 0 — его начало, 1 — конец */
export const holdAt = (frame: number, p: number) => frame + HOLD_FROM + (STOP_AT - HOLD_FROM) * p;

/**
 * Веса кадров — доли пути внутри сцены: времени перехода при листании шагами, длины прокрутки в скролле.
 * Заголовочный кадр вмещает остановку и начало отъезда камеры, поэтому он тяжелее остальных.
 * Mobile: на каждую плашку локаций 01–03 свой кадр (0–2, 8–10, 17–20).
 */
const TITLE_WEIGHT = 2;
/**
 * Кадры макета, которым нужно больше времени: в этих переходах камера проходит сквозь предмет
 * (въезжает в логотип и выезжает из куба, проходит окно офиса, выходит из окна квартиры) или мимо него.
 */
const SLOW_FRAMES: Record<number, number> = {
  // центр → дата-центр: тёмная зона, в которой одни огни сменяют другие, — в ней надо побыть
  22: 1.4, 23: 1.4,
  // дата-центр → офис: наезд до ×160 и отъезд от ×48 — на обычном темпе это рывок
  27: 1.7, 28: 1.7, 29: 1.7, 30: 1.7, 31: 1.7,
  // офис → город: проход сквозь окно
  33: 1.5, 34: 1.5, 35: 1.5, 36: 1.5,
  // поворот от города к улице: фасад проходит перед камерой не рывком
  38: 1.4, 39: 1.4, 40: 1.4,
  42: 1.8, 43: 1.8, 44: 1.8,
  // финал: свет гаснет не рывком
  46: 1.5, 47: 1.5,
};
/**
 * Мобильные кадры, на которых стоит остановка листания: по одному на плашку (у квартиры плашек нет —
 * один кадр с заголовком) и последний кадр финала.
 */
export const MOBILE_TIPS = [
  0, 1, 2, 8, 9, 10, 17, 18, 19, 20,
  M(119), M(120), M(121), M(122), M(122) + 1, M(122) + 2, M(127), M(127) + 1, M(127) + 2, M(131), M(131) + 1, M(131) + 2, M(134),
];
/** Мобильные кадры переходов, которым нужно больше времени */
const MOBILE_SLOW: Record<number, number> = {
  // центр → дата-центр: зал гаснет, в темноте одни огни сменяют другие, потом проступает зал
  [M(113)]: 1.2, [M(115)]: 1.4, [M(116)]: 1.4, [M(117)]: 1.2, [M(118)]: 1.2,
  // дата-центр → офис: наезд в логотип и выезд из красной грани куба
  [M(121) + 1]: 1.8, [M(121) + 2]: 1.8,
  // офис → город: панорама к окнам и проход сквозь стекло
  [M(123)]: 1.3, [M(124)]: 1.3, [M(125)]: 1.6,
  // город → улица: фасад проходит перед камерой
  [M(128)]: 1.3, [M(129)]: 1.3, [M(130)]: 1.2,
  // улица → квартира: выезд из окна
  [M(132)]: 1.6, [M(133)]: 1.6,
  // финал
  [M(134) + 1]: 1.5, [M(134) + 2]: 1.5, [M(134) + 3]: 2,
};
/** кадр таймлайна → номер кадра секции Desktop (в мобильной раскадровке его нет) */
const mockFrame = (i: number) => (VARIANT === 'mobile' ? 0 : i + 1);
export const FRAME_WEIGHTS: number[] = Array.from({ length: FRAME_COUNT }, (_, i) => {
  if (VARIANT === 'mobile') return i === 0 ? 2.8 : MOBILE_TIPS.includes(i) ? 2.4 : MOBILE_SLOW[i] ?? 1;
  const n = mockFrame(i);
  // в скролле за финалом сцена открепляется и уезжает со страницей — стоять на нём незачем
  if (n === OUTRO_FRAME) return STEPPED ? TITLE_WEIGHT : 1;
  if (TITLE_FRAMES.includes(n)) return TITLE_WEIGHT;
  // первый кадр десктопа — подсказка «листайте вниз»: короткий
  return n === 1 ? 1.4 : SLOW_FRAMES[n] ?? 1;
});
/** удержание внутри кадра-заголовка: единицы веса сверх FRAME_WEIGHTS (см. TITLE_HOLD) */
const FRAME_HOLDS: number[] = FRAME_WEIGHTS.map((_, i) => (TITLE_FRAMES.includes(mockFrame(i)) ? TITLE_HOLD : 0));

const starts: number[] = [];
let acc = 0;
FRAME_WEIGHTS.forEach((w, i) => { starts.push(acc); acc += w + FRAME_HOLDS[i]; });
export const TOTAL_WEIGHT = acc;

/** кадр (дробный) → t ∈ [0,1] */
export function frameToT(f: number): number {
  const fl = Math.max(0, Math.min(FRAME_COUNT - 1, Math.floor(f)));
  const frac = Math.max(0, Math.min(1, f - fl));
  const held = FRAME_HOLDS[fl] * Math.max(0, Math.min(1, (frac - HOLD_FROM) / (STOP_AT - HOLD_FROM)));
  return (starts[fl] + frac * FRAME_WEIGHTS[fl] + held) / TOTAL_WEIGHT;
}

/** t → дробный кадр (для отладки и оверлея) */
export function tToFrame(t: number): number {
  const u = Math.max(0, Math.min(1, t)) * TOTAL_WEIGHT;
  let i = 0;
  while (i < FRAME_COUNT - 1 && starts[i + 1] <= u) i++;
  const w = FRAME_WEIGHTS[i], hold = FRAME_HOLDS[i], d = u - starts[i];
  if (!hold || d <= HOLD_FROM * w) return i + d / w;
  if (d >= STOP_AT * w + hold) return i + (d - hold) / w;
  return i + HOLD_FROM + (d - HOLD_FROM * w) / (w + hold / (STOP_AT - HOLD_FROM));
}

// ───────────────────────── интерполяция ─────────────────────────
/** Сглаживание на отрезке между двумя ключами (0…1), нулевая скорость на концах */
export const smooth = (u: number) => u * u * (3 - 2 * u);

/** Найти отрезок ключей для t. Возвращает [a, b, u] */
export function segment<T>(keys: Key<T>[], t: number): [Key<T>, Key<T>, number] {
  const n = keys.length;
  if (n === 1 || t <= frameToT(keys[0].f)) return [keys[0], keys[0], 0];
  if (t >= frameToT(keys[n - 1].f)) return [keys[n - 1], keys[n - 1], 0];
  let i = 0;
  while (i < n - 2 && frameToT(keys[i + 1].f) <= t) i++;
  const ta = frameToT(keys[i].f), tb = frameToT(keys[i + 1].f);
  const u = tb > ta ? (t - ta) / (tb - ta) : 0;
  return [keys[i], keys[i + 1], u];
}

/**
 * Трек по ключам — монотонный кубический сплайн (Фритч — Карлсон).
 *
 * Со сглаживанием каждого отрезка по отдельности движение замирает на каждом ключе: камера,
 * которая проходит четыре кадра подряд, четыре раза разгоняется и тормозит. Сплайн проходит
 * промежуточные ключи без остановки, но, в отличие от обычного, не перелетает за значения
 * ключей: на удержаниях и разворотах скорость нулевая, фон не выезжает за край кадра.
 * На концах трека скорость тоже нулевая, поэтому трек из двух ключей — тот же smooth().
 */
interface Curve { x: number[]; y: number[]; m: number[] }
/** @param open — на концах не нулевая скорость, а наклон крайнего отрезка (трек из двух ключей — прямая) */
function curve(x: number[], y: number[], open = false): Curve {
  const n = x.length;
  const m = new Array<number>(n).fill(0);
  for (let k = 1; k < n - 1; k++) {
    const h0 = x[k] - x[k - 1], h1 = x[k + 1] - x[k];
    if (h0 <= 0 || h1 <= 0) continue;
    const d0 = (y[k] - y[k - 1]) / h0, d1 = (y[k + 1] - y[k]) / h1;
    if (d0 * d1 <= 0) continue;
    const w0 = 2 * h1 + h0, w1 = h1 + 2 * h0;
    m[k] = (w0 + w1) / (w0 / d0 + w1 / d1);
  }
  if (open && n > 1) {
    // крайний наклон не круче утроенного наклона отрезка — иначе сплайн перелетит за ключ
    const d0 = (y[1] - y[0]) / (x[1] - x[0]), d1 = (y[n - 1] - y[n - 2]) / (x[n - 1] - x[n - 2]);
    const edge = (d: number, next: number) => (n === 2 ? d : Math.sign(d) * Math.min(Math.abs(1.5 * d - 0.5 * next), 3 * Math.abs(d)));
    m[0] = edge(d0, m[1]);
    m[n - 1] = edge(d1, m[n - 2]);
  }
  return { x, y, m };
}
/** индекс отрезка [x[i], x[i+1]], в который попадает t */
function span(x: number[], t: number): number {
  let i = 0;
  while (i < x.length - 2 && x[i + 1] <= t) i++;
  return i;
}
function evalCurve(c: Curve, t: number): number {
  const { x, y, m } = c, n = x.length;
  if (t <= x[0]) return y[0];
  if (t >= x[n - 1]) return y[n - 1];
  const i = span(x, t);
  const h = x[i + 1] - x[i];
  if (h <= 0) return y[i + 1];
  const u = (t - x[i]) / h, u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * y[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * y[i + 1] + (u3 - u2) * h * m[i + 1];
}

// кривые считаются один раз на массив ключей
const numberCurves = new WeakMap<object, Curve>();
/**
 * Наезд: подряд идущие ключи, между которыми ширина прямоугольника меняется в одну сторону.
 * Центр на таком участке задан как функция ширины (см. sampleRect).
 */
interface Zoom { from: number; to: number; sign: number; cx: Curve; cy: Curve }
interface RectTrack { x: number[]; cx: Curve; cy: Curve; lw: Curve; lh: Curve; zoom: (Zoom | null)[] }
const rectTracks = new WeakMap<object, RectTrack>();

function rectTrack(ks: Key<Rect>[]): RectTrack {
  const x = ks.map((k) => frameToT(k.f));
  const cxs = ks.map((k) => k.v[0] + k.v[2] / 2), cys = ks.map((k) => k.v[1] + k.v[3] / 2);
  const zoom: (Zoom | null)[] = new Array(ks.length - 1).fill(null);
  const dir = (i: number) => { const d = ks[i + 1].v[2] - ks[i].v[2]; return Math.abs(d) > 1e-4 * ks[i].v[2] ? Math.sign(d) : 0; };
  for (let i = 0; i < ks.length - 1;) {
    const sign = dir(i);
    let j = i + 1;
    if (sign) {
      while (j < ks.length - 1 && dir(j) === sign) j++;
      // ширина вдоль участка монотонна; у отъезда меняем знак, чтобы аргумент сплайна возрастал
      const ws = ks.slice(i, j + 1).map((k) => k.v[2] * sign);
      const z: Zoom = { from: i, to: j, sign, cx: curve(ws, cxs.slice(i, j + 1), true), cy: curve(ws, cys.slice(i, j + 1), true) };
      for (let k = i; k < j; k++) zoom[k] = z;
    }
    i = j;
  }
  return { x, cx: curve(x, cxs), cy: curve(x, cys), lw: curve(x, ks.map((k) => Math.log(k.v[2]))), lh: curve(x, ks.map((k) => Math.log(k.v[3]))), zoom };
}

export function sampleNumber(keys: Key<number>[] | number | undefined, t: number, fallback = 0): number {
  if (keys === undefined) return fallback;
  if (typeof keys === 'number') return keys;
  let c = numberCurves.get(keys);
  if (!c) { c = curve(keys.map((k) => frameToT(k.f)), keys.map((k) => k.v)); numberCurves.set(keys, c); }
  return evalCurve(c, t);
}

/**
 * Доля пути центра прямоугольника между двумя ключами при текущей ширине w, null — ширина не меняется.
 *
 * Наезд — это масштабирование вокруг неподвижной точки: всё на экране расходится от неё по прямым.
 * Так получается, только если центр окна смещается пропорционально его размеру, а не времени.
 * При равномерном по времени смещении центра цель наезда сначала отстаёт, потом догоняет — картинка
 * «плывёт» вбок. Поэтому размер идёт по сплайну в логарифме (равномерный зум), а центр — за размером.
 */
function zoomShare(wa: number, wb: number, w: number): number | null {
  return Math.abs(wb - wa) > 1e-4 * wa ? (w - wa) / (wb - wa) : null;
}

/** Интерполяция двух прямоугольников: размер в логарифме, центр — вслед за размером (см. zoomShare) */
export function lerpRect(p1: Rect, p2: Rect, u: number): Rect {
  const w = Math.exp(Math.log(p1[2]) + (Math.log(p2[2]) - Math.log(p1[2])) * u);
  const h = Math.exp(Math.log(p1[3]) + (Math.log(p2[3]) - Math.log(p1[3])) * u);
  const g = zoomShare(p1[2], p2[2], w) ?? u;
  const cx = (p1[0] + p1[2] / 2) + ((p2[0] + p2[2] / 2) - (p1[0] + p1[2] / 2)) * g;
  const cy = (p1[1] + p1[3] / 2) + ((p2[1] + p2[3] / 2) - (p1[1] + p1[3] / 2)) * g;
  return [cx - w / 2, cy - h / 2, w, h];
}

/**
 * Прямоугольник по ключам. Размер — монотонный сплайн в логарифме: зум идёт равномерно.
 * Центр на участках наезда — сплайн от ширины, а не от времени (см. zoomShare): между двумя ключами
 * это масштабирование вокруг неподвижной точки, а через несколько ключей подряд точка смещается плавно,
 * без излома на каждом ключе. Там, где ширина не меняется (панорама), центр идёт по сплайну от времени.
 */
export function sampleRect(keys: Key<Rect>[] | Rect, t: number): Rect {
  if (!Array.isArray(keys[0]) && typeof (keys as Key<Rect>[])[0]?.f !== 'number') return keys as Rect;
  const ks = keys as Key<Rect>[];
  if (ks.length === 1) return ks[0].v;
  let tr = rectTracks.get(ks);
  if (!tr) { tr = rectTrack(ks); rectTracks.set(ks, tr); }
  const n = ks.length;
  if (t <= tr.x[0]) return ks[0].v;
  if (t >= tr.x[n - 1]) return ks[n - 1].v;
  const w = Math.exp(evalCurve(tr.lw, t)), h = Math.exp(evalCurve(tr.lh, t));
  const z = tr.zoom[span(tr.x, t)];
  const cx = z ? evalCurve(z.cx, w * z.sign) : evalCurve(tr.cx, t);
  const cy = z ? evalCurve(z.cy, w * z.sign) : evalCurve(tr.cy, t);
  return [cx - w / 2, cy - h / 2, w, h];
}

/** Линейный ремап с зажимом */
export const remap = (v: number, a: number, b: number, c = 0, d = 1) => {
  const u = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return c + (d - c) * u;
};
