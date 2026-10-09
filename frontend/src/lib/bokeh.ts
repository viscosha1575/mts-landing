/**
 * Свет поверх сцены: огни перехода из исследовательского центра в дата-центр (2D-канвас, сложение).
 *
 * Лампы центра (группа lights макета): блики на светильниках, которые остаются гореть, когда
 * зал гаснет (кадры 20–21), и расплываются в темноте, уступая место огням дата-центра (кадры 22–23).
 * Их точки заданы в пространстве локации 03 (кадр-заголовок 18), поэтому они сидят на лампах
 * и двигаются вместе с камерой.
 * Боке у стойки (группа 2136136620): красные огни не в фокусе у правого края дата-центра. Заданы
 * в пространстве локации 04 (кадр-заголовок 26) как ближний план: при наезде уходят за кадр первыми.
 */
import type { Stage } from './webgl/Stage';
import { scenes } from './scenes';
import { D as F, M, VARIANT, sampleNumber, type Key, type Rect } from './timeline';

/** огонёк: центр, ширина и высота ореола в px макета, поворот в градусах */
type Light = [x: number, y: number, w: number, h: number, rot?: number];

const LAMPS: Light[] = [
  // подвес над столами и красный светильник на колонне
  [1484.44, 408.99, 26, 26], [860.45, 156, 20, 20],
  // линейные светильники: три вертикальных у дальней стены, два горизонтальных над столами
  [1421.44, 34.65, 6, 35.3], [1420.44, 80.65, 6, 35.3], [1419.44, 117.65, 6, 35.3],
  [1342.45, 321.44, 114, 2.9], [1497.45, 321.44, 114, 2.9],
  // наклонные — балки потолка, уходящие в перспективу
  [1079.49, 79.89, 6, 42.3, -29.54], [1055.79, 34.13, 6, 19.8, -28.38],
  [1717.66, 116.97, 7.9, 30.2, 29.52], [1748.39, 73.36, 7.9, 41.3, 34.12], [1777.76, 35.63, 7.9, 34.2, 35.28],
  // трековые споты
  [1212.46, 303, 18, 18], [1833.46, 285, 18, 18], [1201.46, 284, 18, 18], [1872.46, 260, 18, 18], [1224.46, 329, 18, 18],
  [1833.46, 335, 18, 18], [1897.46, 247, 18, 18], [1909.46, 335, 18, 18], [1184.46, 334, 18, 18], [1173.46, 237, 18, 18],
  [1123.46, 255, 18, 18], [960.46, 258, 18, 18], [976.46, 268, 18, 18], [944.46, 245, 18, 18], [924.46, 232, 18, 18],
  [1581.46, 334, 12, 12], [1431.46, 335, 12, 12], [1247.45, 335, 10, 10],
];

const REDS: Light[] = [
  [1831.51, 143.64, 13.2, 21.6], [1798.89, 822.5, 35.2, 19.9, 11.98], [1829.53, 278.61, 16.8, 25.3], [1829.25, 237.04, 12, 18.1],
  [1829.53, 311.15, 16.8, 25.3], [1789.82, 478.92, 40.7, 19.2, -8.47], [1735.69, 558.99, 40.2, 19.3, -4.99], [1793.02, 299.56, 31.6, 13.8, -22.47],
  [1707.95, 336.19, 30.5, 13.9, -21.63], [1829.66, 350.51, 12.8, 20.9], [1842.55, -34.35, 13, 21.2], [1795.16, 659.26, 22.4, 28],
  [1815.47, 659.26, 22.4, 28], [1717.97, 974.53, 25.3, 57.8], [1828.97, 1022.58, 19.4, 57.8], [1806.71, 1008.87, 25.3, 57.8],
  [1745.5, 863.74, 81, 16, 20.64], [1748.07, 170.65, 70.1, 11.7, -36.35], [1758.54, 1127.46, 84.7, 12.2, 31.76], [1716.26, 907.02, 15.5, 20],
  [1724.76, 799.72, 15.5, 20], [1803.38, 887.47, 35.7, 19.7, 17.7],
];

/**
 * Мобильная раскадровка: лаборатория нарисована иначе, ламп шесть — подвесные лампочки справа (группы
 * кадров 113–117 мобильной секции; координаты — в кадре 393×852 без статус-бара). Красного боке у стойки нет:
 * свет дата-центра там — слой m-s4-lights (scenes.ts).
 */
