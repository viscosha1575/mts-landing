/**
 * Пошаговое листание мобильной раскадровки.
 *
 * На телефоне сцена не привязана к скроллу: она занимает весь экран, страница под ней стоит,
 * а тап или свайп доводит прогресс t до следующей остановки. Промежуточные кадры (наезды,
 * смена неба, отъезд камеры) проигрываются сами по дороге между остановками.
 * После последней остановки следующий жест отпускает страницу — дальше обычный скролл к разделам.
 */
import gsap from 'gsap';
import { TOTAL_WEIGHT, frameToT, legacyFrame as o } from './timeline';

/**
 * Остановки — кадры мобильного таймлайна, на которых текст полностью проявлен:
 * по одной на каждую плашку локаций 01–03 и по одной на заголовок локаций 04–07.
 */
export const STOPS = [
  0, 1.55, 2.55,
  8.55, 9.55, 10.55,
  17.55, 18.55, 19.55, 20.55,
  o(24) + 0.4, o(32) + 0.4, o(36) + 0.4, o(40) + 0.4,
];

interface Options {
  /** без анимации (prefers-reduced-motion) */
  instant: boolean;
  /** жест «дальше» на последней остановке: отпустить страницу */
  onExit(): void;
}

export class Stepper {
  /** прогресс сцены 0…1 — его читает главный цикл */
  t = 0;
  index = 0;
  /** сцена держит экран и принимает жесты; false — страница скроллится обычным образом */
  locked = true;
  private tween?: gsap.core.Tween;
  private wheelAt = 0;

  constructor(el: HTMLElement, private opts: Options) {
    let start: { x: number; y: number; at: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      // тап мимо открытого меню шапки только закрывает его
      const busy = !this.locked || !e.isPrimary || e.button !== 0 || document.documentElement.dataset.menu === 'open';
      start = busy ? null : { x: e.clientX, y: e.clientY, at: performance.now() };
    });
    el.addEventListener('pointercancel', () => { start = null; });
    el.addEventListener('pointerup', (e) => {
      if (!start || !this.locked) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y, held = performance.now() - start.at;
      start = null;
      const dist = Math.hypot(dx, dy);
      // тап — дальше
      if (dist < 12) { if (held < 600) this.next(); return; }
      if (dist < 36) return;
      // свайп вверх или влево — дальше, вниз или вправо — назад
      const forward = Math.abs(dy) >= Math.abs(dx) ? dy < 0 : dx < 0;
      if (forward) this.next(); else this.prev();
    });

    // колесо и клавиатура — для узкого окна на компьютере
    addEventListener('wheel', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      const now = performance.now();
      if (Math.abs(e.deltaY) < 8 || now - this.wheelAt < 900) return;
      this.wheelAt = now;
      if (e.deltaY > 0) this.next(); else this.prev();
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (!this.locked || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      if (['ArrowDown', 'ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); this.next(); }
      else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); this.prev(); }
    });
    // страховка для браузеров, которые скроллят страницу, несмотря на touch-action
    document.addEventListener('touchmove', (e) => { if (this.locked) e.preventDefault(); }, { passive: false });
  }

  next() {
    if (this.index >= STOPS.length - 1) this.opts.onExit();
    else this.go(this.index + 1);
  }

  prev() {
    if (this.index > 0) this.go(this.index - 1);
  }

  /** Перейти к остановке. Длительность — по пути в весах кадров: смена плашки быстрая, перелёт между локациями дольше */
  go(index: number, immediate = false) {
    this.index = Math.max(0, Math.min(STOPS.length - 1, index));
    const to = frameToT(STOPS[this.index]);
    this.tween?.kill();
    if (immediate || this.opts.instant) { this.t = to; return; }
    const units = Math.abs(to - this.t) * TOTAL_WEIGHT;
    const duration = units <= 3 ? 0.8 : Math.min(3.6, 0.5 + 0.3 * units);
    this.tween = gsap.to(this, { t: to, duration, ease: units <= 3 ? 'power2.out' : 'power2.inOut' });
  }

  /** Поставить прогресс напрямую (отладка, renderAt) */
  set(t: number) {
    this.tween?.kill();
    this.t = t;
    let nearest = 0;
    STOPS.forEach((f, i) => { if (Math.abs(frameToT(f) - t) < Math.abs(frameToT(STOPS[nearest]) - t)) nearest = i; });
    this.index = nearest;
  }
}
