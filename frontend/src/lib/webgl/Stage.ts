/**
 * WebGL-сцена на OGL. Никакого 3D: каждый слой — текстурированный квад, который
 * позиционируется 2D-камерой (прямоугольник видимой области в координатах локации).
 *
 * Эффекты, которые делаются «бесплатно» в шейдере:
 *  - дефокус: выборка с более грубого mip-уровня бикубическим фильтром;
 *  - тем же фильтром сглаживается сильное увеличение слоя (крупные планы не «пикселят»);
 *  - смаз быстрой панорамы: слой, который летит через экран, размывается вдоль движения;
 *  - облака: медленный дрейф и «дыхание» формы — шум смещает выборку текстуры;
 *  - затемнение сцены и режимы наложения screen / add для света и облаков;
 *  - premultiplied-alpha смешивание, чтобы края вырезанных объектов не светились.
 */
import { Renderer, Program, Mesh, Geometry, RenderTarget, Texture, type OGLRenderingContext } from 'ogl';
import { scenes, type LayerDef, type Paint, type SceneDef } from '../scenes';
import { REF_W, REF_H, sampleNumber, sampleRect, segment, lerpRect, smooth, tToFrame, type Key, type Rect } from '../timeline';

/** Опорный фрейм: десктопный по умолчанию, у мобильных сцен свой (SceneDef.ref) */
type Ref = readonly [number, number];
const DESKTOP_REF: Ref = [REF_W, REF_H];

/** Размер «клуба» в шуме, которым дышат облака, px макета */
const CLOUD_GRAIN = 300;
/**
 * Запас за краем кадра, на котором плывущее облако переносится с одной стороны на другую. Камера бывает
 * шире кадра (улица как вид из окна квартиры), а дальние планы на ней чуть крупнее — перенос должен быть за её краем.
 */
const DRIFT_PAD = 240;
/** Смаз движения: выдержка в мс, скорость (px за выдержку), с которой он начинается, и наибольшая длина следа в px экрана */
const SHUTTER_MS = 9;
const SMEAR_FROM = 3;
const SMEAR_MAX = 36;
/** за сколько мс смаз подстраивается под темп прокрутки: толчки колеса сливаются в ровное движение */
const SMEAR_SMOOTH_MS = 180;
/** за сколько мс смаз замечает, что сцена встала */
const SMEAR_STOP_MS = 60;
/** шаг по прогрессу t, на котором меряется, куда и как быстро едет слой */
const SMEAR_PROBE = 1e-4;

/** Ширина экрана, до которой сцена кадрируется по точке интереса (SceneDef.focus): там же плашки сменяются чипсами */
const FOCUS_MAX_WIDTH = 1023;

const VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 position;
in vec2 uv;
uniform vec4 uRect;      // x, y, w, h в clip-пикселях экрана
uniform vec2 uViewport;  // ширина/высота канваса в CSS px
uniform float uRotate;   // радианы
out vec2 vUv;
void main() {
  vUv = uv;
  vec2 hs = uRect.zw * 0.5;
  vec2 center = uRect.xy + hs;
  vec2 p = position * hs;          // position ∈ [-1,1]
  float c = cos(uRotate), s = sin(uRotate);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + center;
  // экранные px → clip space (y вниз)
  vec2 clip = (p / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D tMap;
uniform float uLod;      // уровень мипа: масштаб слоя на экране плюс размытие
uniform float uSoft;     // 0 — обычная выборка, 1 — бикубическая
uniform vec4 uDof;       // зона резкости: центр эллипса (uv) и обратные радиусы; z = 0 — зоны нет
uniform vec4 uBlur;      // для слоя с зоной: размытие в ней и прибавка вне её (тексели), max(1, 1/увеличение), увеличение − 1
uniform float uLodMax;
uniform float uAlpha;
uniform float uDim;      // 0..1
uniform vec2 uMotion;    // смаз: смещение слоя за время выдержки, в долях текстуры
uniform vec4 uCloud;     // облако: амплитуда искажения по x и y (в долях текстуры), время, фаза
uniform mat3 uQuad;      // четырёхугольник: из uv прямоугольника слоя — в uv текстуры (перспектива)
uniform float uQuadOn;
uniform vec3 uSway;      // ветер: амплитуда у верхушки (в долях ширины), фаза во времени, сдвиг второй волны
uniform vec4 uTwinkle;   // мигание огоньков: ячеек по x и y, доля мигающих, время
uniform float uTwinkleDepth; // глубина мигания 0…1: у размытого слоя сходит на нет
uniform vec4 uHaze;      // струя воздуха: середина по x и низ по y (uv), полуширина и высота
uniform vec4 uHaze2;     // вторая струя на том же слое
uniform vec2 uHazeAmp;   // сила преломления по x и y, в долях текстуры (0 — струй нет)
uniform vec2 uCloudGrain; // сколько ячеек шума укладывается в слой по x и y
in vec2 vUv;
out vec4 fragColor;

// веса кубического B-сплайна
vec4 cubic(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) * (1.0 / 6.0);
}

// Бикубическая выборка (B-сплайн) с одного уровня мипов четырьмя билинейными тапами: гладко и при сильном
// увеличении (нет «лесенки» билинейной интерполяции), и при размытии через мипы (нет блоков).
// Уровень — только целый, и сетка весов берётся с его настоящего размера. Четыре тапа дают сплайн, только
// когда стоят ровно между текселями уровня; на «дробном уровне» с придуманной сеткой веса расходятся
// с текселями, и на их границах остаются ступеньки — размытый слой выглядит не размытым, а пиксельным.
vec4 cubicLevel(vec2 uv, float level) {
  vec2 size = vec2(textureSize(tMap, int(level)));
  vec2 st = uv * size - 0.5;
  vec2 f = fract(st);
  st -= f;
  vec4 xc = cubic(f.x), yc = cubic(f.y);
  vec4 c = st.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 w = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 o = (c + vec4(xc.yw, yc.yw) / w) / size.xxyy;
  vec4 s0 = textureLod(tMap, o.xz, level);
  vec4 s1 = textureLod(tMap, o.yz, level);
  vec4 s2 = textureLod(tMap, o.xw, level);
  vec4 s3 = textureLod(tMap, o.yw, level);
  float sx = w.x / (w.x + w.y), sy = w.z / (w.z + w.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}

// самый мелкий уровень мипов текстуры (1×1)
float topLevel() {
  vec2 s = vec2(textureSize(tMap, 0));
  return floor(log2(max(s.x, s.y)));
}

// Размытие произвольной силы: смесь выборок с двух соседних целых уровней
vec4 smoothTex(vec2 uv, float lod) {
  lod = min(lod, topLevel());
  float base = floor(lod), f = lod - base;
  vec4 a = cubicLevel(uv, base);
  return f < 0.02 ? a : mix(a, cubicLevel(uv, base + 1.0), f);
}

vec4 sampleMap(vec2 uv) {
  // Обычная выборка — до любых ветвлений: уровень мипа она берёт из разницы uv у соседних пикселей,
  // а внутри ветки, в которую соседи не попали, эта разница не определена — по границе зоны шла бы линия.
  vec4 sharp = texture(tMap, uv);
  float lod = uLod, soft = uSoft;
  if (uDof.z > 0.0) {
    // глубина резкости: в зоне слой резкий, за ней размытие плавно нарастает — уровень считается на каждый пиксель
    float blur = uBlur.x + uBlur.y * smoothstep(1.0, 1.9, length((uv - uDof.xy) * uDof.zw));
    lod = min(uLodMax, log2(uBlur.z + blur));
    soft = clamp(max(uBlur.w, blur), 0.0, 1.0);
  }
  if (soft <= 0.0) return sharp;
  vec4 smoothed = smoothTex(uv, lod);
  return soft >= 1.0 ? smoothed : mix(sharp, smoothed, soft);
}

// плавный шум для облаков
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Струя воздуха (над вентилятором): то, что за ней, слегка дрожит — рябь бежит вверх и сходит на нет.
// Струя выходит из источника (низ зоны) шириной с него и слегка расширяется кверху; у краёв и у верхней границы преломление гаснет.
vec2 haze(vec2 uv, vec4 zone, float seed) {
  vec2 q = (uv - zone.xy) / zone.zw;
  float up = -q.y;
  // у источника струя почти во всю ширину зоны — она шириной с решётку вентилятора; края мягкие
  float m = smoothstep(1.0, 0.68, abs(q.x) / mix(0.86, 1.0, up)) * smoothstep(0.0, 0.035, up) * (1.0 - smoothstep(0.45, 1.0, up));
  if (m <= 0.0) return vec2(0.0);
  float ht = uCloud.z;
  vec2 hp = vec2(q.x * 3.0 + seed, up * 6.0 - ht * 1.7);
  vec2 d = vec2(noise(hp * 2.1 + 11.0), noise(hp * 2.1 + vec2(31.0, 7.0))) - 0.5;
  d += 0.5 * (vec2(noise(hp * 5.3 + 3.0), noise(hp * 5.3 + 19.0)) - 0.5);
  return d * uHazeAmp * m;
}

// яркость огонька в ячейке: часть ячеек живёт своей жизнью — гаснет и загорается в своём ритме
float blink(vec2 cell) {
  float h = hash(cell), h2 = hash(cell + 17.3);
  if (h >= uTwinkle.z) return 1.0;
  // загорается быстро, гаснет плавнее и почти до конца; ритм у каждой ячейки свой
  float ph = fract(uTwinkle.w * (0.16 + 0.7 * h2) + h * 9.0);
  return 0.05 + 0.95 * smoothstep(0.0, 0.07, ph) * (1.0 - smoothstep(0.3 + 0.35 * h2, 0.62 + 0.35 * h2, ph));
}

void main() {
  vec2 uv = vUv;
  float mask = 1.0;
  if (uQuadOn > 0.5) {
    // Картинка вписана в произвольный четырёхугольник (экран монитора под углом): обратная гомография.
    // Кромка сглажена в пределах пикселя.
    vec3 q = uQuad * vec3(vUv, 1.0);
    uv = q.xy / q.z;
    vec2 e = max(fwidth(uv), vec2(1e-5));
    vec2 m = smoothstep(vec2(0.0), e, uv) * smoothstep(vec2(0.0), e, 1.0 - uv);
    mask = q.z > 0.0 ? m.x * m.y : 0.0;
  }
  if (uHazeAmp.x > 0.0) uv += haze(uv, uHaze, 0.0) + (uHaze2.z > 0.0 ? haze(uv, uHaze2, 23.0) : vec2(0.0));
  if (uSway.x != 0.0) {
    // ветер: низ спрайта стоит, верх ходит из стороны в сторону — две волны разной частоты
    float h = 1.0 - uv.y;
    uv.x -= uSway.x * h * h * (sin(uSway.y) + 0.35 * sin(uSway.y * 2.7 + uSway.z));
  }
  if (uCloud.x > 0.0) {
    // два слоя шума плывут в разные стороны: края облака медленно перетекают, сама форма остаётся
    vec2 p = uv * uCloudGrain + uCloud.w;
    float t = uCloud.z;
    vec2 d = vec2(noise(p + vec2(t * 0.11, -t * 0.07)), noise(p.yx * 1.3 + vec2(-t * 0.08, t * 0.1) + 7.3)) - 0.5;
    d += 0.5 * (vec2(noise(p * 2.7 + vec2(-t * 0.19, t * 0.13) + 3.1), noise(p.yx * 3.1 + vec2(t * 0.17, t * 0.15) + 11.9)) - 0.5);
    uv += d * uCloud.xy;
  }
  vec4 col;
  if (dot(uMotion, uMotion) > 0.0) {
    // смаз: выборки вдоль движения. У размытого или увеличенного слоя каждая — та же гладкая, с ближайшего
    // целого уровня: иначе смаз лёг бы поверх ступенек
    float level = min(floor(uLod + 0.5), topLevel());
    col = vec4(0.0);
    for (int i = 0; i < 12; i++) {
      vec2 p = uv + uMotion * (float(i) / 11.0 - 0.5);
      col += uSoft > 0.0 ? cubicLevel(p, level) : textureLod(tMap, p, uLod);
    }
    col /= 12.0;
  } else {
    col = sampleMap(uv);
  }
  col *= mask;
  if (uTwinkleDepth > 0.0) {
    // Огоньки: слой поделён на ячейки, у каждой своя яркость. Между ячейками яркость перетекает плавно —
    // с жёсткой границей огонёк, попавший на стык, резало бы пополам, а на размытом слое была бы мозаика.
    vec2 g = vUv * uTwinkle.xy - 0.5;
    vec2 i = floor(g), f = fract(g);
    f = f * f * (3.0 - 2.0 * f);
    float b = mix(mix(blink(i), blink(i + vec2(1.0, 0.0)), f.x), mix(blink(i + vec2(0.0, 1.0)), blink(i + vec2(1.0, 1.0)), f.x), f.y);
    col *= mix(1.0, b, uTwinkleDepth);
  }
  // текстура премультиплицирована; затемнение — к цвету, не к альфе
  vec3 rgb = col.rgb * (1.0 - uDim);
  fragColor = vec4(rgb, col.a) * uAlpha;
}`;

/**
 * Уменьшенные копии текстуры (мипы) для размытия. Те, что строит видеокарта, — усреднение 2×2: на тонких
 * диагональных линиях оно даёт зубцы, и после нескольких уменьшений размытый слой идёт «штриховкой»
 * и ступеньками. Здесь каждый уровень считается из предыдущего с ядром [1 3 3 1] по каждой оси
 * (четыре билинейные выборки): зубцов нет, и выборка B-сплайном с такого уровня — ровное размытие.
 */
const MIP_VERT = /* glsl */ `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}`;
const MIP_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D tMap;
uniform float uLevel;   // уровень-источник
uniform vec2 uTexel;    // размер его текселя в долях текстуры
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 d = uTexel * 0.75;
  fragColor = 0.25 * (
    textureLod(tMap, vUv + vec2(-d.x, -d.y), uLevel) + textureLod(tMap, vUv + vec2(d.x, -d.y), uLevel) +
    textureLod(tMap, vUv + vec2(-d.x, d.y), uLevel) + textureLod(tMap, vUv + vec2(d.x, d.y), uLevel));
}`;
/**
 * С какого уровня мипы пересчитываются. Первый (половинный размер) остаётся от видеокарты: с него берётся
 * обычная, резкая картинка слоя, когда он на экране чуть меньше текстуры, — её смягчать незачем.
 */
const MIP_REFINE_FROM = 2;

export interface Camera { rect: Rect }

export interface StageOptions {
  canvas: HTMLCanvasElement;
  /** качество текстур */
  quality: 'xl' | 'md';
  /** без дрейфа облаков и смаза (prefers-reduced-motion) */
  still?: boolean;
  onProgress?: (loaded: number, total: number) => void;
}

interface LayerRuntime {
  def: LayerDef;
  texture: Texture | null;
  /** размер текстуры в пикселях */
  size: [number, number];
  aspect: number;
  /** видео на слое (LayerDef.video): элемент и номер кадра рендера, на котором слой последний раз рисовался */
  video?: HTMLVideoElement;
  seen?: number;
  /** случайная фаза шума, чтобы облака не «дышали» синхронно */
  phase: number;
}
interface SceneRuntime {
  def: SceneDef;
  layers: LayerRuntime[];
}

/**
 * Матрица для шейдера: из uv прямоугольника слоя (0…1) — в uv текстуры, если текстура натянута на
 * четырёхугольник q (углы по порядку: левый верхний, правый верхний, правый нижний, левый нижний, в тех же uv).
 * Сначала строится отображение единичного квадрата в четырёхугольник (Хекберт), потом оно обращается.
 */
function quadMatrix(q: readonly number[]): Float32Array {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, sx = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(den) > 1e-12 ? (sx * dy2 - dx2 * sy) / den : 0, h = Math.abs(den) > 1e-12 ? (dx1 * sy - sx * dy1) / den : 0;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  // обратная матрица (присоединённая — общий множитель в однородных координатах не важен)
  const A = e - f * h, B = c * h - b, C = b * f - c * e;
  const D = f * g - d, E = a - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  // по столбцам, как ждёт GLSL
  return new Float32Array([A, D, G, B, E, H, C, F, I]);
}

/** Подряд идущие ключи без привязки к сцене, среди которых стоит ключ a, — отдельный трек для сплайна */
const plainRuns = new WeakMap<object, Map<Key<Rect>, Key<Rect>[]>>();
function plainRun(keys: Key<Rect>[], a: Key<Rect>): Key<Rect>[] {
  let runs = plainRuns.get(keys);
  if (!runs) {
    runs = new Map();
    let run: Key<Rect>[] = [];
    for (const k of keys) {
      if (k.in) { run = []; continue; }
      run.push(k);
      runs.set(k, run);
    }
    plainRuns.set(keys, runs);
  }
  return runs.get(a)!;
}

/** Яркость круга радиуса r, размытого по Гауссу (sigma), на расстоянии d от центра */
function blurredDisc(d: number, r: number, sigma: number): number {
  const n = 24;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const rho = ((i + 0.5) / n) * r;
    for (let j = 0; j < n; j++) {
      const th = ((j + 0.5) / n) * Math.PI * 2;
      sum += Math.exp(-(rho * rho + d * d - 2 * rho * d * Math.cos(th)) / (2 * sigma * sigma)) * rho;
    }
  }
  return (sum * (r / n) * ((Math.PI * 2) / n)) / (2 * Math.PI * sigma * sigma);
}