const M_LAMPS: Light[] = [
  [358.8, 120.8, 11, 11], [308.8, 8.8, 10, 10], [350.8, 2.8, 10, 10], [373.2, 33.5, 10, 10], [385.8, 168.8, 11, 11], [359.7, 215.3, 11, 11],
];
const MOBILE = VARIANT === 'mobile';

/**
 * Зал гаснет до черноты, лампы остаются. Потом, в темноте, они уходят из фокуса, расплываются в боке
 * и тают — а на их месте загораются огни дата-центра (слой s4-led в scenes.ts и красное боке у стойки).
 * Зал дата-центра проступает из темноты позже, когда его огни уже горят.
 */
const ALPHA_LAMPS: Key<number>[] = MOBILE
  ? [{ f: M(113) + 0.2, v: 0 }, { f: M(114), v: 1 }, { f: M(116) + 0.2, v: 1 }, { f: M(117) + 0.3, v: 0 }]
  : [{ f: F(16.2), v: 0 }, { f: F(17), v: 1 }, { f: F(22.1), v: 1 }, { f: F(23.3), v: 0 }];
/** на свету лампы светят вполсилы, в темноте — в полную */
const GAIN_LAMPS: Key<number>[] = MOBILE ? [{ f: M(113) + 0.3, v: 0.8 }, { f: M(114) + 0.8, v: 1 }] : [{ f: F(19.4), v: 0.8 }, { f: F(21), v: 1 }];
/** на выходе лампы уходят из фокуса: пятно растёт */
const SPREAD_LAMPS: Key<number>[] = MOBILE ? [{ f: M(116), v: 1 }, { f: M(117) + 0.3, v: 2.4 }] : [{ f: F(21.9), v: 1 }, { f: F(23.3), v: 2.6 }];
const ALPHA_REDS: Key<number>[] = [{ f: F(22.4), v: 0 }, { f: F(23.5), v: 1 }, { f: F(26.8), v: 1 }, { f: F(27.4), v: 0 }];

/**
 * Улица 07: дым из труб завода и фонари вдоль дороги. Точки — в кадре-заголовке на дальнем плане (слой s7-fg,
 * узел [0, 389, 1920×814]). Видны, пока улица стоит во весь кадр: до неё перед камерой проходит фасад,
 * после — в кадр входит рама окна квартиры, а огни оверлея лежат поверх всего.
 */
const STREET_AT: Rect = [0, 389, 1920, 814];
const CHIMNEYS: [number, number][] = [[888, 505], [926, 530], [963, 562], [1000, 596]];
const STREET_LAMPS: [number, number][] = [[80, 733], [262, 740], [390, 735], [588, 708], [640, 753], [822, 742], [857, 708], [935, 707], [1005, 712], [1036, 738]];
const ALPHA_STREET: Key<number>[] = [{ f: F(40.95), v: 0 }, { f: F(41.15), v: 1 }, { f: F(41.65), v: 1 }, { f: F(41.88), v: 0 }];

export class Bokeh {
  ctx: CanvasRenderingContext2D;
  dpr = 1;
  w = 1; h = 1;
  private start = performance.now();
  private s3 = scenes.find((s) => s.id === 's3')!;
  private s4 = scenes.find((s) => s.id === 's4')!;

