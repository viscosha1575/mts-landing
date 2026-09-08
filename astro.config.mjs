// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://example.com',
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
    build: { target: 'es2022' },
  },
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
