/**
 * Красный свет перехода 3 → 4.
 *
 * Фаза «лампы»: светильники исследовательского центра загораются красным.
 * Их точки заданы в пространстве локации 03 (сняты с фона кадра-заголовка 37), поэтому
 * они сидят на лампах и двигаются вместе с камерой.
 * Фаза «боке» (кадры 1472 … 116): в темноте те же огни расфокусируются и переплывают на позиции
 * кадра 116, а в кадре 11 растворяются в огнях стоек дата-центра.
 * Плюс индикаторы стойки (кадр 116), которые остаются на стойках через заголовок дата-центра.
 */
import { REF_W, REF_H, LEGACY_SCALE, VARIANT, legacyFrame as o, sampleNumber, tToFrame, type Key } from './timeline';

/**
 * s — [x, y, d] светильника в пространстве локации 03 (кадр-заголовок 37, 1920×1080);
 * b — [x, y, d] на экране кадра 116 прежнего макета (1479×832)
 */
const LAMPS: Array<{ s: [number, number, number]; b: [number, number, number] }> = [
  // трековые споты слева → кластер слева-сверху (116)
  { s: [931, 225, 16], b: [457, 84, 18] },
  { s: [951, 236, 16], b: [469, 106, 18] },
  { s: [971, 246, 16], b: [483, 131, 18] },
  { s: [1121, 246, 12], b: [491, 146, 11] },
  // красный светильник на колонне
  { s: [860, 156, 26], b: [438, 147, 15] },
  // красный подвес и споты над столами
  { s: [1484, 399, 22], b: [840, 238, 26] },
  { s: [1180, 325, 13], b: [1360, 801, 22] },
  { s: [1430, 325, 16], b: [1241, 279, 26] },
  // споты справа → кластер справа (116)
  { s: [1580, 325, 15], b: [1313, 148, 20] },
  { s: [1831, 325, 15], b: [1414, 148, 20] },
  { s: [1831, 277, 15], b: [1313, 82, 20] },
  { s: [1863, 255, 15], b: [1366, 51, 20] },
  { s: [1894, 234, 15], b: [1400, 31, 20] },
];

// Индикаторы стойки (кадр 116 прежнего макета), экранные координаты
const LED: Array<[number, number, number]> = [
  [659, 514, 5.7], [669, 510, 5.7], [679, 507, 5.7], [703, 507, 4.3], [713, 505, 4.7], [738, 502, 4.7],
  [738, 484, 4.7], [703, 490, 4.1], [658, 486, 4.1], [739, 481, 4.7], [704, 487, 4.1], [659, 483, 4.1],
  [746, 482, 4.7], [711, 488, 4.1], [668, 487, 4.1], [746, 478, 4.7], [711, 484, 4.1], [668, 483, 4.1],
  [743, 499, 4.7], [739, 515, 3.3], [743, 513, 3.3], [702, 521, 5.7], [708, 519, 5.7], [721, 513, 4.3],
  [669, 523, 5.7], [658, 526, 5.7], [679, 517, 5.7], [766, 480, 5], [767, 496, 5], [777, 491, 5],
  [789, 503, 5.4], [789, 492, 5], [806, 490, 4.3], [822, 486, 3.6], [836, 483, 3.6], [837, 493, 3.1],
  [789, 479, 4.6], [807, 501, 3.3], [823, 496, 3.3],
];

/**
 * Лампы загораются, когда камера после заголовка едет в интерьер, живут в темноте, растворяются в свете стоек.
 * В мобильной раскадровке интерьер другой и камера стоит — огни появляются уже в затемнении, сразу как боке.
 */