  constructor(private canvas: HTMLCanvasElement, private stage: Stage) {
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

  /**
   * Огонёк как в макете: белое ядро и широкий тёмно-красный ореол (#820000), оба размыты и складываются
   * с картинкой (plus-lighter — на канвасе режим lighter, сам канвас смешивается со сценой так же, см. стили).
   * Вытянутые светильники — тот же круг, сжатый по одной оси и повёрнутый.
   */
  private glow(x: number, y: number, w: number, h: number, rot: number, a: number) {
    const ctx = this.ctx;
    const r = Math.max(w, h) / 2;
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    // ореол шире узла на размытие; у линейных светильников оно не даёт пятну схлопнуться в волос
    ctx.scale(Math.max(w / 2, r * 0.07) / r, Math.max(h / 2, r * 0.07) / r);
    const rh = r * 2.1;
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, rh);
    halo.addColorStop(0, `rgba(150,0,6,${a})`);
    halo.addColorStop(0.4, `rgba(130,0,4,${a * 0.62})`);
    halo.addColorStop(0.7, `rgba(120,0,4,${a * 0.2})`);
    halo.addColorStop(1, 'rgba(110,0,4,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, rh, 0, Math.PI * 2); ctx.fill();
    const rc = r * 1.05;
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, rc);
    core.addColorStop(0, `rgba(255,255,255,${a})`);
    core.addColorStop(0.42, `rgba(255,238,232,${a * 0.85})`);
    core.addColorStop(0.75, `rgba(255,190,180,${a * 0.25})`);
    core.addColorStop(1, 'rgba(255,170,160,0)');
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(0, 0, rc, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  update(t: number) {
    const aLamps = sampleNumber(ALPHA_LAMPS, t), aReds = MOBILE ? 0 : sampleNumber(ALPHA_REDS, t);
    const aStreet = MOBILE ? 0 : sampleNumber(ALPHA_STREET, t);
    const ctx = this.ctx;
    if (aLamps <= 0.001 && aReds <= 0.001 && aStreet <= 0.001) {
      if (this.canvas.style.opacity !== '0') { this.canvas.style.opacity = '0'; ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
      return;
    }
    this.canvas.style.opacity = '1';
    const time = (performance.now() - this.start) / 1000;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'lighter';

    if (aLamps > 0.001) {
      const gain = sampleNumber(GAIN_LAMPS, t), spread = sampleNumber(SPREAD_LAMPS, t);
      (MOBILE ? M_LAMPS : LAMPS).forEach(([lx, ly, w, h, rot = 0], i) => {
        // все лампы слегка дышат; часть трековых спотов (у них нет отражения в полу) заметно мерцает
        const blinks = !MOBILE && i >= 12 && i % 3 === 0;
        const flicker = blinks
          ? 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(time * (0.9 + (i % 5) * 0.31) + i * 2.1)) ** 2 * (Math.sin(time * 9.3 + i) > -0.92 ? 1 : 0.35)
          : 0.92 + 0.08 * Math.sin(time * (1.4 + (i % 5) * 0.37) + i * 1.7);
        const [x, y, s] = this.stage.projectScene(this.s3, t, lx, ly);
        this.glow(x, y, w * s * spread, h * s * spread, rot, aLamps * gain * flicker);
      });
    }
    if (aReds > 0.001) {
      REDS.forEach(([lx, ly, w, h, rot = 0], i) => {
        // переливы: каждый огонь медленно разгорается и заметно притухает в своём ритме
        const flicker = 0.38 + 0.62 * (0.5 + 0.5 * Math.sin(time * (0.9 + (i % 7) * 0.31) + i * 2.3)) ** 1.5;
        const [x, y, s] = this.stage.projectScene(this.s4, t, lx, ly, 1);
        if (x < -200 || x > this.w + 200) return;
        this.glow(x, y, w * s * 1.25, h * s * 1.25, rot, aReds * flicker);
      });
    }
    if (aStreet > 0.001) {
      const r = this.stage.screenRectOf('s7', 's7-fg', t);
      if (r) {
        const k = r[2] / STREET_AT[2];
        const at = (px: number, py: number): [number, number] => [r[0] + (px - STREET_AT[0]) * k, r[1] + (py - STREET_AT[1]) * k];
        // дым: клубы поднимаются над трубой, растут, уходят по ветру и тают
        CHIMNEYS.forEach(([cx, cy], e) => {
          for (let n = 0; n < 7; n++) {
            const age = (time * 0.065 + n / 7 + e * 0.37) % 1;
            const [x, y] = at(cx + age * (44 + e * 8) + Math.sin(age * 6 + e * 1.9) * 4, cy - age * 60);
            const rad = (4 + age * 20) * k, a = aStreet * 0.085 * Math.sin(Math.PI * age) ** 0.7 * (1 - age * 0.35);
            const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
            g.addColorStop(0, `rgba(235,180,160,${a})`); g.addColorStop(0.6, `rgba(225,165,150,${a * 0.5})`); g.addColorStop(1, 'rgba(220,160,150,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
          }
        });
        // фонари: ореол слегка дышит у всех, три фонаря моргают сериями
        STREET_LAMPS.forEach(([lx, ly], i) => {
          const [x, y] = at(lx, ly);
          const faulty = i === 2 || i === 5 || i === 8;
          const burst = Math.sin(time * 0.5 + i * 1.3) > 0.35;
          const level = faulty && burst ? (Math.sin(time * 17 + i) + Math.sin(time * 9.7 + i * 3) > 0.2 ? 1 : 0.05) : 0.32 + 0.1 * Math.sin(time * (1.1 + i * 0.13) + i);
          const rad = (faulty ? 17 : 13) * k, a = aStreet * level;
          const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
          g.addColorStop(0, `rgba(255,214,150,${a * 0.9})`); g.addColorStop(0.35, `rgba(255,170,70,${a * 0.45})`); g.addColorStop(1, 'rgba(255,150,40,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
        });
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
