// Готовит ролики для экранов: assets-src/video/*.mp4 → public/video/*.mp4 (нужен ffmpeg).
// Экраны в сцене маленькие — от 50 до 70 px макета шириной, — поэтому ролики ужимаются до размера, который на них
// реально виден: исходники 640×360 весили по полмегабайта и на первом экране начинали играть с задержкой.
// Ролик натягивается на вырез экрана целиком, поэтому кадрируется под его пропорции. У роликов с кодом текст
// мелкий и тусклый и занимает только левый верхний угол кадра — они кадрируются по тексту и осветляются.
// Звук убирается у всех.
// Рядом с роликом экрана кладётся его кадр-заставка (<имя>.webp): она стоит на экране, пока ролик грузится или
// если браузер не даёт его запустить (энергосбережение на айфоне), — экран не остаётся тёмным. У роликов-бликов
// (fade) заставки нет: без блика сцена выглядит естественно. Отпечатки содержимого роликов и заставок пишутся
// в src/lib/video-manifest.json: сайт запрашивает файлы с ними (?v=), и браузер хранит их без перепроверок.
// Почти чёрные кадры (проявление из чёрного в начале, пустой экран перед новой страницей кода) из роликов экранов
// вырезаются: на сайте экран в эти доли секунды гас, и казалось, что ролик пропал.
// `node scripts/build-video.mjs posters` — только заставки и отпечатки, без пересжатия роликов;
// `node scripts/build-video.mjs code-blue lab-hud` — пересжать только эти ролики.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'assets-src/video');
const OUT = join(root, 'public/video');

/**
 * crop — окно в px исходника 640×360 (x, y, w, h); width — ширина результата; fps — частота кадров;
 * gain — множитель яркости (всё, что ярче 1/gain, уходит в белый); curves — тоновая кривая (точки «вход/выход»);
 * crf — сжатие (по умолчанию 25, больше — меньше файл).
 * Для ролика, который кладётся поверх картинки светом (блик на чёрном фоне): fade — сколько секунд он проявляется
 * в начале и гаснет в конце, чтобы повтор не было видно; edge — на скольких px у краёв кадра он сходит в чёрный,
 * чтобы не было видно прямоугольника; floor — уровень, ниже которого всё считается чёрным (шум сжатия).
 */
const EDIT = {
  // ноутбук техника на крыше, вырез 109×80 px картинки: первый экран, должен грузиться мгновенно
  's1-laptop': { width: 256, fps: 30 },
  // блик на высотке первого экрана (ролик от дизайнера: световое пятно медленно идёт слева направо)
  's1-flare': { width: 480, fps: 30, fade: 0.9, edge: 28, floor: 0.014 },
  // мониторы исследовательского центра: вырезы почти квадратные (113×107 и 126×107) и один широкий (244×109)
  'lab-blueprint': { crop: [130, 0, 380, 360], width: 228, fps: 24 },
  'lab-waves': { crop: [216, 0, 424, 360], width: 212, fps: 24 },
  'lab-hud': { crop: [0, 38, 640, 284], width: 360, fps: 24, gain: 1.7 },
  // монитор в офисе, вырез 120×95: текст в левом верхнем углу
  'code-blue': { crop: [0, 0, 212, 168], width: 318, fps: 24, gain: 2.5 },
  // ноутбуки в офисе, вырезы 150×108 и 135×105
  'office-code': { crop: [42, 16, 252, 180], width: 378, fps: 24, gain: 2.4 },
  'office-mesh': { width: 320, fps: 24 },
  // телефон, 2026-10-15 (правки дизайнера): на монитор центра — тот же белый ролик с сеткой, что в офисе. Монитор
  // стоит у самого края кадра, и правую нижнюю половину выреза закрывает рука робота: на экране видно пятно в два
  // десятка px. Поэтому ролик взят крупно — середина волны, где она ходит сильнее всего, и стоит в верхней части
  // выреза; тонкие серые линии затемнены (curves), белый фон остаётся белым. На центральный монитор офиса —
  // красный интерфейс (вырез 305×190: ролик 16:9 обрезан по бокам до 16:10)
  // Частая сетка жмётся плохо — ролик мельче и сжат сильнее (crf), иначе он весил бы полмегабайта и на телефоне
  // долго грузился: пока его нет, экран стоит тёмным.
  'lab-mesh': { crop: [200, 118, 180, 220], width: 150, fps: 15, crf: 31, curves: "0/0 0.55/0.3 0.9/0.92 1/1" },
  'office-hud': { crop: [32, 0, 576, 360], width: 320, fps: 30 },
};