const MOBILE = VARIANT === 'mobile';
const ALPHA_LAMPS: Key<number>[] = [
  ...(MOBILE ? [{ f: o(19.6), v: 0 }, { f: o(20.6), v: 1 }] : [{ f: o(17.7), v: 0 }, { f: o(18.5), v: 1 }]),
  { f: o(22.4), v: 1 }, { f: o(23.2), v: 0 },
];
/** индикаторы стойки: появляются в темноте, остаются через заголовок дата-центра */
const ALPHA_LED: Key<number>[] = [{ f: o(21.2), v: 0 }, { f: o(22), v: 1 }, { f: o(25.3), v: 1 }, { f: o(26), v: 0 }];
/** 0 — лампы на местах в интерьере, 1 — на позициях кадра 1472 */
const MORPH: Key<number>[] = MOBILE ? [{ f: 0, v: 1 }] : [{ f: o(20.6), v: 0 }, { f: o(21.5), v: 1 }];
/** в темноте огни чуть ярче */
const GAIN: Key<number>[] = [{ f: o(19), v: 0.8 }, { f: o(20), v: 1 }];

export type Projector = (x: number, y: number) => [number, number, number];

export class Bokeh {
  ctx: CanvasRenderingContext2D;
  dpr = 1;
  w = 1; h = 1;
  private start = performance.now();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  /** @param project — проекция точки пространства локации 03 на экран (x, y → sx, sy, масштаб) */
  update(t: number, project: Projector) {
    const aLamps = sampleNumber(ALPHA_LAMPS, t), aLed = sampleNumber(ALPHA_LED, t);
    const ctx = this.ctx;
    if (aLamps <= 0.001 && aLed <= 0.001) {
      if (this.canvas.style.opacity !== '0') { this.canvas.style.opacity = '0'; ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
      return;
    }
    this.canvas.style.opacity = '1';
    const time = (performance.now() - this.start) / 1000;
    const f = tToFrame(t);
    const mu = sampleNumber(MORPH, t);
    const m = mu * mu * (3 - 2 * mu);
    const cover = Math.max(this.w / REF_W, this.h / REF_H);
    const ox = (this.w - REF_W * cover) / 2, oy = (this.h - REF_H * cover) / 2;
    // экранные точки сняты с прежнего макета — переводим их в текущий фрейм
    const ref = cover * LEGACY_SCALE;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'lighter';

    /** огонёк как в макете: белое ядро с мягким тёмно-красным ореолом, режим plus-lighter. d — диаметр узла */
    const glow = (x: number, y: number, d: number, a: number) => {
      const rh = d * 0.82;
      const h = ctx.createRadialGradient(x, y, 0, x, y, rh);
      h.addColorStop(0, `rgba(150,0,10,${a})`);
      h.addColorStop(0.45, `rgba(140,0,10,${a * 0.6})`);
      h.addColorStop(1, 'rgba(120,0,10,0)');
      ctx.fillStyle = h;
      ctx.beginPath(); ctx.arc(x, y, rh, 0, Math.PI * 2); ctx.fill();
      const rc = d * 0.45;
      const c = ctx.createRadialGradient(x, y, 0, x, y, rc);
      c.addColorStop(0, `rgba(255,255,255,${a})`);
      c.addColorStop(0.5, `rgba(255,225,225,${a * 0.75})`);
      c.addColorStop(1, 'rgba(255,170,170,0)');
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(x, y, rc, 0, Math.PI * 2); ctx.fill();
    };

    const gain = sampleNumber(GAIN, t);
    if (aLamps > 0.001) {
      LAMPS.forEach((d, i) => {
        const flicker = 0.92 + 0.08 * Math.sin(time * (1.4 + (i % 5) * 0.37) + i * 1.7);
        const [lx, ly, ls] = project(d.s[0], d.s[1]);
        const bx = ox + d.b[0] * ref, by = oy + d.b[1] * ref;
        const x = lx + (bx - lx) * m, y = ly + (by - ly) * m;
        // размер узла в макете; при зуме растёт с камерой, но не разрастается в пятно
        const dLamp = Math.min(d.s[2] * ls, 40 * ref);
        const dBokeh = d.b[2] * ref;
        glow(x, y, dLamp + (dBokeh - dLamp) * m, aLamps * gain * flicker);
      });
    }
    if (aLed > 0.001) {
      LED.forEach(([x0, y0, r0], i) => {
        const flicker = 0.8 + 0.2 * Math.sin(time * (2 + (i % 7) * 0.3) + i);
        glow(ox + x0 * ref, oy + y0 * ref, r0 * ref * 2, aLed * flicker);
      });
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
