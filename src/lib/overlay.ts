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
import { MOBILE_REF, REF_W, REF_H, VARIANT, frameToT, legacyFrame, sampleNumber, sampleRect, tToFrame, type Key, type Rect } from './timeline';

const MOBILE = VARIANT === 'mobile';

/** Волны вокруг антенны: узел waves в кадрах 22–23 и 24 (зум ×1.3985 вместе с крышей) */
const WAVES_TRACK: Key<Rect>[] = MOBILE
  // мобильные кадры 01–04: узел circles у антенны
  ? [{ f: 0, v: [166.2, 261.9, 241, 241] }, { f: 3.6, v: [166.2, 261.9, 241, 241] }]
  : [
    { f: 0, v: [1217.96, 79, 512.87, 512.87] },
    { f: 1.55, v: [1217.96, 79, 512.87, 512.87] },
    { f: 2, v: [1708.41, 110.48, 717.25, 717.25] },
    { f: 3, v: [1930, 20, 910, 910] },
  ];
const WAVES_ALPHA: Key<number>[] = MOBILE
  ? [{ f: 0, v: 1 }, { f: 3, v: 1 }, { f: 3.6, v: 0 }]
  : [{ f: 0, v: 1 }, { f: 2, v: 1 }, { f: 2.6, v: 0 }];

/** с какого кадра активна точка пагинации каждой локации */
const PAGER_BOUNDS = [0, ...(MOBILE ? [6, 15] : [3, 11]), legacyFrame(21.5), legacyFrame(28.5), legacyFrame(33.5), legacyFrame(37)];

/**
 * В какой нумерации заданы data-in / data-out элемента (см. data-frames в Experience.astro).
 * null — блок другой раскадровки, в таймлайн не попадает.
 */
function frameConverter(el: HTMLElement): ((f: number) => number) | null {
  const kind = el.closest<HTMLElement>('[data-frames]')?.dataset.frames;
  if (kind === 'legacy') return legacyFrame;
  if (kind === 'mobile') return MOBILE ? (f) => f : null;
  if (kind === 'desktop') return MOBILE ? null : (f) => f;
  return (f) => f;
}

export class Overlay {
  root: HTMLElement;
  tl: gsap.core.Timeline;
  private positioned: HTMLElement[];
  private mobilePositioned: HTMLElement[];
  private waves: HTMLElement | null;
  private pager: HTMLElement[];

  constructor(private stage: Stage) {
    this.root = document.getElementById('overlay') as HTMLElement;
    this.positioned = [...this.root.querySelectorAll<HTMLElement>('[data-x]')];
    this.mobilePositioned = MOBILE ? [...this.root.querySelectorAll<HTMLElement>('[data-mx]')] : [];
    this.waves = this.root.querySelector('#waves');
    this.pager = [...document.querySelectorAll<HTMLElement>('[data-pager]')];
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
      const fin = rawIn < 0 ? rawIn : conv(rawIn), fout = conv(+el.dataset.out!);
      const tIn = frameToT(fin), tOut = frameToT(fout);
      const dIn = Math.max(0.004, frameToT(fin + 0.5) - tIn);
      const dOut = Math.max(0.004, frameToT(fout + 0.28) - tOut);
      const dir = el.dataset.dir ?? 'up';
      const from = dir === 'up' ? { y: 26 } : dir === 'left' ? { x: -26 } : { scale: 0.96 };
      if (fin < 0) {
        gsap.set(el, { autoAlpha: 1 });
      } else {
        gsap.set(el, { autoAlpha: 0, ...from });
        tl.to(el, { autoAlpha: 1, x: 0, y: 0, scale: 1, duration: dIn, ease: 'power3.out' }, tIn);
      }
      tl.to(el, { autoAlpha: 0, y: dir === 'up' ? -18 : 0, duration: dOut, ease: 'power2.in' }, tOut);
    });
    // зафиксировать длительность ровно 1
    tl.set({}, {}, 1);
    return tl;
  }

  intro() {
    // десктоп: первый экран — чистый кадр 01, заголовок и плашки приходят со скроллом;
    // мобильный: кадр 01 уже с заголовком и первой плашкой
    this.root.classList.add('is-live');
  }

  update(t: number) {
    this.tl.progress(t);
    const f = tToFrame(t);

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
