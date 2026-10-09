/**
 * Точка входа сценария. Связывает прогресс t → WebGL-сцену и DOM-оверлей.
 *
 * Десктоп и планшет: сцену ведёт скролл. Секция высотой в десятки экранов, вьюпорт сцены в ней липкий,
 * t — доля прокрутки секции. Чем дальше прокрутили, тем дальше ушли кадры; остановили прокрутку — кадр
 * стоит. Сама сцена ничего не доигрывает: Lenis только сглаживает колесо.
 * Телефон: секция ровно в экран, страница под сценой стоит, а тап или свайп проигрывает переход
 * к следующей остановке (stepper.ts). После последней остановки страница отпускается.
 */
import Lenis from 'lenis';
import gsap from 'gsap';
import { Stage } from './webgl/Stage';
import { Overlay } from './overlay';
import { Bokeh } from './bokeh';
import { Stepper } from './stepper';
import { MOBILE_QUERY, STEPPED, TOTAL_WEIGHT, VARIANT, tToFrame, frameToT } from './timeline';

const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isTouch = matchMedia('(pointer: coarse)').matches;

/**
 * Длина прокрутки на единицу веса кадра, в процентах высоты экрана. Кадр-заголовок с текстом держится
 * около экрана прокрутки, переход между локациями — два-три. Пальцем прокрутка короче, чем колесом.
 */
const VH_PER_UNIT = isTouch ? 28 : 34;
/** догон прогресса за скроллом, доля за кадр при 60 fps */
const FOLLOW = 0.35;

