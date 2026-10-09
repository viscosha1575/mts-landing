/**
 * DOM-оверлей поверх WebGL: заголовки локаций, плашки, волны у антенн, подсказка скролла.
 * Всё, что «по материалам делаем кодом».
 *
 * Оверлей живёт в координатах фрейма Figma (1920×1080), вписанного в экран по cover — ровно как
 * screen-слои в WebGL, поэтому плашки и волны совпадают с картинкой на любом экране.
 * В мобильной раскадровке локации 01–03 размечены отдельно (фрейм 393×645): заголовок и плашка
 * стоят от левого края экрана, а выноска плашки дотягивается до точки сцены.
 */
import gsap from 'gsap';
import type { Stage } from './webgl/Stage';
import { scenes } from './scenes';
import { D, LEAVE_AT, M, MOBILE_REF, REF_W, REF_H, VARIANT, frameToT, sampleNumber, sampleRect, tToFrame, type Key, type Rect } from './timeline';

const MOBILE = VARIANT === 'mobile';

/** Волны вокруг антенны: узел waves кадров 01–02; с отъездом камеры растут вместе с крышей (кадр 03: ×1.336) и гаснут */
const WAVES_TRACK: Key<Rect>[] = MOBILE
  // мобильные кадры 01–04: узел circles у антенны
  ? [{ f: 0, v: [166.2, 261.9, 241, 241] }, { f: 3.6, v: [166.2, 261.9, 241, 241] }]
  : [
    { f: D(1), v: [1217.96, 79, 512.87, 512.87] },
    { f: D(2 + LEAVE_AT), v: [1217.96, 79, 512.87, 512.87] },
    { f: D(3), v: [1304.6, 12.8, 685.2, 685.2] },
  ];
const WAVES_ALPHA: Key<number>[] = MOBILE
  ? [{ f: 0, v: 1 }, { f: 3, v: 1 }, { f: 3.6, v: 0 }]
  : [{ f: D(1), v: 1 }, { f: D(2 + LEAVE_AT), v: 1 }, { f: D(3), v: 0 }];

/**
 * Линии связи локации 02: видимая в кадре часть узла «линии» — [667.3, 498.7, 1253×332] в пространстве локации.
 * Проявляются, когда камера пришла к заголовку, и гаснут на наезде к аэростату.
 */
const LINKS_AT: readonly [number, number] = [667.3, 498.7];
const LINKS_ALPHA: Key<number>[] = [{ f: D(8.7), v: 0 }, { f: D(9), v: 1 }, { f: D(9 + LEAVE_AT), v: 1 }, { f: D(9.9), v: 0 }];

/**
 * Часы на колонке в квартире: левый верхний угол узла в пространстве локации 08. Появляются, когда комната
 * уже в фокусе (до того цифры видны нарисованные, размытые вместе с картинкой), и темнеют вместе с ней в финале.
 */
const CLOCK_AT: readonly [number, number] = [1157, 774];
const CLOCK_ALPHA: Key<number>[] = [{ f: D(44.2), v: 0 }, { f: D(44.6), v: 1 }];
/** сколько миллисекунд идёт одна «минута» на часах */
const CLOCK_TICK = 10000;

/**
 * Логотип финала: из шапки — в центр кадра. Ключи — узлы Layer кадров 1511, 1513, 1483 секции «3 итерация»
 * в координатах кадра 1920×1080 (× 1.298); первый — логотип шапки. С них берётся только форма пути и темп:
 * настоящие начало и конец — логотип шапки и место в связке, как они стоят на этом экране.
 */
const OUTRO_LOGO: Key<Rect>[] = [
  { f: D(45 + LEAVE_AT), v: [80.44, 35, 44, 44] },
  { f: D(46), v: [123.46, 115.54, 149.29, 149.29] },
  { f: D(47), v: [263.53, 267.42, 272.49, 272.49] },
  { f: D(48), v: [495.9, 388.15, 311.56, 311.56] },
];

/** с какого кадра активна точка пагинации каждой из восьми локаций */
const PAGER_BOUNDS = MOBILE
  ? [0, 6, 15, M(116), M(121) + 2.3, M(125) + 0.8, M(129), M(132) + 0.3]
  : [0, D(5), D(13.2), D(23), D(29.2), D(35.5), D(40), D(43)];

/**
 * В какой нумерации заданы data-in / data-out элемента (см. data-frames в Experience.astro).
 * null — блок другой раскадровки, в таймлайн не попадает.
 */
