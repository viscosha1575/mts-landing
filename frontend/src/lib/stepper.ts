/**
 * Пошаговое листание мобильной раскадровки.
 *
 * На телефоне сцена не привязана к скроллу: она занимает весь экран, страница под ней стоит, а тап
 * или свайп доводит прогресс t до следующей остановки. Переход проигрывается сам — наезды, смена
 * неба, отъезд камеры идут с ровным темпом. На десктопе и планшете сцену ведёт скролл (app.ts).
 * После последней остановки следующий жест отпускает страницу — дальше обычный скролл к разделам.
 */
import gsap from 'gsap';
import { D, MOBILE_TIPS, OUTRO_FRAME, STOP_AT, TOTAL_WEIGHT, frameToT } from './timeline';

/**
 * Остановки — кадры мобильного таймлайна, на которых текст полностью проявлен: первый экран, по одной
 * на каждую плашку (у квартиры — на заголовок) и финал.
 */
export const STOPS = [0, ...MOBILE_TIPS.slice(1).map((f) => f + 0.55), D(OUTRO_FRAME) + STOP_AT];

/** пауза между событиями колеса, после которой начинается новый жест, мс */
const WHEEL_REST = 180;
/** одно событие от такой дельты — уже жест: щелчок колеса мыши (в Chrome на macOS — 4 px), движение по тачпаду */
const WHEEL_EVENT = 4;
/** путь, который набирает медленный жест из мелких дельт, px */
const WHEEL_TRAVEL = 16;

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
  /** до этого момента новые жесты не принимаются: переход должен успеть разыграться */
  private busyUntil = 0;
  /** время последнего события колеса */
  private wheelAt = 0;
  /** путь, набранный в текущем жесте, px */
  private wheelSum = 0;
  /** жест уже дал шаг — его остаток и инерция не считаются */
  private wheelDone = false;
  /** наименьшая дельта после шага: новый толчок узнаём по росту от неё */
  private wheelLow = 0;

  constructor(el: HTMLElement, private opts: Options) {
    // Тап и свайп — для пальца и пера. Мышью сцену не листаем: клик и выделение текста остаются обычными.
    let start: { x: number; y: number; at: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      // тап мимо открытого меню шапки только закрывает его
      const skip = !this.locked || !e.isPrimary || e.pointerType === 'mouse' || document.documentElement.dataset.menu === 'open';
      start = skip ? null : { x: e.clientX, y: e.clientY, at: performance.now() };
    });
    el.addEventListener('pointercancel', () => { start = null; });
    el.addEventListener('pointerup', (e) => {
      if (!start || !this.locked) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y, held = performance.now() - start.at;
      start = null;
      const dist = Math.hypot(dx, dy);
      // тап — дальше
      if (dist < 12) { if (held < 600) this.step(1); return; }
      if (dist < 36) return;
      // свайп вверх или влево — дальше, вниз или вправо — назад
      const forward = Math.abs(dy) >= Math.abs(dx) ? dy < 0 : dx < 0;
      this.step(forward ? 1 : -1);
    });

    // Колесо и тачпад (узкое окно на компьютере): один жест — один шаг. Жест начинается с мелких дельт (тачпад — с 1–2 px, первый
    // щелчок колеса — 4 px), поэтому шаг даёт либо заметное событие, либо набранный путь. После шага
    // остаток жеста и хвост инерции (тачпад шлёт события ещё секунду-полторы) не считаются; новый жест —
    // это события после паузы или новый толчок: дельта заметно выросла, хотя в хвосте она только убывает.
    addEventListener('wheel', (e) => {
      // масштаб страницы (Ctrl/⌘ + колесо, щипок) и горизонтальные жесты оставляем браузеру
      if (!this.locked || e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      // время события, а не обработки: если кадр затянулся, события приходят пачкой, и паузы между ними теряются
      const now = e.timeStamp > 0 && e.timeStamp < 1e12 ? e.timeStamp : performance.now();
      // строки и страницы (Firefox, часть мышей) → px
      const delta = e.deltaY * (e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? innerHeight : 1);
      const power = Math.abs(delta);
      if (now - this.wheelAt > WHEEL_REST) {
        this.wheelSum = 0; this.wheelDone = false;
      } else if (this.wheelDone) {
        if (power >= WHEEL_EVENT + 2 && power > this.wheelLow * 3) { this.wheelSum = 0; this.wheelDone = false; }
        else this.wheelLow = Math.min(this.wheelLow, power);
      }
      this.wheelAt = now;
      if (this.wheelDone) return;
      // сменили направление посреди жеста — путь считается заново
      if (this.wheelSum * delta < 0) this.wheelSum = 0;
      this.wheelSum += delta;
      if (power < WHEEL_EVENT && Math.abs(this.wheelSum) < WHEEL_TRAVEL) return;
      this.wheelDone = true;
      this.wheelLow = power;
      this.step(this.wheelSum > 0 ? 1 : -1);
    }, { passive: false });

    addEventListener('keydown', (e) => {
      if (!this.locked || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]'))) return;
      if (['ArrowDown', 'ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); this.step(1); }
      else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); this.step(-1); }
    });
    // страховка для браузеров, которые скроллят страницу, несмотря на touch-action
    document.addEventListener('touchmove', (e) => { if (this.locked) e.preventDefault(); }, { passive: false });
  }

  /** идёт ли сейчас переход между остановками */
  get moving() {
    return !!this.tween?.isActive();
  }

  /** Сцена снова берёт экран. Хвост инерции скролла, которым до неё докрутили, шагом не считается */
  hold() {
    this.locked = true;
    this.busyUntil = performance.now() + 500;
    this.wheelAt = performance.now();
    this.wheelDone = true;
    this.wheelLow = Infinity;
  }

  /** Жест: шаг вперёд или назад. Пока переход не разыгрался больше чем наполовину, новый жест не принимается */
  private step(dir: 1 | -1) {
    if (performance.now() < this.busyUntil) return;
    if (dir > 0 && this.index >= STOPS.length - 1) this.opts.onExit();
    else this.go(this.index + dir);
  }

  /**
   * Перейти к остановке. Длительность — по пути в весах кадров: появление текста и смена плашки
   * быстрые, перелёт между локациями идёт несколько секунд.
   */
  go(index: number, immediate = false) {
    this.index = Math.max(0, Math.min(STOPS.length - 1, index));
    const to = frameToT(STOPS[this.index]);
    this.tween?.kill();
    if (immediate || this.opts.instant) { this.t = to; return; }
    const units = Math.abs(to - this.t) * TOTAL_WEIGHT;
    if (units < 1e-4) return;
    const short = units <= 3.5;
    const duration = short ? 0.9 : Math.min(5, 0.6 + 0.36 * units);
    this.busyUntil = performance.now() + Math.max(450, duration * 550);
    // длинный перелёт — с мягким разгоном и торможением: внутри него темп задают веса кадров
    this.tween = gsap.to(this, { t: to, duration, ease: short ? 'power2.out' : 'sine.inOut' });
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