/** Нарисовать процедурную текстуру: градиент неба, свечение, сплошной цвет */
function paintCanvas(paint: Paint): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  if (paint.type === 'solid') {
    c.width = c.height = 2;
    ctx.fillStyle = paint.color; ctx.fillRect(0, 0, 2, 2);
  } else if (paint.type === 'linear') {
    // градиент плавный — хватает небольшой текстуры в пропорциях слоя
    c.width = Math.max(8, Math.round(512 * Math.min(1, paint.aspect)));
    c.height = Math.max(8, Math.round(512 * Math.min(1, 1 / paint.aspect)));
    if (paint.base) { ctx.fillStyle = paint.base; ctx.fillRect(0, 0, c.width, c.height); }
    const g = ctx.createLinearGradient(paint.from[0] * c.width, paint.from[1] * c.height, paint.to[0] * c.width, paint.to[1] * c.height);
    for (const [pos, color] of paint.stops) g.addColorStop(Math.max(0, Math.min(1, pos)), color);
    ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
  } else {
    // размытый круг: профиль яркости по радиусу считаем численно и кладём в радиальный градиент
    c.width = c.height = 256;
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    const [r, gr, b] = paint.rgb;
    const steps = 32;
    for (let i = 0; i <= steps; i++) {
      const d = i / steps;
      // к краю текстуры свечение сходит в ноль без видимой границы
      const edge = d > 0.85 ? (1 - d) / 0.15 : 1;
      g.addColorStop(d, `rgba(${r},${gr},${b},${(paint.opacity * blurredDisc(d, paint.radius, paint.sigma) * edge).toFixed(4)})`);
    }
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
  }
  return c;
}

