/**
 * assets-src/*.png  ->  public/img/<name>-<size>.webp
 * Каждая картинка получает варианты по ширине: xl (<=4096) и md (<=2048).
 * Слои с альфой сохраняются с альфой (WebP lossless alpha не нужен, достаточно alphaQuality).
 * Запуск: npm run images
 */
import sharp from 'sharp';
import { readdir, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SRC = new URL('../assets-src/', import.meta.url).pathname;
const OUT = new URL('../public/img/', import.meta.url).pathname;

/** Карта: имя исходника -> имя слоя (только эти файлы идут в сборку) */
const MAP = {
  's1_bg.png': 's1-bg',
  's1_dish_raw.png': 's1-dish',
  's1_cab_cut.png': 's1-cabinet',
  's1_fg_cut.png': 's1-fg',
  'airship_raw1.png': 'airship',
  's2_field.png': 's2-field',
  's3_wide_raw.png': 's3-bg',
  'model_raw1.png': 's3-model',
  'dc_raw4.png': 's4-bg',
  's4_rack_cut.png': 's4-rack',
  
  's4_tech.png': 's4-tech',
  's5_raw3.png': 's5-office',
  's5_window.png': 's5-window',
  's5_plant_cut.png': 's5-plant',
  's6_bg.png': 's6-city',
  's7_room_raw1.png': 's7-room',
  's7_fg_cut.png': 's7-fg',
  // внутренняя страница
  'main_raw1.png': 'about-trophy',
  'main_raw3.png': 'about-heart',
  'main_raw6.png': 'about-pulse',
  'main_raw12.png': 'about-decor',
  'main_raw13.png': 'about-house',
  'main_raw14.png': 'about-video',
};

const SIZES = [
  { suffix: 'xl', width: 4096, quality: 82 },
  { suffix: 'md', width: 2048, quality: 80 },
];

await mkdir(OUT, { recursive: true });
const manifest = {};

for (const [file, name] of Object.entries(MAP)) {
  const src = path.join(SRC, file);
  try { await stat(src); } catch { console.warn('skip (missing):', file); continue; }
  const meta = await sharp(src).metadata();
  manifest[name] = { width: meta.width, height: meta.height, alpha: !!meta.hasAlpha, sizes: {} };
  const sizes = name.startsWith('about-') ? [{ suffix: 'md', width: 1200, quality: 82 }] : SIZES;
  for (const s of sizes) {
    const width = Math.min(s.width, meta.width);
    const out = path.join(OUT, `${name}-${s.suffix}.webp`);
    const img = sharp(src).resize({ width, withoutEnlargement: true });
    const info = await img
      .webp({ quality: s.quality, alphaQuality: 90, effort: 5, smartSubsample: true })
      .toFile(out);
    manifest[name].sizes[s.suffix] = { width: info.width, height: info.height, bytes: info.size };
    console.log(`${name}-${s.suffix}.webp  ${info.width}x${info.height}  ${(info.size / 1024).toFixed(0)} KB`);
  }
}

await writeFile(new URL('../src/lib/image-manifest.json', import.meta.url), JSON.stringify(manifest, null, 2));
console.log('manifest written');
