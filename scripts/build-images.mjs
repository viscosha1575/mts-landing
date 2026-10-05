/**
 * assets-src/**.png  ->  public/img/<name>-<size>.webp
 * Каждая картинка получает варианты по ширине: xl (<=4096) и md (<=2048).
 * Слои с альфой сохраняются с альфой (WebP lossless alpha не нужен, достаточно alphaQuality).
 * Запуск: npm run images
 */
import sharp from 'sharp';
import { readdir, mkdir, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const SRC = new URL('../assets-src/', import.meta.url).pathname;
const OUT = new URL('../public/img/', import.meta.url).pathname;

/** Карта: имя исходника -> имя слоя (только эти файлы идут в сборку) */
const MAP = {
  // локации 01–03: исходники Figma после scripts/bake-figma.py (v3/) и без обработки (v3/raw/)
  'v3/s1_sky.png': 's1-sky',
  'v3/raw/s1_city_raw.png': 's1-city',
  'v3/s1_roof.png': 's1-roof',
  'v3/airship.png': 'airship',
  'v3/s2_sky.png': 's2-sky',
  'v3/s2_far.png': 's2-far',
  'v3/raw/s2_near_raw.png': 's2-near',
  'v3/s3_lab.png': 's3-lab',
  'v3/s3_model.png': 's3-model',
  // те же локации в мобильной раскадровке (портретные исходники 1024×1536)
  'v3/raw/m_s1_sky_raw.png': 'm-s1-sky',
  'v3/raw/m_s1_city_raw.png': 'm-s1-city',
  'v3/raw/m_s1_roof_raw.png': 'm-s1-roof',
  'v3/m_s2_sky.png': 'm-s2-sky',
  'v3/m_s2_far.png': 'm-s2-far',
  'v3/raw/m_s2_near_raw.png': 'm-s2-near',
  'v3/raw/m_s3_lab_raw.png': 'm-s3-lab',
  // локации 04–07
  'dc_raw4.png': 's4-bg',
  's4_rack_cut.png': 's4-rack',
  's4_tech.png': 's4-tech',
  's5_raw3.png': 's5-office',
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

// файлы слоёв, которых больше нет в MAP, не должны уезжать в сборку
const keep = new Set(Object.entries(manifest).flatMap(([name, m]) => Object.keys(m.sizes).map((sfx) => `${name}-${sfx}.webp`)));
for (const f of await readdir(OUT)) {
  if (f.endsWith('.webp') && !keep.has(f)) { await unlink(path.join(OUT, f)); console.log('removed stale:', f); }
}
console.log('manifest written');
