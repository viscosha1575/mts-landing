/**
 * Прокрутка сцены на телефоне без прокрутки страницы.
 *
 * Страница под сценой стоит: сцена ровно в экран, документ не сдвигается, и браузер не прячет адресную строку.
 * Прогресс ведёт палец — как при обычной прокрутке: потянул вверх — кадры ушли вперёд ровно на пройденный путь,
 * отпустил — докатываются по инерции, остановил палец — кадр стоит. В узком окне на компьютере то же делают
 * колесо, тачпад и клавиши. На последнем кадре движение «дальше» отпускает страницу (onExit): ниже — обычные
 * разделы с обычным скроллом.
 *
 * Плашки листаются по одной (2026-10-16: «нужно чтобы плашки свайпались по одной, но между сценами пролёт так же
 * зависел от свайпа»). У каждой плашки своя остановка (stops). Между плашками одной локации палец по-прежнему
 * ведёт сцену, но дальше соседней плашки за один жест не уводит, а отпущенная сцена доезжает до неё сама (или
 * возвращается, если жест был совсем коротким). Между локациями — пролёт как был: за пальцем и по инерции,
 * только инерция встаёт на ближайшей плашке и не проскакивает её.
 */

/** за сколько миллисекунд скорость инерции падает в e раз (как у системной прокрутки iOS: 0.998 за мс) */
const GLIDE_MS = 500;
/** окно, по которому меряется скорость пальца в момент отпускания, мс */
const FLICK_WINDOW = 90;
/** скорость, ниже которой отпускание — не бросок, и наибольшая скорость броска, px/с */
const FLICK_MIN = 60;
const FLICK_MAX = 7000;
/** короче этого (px) жест между плашками не листает: сцена возвращается к прежней плашке */
const STEP_MIN = 14;
/** доезд до соседней плашки — пружина без отскока: её собственная частота, рад/с (встаёт примерно за 0,6 с) */
const SNAP_OMEGA = 8;
/** колесо: пауза, после которой серия щелчков (или инерция тачпада) считается законченным жестом, мс */
const WHEEL_IDLE = 160;
/** сколько px нужно протянуть «дальше» на последнем кадре, чтобы страница отпустилась: пальцем и колесом */
const EXIT_PULL = 28;
const EXIT_WHEEL = 90;
/** путь, который дают клавиши: стрелки и пробел/PageDown, в долях экрана */
const KEY_STEP = 0.35;
const KEY_PAGE = 0.9;

/** остановка у плашки: прогресс и локация, которой плашка принадлежит */
export interface Stop { t: number; group: string }

interface Options {
  /** длина всего пути по сцене в px: столько нужно протянуть пальцем от первого кадра до последнего */
  length(): number;
  /** остановки у плашек по возрастанию t */
  stops?: Stop[];
  /** движение «дальше» на последнем кадре: отпустить страницу */
  onExit(): void;
}

export class Scrubber {
  /** прогресс сцены 0…1 — его читает главный цикл */
  t = 0;
  /** сцена держит экран и принимает жесты; false — страница скроллится обычным образом */
  locked = true;
  /** скорость инерции, px/с */
  private vel = 0;
  /** до какого прогресса докатывается инерция: ближайшая плашка по ходу */
  private limit = 1;
  /** доезд до плашки: куда (null — не едем) и скорость, px/с */
  private snap: number | null = null;
  private snapVel = 0;
  /** жест (палец или серия щелчков колеса): с какого прогресса начался и в каких пределах может водить сцену */
  private anchor = 0;
  private range: [number, number] = [0, 1];
  /** колесо крутят: когда пришёл последний щелчок */
  private wheelAt = 0;
  /** палец на экране: его id, прошлое положение и недавние точки — по ним считается скорость броска */
  private touch: { id: number; y: number; trail: { y: number; at: number }[] } | null = null;
  /** путь, набранный жестом «дальше» на последнем кадре */
  private pull = 0;
  /** палец дотянул «дальше» на последнем кадре: страница отпустится, когда он оторвётся от экрана */
  private exiting = false;
  /** до этого момента «дальше» страницу не отпускает: сцена только что взяла экран, это хвост прежнего жеста */
  private quietUntil = 0;
  private stops: Stop[];