export class Stage {
  renderer: Renderer;
  gl: OGLRenderingContext;
  program: Program;
  mesh: Mesh;
  private mipMesh: Mesh;
  private mipTarget: RenderTarget | null = null;
  scenes: SceneRuntime[];
  quality: 'xl' | 'md';
  width = 1;
  height = 1;
  dpr = 1;
  /** смещение мыши в −1…1 */
  pointer = { x: 0, y: 0 };
  pointerSmooth = { x: 0, y: 0 };
  private textures = new Map<string, Texture>();
  /** загруженные текстуры, которые ещё не залиты в видеопамять */
  private cold: Texture[] = [];
  private onProgress?: StageOptions['onProgress'];
  private still: boolean;
  private start = performance.now();
  /** прогресс и время прошлого кадра — по ним считается темп для смаза */
  private prev: { t: number; at: number } | null = null;
  /** сглаженный темп: прогресс t в секунду */
  private flow = 0;
  /** он же с коротким сглаживанием — чтобы заметить остановку, но не реагировать на один неровный кадр */
  private flowNow = 0;
  /** время кадра, с — для покачивания и ветра */
  private time = 0;
  private frameNo = 0;
  /** на сколько px экрана сейчас смещён от своего места слой с покачиванием (аэростат) — к нему привязаны линии оверлея */
  floating: [number, number] = [0, 0];
  ready = false;

