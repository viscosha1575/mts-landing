/**
 * DOM-оверлей поверх WebGL: заголовки локаций, плашки, волны у антенн, логотип при зуме,
 * подсказка скролла. Всё, что «по материалам делаем кодом».
 *
 * Оверлей живёт в координатах фрейма Figma (1479×832), вписанного в экран по cover — ровно как
 * screen-слои в WebGL, поэтому плашки и волны совпадают с картинкой на любом экране.
 */
import gsap from 'gsap';
import type { Stage } from './webgl/Stage';
import { frameToT, sampleNumber, sampleRect, tToFrame, type Key, type Rect } from './timeline';

const WAVES_TRACK: Key<Rect>[] = [
  { f: 0, v: [924, 61, 453, 431] },
  { f: 1, v: [880, 17, 541, 514] },
  { f: 2.2, v: [880, 17, 541, 514] },
  { f: 3, v: [820, -80, 700, 660] },
];
const WAVES_ALPHA: Key<number>[] = [{ f: 0, v: 1 }, { f: 2.3, v: 1 }, { f: 3, v: 0 }];

const TETHER_RECT: Rect = [740, 459, 847, 213];
const TETHER_ALPHA: Key<number>[] = [{ f: 8.6, v: 0 }, { f: 9.1, v: 1 }, { f: 9.8, v: 1 }, { f: 10.3, v: 0 }];

export class Overlay {
  root: HTMLElement;
  tl: gsap.core.Timeline;
  private positioned: HTMLElement[];
  private waves: HTMLElement | null;
  private tether: HTMLElement | null;
  private pager: HTMLElement[];

  constructor(private stage: Stage) {
    this.root = document.getElementById('overlay') as HTMLElement;
    this.positioned = [...this.root.querySelectorAll<HTMLElement>('[data-x]')];
    this.waves = this.root.querySelector('#waves');
    this.tether = this.root.querySelector('#tether');
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
    this.root.style.setProperty('--ui', String(Math.min(scale, W / 1479)));
    const pad = 16;
    for (const el of this.positioned) {
      const x = +el.dataset.x!, y = +el.dataset.y!;
      if (el.dataset.safe !== undefined) {
        // заголовки: отступы от вьюпорта, а не от обрезанного кадра; центр блока — на высоте y макета
        // (центрируем расчётом, а не transform: его перезаписывает GSAP)
        el.style.left = `${x * (W / 1479)}px`;
        el.style.top = `${H / 2 + (y - 416) * (H / 832) - el.offsetHeight / 2}px`;
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
  }

  private place(el: HTMLElement, r: Rect) {
    const { scale, ox, oy } = this.stage.refTransform();
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
      const fin = +el.dataset.in!, fout = +el.dataset.out!;
      const tIn = frameToT(fin), tOut = frameToT(fout);
      const dIn = Math.max(0.004, frameToT(fin + 0.5) - tIn);
      const dOut = Math.max(0.004, frameToT(fout + 0.28) - tOut);
      const dir = el.dataset.dir ?? 'up';
      const from = dir === 'up' ? { y: 26 } : dir === 'left' ? { x: -26 } : { scale: 0.96 };
      if (fin < 0) {
        // видно с самого начала (первая локация): интро делает Overlay.intro()
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
    // первый экран — чистый кадр 01: заголовок и плашки приходят только со скроллом
    this.root.classList.add('is-live');
  }

  update(t: number) {
    this.tl.progress(t);
    const f = tToFrame(t);

    if (this.waves) {
      const a = sampleNumber(WAVES_ALPHA, t);
      this.waves.style.opacity = String(a * 0.9);
      if (a > 0) this.place(this.waves, sampleRect(WAVES_TRACK, t));
    }
    if (this.tether) {
      const a = sampleNumber(TETHER_ALPHA, t);
      this.tether.style.opacity = String(a);
      if (a > 0) this.place(this.tether, TETHER_RECT);
    }
    // пагинация: активная локация по текущему кадру
    const bounds = [0, 5.5, 13.5, 21.5, 28.5, 33.5, 37];
    let active = 0;
    for (let i = 0; i < bounds.length; i++) if (f >= bounds[i]) active = i;
    this.pager.forEach((p) => {
      const dots = p.children;
      for (let i = 0; i < dots.length; i++) (dots[i] as HTMLElement).classList.toggle('is-active', i === active);
    });
  }
}
