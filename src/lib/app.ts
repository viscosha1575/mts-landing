/**
 * Точка входа сценария. Связывает Lenis (скролл) → прогресс t → WebGL-сцену и DOM-оверлей.
 */
import Lenis from 'lenis';
import gsap from 'gsap';
import { Stage } from './webgl/Stage';
import { Overlay } from './overlay';
import { Bokeh } from './bokeh';
import { TOTAL_WEIGHT, tToFrame, frameToT, sampleRect } from './timeline';
import { scenes } from './scenes';

const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isTouch = matchMedia('(pointer: coarse)').matches;

/** высота секции сцены на одну единицу веса кадра */
const VH_PER_UNIT = isTouch ? 36 : 46;

export function boot() {
  const root = document.getElementById('experience') as HTMLElement;
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const fx = document.getElementById('fx') as HTMLCanvasElement;
  const loader = document.getElementById('loader') as HTMLElement;
  const loaderBar = loader.querySelector<HTMLElement>('[data-bar]')!;
  const loaderNum = loader.querySelector<HTMLElement>('[data-num]')!;
  const header = document.getElementById('header') as HTMLElement;
  const debug = document.getElementById('debug');

  root.style.height = `${Math.round(TOTAL_WEIGHT * VH_PER_UNIT)}vh`;

  // качество текстур: большие только на больших экранах с нормальным GPU
  const bigScreen = Math.max(innerWidth, innerHeight) * Math.min(devicePixelRatio, 2) > 2200;
  const quality: 'xl' | 'md' = bigScreen && !isTouch ? 'xl' : 'md';

  const stage = new Stage({
    canvas, quality,
    onProgress: (n, total) => {
      const p = n / total;
      loaderBar.style.transform = `scaleX(${p})`;
      loaderNum.textContent = String(Math.round(p * 100)).padStart(3, '0');
    },
  });
  const overlay = new Overlay(stage);
  const bokeh = new Bokeh(fx);
  // проекция точек интерьера центра на экран через его камеру — для ламп перехода 3 → 4
  const s3 = scenes.find((sc) => sc.id === 's3')!;
  const projectS3 = (tt: number) => (x: number, y: number) => stage.projectScene(sampleRect(s3.cam, tt), x, y, 0);

  // ───────── скролл ─────────
  const lenis = new Lenis({
    lerp: prefersReduced ? 1 : 0.085,
    smoothWheel: true,
    syncTouch: false,
    wheelMultiplier: 0.9,
  });
  let scrollY = 0;
  lenis.on('scroll', (e: { scroll: number }) => { scrollY = e.scroll; });
  lenis.stop(); // пока грузимся

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
  let t = 0;
  let tSmooth = 0;
  let lastFrameIdx = -1;
  const range = () => root.offsetHeight - innerHeight;

  const tick = (time: number) => {
    lenis.raf(time);
    const top = root.offsetTop;
    t = Math.max(0, Math.min(1, (scrollY - top) / range()));
    // Lenis уже сглаживает, здесь лёгкий догон для WebGL, чтобы не было ступенек на тачпаде
    tSmooth += (t - tSmooth) * (prefersReduced ? 1 : 0.35);
    if (Math.abs(t - tSmooth) < 1e-5) tSmooth = t;

    const inView = scrollY < top + root.offsetHeight + innerHeight;
    if (inView) {
      const t0 = performance.now();
      stage.render(tSmooth);
      const t1 = performance.now();
      overlay.update(tSmooth);
      const t2 = performance.now();
      bokeh.update(tSmooth, projectS3(tSmooth));
      const t3 = performance.now();
      if (import.meta.env.DEV && (t3 - t0) > 30) console.warn(`[perf] render ${(t1 - t0).toFixed(1)}ms overlay ${(t2 - t1).toFixed(1)}ms bokeh ${(t3 - t2).toFixed(1)}ms`);
    }

    // тема шапки: тёмная сцена / светлая страница ниже
    const f = tToFrame(tSmooth);
    const past = scrollY > top + root.offsetHeight - innerHeight * 0.5;
    header.dataset.theme = past ? 'page' : (f > 20.6 && f < 28.6 ? 'dark' : 'light');
    const idx = Math.floor(f);
    if (debug && idx !== lastFrameIdx) { lastFrameIdx = idx; }
    if (debug) debug.textContent = `t ${tSmooth.toFixed(3)}  f ${f.toFixed(2)}  ${stage.width}×${stage.height} ${quality}`;

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
    const tl = gsap.timeline({ onComplete: () => { loader.remove(); lenis.start(); } });
    tl.to(loader.querySelector('[data-inner]'), { autoAlpha: 0, y: -12, duration: 0.5, ease: 'power2.in' })
      .to(loader, { yPercent: -100, duration: 0.9, ease: 'expo.inOut' }, '-=0.1')
      .add(() => overlay.intro(), '-=0.6');
    document.documentElement.classList.add('is-ready');
  });

  /** dev: синхронно отрисовать кадр без сглаживания (для скриншотов и отладки) */
  const renderAt = (f: number) => {
    const tt = frameToT(f);
    lenis.scrollTo(root.offsetTop + tt * range(), { immediate: true, force: true });
    scrollY = root.offsetTop + tt * range();
    t = tSmooth = tt;
    stage.pointerSmooth?.x !== undefined && (stage.pointerSmooth = { x: 0, y: 0 });
    stage.render(tt); overlay.update(tt); bokeh.update(tt, projectS3(tt));
    return tToFrame(tt);
  };
  const goto = (f: number, immediate = true) => lenis.scrollTo(root.offsetTop + frameToT(f) * range(), immediate ? { immediate: true } : { duration: 1.2 });
  // якоря шапки — через Lenis
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const target = document.querySelector(a.getAttribute('href')!);
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target as HTMLElement, { offset: 0, duration: 1.4 });
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-scroll-top]').forEach((b) =>
    b.addEventListener('click', () => lenis.scrollTo(0, { duration: 1.6 })));

  return { lenis, stage, overlay, goto, renderAt };
}