  constructor(opts: StageOptions) {
    this.quality = opts.quality;
    this.onProgress = opts.onProgress;
    this.still = !!opts.still;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer = new Renderer({
      canvas: opts.canvas, dpr: this.dpr, alpha: false, antialias: false,
      premultipliedAlpha: true, powerPreference: 'high-performance', webgl: 2,
    });
    const gl = this.renderer.gl;
    this.gl = gl;
    if (!this.renderer.isWebgl2) console.warn('[stage] WebGL2 недоступен — дефокус через mip отключён');
    gl.clearColor(0.98, 0.957, 0.941, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    const geometry = new Geometry(gl, {
      position: { size: 2, data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]) },
      uv: { size: 2, data: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]) },
    });
    this.program = new Program(gl, {
      vertex: VERT, fragment: FRAG, transparent: true, depthTest: false, depthWrite: false, cullFace: false,
      uniforms: {
        tMap: { value: null }, uRect: { value: [0, 0, 1, 1] }, uViewport: { value: [1, 1] },
        uRotate: { value: 0 }, uLod: { value: 0 }, uSoft: { value: 0 }, uAlpha: { value: 1 }, uDim: { value: 0 },
        uDof: { value: [0, 0, 0, 0] }, uBlur: { value: [0, 0, 1, 0] }, uLodMax: { value: 0 },
        uQuad: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }, uQuadOn: { value: 0 }, uSway: { value: [0, 0, 0] }, uTwinkle: { value: [0, 0, 0, 0] }, uTwinkleDepth: { value: 0 },
        uHaze: { value: [0, 0, 1, 1] }, uHaze2: { value: [0, 0, 0, 1] }, uHazeAmp: { value: [0, 0] },
        uMotion: { value: [0, 0] }, uCloud: { value: [0, 0, 0, 0] }, uCloudGrain: { value: [1, 1] },
      },
    });
    this.mesh = new Mesh(gl, { geometry, program: this.program, mode: gl.TRIANGLE_STRIP });
    this.mipMesh = new Mesh(gl, {
      geometry, mode: gl.TRIANGLE_STRIP,
      program: new Program(gl, {
        vertex: MIP_VERT, fragment: MIP_FRAG, depthTest: false, depthWrite: false, cullFace: false,
        uniforms: { tMap: { value: null }, uLevel: { value: 0 }, uTexel: { value: [0, 0] } },
      }),
    });

    this.scenes = scenes.map((def) => ({
      def,
      layers: def.layers.map((l, i) => ({ def: l, texture: null, size: [1, 1], aspect: 1, phase: (i * 7.31 + def.id.length * 3.17) % 23 })),
    }));
    this.resize();
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.renderer.setSize(this.width, this.height);
    this.program.uniforms.uViewport.value = [this.width, this.height];
  }

  /** Загрузка текстур. Сначала первые локации (чтобы стартовать быстрее), потом остальные. */
  async load(): Promise<void> {
    const ids = new Set<string>();
    for (const s of this.scenes) for (const l of s.layers) {
      if (l.def.video) this.attachVideo(l); else ids.add(l.def.img);
    }
    const list = [...ids];
    let done = 0;
    const total = list.length;
    const loadOne = async (id: string) => {
      const tex = await this.loadTexture(id);
      for (const s of this.scenes) for (const l of s.layers) if (l.def.img === id) {
        l.texture = tex;
        const img = tex.image as unknown as ImageBitmap;
        const w = img.width, h = img.height;
        l.size = [w, h];
        l.aspect = w / h;
      }
      done++;
      this.onProgress?.(done, total);
    };
    // первая волна: то, что видно на старте, — первые две локации и аэростат
    const early = new Set(this.scenes.filter((s) => ['s1', 's2', 'airship'].includes(s.def.id)).flatMap((s) => s.layers.map((l) => l.def.img)));
    const first = list.filter((id) => early.has(id));
    await Promise.all(first.map(loadOne));
    while (this.warm()) { /* стартовые текстуры — в видеопамять ещё под загрузчиком */ }
    this.ready = true;
    // остальное — параллельно, по 3 за раз, чтобы не душить сеть
    const rest = list.filter((id) => !first.includes(id));
    const queue = [...rest];
    const worker = async () => { while (queue.length) await loadOne(queue.shift()!); };
    await Promise.all([worker(), worker(), worker()]);
  }

  /**
   * Видео на слое: экран монитора, планшета. Грузится само, загрузчик его не ждёт; играет только пока слой
   * в кадре. Без звука и в строке — иначе браузер не даст запустить его без жеста. Если запуск не удался
   * (режим энергосбережения на телефоне), на экране остаётся первый кадр.
   */
  private attachVideo(l: LayerRuntime) {
    const gl = this.gl;
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    v.src = `/video/${l.def.video}.mp4`;
    l.video = v;
    l.texture = new Texture(gl, {
      generateMipmaps: false, minFilter: gl.LINEAR, magFilter: gl.LINEAR,
      premultiplyAlpha: false, flipY: false, wrapS: gl.CLAMP_TO_EDGE, wrapT: gl.CLAMP_TO_EDGE,
    });
    l.size = [640, 360];
  }

  private async loadTexture(id: string): Promise<Texture> {
    const cached = this.textures.get(id);
    if (cached) return cached;
    const gl = this.gl;
    let bitmap: ImageBitmap;
    const paint = this.scenes.flatMap((s) => s.layers).find((l) => l.def.img === id)?.def.paint;
    if (paint) {
      // процедурная текстура: рисуется на канвасе, в сеть не ходим
      bitmap = await createImageBitmap(paintCanvas(paint), { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
    } else {
      const url = `/img/${id}-${this.quality}.webp`;
      const res = await fetch(url);
      const blob = await res.blob();
      bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
    }
    const tex = new Texture(gl, {
      image: bitmap as unknown as HTMLImageElement,
      generateMipmaps: true,
      minFilter: gl.LINEAR_MIPMAP_LINEAR,
      magFilter: gl.LINEAR,
      premultiplyAlpha: false, // ImageBitmap уже премультиплицирован
      flipY: false,
      anisotropy: 4,
      wrapS: gl.CLAMP_TO_EDGE, wrapT: gl.CLAMP_TO_EDGE,
    });
    this.textures.set(id, tex);
    this.cold.push(tex);
    return tex;
  }

  /**
   * Залить в видеопамять одну загруженную, но ещё не показанную текстуру. Возвращает false, если таких нет.
   * Заливка большой текстуры с мипами — десятки миллисекунд; если оставить её до первого появления
   * слоя, каждый переход между локациями начинается с рывка. Поэтому app.ts вызывает warm(),
   * пока сцена стоит на остановке.
   */
  warm(): boolean {
    const tex = this.cold.shift();
    if (!tex) return false;
    this.upload(tex);
    return true;
  }

  /** Залить текстуру в видеопамять и пересчитать её мипы для размытия (см. MIP_FRAG) */
  private upload(tex: Texture) {
    tex.update();
    if (!this.renderer.isWebgl2) return;
    const gl = this.gl as unknown as WebGL2RenderingContext;
    const img = tex.image as unknown as ImageBitmap;
    let w = img.width, h = img.height;
    const u = this.mipMesh.program.uniforms;
    u.tMap.value = tex;
    for (let level = 1; w > 1 || h > 1; level++) {
      const sw = w, sh = h;
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      if (level < MIP_REFINE_FROM) continue;
      // Уровень рисуется в отдельный буфер и копируется в текстуру: рисовать прямо в неё, читая из неё же, нельзя
      if (!this.mipTarget || this.mipTarget.width < w || this.mipTarget.height < h) {
        if (this.mipTarget) { gl.deleteFramebuffer(this.mipTarget.buffer); gl.deleteTexture(this.mipTarget.texture.texture); }
        this.mipTarget = new RenderTarget(this.gl, { width: w, height: h, depth: false, minFilter: gl.NEAREST, magFilter: gl.NEAREST });
      }
      this.renderer.bindFramebuffer(this.mipTarget);
      gl.viewport(0, 0, w, h);
      u.uLevel.value = level - 1;
      u.uTexel.value = [1 / sw, 1 / sh];
      this.mipMesh.draw();
      this.renderer.activeTexture(0);
      tex.bind();
      gl.copyTexSubImage2D(gl.TEXTURE_2D, level, 0, 0, 0, 0, w, h);
    }
    this.renderer.bindFramebuffer();
    // всё залито — буфер для пересчёта больше не нужен
    if (!this.cold.length && this.mipTarget && this.scenes.every((sc) => sc.layers.every((l) => l.texture))) {
      gl.deleteFramebuffer(this.mipTarget.buffer); gl.deleteTexture(this.mipTarget.texture.texture);
      this.mipTarget = null;
    }
  }

  /** Прогресс поставили скачком (отладка, возврат к началу): следующий кадр рисуется без смаза */
  cut() {
    this.prev = null;
    this.flow = this.flowNow = 0;
  }

  /** Сменить плотность пикселей канваса (app.ts понижает её, если кадры не успевают) */
  setDpr(dpr: number) {
    this.dpr = dpr;
    this.renderer.dpr = dpr;
    this.resize();
  }

  /**
   * Опорный фрейм (1920×1080, у мобильных сцен 393×645) вписывается в экран по принципу cover.
   * Возвращает масштаб и смещение так, что фрейм покрывает экран.
   */
  refTransform(ref: Ref = DESKTOP_REF) {
    const scale = Math.max(this.width / ref[0], this.height / ref[1]);
    return { scale, ox: (this.width - ref[0] * scale) / 2, oy: (this.height - ref[1] * scale) / 2 };
  }

  /** Экранные координаты для точки в пространстве сцены (для DOM-оверлея и огней) */
  projectScene(scene: SceneDef, t: number, x: number, y: number, depth = 0): [number, number, number] {
    const cam = sampleRect(scene.cam, t);
    const ref = scene.ref ?? DESKTOP_REF;
    const { scale: s } = this.camTransform(cam, depth, ref);
    const cx = cam[0] + cam[2] / 2, cy = cam[1] + cam[3] / 2;
    return [(x - cx) * s + this.width / 2 + this.focusShift(scene, t, cam), (y - cy) * s + this.height / 2, s];
  }

  /** Масштаб экрана для камеры с учётом глубины (параллакс) */
  private camTransform(cam: Rect, depth: number, ref: Ref) {
    const base = Math.max(this.width / cam[2], this.height / cam[3]);
    const zoom = ref[0] / cam[2];
    // ближние слои растут быстрее фона, дальние — медленнее
    const scale = base * Math.pow(zoom, depth * 0.18);
    return { scale, zoom };
  }

  /**
   * Сдвиг кадра по горизонтали на узком экране. Кадр 16:9 вписан по cover, и на портретном экране
   * от него остаётся средняя треть — главный объект локации (техник, куб, дом) может оказаться за краем.
   * focus — доля ширины кадра, которую нужно держать в центре; сдвиг не выходит за запас кадра.
   */
  private focusShift(scene: SceneDef, t: number, cam: Rect): number {
    if (scene.focus === undefined || this.width > FOCUS_MAX_WIDTH) return 0;
    const scale = Math.max(this.width / cam[2], this.height / cam[3]);
    const spare = (cam[2] * scale - this.width) / 2;
    if (spare <= 0) return 0;
    const want = (0.5 - sampleNumber(scene.focus, t, 0.5)) * cam[2] * scale;
    return Math.max(-spare, Math.min(spare, want));
  }

  /**
   * Сдвиг от мыши для слоя. Объект, обрезанный краем экрана, не может «отъехать» от этого края
   * внутрь (иначе открывается щель и он левитирует). Допустимый сдвиг внутрь плавно растёт
   * от 0 у кромки до полного, когда край объекта отстоит от кромки на величину амплитуды.
   */
  private parallaxOffset(r: Rect, depth: number): [number, number] {
    if (!depth) return [0, 0];
    const amp = 22 * Math.min(1.5, Math.abs(depth));
    const px = this.pointerSmooth.x, py = this.pointerSmooth.y;
    const W = this.width, H = this.height;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    let dx = -px * amp * Math.sign(depth), dy = -py * amp * Math.sign(depth);
    if (dx < 0) dx = Math.max(dx, -clamp(W - (r[0] + r[2]), 0, amp)); // влево: щель у правого края
    if (dx > 0) dx = Math.min(dx, clamp(r[0], 0, amp));               // вправо: щель у левого края
    if (dy < 0) dy = Math.max(dy, -clamp(H - (r[1] + r[3]), 0, amp)); // вверх: щель у нижнего края
    if (dy > 0) dy = Math.min(dy, clamp(r[1], 0, amp));               // вниз: щель у верхнего края
    return [dx, dy];
  }

  /** Прямоугольник в пространстве сцены → экран через её камеру (без сдвига от мыши) */
  private throughCamera(r: Rect, scene: SceneDef, t: number, cam: Rect, depth: number): Rect {
    const { scale } = this.camTransform(cam, depth, scene.ref ?? DESKTOP_REF);
    const cx = cam[0] + cam[2] / 2, cy = cam[1] + cam[3] / 2;
    const w = r[2] * scale, h = r[3] * scale;
    return [(r[0] + r[2] / 2 - cx) * scale + this.width / 2 - w / 2 + this.focusShift(scene, t, cam), (r[1] + r[3] / 2 - cy) * scale + this.height / 2 - h / 2, w, h];
  }

  /** Прямоугольник в координатах экрана-фрейма → экран */
  private throughFrame(r: Rect, ref: Ref, shift: number): Rect {
    const { scale, ox, oy } = this.refTransform(ref);
    return [ox + r[0] * scale + shift, oy + r[1] * scale, r[2] * scale, r[3] * scale];
  }

  /** Ключ трека: из пространства своей сцены (или экрана, если сцены нет) → экран */
  private project(r: Rect, sceneId: string | undefined, t: number, depth: number, own: SceneDef, shift: number): Rect {
    if (!sceneId) return this.throughFrame(r, own.ref ?? DESKTOP_REF, shift);
    const sc = this.scenes.find((s) => s.def.id === sceneId)!.def;
    return this.throughCamera(r, sc, t, sampleRect(sc.cam, t), depth);
  }

  /** Место слоя на экране: по трекам и камере, плюс сдвиг от мыши */
  private layerScreenRect(layer: LayerDef, scene: SceneDef, t: number, cam: Rect): Rect {
    const out = this.layerBaseRect(layer, scene, t, cam);
    const depth = layer.depth ?? 0;
    // спрайт, привязанный к соседнему слою (куст на поле), сдвигается от мыши ровно как он — иначе разъедутся
    const host = layer.attach ? scene.layers.find((h) => h.id === layer.attach) : undefined;
    let [dx, dy] = this.parallaxOffset(host ? this.layerBaseRect(host, scene, t, cam) : out, host ? host.depth ?? 0 : depth);
    if (layer.hover || layer.bob) {
      // предмет в воздухе: слегка идёт за мышью и покачивается сам
      const k = this.refTransform(scene.ref ?? DESKTOP_REF).scale;
      const fx = -this.pointerSmooth.x * (layer.hover ?? 0) * k;
      const fy = (-this.pointerSmooth.y * (layer.hover ?? 0) * 0.6 + (this.still ? 0 : (layer.bob ?? 0) * Math.sin(this.time * 0.8))) * k;
      dx += fx; dy += fy;
      this.floating = [fx, fy];
    }
    return [out[0] + dx, out[1] + dy, out[2], out[3]];
  }

  private layerBaseRect(layer: LayerDef, scene: SceneDef, t: number, cam: Rect): Rect {
    const depth = layer.depth ?? 0;
    const ref = scene.ref ?? DESKTOP_REF;
    const shift = this.focusShift(scene, t, cam);
    const keys = layer.rect as Key<Rect>[];
    let out: Rect;
    // Ключи с привязкой к сценам: соседние ключи проецируем через камеры их сцен и интерполируем
    // уже на экране — объект едет вместе с камерой и передаётся между локациями без скачка.
    // Участки, где привязки нет ни у одного из соседних ключей, идут общим сплайном, как обычный трек:
    // иначе слой останавливался бы на каждом ключе.
    if (Array.isArray(keys) && typeof keys[0]?.f === 'number' && keys.some((k) => k.in)) {
      const [a, b, u0] = segment(keys, t);
      const run = a !== b && !a.in && !b.in ? plainRun(keys, a) : null;
      if (run) {
        out = this.throughFrame(sampleRect(run, t), ref, shift);
      } else {
        const ra = this.project(a.v, a.in, t, depth, scene, shift);
        out = a === b ? ra : lerpRect(ra, this.project(b.v, b.in, t, depth, scene, shift), smooth(u0));
      }
    } else {
      let r = sampleRect(layer.rect as any, t);
      // Облако плывёт вместе с прокруткой: чем дальше ушли кадры, тем дальше оно сместилось — у каждого
      // со своей скоростью. На кадре driftFrom оно стоит на месте из макета. Уйдя за край кадра целиком,
      // оно возвращается с другой стороны — тоже за кадром, так что переноса не видно.
      if (layer.drift && scene.driftFrom !== undefined) {
        const frames = tToFrame(t) - scene.driftFrom;
        const span = ref[0] + r[2] + DRIFT_PAD * 2;
        const x = r[0] + layer.drift * (scene.driftAfter ? Math.max(0, frames) : frames) + r[2] + DRIFT_PAD;
        r = [((x % span) + span) % span - r[2] - DRIFT_PAD, r[1], r[2], r[3]];
      }
      if (layer.space === 'screen') {
        out = this.throughFrame(r, ref, shift);
      } else {
        out = this.throughCamera(r, scene, t, cam, depth);
        // Фон во весь кадр должен закрывать экран при любом положении камеры: ключи камеры из макета
        // могут выходить за кадр на пару px, а камера шире кадра (вид из окна) открыла бы края.
        if (depth === 0 && r[2] === ref[0] && r[3] === ref[1]) {
          let [ox, oy, w, h] = out;
          const cover = Math.max(this.width / w, this.height / h);
          if (cover > 1) { ox -= (w * (cover - 1)) / 2; oy -= (h * (cover - 1)) / 2; w *= cover; h *= cover; }
          out = [Math.min(0, Math.max(this.width - w, ox)), Math.min(0, Math.max(this.height - h, oy)), w, h];
        }
      }
    }
    return out;
  }

  /**
   * Где сейчас на экране слой (с камерой и сдвигом от мыши) — чтобы огни оверлея, привязанные к точкам
   * этого слоя, шли вместе с ним. null — такого слоя нет.
   */
  screenRectOf(sceneId: string, layerId: string, t: number): Rect | null {
    const s = this.scenes.find((sc) => sc.def.id === sceneId);
    const l = s?.def.layers.find((ld) => ld.id === layerId);
    return s && l ? this.layerScreenRect(l, s.def, t, sampleRect(s.def.cam, t)) : null;
  }

  /** Состояние сцен на момент t — используется и для DOM-оверлея */
  sampleScene(scene: SceneDef, t: number) {
    return {
      cam: sampleRect(scene.cam, t),
      alpha: sampleNumber(scene.alpha, t, 1),
      dim: sampleNumber(scene.dim, t, 0),
      blur: sampleNumber(scene.blur, t, 0),
    };
  }

  /** @param now — время кадра; по умолчанию текущее (в отладке кадры снимаются по своим часам) */
  render(t: number, now = performance.now()) {
    const gl = this.gl;
    const time = (now - this.start) / 1000;
    this.time = time;
    this.frameNo++;
    this.floating = [0, 0];
    // плавная мышь
    this.pointerSmooth.x += (this.pointer.x - this.pointerSmooth.x) * 0.06;
    this.pointerSmooth.y += (this.pointer.y - this.pointerSmooth.y) * 0.06;

    // Слой показывается раньше, чем до его текстуры дошла очередь в warm(): заливаем её сейчас, до кадра
    if (this.cold.length) {
      for (const s of this.scenes) {
        if (sampleNumber(s.def.alpha, t, 1) <= 0.002) continue;
        for (const l of s.layers) {
          const i = l.texture ? this.cold.indexOf(l.texture) : -1;
          if (i >= 0) this.upload(this.cold.splice(i, 1)[0]);
        }
      }
    }

    this.renderer.bindFramebuffer();
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const u = this.program.uniforms;
    const maxLod = this.renderer.isWebgl2 ? 7 : 0;

    // Темп для смаза. Скорость одного кадра не годится: колесо мыши двигает сцену толчками, а кадры
    // приходят неровно, и смаз мигал бы вместе с ними. Берём сглаженный темп, но не больше удвоенного
    // текущего (он тоже сглажен, только коротко) — встали или развернулись, и смаза нет почти сразу.
    const dt = this.prev ? Math.max(4, Math.min(100, now - this.prev.at)) : 0;
    const inst = dt ? ((t - this.prev!.t) / dt) * 1000 : 0;
    if (dt) {
      this.flow += (inst - this.flow) * (1 - Math.exp(-dt / SMEAR_SMOOTH_MS));
      this.flowNow += (inst - this.flowNow) * (1 - Math.exp(-dt / SMEAR_STOP_MS));
    }
    this.prev = { t, at: now };
    const pace = this.still || this.flowNow * this.flow <= 0 ? 0 : Math.sign(this.flow) * Math.min(Math.abs(this.flow), Math.abs(this.flowNow) * 2);
    // сколько прогресса проходит за выдержку и куда смотреть, чтобы измерить ход слоя (у конца таймлайна — назад)
    const exposure = (pace * SHUTTER_MS) / 1000;
    const probe = t + SMEAR_PROBE <= 1 ? SMEAR_PROBE : -SMEAR_PROBE;
    const smear = Math.abs(exposure) > 1e-7;

    for (const s of this.scenes) {
      const st = this.sampleScene(s.def, t);
      if (st.alpha <= 0.002) continue;
      const camAhead = smear ? sampleRect(s.def.cam, t + probe) : st.cam;
      // сколько пикселей канваса приходится на 1 px макета: в этих единицах задано размытие
      const frame = this.refTransform(s.def.ref ?? DESKTOP_REF).scale * this.dpr;
      for (const l of s.layers) {
        if (!l.texture) continue;
        if (l.def.minWidth && this.width < l.def.minWidth) continue;
        // слой со сменой света проступает и уходит по времени: медленно, с задержкой в крайних положениях
        let la = sampleNumber(l.def.alpha, t, 1) * st.alpha;
        if (l.def.pulse && !this.still) { const w = 0.5 - 0.5 * Math.cos((time / l.def.pulse) * Math.PI * 2); la *= w * w * (3 - 2 * w); }
        if (la <= 0.002) continue;
        let rect = this.layerScreenRect(l.def, s.def, t, st.cam);
        // Четырёхугольник (экран под углом): углы заданы в долях прямоугольника слоя; рисуется их рамка,
        // а шейдер натягивает текстуру на сам четырёхугольник
        let quad: Float32Array | null = null;
        if (l.def.quad) {
          const q = l.def.quad, xs = [0, 2, 4, 6].map((i) => rect[0] + q[i] * rect[2]), ys = [1, 3, 5, 7].map((i) => rect[1] + q[i] * rect[3]);
          const bx = Math.min(...xs) - 1, by = Math.min(...ys) - 1, bw = Math.max(...xs) + 1 - bx, bh = Math.max(...ys) + 1 - by;
          quad = quadMatrix([0, 1, 2, 3].flatMap((i) => [(xs[i] - bx) / bw, (ys[i] - by) / bh]));
          rect = [bx, by, bw, bh];
        }
        // отсечение вне экрана
        if (rect[0] > this.width || rect[1] > this.height || rect[0] + rect[2] < 0 || rect[1] + rect[3] < 0) continue;
        if (l.video) {
          // видео: играет, пока слой в кадре; новый кадр — в текстуру
          const v = l.video;
          l.seen = this.frameNo;
          if (v.paused && !this.still) v.play().catch(() => { /* автозапуск запрещён — остаётся первый кадр */ });
          if (v.readyState < 2) continue;
          if (l.texture.image !== (v as unknown as HTMLImageElement)) l.texture.image = v as unknown as HTMLImageElement;
          l.texture.needsUpdate = true;
        }
        // сколько пикселей канваса приходится на тексель: больше 1 — слой увеличен
        const mag = (rect[2] * this.dpr) / l.size[0];
        // размытие задано в px макета — переводим в тексели, чтобы оно выглядело одинаково на любом экране
        const blurTex = ((sampleNumber(l.def.blur, t, 0) + st.blur) * frame) / mag;

        // Смаз: слой, который быстро едет через экран, слегка размывается вдоль своего движения —
        // короткая выдержка, только чтобы панорама не дробилась на отдельные кадры. На стоящем кадре его нет.
        // Куда и как быстро едет слой, берётся из самих треков (его место при t и чуть дальше), а не из
        // разницы с прошлым кадром: длина следа меняется плавно и не зависит от того, как пришли кадры.
        // Меряется ход того, что сейчас в середине экрана. При наезде точки кадра расходятся от центра
        // зума в разные стороны, общий смаз в одну сторону там неправда — поэтому из хода вычитается то,
        // на сколько за ту же выдержку расходятся середина и угол экрана: смаз остаётся только панорамам.
        let mx = 0, my = 0;
        if (smear && !l.def.drift && !l.def.quad && !l.def.hover) {
          const ahead = this.layerScreenRect(l.def, s.def, t + probe, camAhead);
          const k = exposure / probe;
          const grow = Math.log(ahead[2] / rect[2]);
          const cx = rect[0] + rect[2] / 2, cy = rect[1] + rect[3] / 2;
          const sx = (ahead[0] + ahead[2] / 2 - cx + grow * (this.width / 2 - cx)) * k;
          const sy = (ahead[1] + ahead[3] / 2 - cy + grow * (this.height / 2 - cy)) * k;
          const speed = Math.hypot(sx, sy);
          const len = Math.min(SMEAR_MAX, speed - (Math.abs(grow * k) * Math.hypot(this.width, this.height)) / 2 - SMEAR_FROM);
          if (len > 0) { mx = ((sx / speed) * len) / rect[2]; my = ((sy / speed) * len) / rect[3]; }
        }

        u.tMap.value = l.texture;
        u.uRect.value = rect;
        u.uRotate.value = ((l.def.rotate ?? 0) * Math.PI) / 180;
        // уровень мипа — по уменьшению слоя на экране и радиусу размытия в текселях
        u.uLod.value = Math.min(maxLod, Math.log2(Math.max(1, 1 / mag) + blurTex));
        // бикубический фильтр нужен при размытии и при заметном увеличении; на 1:1 он только мылит,
        // поэтому включается плавно — без скачка резкости, когда размытие сходит на нет
        u.uSoft.value = maxLod && !l.video ? Math.max(0, Math.min(1, Math.max(mag - 1, blurTex))) : 0;
        u.uQuadOn.value = quad ? 1 : 0;
        if (quad) u.uQuad.value = quad;
        // ветер и мигание — в единицах макета, одинаковы на любом экране
        const lw = l.def.sway || l.def.twinkle ? sampleRect(l.def.rect as Key<Rect>[] | Rect, t)[2] : 1;
        u.uSway.value = l.def.sway && !this.still ? [l.def.sway / lw, time * (0.7 + (l.phase % 5) * 0.09) + l.phase, l.phase * 1.7] : [0, 0, 0];
        if (l.def.twinkle && !this.still) {
          // Мигает то, что в фокусе. Размытый огонёк — пятно шире ячейки: мигание отдельных ячеек дробило бы его
          // на квадраты, поэтому с ростом размытия оно сходит на нет.
          const cell = lw / l.def.twinkle.grid[0];
          const blurPx = sampleNumber(l.def.blur, t, 0) + st.blur + (l.def.dof ? sampleNumber(l.def.dof.blur, t, 0) : 0);
          u.uTwinkle.value = [l.def.twinkle.grid[0], l.def.twinkle.grid[1], l.def.twinkle.share, time];
          u.uTwinkleDepth.value = 1 / (1 + 6 * (blurPx / cell) ** 2);
        } else {
          u.uTwinkleDepth.value = 0;
        }
        // зона резкости (LayerDef.dof): эллипс из пространства слоя → в его uv
        const around = l.def.dof && maxLod ? sampleNumber(l.def.dof.blur, t, 0) : 0;
        if (around > 0.01) {
          const lr = sampleRect(l.def.rect as Key<Rect>[] | Rect, t), z = l.def.dof!.zone;
          u.uDof.value = [(z[0] + z[2] / 2 - lr[0]) / lr[2], (z[1] + z[3] / 2 - lr[1]) / lr[3], lr[2] / (z[2] / 2), lr[3] / (z[3] / 2)];
          u.uBlur.value = [blurTex, (around * frame) / mag, Math.max(1, 1 / mag), mag - 1];
          u.uLodMax.value = maxLod;
        } else {
          u.uDof.value = [0, 0, 0, 0];
        }
        u.uAlpha.value = la;
        u.uDim.value = 1 - (1 - (l.def.lit ? 0 : st.dim)) * (l.def.gain ?? 1);
        // струи воздуха: зоны заданы в том же пространстве, что и rect слоя
        const haze = l.def.haze && !this.still ? sampleNumber(l.def.haze.amp, t, 0) : 0;
        if (haze > 0.01) {
          const lr = sampleRect(l.def.rect as Key<Rect>[] | Rect, t);
          const zone = (z?: Rect) => (z ? [(z[0] + z[2] / 2 - lr[0]) / lr[2], (z[1] + z[3] - lr[1]) / lr[3], z[2] / 2 / lr[2], z[3] / lr[3]] : [0, 0, 0, 1]);
          u.uHaze.value = zone(l.def.haze!.zones[0]);
          u.uHaze2.value = zone(l.def.haze!.zones[1]);
          u.uHazeAmp.value = [haze / lr[2], haze / lr[3]];
        } else {
          u.uHazeAmp.value = [0, 0];
        }
        u.uMotion.value = [mx, my];
        if (l.def.cloud && !this.still) {
          // амплитуда и размер «клубов» заданы в px макета — одинаковы у большого и у маленького облака
          const k = frame / this.dpr;
          u.uCloud.value = [(l.def.cloud * k) / rect[2], (l.def.cloud * k) / rect[3], time, l.phase];
          u.uCloudGrain.value = [rect[2] / (CLOUD_GRAIN * k), rect[3] / (CLOUD_GRAIN * k)];
        } else {
          u.uCloud.value = [0, 0, time, l.phase];
        }
        // режим наложения: OGL выставляет его из программы при каждом draw
        if (l.def.blend === 'add') this.program.setBlendFunc(gl.ONE, gl.ONE);
        else if (l.def.blend === 'screen') this.program.setBlendFunc(gl.ONE_MINUS_DST_COLOR, gl.ONE);
        else this.program.setBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        this.mesh.draw();
      }
    }
    // видео, чей слой в этом кадре не рисовался, не играет
    for (const s of this.scenes) for (const l of s.layers) if (l.video && l.seen !== this.frameNo && !l.video.paused) l.video.pause();
  }
}
