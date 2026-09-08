/** Поведение обычных секций ниже сцены: появление по скроллу, кнопка «наверх», чипы. */
import type Lenis from 'lenis';

export function initPage(lenis: Lenis) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
  document.querySelectorAll('[data-reveal-on-scroll]').forEach((el) => io.observe(el));

  const top = document.querySelector<HTMLElement>('[data-scroll-top]');
  const about = document.getElementById('about');
  if (top && about) {
    lenis.on('scroll', ({ scroll }: { scroll: number }) => {
      const show = scroll > about.offsetTop - innerHeight * 0.5;
      if (show) top.dataset.show = ''; else delete top.dataset.show;
    });
  }

  const perks = [...document.querySelectorAll<HTMLButtonElement>('[data-perk]')];
  perks.forEach((b) => b.addEventListener('click', () => {
    perks.forEach((o) => { o.classList.remove('bg-ink-deep', 'text-white'); o.classList.add('bg-white', 'text-ink-deep'); });
    b.classList.add('bg-ink-deep', 'text-white'); b.classList.remove('bg-white', 'text-ink-deep');
  }));
}