function frameConverter(el: HTMLElement): ((f: number) => number) | null {
  const kind = el.closest<HTMLElement>('[data-frames]')?.dataset.frames;
  if (kind === 'shared') return D;
  if (kind === 'desktop') return MOBILE ? null : D;
  if (kind === 'mobile') return MOBILE ? (f) => f : null;
  return (f) => f;
}

export class Overlay {
  root: HTMLElement;
  tl: gsap.core.Timeline;
  private positioned: HTMLElement[];
  private mobilePositioned: HTMLElement[];
  private waves: HTMLElement | null;
  private links: HTMLElement | null;
  private s2 = scenes.find((s) => s.id === 's2');
  private s8 = scenes.find((s) => s.id === 's8');
  private clock: HTMLElement | null;
  private clockText: HTMLElement | null;
  private clockStart = performance.now();
  private clockShown = '';
  private pager: HTMLElement[];
  private outroLogo: HTMLElement | null;
  private outroSlot: HTMLElement | null;
  private headerLogo: HTMLElement | null;
  /** логотип в шапке и его место в связке финала: x, y, сторона */
  private outroFrom: [number, number, number] = [0, 0, 44];
  private outroTo: [number, number, number] = [0, 0, 44];
  private logoHidden = false;
  private wasHeld = true;

  constructor(private stage: Stage) {
    this.root = document.getElementById('overlay') as HTMLElement;
    this.positioned = [...this.root.querySelectorAll<HTMLElement>('[data-x]')];
    this.mobilePositioned = MOBILE ? [...this.root.querySelectorAll<HTMLElement>('[data-mx]')] : [];
    this.waves = this.root.querySelector('#waves');
    this.links = MOBILE ? null : this.root.querySelector('#links');
    this.clock = MOBILE ? null : this.root.querySelector('#clock');
    this.clockText = this.clock?.querySelector('[data-clock]') ?? null;
    this.pager = [...document.querySelectorAll<HTMLElement>('[data-pager]')];
    this.outroLogo = this.root.querySelector('[data-outro-logo]');
    this.outroSlot = this.root.querySelector('[data-outro-slot]');
    this.headerLogo = document.querySelector('#header a[aria-label]');
    this.tl = this.buildTimeline();
    this.resize();
  }

  /** Расставить элементы по координатам макета */
  resize() {
    const { scale, ox, oy } = this.stage.refTransform();
    const W = this.stage.width, H = this.stage.height;
    // --rs — масштаб картинки (cover), --ui — масштаб интерфейса по ширине, чтобы текст не рос на узких экранах
    this.root.style.setProperty('--rs', String(scale));
    this.root.style.setProperty('--ui', String(Math.min(scale, W / REF_W)));
    const pad = 16;
    for (const el of this.positioned) {
      const x = +el.dataset.x!, y = +el.dataset.y!;
      if (el.dataset.safe !== undefined) {
        // заголовки: отступы от вьюпорта, а не от обрезанного кадра; центр блока — на высоте y макета
        // (центрируем расчётом, а не transform: его перезаписывает GSAP)
        el.style.left = `${x * (W / REF_W)}px`;
        el.style.top = `${H / 2 + (y - REF_H / 2) * (H / REF_H) - el.offsetHeight / 2}px`;
        continue;
      }
      if (el.dataset.w) el.style.width = `${+el.dataset.w * scale}px`;
      if (el.dataset.h) el.style.height = `${+el.dataset.h * scale}px`;
      let left = ox + x * scale, top = oy + y * scale;
      // плашки не должны уходить за экран на узких пропорциях
      const w = el.offsetWidth, h = el.offsetHeight;
      if (w && left + w > W - pad) left = W - pad - w;
      if (left < pad) left = pad;
      if (h && top + h > H - pad) top = H - pad - h;
      if (top < 60) top = 60;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }
    if (MOBILE) this.resizeMobile();
    this.measureOutro();
  }

  /** Откуда и куда летит логотип финала. Шапка закреплена на экране, сцена в этот момент стоит в его начале */
  private measureOutro() {
    if (!this.outroLogo || !this.outroSlot || !this.headerLogo) return;
    const view = this.root.getBoundingClientRect();
    const a = this.headerLogo.getBoundingClientRect(), b = this.outroSlot.getBoundingClientRect();
    this.outroFrom = [a.left, a.top, a.width];
    this.outroTo = [b.left - view.left, b.top - view.top, b.width];
    // в полный размер: уменьшенный логотип резче увеличенного
    this.outroLogo.style.width = this.outroLogo.style.height = `${b.width}px`;
  }

