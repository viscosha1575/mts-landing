/**
 * WebGL-сцена на OGL. Никакого 3D: каждый слой — текстурированный квад, который
 * позиционируется 2D-камерой (прямоугольник видимой области в координатах локации).
 *
 * Эффекты, которые делаются «бесплатно» в шейдере:
 *  - дефокус: смещение mip-уровня (texture bias) + 4 тапа, чтобы скрыть блочность мипов;
 *  - затемнение и лёгкий цветовой сдвиг для перехода в дата-центр;
 *  - premultiplied-alpha смешивание, чтобы края вырезанных объектов не светились.
 */
import { Renderer, Program, Mesh, Geometry, Texture, type OGLRenderingContext } from 'ogl';
import { scenes, type LayerDef, type SceneDef } from '../scenes';
import { REF_W, REF_H, sampleNumber, sampleRect, segment, lerpRect, easings, type Key, type Rect } from '../timeline';


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
uniform float uBlur;     // mip bias
uniform float uAlpha;
uniform float uDim;      // 0..1
uniform vec2 uTexel;     // 1/размер текстуры
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 col;
  if (uBlur < 0.05) {
    col = texture(tMap, vUv);
  } else {
    // 8 тапов по кольцу + mip bias: мягкий дефокус без ступенек и «креста»
    float r = pow(2.0, uBlur) * 0.55;
    vec2 o = uTexel * r;
    col  = texture(tMap, vUv, uBlur) * 2.0;
    col += texture(tMap, vUv + vec2( o.x,  0.0), uBlur);
    col += texture(tMap, vUv + vec2(-o.x,  0.0), uBlur);
    col += texture(tMap, vUv + vec2( 0.0,  o.y), uBlur);
    col += texture(tMap, vUv + vec2( 0.0, -o.y), uBlur);
    col += texture(tMap, vUv + vec2( o.x,  o.y) * 0.707, uBlur);
    col += texture(tMap, vUv + vec2(-o.x,  o.y) * 0.707, uBlur);
    col += texture(tMap, vUv + vec2( o.x, -o.y) * 0.707, uBlur);
    col += texture(tMap, vUv + vec2(-o.x, -o.y) * 0.707, uBlur);
    col *= 0.1;
  }
  // текстура премультиплицирована; затемнение — к цвету, не к альфе
  vec3 rgb = col.rgb * (1.0 - uDim);
  fragColor = vec4(rgb, col.a) * uAlpha;
}`;

export interface Camera { rect: Rect }

export interface StageOptions {
  canvas: HTMLCanvasElement;
  /** качество текстур */
  quality: 'xl' | 'md';
  onProgress?: (loaded: number, total: number) => void;
}

interface LayerRuntime {
  def: LayerDef;
  texture: Texture | null;
  texel: [number, number];
  aspect: number;
}
interface SceneRuntime { def: SceneDef; layers: LayerRuntime[] }

export class Stage {
  renderer: Renderer;
  gl: OGLRenderingContext;
  program: Program;
  mesh: Mesh;
  scenes: SceneRuntime[];
  quality: 'xl' | 'md';
  width = 1;
  height = 1;
  dpr = 1;
  /** смещение мыши в −1…1 */
  pointer = { x: 0, y: 0 };
  pointerSmooth = { x: 0, y: 0 };
  private textures = new Map<string, Texture>();
  private onProgress?: StageOptions['onProgress'];
  ready = false;

  constructor(opts: StageOptions) {
    this.quality = opts.quality;
    this.onProgress = opts.onProgress;
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
        uRotate: { value: 0 }, uBlur: { value: 0 }, uAlpha: { value: 1 }, uDim: { value: 0 }, uTexel: { value: [0, 0] },
      },
    });
    this.mesh = new Mesh(gl, { geometry, program: this.program, mode: gl.TRIANGLE_STRIP });

    this.scenes = scenes.map((def) => ({
      def,
      layers: def.layers.map((l) => ({ def: l, texture: null, texel: [0, 0], aspect: 1 })),
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
    for (const s of this.scenes) for (const l of s.layers) ids.add(l.def.img);
    const list = [...ids];
    let done = 0;
    const total = list.length;
    const loadOne = async (id: string) => {
      const tex = await this.loadTexture(id);
      for (const s of this.scenes) for (const l of s.layers) if (l.def.img === id) {
        l.texture = tex;
        const img = tex.image as unknown as ImageBitmap;
        const w = img.width, h = img.height;
        l.texel = [1 / w, 1 / h];
        l.aspect = w / h;
      }
      done++;
      this.onProgress?.(done, total);
    };
    // первая волна: то, что видно на старте
    const first = list.filter((id) => id.startsWith('s1') || id === 'airship' || id.startsWith('s2'));
    await Promise.all(first.map(loadOne));
    this.ready = true;
    // остальное — параллельно, по 3 за раз, чтобы не душить сеть
    const rest = list.filter((id) => !first.includes(id));
    const queue = [...rest];
    const worker = async () => { while (queue.length) await loadOne(queue.shift()!); };
    await Promise.all([worker(), worker(), worker()]);
  }

  private async loadTexture(id: string): Promise<Texture> {
    const cached = this.textures.get(id);
    if (cached) return cached;
    const gl = this.gl;
    let bitmap: ImageBitmap;
    if (id.startsWith('solid:')) {
      // однотонная текстура 2×2 — для подложек
      const c = document.createElement('canvas'); c.width = c.height = 2;
      const ctx = c.getContext('2d')!; ctx.fillStyle = id.slice(6); ctx.fillRect(0, 0, 2, 2);
      bitmap = await createImageBitmap(c);
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
    return tex;
  }

  /**
   * Опорный фрейм 1479×832 вписывается в экран по принципу cover.
   * Возвращает масштаб и смещение так, что (0,0)-(1479,832) покрывает экран.
   */
  refTransform() {
    const scale = Math.max(this.width / REF_W, this.height / REF_H);
    return { scale, ox: (this.width - REF_W * scale) / 2, oy: (this.height - REF_H * scale) / 2 };
  }

  /** Экранные координаты для точки в пространстве сцены (для DOM-оверлея) */
  projectScene(cam: Rect, x: number, y: number, depth = 0): [number, number, number] {
    const { scale: s } = this.camTransform(cam, depth);
    const cx = cam[0] + cam[2] / 2, cy = cam[1] + cam[3] / 2;
    return [(x - cx) * s + this.width / 2, (y - cy) * s + this.height / 2, s];
  }

  /** Масштаб экрана для камеры с учётом глубины (параллакс) */
  private camTransform(cam: Rect, depth: number) {
    const base = Math.max(this.width / cam[2], this.height / cam[3]);
    const zoom = REF_W / cam[2];
    // ближние слои растут быстрее фона, дальние — медленнее
    const scale = base * Math.pow(zoom, depth * 0.18);
    return { scale, zoom };
  }

  /**
   * Сдвиг от мыши для слоя. Объект, обрезанный краем экрана, не может «отъехать» от этого края
   * внутрь (иначе открывается щель и он левитирует). Допустимый сдвиг внутрь плавно растёт
   * от 0 у кромки до полного, когда край объекта отстоит от кромки на величину амплитуды.
   */
  private parallaxOffset(r: Rect, depth: number): [number, number] {
    if (!depth) return [0, 0];
    const amp = 22 * Math.abs(depth);
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

  /** Прямоугольник из пространства сцены (или экрана, если сцены нет) → экран */
  private project(r: Rect, sceneId: string | undefined, t: number, depth: number): Rect {
    let out: Rect;
    if (!sceneId) {
      const { scale, ox, oy } = this.refTransform();
      out = [ox + r[0] * scale, oy + r[1] * scale, r[2] * scale, r[3] * scale];
    } else {
      const sc = this.scenes.find((s) => s.def.id === sceneId)!.def;
      const cam = sampleRect(sc.cam, t);
      const { scale } = this.camTransform(cam, depth);
      const cx = cam[0] + cam[2] / 2, cy = cam[1] + cam[3] / 2;
      const w = r[2] * scale, h = r[3] * scale;
      out = [(r[0] + r[2] / 2 - cx) * scale + this.width / 2 - w / 2, (r[1] + r[3] / 2 - cy) * scale + this.height / 2 - h / 2, w, h];
    }
    const [dx, dy] = this.parallaxOffset(out, depth);
    return [out[0] + dx, out[1] + dy, out[2], out[3]];
  }

  private layerScreenRect(layer: LayerDef, t: number, cam: Rect): Rect {
    const depth = layer.depth ?? 0;
    const keys = layer.rect as Key<Rect>[];
    // Ключи с привязкой к сценам: соседние ключи проецируем через камеры их сцен и интерполируем
    // уже на экране — объект едет вместе с камерой и передаётся между локациями без скачка.
    if (Array.isArray(keys) && typeof keys[0]?.f === 'number' && keys.some((k) => k.in)) {
      const [a, b, u0] = segment(keys, t);
      const ra = this.project(a.v, a.in, t, depth);
      if (a === b) return ra;
      const rb = this.project(b.v, b.in, t, depth);
      return lerpRect(ra, rb, easings[a.ease ?? 'smooth'](u0));
    }
    const r = sampleRect(layer.rect as any, t);
    if (layer.space === 'screen') {
      const { scale, ox, oy } = this.refTransform();
      const o: Rect = [ox + r[0] * scale, oy + r[1] * scale, r[2] * scale, r[3] * scale];
      const [dx, dy] = this.parallaxOffset(o, depth);
      return [o[0] + dx, o[1] + dy, o[2], o[3]];
    }
    const { scale } = this.camTransform(cam, depth);
    const cx = cam[0] + cam[2] / 2, cy = cam[1] + cam[3] / 2;
    const lx = r[0] + r[2] / 2, ly = r[1] + r[3] / 2;
    const sx = (lx - cx) * scale + this.width / 2;
    const sy = (ly - cy) * scale + this.height / 2;
    // Фон с depth 0 при масштабе, отличном от «cover», должен всё равно закрывать экран:
    // компенсируем, слегка растягивая, если слой уже экрана.
    let w = r[2] * scale, h = r[3] * scale;
    let ox = sx - w / 2, oy = sy - h / 2;
    if (depth === 0 && r[2] === REF_W && r[3] === REF_H) {
      const cover = Math.max(this.width / w, this.height / h);
      if (cover > 1) { w *= cover; h *= cover; ox = sx - w / 2; oy = sy - h / 2; }
      // фон никогда не отходит от кромок: ключи камеры из макета могут выходить за кадр на пару px
      ox = Math.min(0, Math.max(this.width - w, ox));
      oy = Math.min(0, Math.max(this.height - h, oy));
    }
    const o: Rect = [ox, oy, w, h];
    const [dx, dy] = this.parallaxOffset(o, depth);
    return [o[0] + dx, o[1] + dy, o[2], o[3]];
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

  render(t: number) {
    const gl = this.gl;
    // плавная мышь
    this.pointerSmooth.x += (this.pointer.x - this.pointerSmooth.x) * 0.06;
    this.pointerSmooth.y += (this.pointer.y - this.pointerSmooth.y) * 0.06;

    this.renderer.bindFramebuffer();
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // OGL кэширует state; blend выставляем явно, т.к. program.use() может его переключить
    this.renderer.enable(gl.BLEND);
    this.renderer.setBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const u = this.program.uniforms;
    const maxBlur = this.renderer.isWebgl2 ? 6 : 0;

    for (const s of this.scenes) {
      const st = this.sampleScene(s.def, t);
      if (st.alpha <= 0.002) continue;
      for (const l of s.layers) {
        if (!l.texture) continue;
        if (l.def.minWidth && this.width < l.def.minWidth) continue;
        const la = sampleNumber(l.def.alpha, t, 1) * st.alpha;
        if (la <= 0.002) continue;
        const rect = this.layerScreenRect(l.def, t, st.cam);
        // отсечение вне экрана
        if (rect[0] > this.width || rect[1] > this.height || rect[0] + rect[2] < 0 || rect[1] + rect[3] < 0) continue;
        const blur = Math.min(maxBlur, sampleNumber(l.def.blur, t, 0) + st.blur);
        u.tMap.value = l.texture;
        u.uRect.value = rect;
        u.uRotate.value = ((l.def.rotate ?? 0) * Math.PI) / 180;
        u.uBlur.value = blur;
        u.uAlpha.value = la;
        u.uDim.value = st.dim;
        u.uTexel.value = l.texel;
        this.mesh.draw();
      }
    }
  }
}