export function boot() {
  const root = document.getElementById('experience') as HTMLElement;
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const fx = document.getElementById('fx') as HTMLCanvasElement;
  const loader = document.getElementById('loader') as HTMLElement;
  const loaderBar = loader.querySelector<HTMLElement>('[data-bar]')!;
  const loaderNum = loader.querySelector<HTMLElement>('[data-num]')!;
  const header = document.getElementById('header') as HTMLElement;
  const debug = document.getElementById('debug');
  const html = document.documentElement;

  // высота секции под скролл: путь по сцене и экран, на котором вьюпорт сцены стоит в её конце
  if (!STEPPED) root.style.height = `${Math.round(TOTAL_WEIGHT * VH_PER_UNIT) + 100}vh`;

  // качество текстур: большие только на больших экранах с нормальным GPU
  const bigScreen = Math.max(innerWidth, innerHeight) * Math.min(devicePixelRatio, 2) > 2200;
  const quality: 'xl' | 'md' = bigScreen && !isTouch ? 'xl' : 'md';

  const stage = new Stage({
    canvas, quality, still: prefersReduced,
    onProgress: (n, total) => {
      const p = n / total;
      loaderBar.style.transform = `scaleX(${p})`;
      loaderNum.textContent = String(Math.round(p * 100)).padStart(3, '0');
    },
  });
  const overlay = new Overlay(stage);
  const bokeh = new Bokeh(fx, stage);

  // раскадровка выбирается при загрузке: если экран перешёл границу (поворот телефона, окно) — собираем заново
  matchMedia(MOBILE_QUERY).addEventListener('change', (e) => {
    if ((e.matches ? 'mobile' : 'desktop') !== VARIANT) location.reload();
  });

  // ───────── скролл ─────────
  // Колесо и тачпад сглаживает Lenis: сцена идёт за прокруткой ровно и встаёт вместе с ней.
  // Пальцем страница скроллится нативно.
  const lenis = new Lenis({
    lerp: prefersReduced ? 1 : 0.1,
    smoothWheel: true,
    syncTouch: false,
    wheelMultiplier: 0.9,
  });
  let scrollY = window.scrollY;
  lenis.on('scroll', (e: { scroll: number }) => { scrollY = e.scroll; });
  lenis.stop(); // пока грузимся
  /** путь прокрутки, на котором вьюпорт сцены стоит на экране */
  const range = () => Math.max(1, root.offsetHeight - innerHeight);

  // ───────── телефон: листание шагами ─────────
  // Пока сцена держит экран, страница стоит (Lenis остановлен, жесты забирает Stepper).
  // После последней остановки страница отпускается; вернулись к самому верху — сцена снова берёт экран.
  let armed = false;   // страница уходила от верха
  let restart = false; // при возврате начать с первой остановки (логотип, кнопка «наверх»)
  const leaveScene = (to: number | HTMLElement) => {
    if (!stepper) return;
    stepper.locked = false;
    html.classList.remove('is-stepping');
    lenis.start();
    lenis.scrollTo(to, { duration: 1.1 });
  };
  const holdScene = () => {
    if (!stepper) return;
    stepper.hold();
    armed = false;
    lenis.stop();
    scrollTo(0, 0);
    html.classList.add('is-stepping');
    if (restart) { restart = false; stage.cut(); stepper.go(0, true); }
  };
  const stepper = STEPPED
    ? new Stepper(root, { instant: prefersReduced, onExit: () => leaveScene(root.offsetTop + root.offsetHeight) })
    : null;
  if (stepper) { history.scrollRestoration = 'manual'; holdScene(); }
  addEventListener('scroll', () => {
    if (!stepper) {
      // пока Lenis стоит (загрузка), позицию двигает только браузер: восстановил её после перезагрузки
      if (lenis.isStopped) scrollY = window.scrollY;
      return;
    }
    // возврат к сцене ловим по нативному скроллу: он приходит и тогда, когда Lenis занят своей анимацией
    scrollY = window.scrollY;
    if (stepper.locked) return;
    if (scrollY > 24) armed = true;
    else if (armed && scrollY <= 0.5) holdScene();
  }, { passive: true });

  // ───────── мышь ─────────
  if (!isTouch && !prefersReduced) {
    addEventListener('pointermove', (e) => {
      stage.pointer.x = (e.clientX / innerWidth) * 2 - 1;
      stage.pointer.y = (e.clientY / innerHeight) * 2 - 1;
    }, { passive: true });
  }

  // ───────── resize ─────────
  let resizeTimer = 0;
  const onResize = () => {
    stage.resize();
    overlay.resize();
    bokeh.resize();
  };
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(onResize, 80); });
  onResize();
  // высота текстовых блоков меняется после подгрузки шрифтов
  document.fonts?.ready.then(onResize);
  addEventListener('load', onResize);

  // ───────── главный цикл ─────────
  /** прогресс сцены 0…1: в скролле идёт за прокруткой, на телефоне его ведёт степпер */
  let t = 0;
  let live = false; // загрузчик ушёл, сцену видно
  let last = 0;
  let slow = 0; // подряд идущие медленные кадры во время движения

  const tick = (time: number) => {
    const dt = last ? time - last : 16;
    last = time;
    lenis.raf(time);
    const top = root.offsetTop;
    let moving: boolean;
    // сцена держит экран: на телефоне — пока листается, в скролле — пока её вьюпорт прилип
    let held: boolean;
    if (stepper) {
      t = stepper.t;
      moving = stepper.moving;
      held = stepper.locked;
    } else {
      const target = Math.max(0, Math.min(1, (scrollY - top) / range()));
      const from = t;
      // Lenis уже сгладил колесо; догон убирает ступеньки там, где его нет: палец, полоса прокрутки, клавиши.
      // Под загрузчиком догонять нечего — встаём сразу туда, где браузер восстановил страницу.
      t += (target - t) * (live && !prefersReduced ? 1 - Math.pow(1 - FOLLOW, dt / 16.7) : 1);
      if (Math.abs(target - t) < 1e-6) t = target;
      if (!live) stage.cut();
      moving = Math.abs(t - from) > 1e-6;
      held = scrollY <= top + range() + 1;
    }

    const inView = scrollY < top + root.offsetHeight + innerHeight;
    if (inView) {
      const t0 = performance.now();
      stage.render(t);
      const t1 = performance.now();
      overlay.update(t, held);
      const t2 = performance.now();
      bokeh.update(t);
      const t3 = performance.now();
      if (import.meta.env.DEV && (t3 - t0) > 30) console.warn(`[perf] render ${(t1 - t0).toFixed(1)}ms overlay ${(t2 - t1).toFixed(1)}ms bokeh ${(t3 - t2).toFixed(1)}ms`);
    }

    if (moving) {
      // Кадры не успевают (слабая видеокарта, 4K) — понижаем плотность пикселей канваса:
      // чуть более мягкая картинка лучше дёрганого движения.
      slow = dt > 24 && dt < 200 ? slow + 1 : 0;
      if (slow > 30 && stage.dpr > 1) { stage.setDpr(Math.max(1, stage.dpr - 0.5)); slow = 0; }
    } else if (stage.ready) {
      // Сцена стоит: заливаем в видеопамять текстуры следующих локаций, по одной за кадр,
      // чтобы их первое появление не давало рывка
      stage.warm();
    }

    // шапка: над сценой светлая, как в макете, на странице ниже — тёмная
    const f = tToFrame(t);
    const past = scrollY > top + root.offsetHeight - innerHeight * 0.5;
    header.dataset.theme = past ? 'page' : 'light';
    if (debug) debug.textContent = `t ${t.toFixed(3)}  f ${f.toFixed(2)}  ${stage.width}×${stage.height} ${quality} dpr ${stage.dpr}`;

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ───────── загрузка и интро ─────────
  stage.load().catch((err) => console.error('[stage] load', err));
  const waitReady = () => new Promise<void>((res) => {
    const check = () => (stage.ready ? res() : setTimeout(check, 50));
    check();
  });
  waitReady().then(() => {
    live = true;
    const tl = gsap.timeline({ onComplete: () => { loader.remove(); if (!stepper) lenis.start(); } });
    tl.to(loader.querySelector('[data-inner]'), { autoAlpha: 0, y: -12, duration: 0.5, ease: 'power2.in' })
      .to(loader, { yPercent: -100, duration: 0.9, ease: 'expo.inOut' }, '-=0.1')
      .add(() => overlay.intro(), '-=0.6');
    html.classList.add('is-ready');
  });

  /** поставить прогресс скачком: в скролле — саму страницу в нужное место */
  const jump = (tt: number) => {
    stage.cut();
    t = tt;
    if (stepper) { stepper.set(tt); return; }
    scrollY = root.offsetTop + tt * range();
    lenis.scrollTo(scrollY, { immediate: true, force: true });
  };
  /** dev: синхронно отрисовать кадр (для скриншотов и отладки) */
  const renderAt = (f: number) => {
    const tt = frameToT(f);
    jump(tt);
    stage.pointerSmooth = { x: 0, y: 0 };
    stage.render(tt); overlay.update(tt); bokeh.update(tt);
    return tToFrame(tt);
  };
  const goto = (f: number) => jump(frameToT(f));
  /** dev: отрисовать текущий прогресс вне главного цикла (покадровая съёмка по своим часам) */
  const draw = (now?: number) => { stage.render(t, now); overlay.update(t); bokeh.update(t); };
  /** к началу: на телефоне это первая остановка сцены, а не просто верх страницы */
  const toStart = (duration: number) => {
    if (stepper?.locked) { stage.cut(); stepper.go(0, true); return; }
    if (stepper) restart = true;
    lenis.scrollTo(0, { duration });
  };
  // якоря шапки — через Lenis
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href')!;
      const target = document.querySelector<HTMLElement>(href);
      if (!target) return;
      e.preventDefault();
      if (href === '#top') toStart(1.4);
      else if (stepper?.locked) leaveScene(target);
      else lenis.scrollTo(target, { offset: 0, duration: 1.4 });
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-scroll-top]').forEach((b) => b.addEventListener('click', () => toStart(1.6)));

  return { lenis, stage, overlay, stepper, goto, renderAt, draw, progress: () => t };
}