const onlyPosters = process.argv[2] === 'posters';
const only = onlyPosters ? [] : process.argv.slice(2);
const hash = (path) => createHash('md5').update(readFileSync(path)).digest('hex').slice(0, 10);
const manifest = {};
mkdirSync(OUT, { recursive: true });
for (const file of readdirSync(SRC).filter((f) => f.endsWith('.mp4')).sort()) {
  const name = file.replace(/\.mp4$/, '');
  const edit = EDIT[name];
  if (!edit) throw new Error(`${file}: нет настроек в EDIT — на каком экране ролик и какого он размера?`);
  if (!onlyPosters && (!only.length || only.includes(name))) encode(file, edit);
  const out = join(OUT, file);
  manifest[name] = { v: hash(out) };
  if (edit.fade) continue;
  // заставка — кадр из середины ролика: в начале у роликов бывают пустые кадры проявления
  const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString();
  const png = execFileSync('ffmpeg', ['-v', 'error', '-ss', (dur / 2).toFixed(2), '-i', out, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'], { maxBuffer: 64 << 20 });
  const poster = join(OUT, `${name}.webp`);
  await sharp(png).webp({ quality: 82, effort: 6 }).toFile(poster);
  manifest[name].poster = hash(poster);
  console.log(`${name}.webp: заставка ${Math.round(statSync(poster).size / 1024)} КБ`);
}
writeFileSync(join(root, 'src/lib/video-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('video-manifest.json записан');

function encode(file, edit) {
  const [x, y, w, h] = edit.crop ?? [0, 0, 640, 360];
  const height = Math.round((edit.width * h) / w / 2) * 2;
  const filters = [`crop=${w}:${h}:${x}:${y}`, `scale=${edit.width}:${height}:flags=lanczos`, `fps=${edit.fps}`];
  if (edit.gain) {
    const top = (1 / edit.gain).toFixed(3);
    filters.push(`colorlevels=rimax=${top}:gimax=${top}:bimax=${top}`, 'eq=saturation=1.2');
  }
  if (edit.curves) filters.push(`curves=all='${edit.curves}'`);
  if (edit.floor) filters.push(`colorlevels=rimin=${edit.floor}:gimin=${edit.floor}:bimin=${edit.floor}`);
  if (edit.edge) {
    const m = `clip(X/${edit.edge},0,1)*clip((W-1-X)/${edit.edge},0,1)*clip(Y/${edit.edge},0,1)*clip((H-1-Y)/${edit.edge},0,1)`;
    filters.push('format=gbrp', `geq=r='r(X,Y)*${m}':g='g(X,Y)*${m}':b='b(X,Y)*${m}'`);
  }
  if (edit.fade) {
    const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(SRC, file)]).toString();
    filters.push(`fade=t=in:st=0:d=${edit.fade}`, `fade=t=out:st=${(dur - edit.fade).toFixed(2)}:d=${edit.fade}`);
  } else {
    // у блика чёрный — это фон, а на экране — пустота: такие кадры выкидываются, остальные идут подряд
    const dark = darkFrames(file, filters, edit.width, height);
    if (dark.length) {
      // одиночный светлый кадр среди тёмных тоже уходит: иначе он мелькнул бы перед склейкой
      const runs = dark.reduce((r, n) => (r.length && n - r[r.length - 1][1] <= 3 ? (r[r.length - 1][1] = n) : r.push([n, n]), r), []);
      filters.push(`select='not(${runs.map(([a, b]) => `between(n,${a},${b})`).join('+')})'`, `setpts=N/(${edit.fps}*TB)`);
      console.log(`${file}: вырезано ${runs.reduce((k, [a, b]) => k + b - a + 1, 0)} тёмных кадров (${runs.map(([a, b]) => `${(a / edit.fps).toFixed(2)}–${((b + 1) / edit.fps).toFixed(2)} с`).join(', ')})`);
    }
  }
  const out = join(OUT, file);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', join(SRC, file), '-vf', filters.join(','), '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(edit.crf ?? 25), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
  ], { stdio: 'inherit' });
  console.log(`${file}: ${edit.width}×${height}, ${edit.fps} к/с, ${Math.round(statSync(out).size / 1024)} КБ (было ${Math.round(statSync(join(SRC, file)).size / 1024)} КБ)`);
}

/** Номера кадров (после кадрирования, осветления и fps), средняя яркость которых ниже 30% обычной для ролика */
function darkFrames(file, filters, width, height) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', join(SRC, file), '-vf', [...filters, 'format=gray'].join(','), '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const size = width * height, count = Math.floor(raw.length / size);
  const means = Array.from({ length: count }, (_, i) => {
    let sum = 0;
    for (let j = i * size; j < (i + 1) * size; j++) sum += raw[j];
    return sum / size;
  });
  const median = [...means].sort((a, b) => a - b)[count >> 1];
  return means.flatMap((m, i) => (m < 0.3 * median ? [i] : []));
}
