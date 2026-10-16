/**
 * assets-src/**.png  ->  public/img/<name>-<size>.webp
 * Каждая картинка получает варианты по ширине: xl (<=4096) и md (<=2048).
 * Слои с альфой сохраняются с альфой (WebP lossless alpha не нужен, достаточно alphaQuality).
 * Запуск: npm run images
 */
import sharp from 'sharp';
import { readdir, mkdir, stat, writeFile, unlink, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const SRC = new URL('../assets-src/', import.meta.url).pathname;
const OUT = new URL('../public/img/', import.meta.url).pathname;

/** Карта: имя исходника -> имя слоя (только эти файлы идут в сборку) */
const MAP = {
  // локации 01–03: исходники Figma после scripts/bake-figma.py (v3/) и без обработки (v3/raw/)
  'v3/raw/s1_city_raw.png': 's1-city',
  'v6/s1_roof.png': 's1-roof',
  'v3/airship.png': 'airship',
  'v3/s2_far.png': 's2-far',
  'v6/s1_flare_mask.png': 's1-flare-mask',
  'v6/s2_near.png': 's2-near',
  'v6/s2_tree.png': 's2-tree',
  'v6/s2_van.png': 's2-van',
  'v6/s2_van_shadow.png': 's2-van-shadow',
  'v6/s2_bush_a.png': 's2-bush-a',
  'v6/s2_bush_b.png': 's2-bush-b',
  'v6/s2_bush_c.png': 's2-bush-c',
  'v6/s2_flowers.png': 's2-flowers',
  'v6/s2_grass.png': 's2-grass',
  'v6/s3_lab.png': 's3-lab',
  'v6/s3_lab_day.png': 's3-lab-day',
  'v6/s3_case.png': 's3-case',
  'v6/s3_case_shadow.png': 's3-case-shadow',
  'v3/s3_model.png': 's3-model',
  // те же локации в мобильной раскадровке (портретные исходники 1024×1536); с 2026-10-14 — по слоям из кадров
  // «61», «59», «64», «63» дизайнера (v7/): небо обеих локаций — градиент, облака — те же спрайты, что на десктопе
  'v3/raw/m_s1_city_raw.png': 'm-s1-city',
  'v7/m_s1_roof.png': 'm-s1-roof',
  'v3/m_s2_far.png': 'm-s2-far',
  'v7/m_s2_near.png': 'm-s2-near',
  'v7/m_s2_tree.png': 'm-s2-tree',
  'v7/raw/m_s2_tree_shadow_raw.png': 'm-s2-tree-shadow',
  'v7/raw/m_s2_van_shadow_raw.png': 'm-s2-van-shadow',
  'v7/raw/m_s3_lab_raw.png': 'm-s3-lab',
  'v7/m_s3_lab_light.png': 'm-s3-lab-light',
  'v7/raw/m_s4_tubes_raw.png': 'm-s4-tubes',
  'v7/raw/m_s4_leds_raw.png': 'm-s4-leds',
  // финальный макет (v4/): облака отдельными слоями
  'v4/s1_cloud_a.png': 's1-cloud-a',
  'v4/s1_cloud_b.png': 's1-cloud-b',
  'v4/s1_cloud_c.png': 's1-cloud-c',
  'v4/s2_cloud_1.png': 's2-cloud-1',
  'v4/s2_cloud_2.png': 's2-cloud-2',
  'v4/s2_cloud_3.png': 's2-cloud-3',
  'v4/s2_cloud_4.png': 's2-cloud-4',
  'v4/s2_cloud_5.png': 's2-cloud-5',
  'v4/s7_cloud_5.png': 's7-cloud-5',
  'v4/s7_cloud_6.png': 's7-cloud-6',
  'v4/s7_cloud_8.png': 's7-cloud-8',
  'v4/s7_cloud_10.png': 's7-cloud-10',
  'v4/s7_cloud_11.png': 's7-cloud-11',
  'v4/s7_cloud_12.png': 's7-cloud-12',
  'v4/s7_cloud_13.png': 's7-cloud-13',
  // локации 04–08
  'v4/raw/s4_dc.png': 's4-dc',
  'v4/s4_led.png': 's4-led',
  'v4/raw/s4_logo.png': 's4-logo',
  'v4/s4_rack.png': 's4-rack',
  'v6/s5_office.png': 's5-office',
  'v6/s5_office_shade.png': 's5-shade',
  'v6/s6_city.png': 's6-city',
  'v6/s6_city_sun.png': 's6-city-sun',
  'v6/s6_clouds_a.png': 's6-clouds-a',
  'v6/s6_clouds_b.png': 's6-clouds-b',
  'v6/s6_clouds_c1.png': 's6-clouds-c1',
  'v6/s6_clouds_c2.png': 's6-clouds-c2',
  'v4/s6_facade.png': 's6-facade',
  'v6/s7_fg.png': 's7-fg',
  'v6/s7_car_1.png': 's7-car-1',
  'v6/s7_car_2.png': 's7-car-2',
  'v6/s7_house.png': 's7-house',
  'v6/s8_apt.png': 's8-apt',
  'v6/s8_plant.png': 's8-plant',
  'v6/s8_sofa.png': 's8-sofa',
  'v6/s8_robot.png': 's8-robot',
  // мобильная раскадровка локаций 04–08 (секция 25:196, кадры 113–134): вертикальные исходники
  'v5/m_s4_dc.png': 'm-s4-dc',
  'v5/m_s4_lights.png': 'm-s4-lights',
  // офис и город с 2026-10-15 — по слоям из кадров «65», «68», «66» дизайнера (v8/): у обоих два света,
  // в офисе вырезаны экраны; облака города — окна тех же листов, что на десктопе
  'v8/raw/m_s5_office_raw.png': 'm-s5-office',
  'v8/m_s5_office_sun.png': 'm-s5-office-sun',
  'v8/m_s6_city.png': 'm-s6-city',
  'v8/m_s6_city_sun.png': 'm-s6-city-sun',
  'v8/m_s6_clouds_a.png': 'm-s6-clouds-a',
  'v8/m_s6_clouds_b.png': 'm-s6-clouds-b',
  // улица с 2026-10-15 — по слоям из кадра «72» дизайнера (v9/): дальний план, дом, машина и столб перед её полосой,
  // облака — окна листов (три из них те же, что у десктопной улицы)
  'v9/m_s7_far.png': 'm-s7-far',
  'v9/m_s7_house.png': 'm-s7-house',
  'v9/m_s7_house_sun.png': 'm-s7-house-sun',
  'v9/m_s7_car.png': 'm-s7-car',
  'v9/m_s7_pole.png': 'm-s7-pole',
  'v9/m_s7_cloud_1.png': 'm-s7-cloud-1',
  'v9/m_s7_cloud_2.png': 'm-s7-cloud-2',
  'v9/m_s7_cloud_3.png': 'm-s7-cloud-3',
  'v9/m_s7_cloud_4.png': 'm-s7-cloud-4',
  'v9/m_s7_cloud_5.png': 'm-s7-cloud-5',
  'v9/m_s7_cloud_6.png': 'm-s7-cloud-6',
  'v9/m_s7_cloud_7.png': 'm-s7-cloud-7',
  // маски остекления для бликов на телефоне (bake-figma.py, mobile_flare_masks)
  'v9/m_s1_flare_mask.png': 'm-s1-flare-mask',
  'v9/m_s6_flare_mask.png': 'm-s6-flare-mask',
  'v9/m_s7_flare_mask.png': 'm-s7-flare-mask',
  // квартира с 2026-10-15 — по слоям из кадра «75» файла заказчика (v10/): комната в двух светах, пылесос,
  // цветок и пуф на переднем плане
  'v10/raw/m_s8_room_raw.png': 'm-s8-room',
  'v10/m_s8_room_sun.png': 'm-s8-room-sun',
  'v10/m_s8_robot.png': 'm-s8-robot',
  'v10/m_s8_plant.png': 'm-s8-plant',
  'v10/m_s8_pouf.png': 'm-s8-pouf',
  // внутренняя страница
  'main_raw1.png': 'about-trophy',
  'main_raw3.png': 'about-heart',
  'main_raw6.png': 'about-pulse',
  'main_raw12.png': 'about-decor',
  'main_raw13.png': 'about-house',
  'main_raw14.png': 'about-video',
};

/**
 * Слои, которым не нужен полный размер исходника: огни стоек — россыпь точек, на экране они мелкие;
 * вертикальные дата-центр, город, улица и квартира идут только на телефон (экран до 1300 px шириной), а в видеопамяти они самые
 * тяжёлые (города два — в двух светах)
 */
const MAX_WIDTH = { 's4-led': 2048, 'm-s1-roof': 1536, 'm-s4-dc': 1536, 'm-s6-city': 1536, 'm-s6-city-sun': 1536, 'm-s7-far': 1280, 'm-s7-house': 1280, 'm-s7-house-sun': 1280, 'm-s8-room': 1280, 'm-s8-room-sun': 1280 };

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
    const width = Math.min(s.width, meta.width, MAX_WIDTH[name] ?? Infinity);
    const out = path.join(OUT, `${name}-${s.suffix}.webp`);
    const img = sharp(src).resize({ width, withoutEnlargement: true });
    const info = await img
      .webp({ quality: s.quality, alphaQuality: 90, effort: 5, smartSubsample: true })
      .toFile(out);
    // отпечаток содержимого: сайт запрашивает картинку с ним (?v=), и браузер держит её в кэше без перепроверок —
    // после деплоя заново качаются только изменившиеся
    const v = createHash('md5').update(await readFile(out)).digest('hex').slice(0, 10);
    manifest[name].sizes[s.suffix] = { width: info.width, height: info.height, bytes: info.size, v };
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
