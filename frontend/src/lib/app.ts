/**
 * Точка входа сценария. Связывает прогресс t → WebGL-сцену и DOM-оверлей.
 *
 * Сцену ведёт прокрутка: чем дальше прокрутили, тем дальше ушли кадры; остановили — кадр стоит. Сама сцена
 * ничего не доигрывает.
 * Десктоп и планшет: секция высотой в десятки экранов, вьюпорт сцены в ней липкий, t — доля прокрутки секции.
 * Lenis сглаживает колесо.
 * Телефон: секция ровно в экран, и страница под сценой стоит — иначе браузер прячет адресную строку и кадр
 * прыгает. Тот же путь палец проходит виртуально (scrubber.ts): тянешь — кадры идут за пальцем, отпустил —
 * докатываются по инерции. За последним кадром страница отпускается, дальше обычный скролл.
 */
import Lenis from 'lenis';
import gsap from 'gsap';
import { Stage, diag } from './webgl/Stage';
import { Overlay } from './overlay';
import { Bokeh } from './bokeh';
import { Scrubber } from './scrubber';
import { MOBILE_QUERY, TOTAL_WEIGHT, VARIANT, tToFrame, frameToT } from './timeline';

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
  const view = root.querySelector<HTMLElement>('.exp__view')!;
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const fx = document.getElementById('fx') as HTMLCanvasElement;
  const loader = document.getElementById('loader') as HTMLElement;
  const loaderBar = loader.querySelector<HTMLElement>('[data-bar]')!;
  const loaderNum = loader.querySelector<HTMLElement>('[data-num]')!;
  const header = document.getElementById('header') as HTMLElement;
  const debug = document.getElementById('debug');
  const html = document.documentElement;

  /** телефон: страница под сценой не прокручивается, путь по сцене проходится виртуально */
  const virtual = VARIANT === 'mobile';
  // высота секции под скролл: путь по сцене и экран, на котором вьюпорт сцены стоит в её конце
  if (!virtual) root.style.height = `${Math.round(TOTAL_WEIGHT * VH_PER_UNIT) + 100}vh`;

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
  /** ниже этой плотности канвас не опускается, даже если кадры не успевают (см. tick) */
  const dprFloor = virtual ? Math.min(stage.dpr, 2) : 1;
  // ?debug — строка состояния внизу экрана: кадр, размер канваса, качество текстур, плотность пикселей
  if (new URLSearchParams(location.search).has('debug')) debug?.classList.remove('hidden');
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
  const range = () => Math.max(1, root.offsetHeight - view.offsetHeight);

  // ───────── телефон: сцена держит экран ─────────
  // Пока сцена держит экран, страница стоит (Lenis остановлен, жесты забирает Scrubber).
  // За последним кадром страница отпускается; вернулись к самому верху — сцена снова берёт экран.
  let armed = false;   // страница уходила от верха
  let restart = false; // при возврате начать с первого кадра (логотип, кнопка «наверх»)
  const leaveScene = (to: number | HTMLElement) => {
    if (!scrubber) return;
    scrubber.release();
    html.classList.remove('is-held');
    lenis.start();
    // lock: хвост жеста, которым вышли из сцены (инерция колеса, палец), страницу на полпути не останавливает
    lenis.scrollTo(to, { duration: 1.1, lock: true });
  };
  const holdScene = () => {
    if (!scrubber) return;
    scrubber.hold();
    armed = false;
    lenis.stop();
    scrollTo(0, 0);
    html.classList.add('is-held');
    if (restart) { restart = false; stage.cut(); scrubber.set(0); }
  };
  const scrubber = virtual
    ? new Scrubber(root, {
      // тот же путь, что прошла бы страница: единица веса кадра — VH_PER_UNIT процентов высоты экрана
      length: () => Math.max(1, (TOTAL_WEIGHT * VH_PER_UNIT * view.offsetHeight) / 100),
      stops: overlay.mobileStops(),
      onExit: () => leaveScene(root.offsetTop + root.offsetHeight),
    })
    : null;
  if (scrubber) { history.scrollRestoration = 'manual'; holdScene(); }
  addEventListener('scroll', () => {
    if (!scrubber) {
      // пока Lenis стоит (загрузка), позицию двигает только браузер: восстановил её после перезагрузки
      if (lenis.isStopped) scrollY = window.scrollY;
      return;
    }
    // возврат к сцене ловим по нативному скроллу: он приходит и тогда, когда Lenis занят своей анимацией
    scrollY = window.scrollY;
    if (scrubber.locked) return;
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

  // ошибки скрипта — на сервер (diag), первые несколько за визит: без них не понять, что сломалось на чужом телефоне
  let reported = 0;
  const report = (msg: string) => { if (reported++ < 5) diag('error', msg); };
  addEventListener('error', (e) => report(`${e.message} @${e.filename?.split('/').pop()}:${e.lineno}`));
  addEventListener('unhandledrejection', (e) => report(String((e.reason as Error)?.message ?? e.reason)));

  // ролики на экранах: на айфоне их можно запустить только из жеста — любое касание запускает те, что в кадре
  const wake = (e: Event) => stage.wakeVideos(e.type);
  for (const type of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'click', 'keydown']) addEventListener(type, wake, { passive: true, capture: true });

  // ───────── resize ─────────
  let resizeTimer = 0;
  const onResize = () => {
    stage.resize();
    overlay.resize();
    bokeh.resize();
  };
  const later = () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(onResize, 80); };
  addEventListener('resize', later);
  // Размер сцены сверяется и по самому её блоку: на телефоне он 100dvh, и панели браузера (Chrome на айфоне,
  // 2026-10-16) встают на место уже после события resize. Канвас оставался прежней высоты — снизу полоса фона,
  // а заголовок и плашки, расставленные по ней, наезжали на шапку.
  new ResizeObserver(later).observe(view);
  onResize();
  // высота текстовых блоков меняется после подгрузки шрифтов
  document.fonts?.ready.then(onResize);
  addEventListener('load', onResize);

  // ───────── главный цикл ─────────
  /** прогресс сцены 0…1: идёт за прокруткой — страницы или, на телефоне, виртуальной */
  let t = 0;
  let live = false; // загрузчик ушёл, сцену видно
  let last = 0;
  let slow = 0; // подряд идущие медленные кадры во время движения

  const tick = (time: number) => {
    const dt = last ? time - last : 16;
    last = time;
    lenis.raf(time);
    const top = root.offsetTop;
    scrubber?.update(dt);
    const target = scrubber ? scrubber.t : Math.max(0, Math.min(1, (scrollY - top) / range()));
    const from = t;
    // Lenis уже сгладил колесо; догон убирает ступеньки там, где его нет: палец, полоса прокрутки, клавиши.
    // Под загрузчиком догонять нечего — встаём сразу туда, где браузер восстановил страницу.
    t += (target - t) * (live && !prefersReduced ? 1 - Math.pow(1 - FOLLOW, dt / 16.7) : 1);
    if (Math.abs(target - t) < 1e-6) t = target;
    if (!live) stage.cut();
    const moving = Math.abs(t - from) > 1e-6;
    // сцена держит экран: на телефоне — пока не отпустила страницу, в скролле — пока её вьюпорт прилип
    const held = scrubber ? scrubber.locked : scrollY <= top + range() + 1;

    if (moving) {
      // Кадры не успевают (слабая видеокарта, 4K) — понижаем плотность пикселей канваса:
      // чуть более мягкая картинка лучше дёрганого движения. На телефоне — не ниже двух: айфон в режиме
      // энергосбережения рисует 30 кадров в секунду, для этой проверки все они «медленные», и плотность падала
      // до единицы — картинка на экране с плотностью 3 становилась мылом.
      // Только до отрисовки кадра: смена размера стирает канвас, и стёртый после отрисовки кадр
      // показывался бы целиком чёрным.
      slow = dt > 24 && dt < 200 ? slow + 1 : 0;
      if (slow > 30 && stage.dpr > dprFloor) { stage.setDpr(Math.max(dprFloor, stage.dpr - 0.5)); slow = 0; }
    }

    const inView = scrollY < top + root.offsetHeight + innerHeight;
    // Пока не пришла первая волна картинок, сцену закрывает загрузчик — рисовать её незачем. На айфоне кадр
    // в полном разрешении и заливка каждой пришедшей картинки отнимали время у расшифровки следующих.
    if (inView && stage.ready) {
      const t0 = performance.now();
      stage.render(t);
      const t1 = performance.now();
      overlay.update(t, held);
      const t2 = performance.now();
      bokeh.update(t);
      const t3 = performance.now();
      if (import.meta.env.DEV && (t3 - t0) > 30) console.warn(`[perf] render ${(t1 - t0).toFixed(1)}ms overlay ${(t2 - t1).toFixed(1)}ms bokeh ${(t3 - t2).toFixed(1)}ms`);
    }

    if (!moving && stage.ready) {
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
    // остальные картинки сайта начинают грузиться, когда загрузчик ушёл: иначе их заливка дёргала бы его уход
    const tl = gsap.timeline({ onComplete: () => { loader.remove(); if (!scrubber) lenis.start(); stage.loadRest(); } });
    tl.to(loader.querySelector('[data-inner]'), { autoAlpha: 0, y: -12, duration: 0.5, ease: 'power2.in' })
      .to(loader, { yPercent: -100, duration: 0.9, ease: 'expo.inOut' }, '-=0.1')
      .add(() => overlay.intro(), '-=0.6');
    html.classList.add('is-ready');
  });

  /** поставить прогресс скачком: в скролле — саму страницу в нужное место */
  const jump = (tt: number) => {
    stage.cut();
    t = tt;
    if (scrubber) { scrubber.set(tt); return; }
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
  /** к началу: на телефоне это первый кадр сцены, а не просто верх страницы */
  const toStart = (duration: number) => {
    if (scrubber?.locked) { stage.cut(); scrubber.set(0); return; }
    if (scrubber) restart = true;
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
      else if (scrubber?.locked) leaveScene(target);
      else lenis.scrollTo(target, { offset: 0, duration: 1.4 });
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-scroll-top]').forEach((b) => b.addEventListener('click', () => toStart(1.6)));

  return { lenis, stage, overlay, scrubber, goto, renderAt, draw, progress: () => t };
}
