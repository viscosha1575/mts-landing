/**
 * Таймлайн раскадровки.
 *
 * Единица времени — «кадр» Figma (0…40). Каждый кадр имеет вес (длительность в условных
 * единицах скролла); заголовочные кадры держатся дольше. Дробный номер кадра (9.5) — середина
 * удержания кадра 9. Все треки задаются ключами по кадрам и семплируются по глобальному
 * прогрессу t ∈ [0, 1].
 */

export type Rect = readonly [x: number, y: number, w: number, h: number];
export type Ease = 'linear' | 'smooth' | 'in' | 'out' | 'hold';

export interface Key<T> {
  /** номер кадра Figma, может быть дробным */
  f: number;
  v: T;
  /** для прямоугольников: id сцены, в пространстве которой задан ключ (камера этой сцены его двигает) */
  in?: string;
  /** easing на отрезке от этого ключа к следующему */
  ease?: Ease;
}

/** Опорная ширина/высота макета (фрейм Figma). */
export const REF_W = 1479;
export const REF_H = 832;
export const FRAME_COUNT = 41;

/** Веса кадров: заголовочные удерживаются дольше, чтобы тексты успевали прочитаться. */
const TITLE_FRAMES = new Set([1, 9, 17, 24, 32, 36, 40]);
export const FRAME_WEIGHTS: number[] = Array.from({ length: FRAME_COUNT }, (_, i) => {
  if (i === 0) return 1.6;
  if (i === 9) return 4.2; // текст локации 02 появляется после отлёта аэростата — держим дольше
  if (TITLE_FRAMES.has(i)) return 3.2;
  // затемнение в дата-центр и зумы на логотип: чуть длиннее, чтобы не мелькало
  if (i === 20 || i === 21 || i === 28) return 1.4;
  return 1;
});

const starts: number[] = [];
let acc = 0;
for (const w of FRAME_WEIGHTS) { starts.push(acc); acc += w; }
export const TOTAL_WEIGHT = acc;

/** кадр (дробный) → t ∈ [0,1] */
export function frameToT(f: number): number {
  const fl = Math.max(0, Math.min(FRAME_COUNT - 1, Math.floor(f)));
  const frac = Math.max(0, Math.min(1, f - fl));
  return (starts[fl] + frac * FRAME_WEIGHTS[fl]) / TOTAL_WEIGHT;
}

/** t → дробный кадр (для отладки и оверлея) */
export function tToFrame(t: number): number {
  const u = Math.max(0, Math.min(1, t)) * TOTAL_WEIGHT;
  let i = 0;
  while (i < FRAME_COUNT - 1 && starts[i + 1] <= u) i++;
  return i + (u - starts[i]) / FRAME_WEIGHTS[i];
}

// ───────────────────────── easing ─────────────────────────
export const easings: Record<Ease, (u: number) => number> = {
  linear: (u) => u,
  smooth: (u) => u * u * (3 - 2 * u),
  in: (u) => u * u * u,
  out: (u) => 1 - Math.pow(1 - u, 3),
  hold: () => 0,
};

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

export function sampleNumber(keys: Key<number>[] | number | undefined, t: number, fallback = 0): number {
  if (keys === undefined) return fallback;
  if (typeof keys === 'number') return keys;
  const [a, b, u] = segment(keys, t);
  const e = easings[a.ease ?? 'smooth'](u);
  return a.v + (b.v - a.v) * e;
}

/**
 * Прямоугольники интерполируем по центру и логарифму размера — так зум ощущается равномерным,
 * а не «ускоряющимся» в конце. Без сплайнов: они перелетают за края кадра рядом с удержаниями.
 */
/** Интерполяция двух прямоугольников: центр линейно, размер в log-пространстве */
export function lerpRect(p1: Rect, p2: Rect, u: number): Rect {
  const cx = (p1[0] + p1[2] / 2) + ((p2[0] + p2[2] / 2) - (p1[0] + p1[2] / 2)) * u;
  const cy = (p1[1] + p1[3] / 2) + ((p2[1] + p2[3] / 2) - (p1[1] + p1[3] / 2)) * u;
  const w = Math.exp(Math.log(p1[2]) + (Math.log(p2[2]) - Math.log(p1[2])) * u);
  const h = Math.exp(Math.log(p1[3]) + (Math.log(p2[3]) - Math.log(p1[3])) * u);
  return [cx - w / 2, cy - h / 2, w, h];
}

export function sampleRect(keys: Key<Rect>[] | Rect, t: number): Rect {
  if (!Array.isArray(keys[0]) && typeof (keys as Key<Rect>[])[0]?.f !== 'number') return keys as Rect;
  const ks = keys as Key<Rect>[];
  if (ks.length === 1) return ks[0].v;
  const [a, b, u0] = segment(ks, t);
  if (a === b) return a.v;
  const u = easings[a.ease ?? 'smooth'](u0);
  return lerpRect(a.v, b.v, u);
}

/** Линейный ремап с зажимом */
export const remap = (v: number, a: number, b: number, c = 0, d = 1) => {
  const u = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return c + (d - c) * u;
};