  constructor(el: HTMLElement, private opts: Options) {
    this.stops = opts.stops ?? [];
    const menuOpen = () => document.documentElement.dataset.menu === 'open';

    el.addEventListener('touchstart', (e) => {
      if (!this.locked || this.touch || menuOpen()) return;
      const p = e.changedTouches[0];
      // палец ловит сцену на ходу: инерция и доезд гаснут
      this.begin();
      this.pull = 0;
      this.touch = { id: p.identifier, y: p.clientY, trail: [{ y: p.clientY, at: e.timeStamp }] };
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (!this.locked || !this.touch) return;
      const p = [...e.changedTouches].find((c) => c.identifier === this.touch!.id);
      if (!p) return;
      e.preventDefault();
      const dy = this.touch.y - p.clientY;
      this.touch.y = p.clientY;
      this.touch.trail.push({ y: p.clientY, at: e.timeStamp });
      while (this.touch.trail.length > 2 && e.timeStamp - this.touch.trail[0].at > FLICK_WINDOW) this.touch.trail.shift();
      this.move(dy, EXIT_PULL);
    }, { passive: false });

    const release = (e: TouchEvent) => {
      if (!this.touch || ![...e.changedTouches].some((c) => c.identifier === this.touch!.id)) return;
      const trail = this.touch.trail, a = trail[0], b = trail[trail.length - 1];
      this.touch = null;
      if (this.exiting) {
        this.exiting = false;
        this.pull = 0;
        // после того как событие обойдёт всех слушателей: Lenis на отрыв пальца останавливает свою прокрутку
        setTimeout(() => { if (this.locked) this.opts.onExit(); }, 0);
        return;
      }
      // бросок: скорость пальца за последние мгновения; палец, который перед отпусканием стоял, сцену не толкает
      const dt = b.at - a.at;
      const v = dt > 0 && e.timeStamp - b.at < FLICK_WINDOW ? ((a.y - b.y) / dt) * 1000 : 0;
      if (this.locked) this.settle(Math.abs(v) >= FLICK_MIN ? Math.max(-FLICK_MAX, Math.min(FLICK_MAX, v)) : 0);
    };
    el.addEventListener('touchend', release, { passive: true });
    el.addEventListener('touchcancel', release, { passive: true });

    // Колесо и тачпад (узкое окно на компьютере): страница тоже стоит, дельта идёт в прогресс. Серия щелчков
    // (и инерция тачпада) — один жест: плашки и с колеса листаются по одной
    addEventListener('wheel', (e) => {
      // масштаб страницы (Ctrl/⌘ + колесо, щипок) и горизонтальные жесты оставляем браузеру
      if (!this.locked || e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (!this.wheelAt) this.begin();
      this.wheelAt = performance.now();
      // строки и страницы (Firefox, часть мышей) → px
      this.move(e.deltaY * (e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? innerHeight : 1), EXIT_WHEEL);
    }, { passive: false });

    addEventListener('keydown', (e) => {
      if (!this.locked || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]'))) return;
      const dir = ['ArrowDown', 'ArrowRight', 'PageDown', ' '].includes(e.key) ? 1 : ['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key) ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      if (dir > 0 && this.t >= 1) { this.opts.onExit(); return; }
      // между плашками локации — на соседнюю плашку; в пролёте — толчок такой силы, чтобы по инерции пройти
      // нужный путь (не дальше ближайшей плашки)
      const from = this.snap ?? this.t;
      this.begin();
      const path = innerHeight * (e.key.startsWith('Arrow') ? KEY_STEP : KEY_PAGE);
      const [a, b] = this.around(from + dir * 1e-4);
      const to = dir > 0 ? b : a;
      if (a && b && a.group === b.group && to) { this.snap = to.t; this.snapVel = 0; return; }
      this.vel = (dir * path * 1000) / GLIDE_MS;
      this.limit = dir > 0 ? (b?.t ?? 1) : (a?.t ?? 0);
    });

    // страховка для браузеров, которые скроллят страницу, несмотря на touch-action
    document.addEventListener('touchmove', (e) => { if (this.locked && !menuOpen()) e.preventDefault(); }, { passive: false });
  }

  /** идёт ли сцена: её тянут, она докатывается или доезжает до плашки */
  get moving() {
    return !!this.touch || this.vel !== 0 || this.snap !== null || !!this.wheelAt;
  }

  /**
   * Остановки по обе стороны прогресса t: последняя не дальше t и первая после него (null — их там нет).
   * Стоящий ровно на остановке считается на ней.
   */
  private around(t: number): [Stop | null, Stop | null] {
    let a: Stop | null = null, b: Stop | null = null;
    for (const s of this.stops) {
      if (s.t <= t + 1e-6) a = s;
      else { b = s; break; }
    }
    return [a, b];
  }

  /**
   * Начало жеста: инерция и доезд гаснут, жест может увести сцену не дальше соседних остановок — с плашки на
   * следующую или предыдущую, из пролёта — до плашек по его краям.
   */
  private begin() {
    // сцена ещё доезжает до плашки — жест считается с неё: следующий свайп листает дальше, а не дотягивает
    // оставшиеся доли пикселя
    const at = this.snap ?? this.t;
    this.vel = 0;
    this.snap = null;
    this.anchor = this.t;
    const k = this.stopAt(at);
    if (k >= 0) this.range = [this.stops[k - 1]?.t ?? 0, this.stops[k + 1]?.t ?? 1];
    else { const [a, b] = this.around(at); this.range = [a?.t ?? 0, b?.t ?? 1]; }
  }

  /** номер остановки, на которой стоит прогресс t (с точностью до пикселя), или -1 */
  private stopAt(t: number) {
    const len = this.opts.length();
    return this.stops.findIndex((s) => Math.abs(s.t - t) * len < 1);
  }

  /**
   * Жест закончился, v — скорость броска (px/с, 0 — отпустили без броска). Между плашками одной локации сцена
   * доезжает до соседней плашки в сторону жеста (короткий жест — обратно); в пролёте — инерция до ближайшей плашки.
   */
  private settle(v: number) {
    const k = this.stopAt(this.t);
    if (k >= 0) { this.t = this.stops[k].t; this.vel = 0; return; }
    const [a, b] = this.around(this.t);
    if (a && b && a.group === b.group) {
      const moved = (this.t - this.anchor) * this.opts.length();
      const dir = v !== 0 ? Math.sign(v) : Math.abs(moved) >= STEP_MIN ? Math.sign(moved) : 0;
      this.snap = dir > 0 ? b.t : dir < 0 ? a.t : (this.t - a.t < b.t - this.t ? a.t : b.t);
      // доезд подхватывает скорость пальца, если она направлена к цели
      this.snapVel = Math.sign(this.snap - this.t) === Math.sign(v) ? v : 0;
      return;
    }
    this.vel = v;
    this.limit = v > 0 ? (b?.t ?? 1) : (a?.t ?? 0);
  }

  /**
   * Сдвинуть прогресс на путь в px. На последнем кадре путь «дальше» копится и, набрав `exit`, отпускает страницу:
   * колесо и клавиши — сразу, палец — когда оторвётся от экрана (пока он на экране, страница к разделам не поедет:
   * её прокрутку браузер и Lenis отдают пальцу).
   */
  private move(px: number, exit: number) {
    if (this.t >= 1 && px > 0) {
      if (performance.now() < this.quietUntil) return;
      this.pull += px;
      if (this.pull < exit) return;
      if (this.touch) { this.exiting = true; return; }
      this.pull = 0;
      this.vel = 0;
      this.wheelAt = 0;
      this.opts.onExit();
      return;
    }
    // потянули назад — передумали уходить
    this.pull = 0;
    this.exiting = false;
    const [lo, hi] = this.range;
    this.t = Math.max(lo, Math.min(hi, this.t + px / this.opts.length()));
  }

  /** Кадр главного цикла: конец серии щелчков колеса, доезд до плашки, инерция после броска */
  update(dt: number) {
    if (!this.locked || this.touch) return;
    if (this.wheelAt && performance.now() - this.wheelAt > WHEEL_IDLE) {
      this.wheelAt = 0;
      this.settle(0);
    }
    const len = this.opts.length();
    if (this.snap !== null) {
      // критически затухающая пружина: разгоняется от скорости пальца и встаёт на плашке без отскока
      const s = Math.min(dt, 50) / 1000, x = (this.t - this.snap) * len;
      this.snapVel += (-SNAP_OMEGA * SNAP_OMEGA * x - 2 * SNAP_OMEGA * this.snapVel) * s;
      const next = this.t + (this.snapVel * s) / len;
      // не проезжает плашку
      this.t = (next - this.snap) * (this.t - this.snap) <= 0 ? this.snap : next;
      if (this.t === this.snap || (Math.abs(x) < 1 && Math.abs(this.snapVel) < 30)) { this.t = this.snap; this.snap = null; this.snapVel = 0; }
      return;
    }
    if (!this.vel) return;
    this.t += (this.vel * dt) / 1000 / len;
    this.vel *= Math.exp(-dt / GLIDE_MS);
    // докатилась, дошла до плашки или упёрлась в край
    if ((this.vel > 0 && this.t >= this.limit) || (this.vel < 0 && this.t <= this.limit)) { this.t = this.limit; this.vel = 0; }
    if (Math.abs(this.vel) < 6 || this.t <= 0 || this.t >= 1) this.vel = 0;
    this.t = Math.max(0, Math.min(1, this.t));
  }

  /** Сцена снова берёт экран. Хвост жеста, которым до неё докрутили, страницу обратно не отпускает */
  hold() {
    this.locked = true;
    this.vel = 0;
    this.snap = null;
    this.wheelAt = 0;
    this.pull = 0;
    this.exiting = false;
    this.touch = null;
    this.range = [0, 1];
    this.quietUntil = performance.now() + 500;
  }

  /** Сцена отпускает экран: страница скроллится сама */
  release() {
    this.locked = false;
    this.vel = 0;
    this.snap = null;
    this.wheelAt = 0;
    this.touch = null;
  }

  /** Поставить прогресс напрямую (возврат к началу, отладка) */
  set(t: number) {
    this.t = Math.max(0, Math.min(1, t));
    this.vel = 0;
    this.snap = null;
    this.range = [0, 1];
  }
}