  /**
   * Мобильные блоки: по горизонтали — от края экрана в единицах макета (--mui = ширина / 393),
   * по вертикали — вместе с картинкой (она вписана по cover и на высоких экранах крупнее).
   */
  private resizeMobile() {
    const m = this.stage.refTransform(MOBILE_REF);
    const mui = this.stage.width / MOBILE_REF[0];
    this.root.style.setProperty('--mui', String(mui));
    for (const el of this.mobilePositioned) {
      const left = +el.dataset.mx! * mui;
      const top = Math.max(60, m.oy + +el.dataset.my! * m.scale);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      if (el.dataset.tx) this.drawLeader(el, m.ox + +el.dataset.tx * m.scale - left, m.oy + +el.dataset.ty! * m.scale - top, mui);
    }
  }

  /**
   * Выноска мобильной плашки до точки (tx, ty) в координатах плашки.
   * Вправо — прямая на высоте цели; вниз — прямая или со скруглённым поворотом к цели, как в макете.
   */
  private drawLeader(el: HTMLElement, tx: number, ty: number, mui: number) {
    const box = el.querySelector<HTMLElement>('.mtip__box')!;
    const svg = el.querySelector<SVGElement>('.mtip__line')!;
    const path = svg.querySelector('path')!;
    const w = box.offsetWidth, h = box.offsetHeight;
    const inset = 12 * mui;
    let d = '';
    if (el.dataset.side === 'right') {
      if (tx > w + 6) d = `M${w} ${Math.max(inset, Math.min(h - inset, ty))}L${tx} ${ty}`;
    } else if (ty > h + 6) {
      const x0 = Math.max(inset, Math.min(w - inset, +(el.dataset.at ?? 0) * mui));
      const dx = tx - x0;
      const r = Math.min(10 * mui, Math.abs(dx), ty - h);
      d = Math.abs(dx) < 6
        ? `M${tx} ${h}L${tx} ${ty}`
        : `M${x0} ${h}L${x0} ${ty - r}Q${x0} ${ty} ${x0 + Math.sign(dx) * r} ${ty}L${tx} ${ty}`;
    }
    // цель оказалась под плашкой (нестандартные пропорции экрана) — выноску не рисуем
    svg.style.display = d ? '' : 'none';
    path.setAttribute('d', d);
    svg.querySelectorAll('circle').forEach((c) => { c.setAttribute('cx', String(tx)); c.setAttribute('cy', String(ty)); });
  }

  private place(el: HTMLElement, r: Rect) {
    const { scale, ox, oy } = this.stage.refTransform(MOBILE ? MOBILE_REF : undefined);
    el.style.transform = `translate3d(${ox + r[0] * scale}px, ${oy + r[1] * scale}px, 0)`;
    el.style.width = `${r[2] * scale}px`;
    el.style.height = `${r[3] * scale}px`;
  }

  /** Скраб-таймлайн для появления/исчезновения блоков. Длительность = 1 (t). */
  private buildTimeline() {
    // overwrite отключён: в скраб-таймлайне твин «out» иначе убивает твин «in» той же плашки,
    // и при обратном скролле она остаётся видимой
    const tl = gsap.timeline({ paused: true, defaults: { overwrite: false, immediateRender: false } });
    const els = this.root.querySelectorAll<HTMLElement>('[data-in]');
    els.forEach((el) => {
      const conv = frameConverter(el);
      if (!conv) return;
      // отрицательный data-in — «видно с самого начала», номером кадра не является
      const rawIn = +el.dataset.in!;
      // без data-out блок остаётся до конца сцены
      const stays = el.dataset.out === undefined;
      const fin = rawIn < 0 ? rawIn : conv(rawIn), fout = stays ? fin : conv(+el.dataset.out!);
      const tIn = frameToT(fin), tOut = frameToT(fout);
      // длительность появления в кадрах: по умолчанию полкадра, у плашек короче (data-dur)
      const dIn = Math.max(0.004, frameToT(fin + +(el.dataset.dur ?? 0.5)) - tIn);
      const dOut = Math.max(0.004, frameToT(fout + 0.28) - tOut);
      const dir = el.dataset.dir ?? 'up';
      const from = dir === 'up' ? { y: 26 } : dir === 'left' ? { x: -26 } : { scale: 0.96 };
      if (fin < 0) {
        gsap.set(el, { autoAlpha: 1 });
      } else {
        gsap.set(el, { autoAlpha: 0, ...from });
        tl.to(el, { autoAlpha: 1, x: 0, y: 0, scale: 1, duration: dIn, ease: 'power3.out' }, tIn);
      }
      if (!stays) tl.to(el, { autoAlpha: 0, y: dir === 'up' ? -18 : 0, duration: dOut, ease: 'power2.in' }, tOut);
    });
    // зафиксировать длительность ровно 1
    tl.set({}, {}, 1);
    return tl;
  }

