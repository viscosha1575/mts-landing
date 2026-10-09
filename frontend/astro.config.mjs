// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // адрес сайта: в продакшен-сборке приходит из docker-compose.yml (DOMAIN)
  site: process.env.SITE_URL || 'https://scroll.testforspec.ru',
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
    build: { target: 'es2022' },
  },
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