  intro() {
    // десктоп: первый экран — кадр 01 с подсказкой, заголовок и плашки приходят с первым шагом;
    // мобильный: кадр 01 уже с заголовком и первой плашкой
    this.root.classList.add('is-live');
  }

  /** @param held — сцена держит экран (страница не ушла дальше): тогда логотип шапки уступает место летящему */
  update(t: number, held = true) {
    this.tl.progress(t);
    const f = tToFrame(t);

    if (this.outroLogo) {
      const on = t > frameToT(OUTRO_LOGO[0].f);
      this.outroLogo.style.opacity = on ? '1' : '0';
      const hide = on && held;
      if (this.headerLogo && hide !== this.logoHidden) {
        // летящему логотипу шапка уступает место сразу — они стоят точка в точку; а когда сцена
        // уезжает со страницей и увозит его с собой, логотип в шапке проявляется, а не выскакивает
        this.headerLogo.style.transition = held === this.wasHeld ? 'none' : 'opacity 0.3s';
        this.headerLogo.style.opacity = hide ? '0' : '';
        this.logoHidden = hide;
      }
      this.wasHeld = held;
      if (on) {
        // доля пути по размеру и по каждой оси — из ключей макета, сам путь — между настоящими точками
        const r = sampleRect(OUTRO_LOGO, t);
        const a = OUTRO_LOGO[0].v, b = OUTRO_LOGO[OUTRO_LOGO.length - 1].v;
        const us = Math.log(r[2] / a[2]) / Math.log(b[2] / a[2]);
        const ux = (r[0] + r[2] / 2 - (a[0] + a[2] / 2)) / (b[0] + b[2] / 2 - (a[0] + a[2] / 2));
        const uy = (r[1] + r[3] / 2 - (a[1] + a[3] / 2)) / (b[1] + b[3] / 2 - (a[1] + a[3] / 2));
        const [x0, y0, s0] = this.outroFrom, [x1, y1, s1] = this.outroTo;
        const s = s0 * Math.pow(s1 / s0, us);
        const cx = x0 + s0 / 2 + (x1 + s1 / 2 - x0 - s0 / 2) * ux, cy = y0 + s0 / 2 + (y1 + s1 / 2 - y0 - s0 / 2) * uy;
        this.outroLogo.style.transform = `translate3d(${cx - s / 2}px, ${cy - s / 2}px, 0) scale(${s / s1})`;
      }
    }

    if (this.links && this.s2) {
      const a = sampleNumber(LINKS_ALPHA, t);
      this.links.style.opacity = String(a);
      if (a > 0) {
        // верх линий — у гондолы аэростата: вместе с ним идут за мышью и покачиваются
        const [x, y, k] = this.stage.projectScene(this.s2, t, LINKS_AT[0], LINKS_AT[1]);
        const [fx, fy] = this.stage.floating;
        this.links.style.transform = `translate3d(${x + fx}px, ${y + fy}px, 0) scale(${k})`;
      }
    }
    if (this.clock && this.clockText && this.s8) {
      const a = sampleNumber(CLOCK_ALPHA, t);
      this.clock.style.opacity = String(a);
      if (a > 0) {
        const [x, y, k] = this.stage.projectScene(this.s8, t, CLOCK_AT[0], CLOCK_AT[1]);
        this.clock.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
        this.clock.style.filter = `brightness(${1 - sampleNumber(this.s8.dim, t, 0)})`;
        // 20:00 и дальше: минута раз в CLOCK_TICK
        const m = (20 * 60 + Math.floor((performance.now() - this.clockStart) / CLOCK_TICK)) % 1440;
        const text = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        if (text !== this.clockShown) { this.clockShown = text; this.clockText.textContent = text; }
      }
    }
    if (this.waves) {
      const a = sampleNumber(WAVES_ALPHA, t);
      // в макете волны едва заметны: overlay при 50%
      this.waves.style.opacity = String(a * 0.55);
      if (a > 0) this.place(this.waves, sampleRect(WAVES_TRACK, t));
    }
    // пагинация: активная локация по текущему кадру
    let active = 0;
    for (let i = 0; i < PAGER_BOUNDS.length; i++) if (f >= PAGER_BOUNDS[i]) active = i;
    this.pager.forEach((p) => {
      const dots = p.children;
      for (let i = 0; i < dots.length; i++) (dots[i] as HTMLElement).classList.toggle('is-active', i === active);
    });
  }
}
