/**
 * The synaesthetic 3D view (PLAN D10). Each layer has its own visual language, driven by the
 * engine's per-sound events and features rather than a mixed FFT:
 *
 *   music  → the object. Each chord picks a shape family and the palette (pitch class → hue);
 *            notes light nodes that send rings across the skin; a strange attractor is its core.
 *   bowls  → a strike rings a cymatic (Chladni-style) pattern across the object's skin,
 *            decaying with the bowl; the beat's kick makes the object throb, slowly.
 *   chimes → (ambience) rods hanging along the far shore that glow when struck.
 *   rain   → ripples on the lake where and when drops land, streaks, a glossier landscape.
 *   wind   → curl-noise haze and aurora; gusts bend the object and warp the contour hills.
 *
 * Two render layers: the background (sky, hills, lake, reflections, rain, haze) and the object
 * layer, which runs through a feedback buffer (trails) before both are composited, bloomed and
 * finished (kaleidoscope at high Trip, chromatic aberration, grain).
 *
 * Safety: event light has slewed attacks and slow releases, trails use "lighten" so they never
 * add up, and a FlashMeter watches a 64×36 copy of every third frame; if a region nears the
 * WCAG limit (3 flashes/s) the event light is turned down until it settles.
 */

import * as THREE from 'three';
import { GPUComputationRenderer, type Variable } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { LayerId, WorldEvents, WorldFeatures } from '../../src/audio/world/WorldSynth';
import type { SurfaceId } from '../../src/audio/nature/rain/surfaces';
import { FlashMeter, type FlashReport } from './flash';
import * as S from './shaders';
import { pitchHue } from './view';


/** Hue of each layer's controls and edit glow (degrees). */
export const LAYER_HUE: Record<LayerId, number> = { rain: 196, wind: 152, chimes: 42, music: 318 };

export interface VisualWorld {
  rainRate: number;
  windAmount: number;
  sustain: number;
  chordSeconds: number;
  /** Perform processors: the looper's layers echo as longer trails, freeze slows time,
   *  tape age adds grain and fades colour, texture thickens the particle core. */
  layers: number;
  age: number;
  texture: number;
  freeze: boolean;
}

const TUBES_MAX = 8;
const NODES = 12;
const RIPPLES = 48;
const SIM = 256;
const OBJECT_Y = 2.1;
const PROBE_W = 64;
const PROBE_H = 36;

const SURFACE_KIND: Record<SurfaceId, number> = { water: 0, leaves: 1, grass: 1, stone: 2, tin: 2, glass: 2, bells: 3 };

/** Where each dial cluster floats, in world space: music around the object, ambience low. */
const ANCHORS: Record<string, THREE.Vector3> = {
  mood: new THREE.Vector3(-3.4, 3.8, 0.4),
  move: new THREE.Vector3(3.4, 3.8, 0.4),
  inst: new THREE.Vector3(-3.6, 0.8, 2.3),
  amb: new THREE.Vector3(3.6, 0.8, 2.3),
  perf: new THREE.Vector3(0, -0.6, 3.6),
};

/** Camera framing per focused layer: [position, look-at]. */
const FRAMING: Record<LayerId | 'none', [THREE.Vector3, THREE.Vector3]> = {
  none: [new THREE.Vector3(0, 3.0, 9.6), new THREE.Vector3(0, 2.0, 0)],
  music: [new THREE.Vector3(0, 2.6, 7.4), new THREE.Vector3(0, 2.1, 0)],
  chimes: [new THREE.Vector3(0.6, 3.2, 7.8), new THREE.Vector3(0, 2.5, 0)],
  rain: [new THREE.Vector3(0, 2.3, 8.8), new THREE.Vector3(0, 0.9, 0)],
  wind: [new THREE.Vector3(0, 3.8, 10.2), new THREE.Vector3(0, 3.0, 0)],
};

const named = <T extends THREE.Object3D>(name: string, o: T): T => { o.name = name; return o; };

const mulberry = (a: number) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The object's shape family for a chord root (scale step). */
function poseFor(step: number): THREE.Vector4 {
  const r = mulberry(((step % 64) + 64) * 7919 + 13);
  return new THREE.Vector4(2 + Math.floor(r() * 5), 1 + Math.floor(r() * 4), 0.22 + r() * 0.2, (r() - 0.5) * 2.4);
}

/** Linear level → 0..1 on a −60…−15 dB scale. */
const norm = (lvl: number) => Math.min(1, Math.max(0, (20 * Math.log10(lvl + 1e-9) + 60) / 45));
const ease = (cur: number, target: number, dt: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));

export interface VisualStats {
  fps: number;
  frames: number;
  scale: number;
  flash: FlashReport;
  pressure: number;
}

export class SceneView3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  private readonly bg = new THREE.Scene();
  private readonly fg = new THREE.Scene();
  private readonly post = new THREE.Scene();
  private readonly postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private rt!: { bg: THREE.WebGLRenderTarget; fg: THREE.WebGLRenderTarget; fbA: THREE.WebGLRenderTarget; fbB: THREE.WebGLRenderTarget; comp: THREE.WebGLRenderTarget };
  private readonly probe = new THREE.WebGLRenderTarget(PROBE_W, PROBE_H);
  private readonly probeBuf = new Uint8Array(PROBE_W * PROBE_H * 4);
  private probeBusy = false;
  private readonly bloom: UnrealBloomPass;
  private readonly gpu: GPUComputationRenderer;
  private readonly posVar: Variable;

  // shared uniform sets
  private readonly shapeU: Record<string, THREE.IUniform>;
  private readonly lookU: Record<string, THREE.IUniform>;
  private readonly fbMat: THREE.ShaderMaterial;
  private readonly compMat: THREE.ShaderMaterial;
  private readonly finalMat: THREE.ShaderMaterial;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly terrainMat: THREE.ShaderMaterial;
  private readonly lakeMat: THREE.ShaderMaterial;
  private readonly rainMat: THREE.ShaderMaterial;
  private readonly hazeMat: THREE.ShaderMaterial;
  private readonly attrMats: THREE.ShaderMaterial[] = [];
  private readonly rods: { pivot: THREE.Group; mirror: THREE.Group; u: { uHue: THREE.IUniform; uE: THREE.IUniform } }[] = [];
  private readonly rodShared: Record<string, THREE.IUniform>;
  private chimeGroups: THREE.Group[] = [];
  private readonly objectGroup = new THREE.Group();
  private readonly mirrorGroup = new THREE.Group();

  // world state, smoothed
  private queue: { time: number; fn: () => void }[] = [];
  private qHead = 0;
  private features: WorldFeatures | null = null;
  private world: VisualWorld = { rainRate: 5, windAmount: 0.3, sustain: 1, chordSeconds: 35, layers: 0, age: 0, texture: 0, freeze: false };
  private frozen = 0;
  private tubeHz: number[] = [];
  /** Bowl strikes → cymatic patterns on the shell, one slot per pitch class group. */
  private bowlKick = new Float32Array(TUBES_MAX);
  private bowlE = new Float32Array(TUBES_MAX);
  /** Chime strikes → rods on the shore. */
  private chimeKick = new Float32Array(TUBES_MAX);
  private chimeE = new Float32Array(TUBES_MAX);
  private beatKick = 0;
  private beatE = 0;
  private nodeBirth = new Float32Array(NODES).fill(-99);
  private nodeIdx = 0;
  private ripIdx = 0;
  private ripTokens = 10;
  private hue = 0.52;
  private hueTarget = 0.52;
  private levels: Record<LayerId, number> = { rain: 0, wind: 0, chimes: 0, music: 0 };
  private wind = 0;
  private gust = 0;
  private windPhase = 0;
  private gustPhase = 0;
  private morph = 1;
  private morphDur = 5;
  private pendingPose: THREE.Vector4 | null = null;
  private attrMix = 0;
  private attrMixTarget = 0;
  private attrD = 3.5;
  private attrDTarget = 3.5;
  private attrBoost = 0;
  private edit: Record<LayerId, number> = { rain: 0, wind: 0, chimes: 0, music: 0 };
  private focus: LayerId | null = null;
  private editing = new Set<LayerId>();
  private lastEditRipple = 0;
  private camPos = FRAMING.none[0].clone();
  private camLook = FRAMING.none[1].clone();
  private trip = 0.6;
  private reduced = false;
  private guard = 1;
  private readonly flash = new FlashMeter(PROBE_W, PROBE_H);
  private frameNo = 0;
  private vt = 0;
  private probeFailed = false;
  private syncProbe = false;
  private manualDt: number | null = null;
  private strobe = false;

  // timing and quality
  private raf = 0;
  private last = performance.now();
  private frameMs = 16;
  private scale = 1;
  private maxScale = 1;
  private pinnedScale: number | null = null;
  private slowFor = 0;
  private fastFor = 0;
  private width = 1;
  private height = 1;

  static supported(): boolean {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch {
      return false;
    }
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly audioNow: () => number,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.autoClear = true;
    this.renderer.setClearColor(0x000000, 1);
    this.maxScale = Math.min(window.devicePixelRatio || 1, 1.5);
    this.scale = this.maxScale;

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.post.add(this.quad);

    // ---------------------------------------------------------------- uniforms
    const v4s = (n: number) => Array.from({ length: n }, () => new THREE.Vector4(0, 1, 0, 99));
    this.shapeU = {
      uTime: { value: 0 },
      uPoseA: { value: poseFor(0) },
      uPoseB: { value: poseFor(0) },
      uMorph: { value: 1 },
      uNoise: { value: 0.1 },
      uBreath: { value: 0 },
      uGust: { value: new THREE.Vector3() },
      uNodes: { value: v4s(NODES) },
      uNodeInfo: { value: v4s(NODES).map(() => new THREE.Vector4()) },
      uTubeE: { value: new Array(TUBES_MAX).fill(0) },
      uTubeHue: { value: new Array(TUBES_MAX).fill(0) },
      uTubes: { value: TUBES_MAX },
    };
    this.lookU = {
      uHue: { value: this.hue },
      uSat: { value: 0.75 },
      uLevel: { value: 0 },
      uEdit: { value: 0 },
      uEditHue: { value: LAYER_HUE.music / 360 },
      uGain: { value: 1 },
      uReduced: { value: 0 },
    };
    const additive = { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide };
    const mat = (vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters> = {}) =>
      new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, ...additive, ...extra });

    // ---------------------------------------------------------------- the object
    this.objectGroup.position.y = OBJECT_Y;
    this.fg.add(this.objectGroup);
    // Reflection: the same meshes mirrored under the lake, dimmer. Shares uniforms by reference.
    this.mirrorGroup.position.y = -OBJECT_Y;
    this.mirrorGroup.scale.y = -1;
    this.mirrorGroup.renderOrder = 1;
    const addBoth = (make: (dim: number) => THREE.Object3D) => {
      this.objectGroup.add(make(1));
      const m = make(0.32);
      m.renderOrder = 1;
      this.mirrorGroup.add(m);
    };

    const shellGeo = new THREE.IcosahedronGeometry(1, 30);
    addBoth((dim) => named('shell', new THREE.Mesh(shellGeo, mat(S.SHELL_VERT, S.SHELL_FRAG, { ...this.shapeU, ...this.lookU, uDim: { value: dim } }))));
    const cageGeo = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 5));
    addBoth((dim) => named('cage', new THREE.LineSegments(cageGeo, mat(S.CAGE_VERT, S.CAGE_FRAG, { ...this.shapeU, ...this.lookU, uDim: { value: dim } }))));

    // Attractor core, simulated on the GPU.
    this.gpu = new GPUComputationRenderer(SIM, SIM, this.renderer);
    const init = this.gpu.createTexture();
    const data = init.image.data as Float32Array;
    const rnd = mulberry(7);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (rnd() - 0.5) * 0.6;
      data[i + 1] = (rnd() - 0.5) * 0.6;
      data[i + 2] = rnd() * 0.6;
      data[i + 3] = 0;
    }
    this.posVar = this.gpu.addVariable('tPos', S.ATTRACTOR_SIM, init);
    this.gpu.setVariableDependencies(this.posVar, [this.posVar]);
    Object.assign(this.posVar.material.uniforms, { uDt: { value: 0.01 }, uMix: { value: 0 }, uA: { value: 0.95 }, uD: { value: 3.5 }, uSeed: { value: 0 } });
    const err = this.gpu.init();
    if (err) throw new Error(err);
    const attrGeo = new THREE.BufferGeometry();
    const uvs = new Float32Array(SIM * SIM * 3);
    for (let j = 0; j < SIM; j++) for (let i = 0; i < SIM; i++) {
      const k = (j * SIM + i) * 3;
      uvs[k] = (i + 0.5) / SIM;
      uvs[k + 1] = (j + 0.5) / SIM;
    }
    attrGeo.setAttribute('position', new THREE.BufferAttribute(uvs, 3));
    const attrShared = { tPos: { value: null as THREE.Texture | null }, uSize: { value: 2.2 }, uPixel: { value: 1 }, uBoost: { value: 0 } };
    addBoth((dim) => {
      const m = mat(S.ATTRACTOR_VERT, S.ATTRACTOR_FRAG, { ...attrShared, ...this.lookU, uDim: { value: dim } });
      this.attrMats.push(m);
      const pts = new THREE.Points(attrGeo, m);
      pts.frustumCulled = false;
      return named('core', pts);
    });

    // Chime rods hang along the far shore (ambience), with their reflections.
    this.rodShared = { uGain: this.lookU.uGain, uEdit: { value: 0 } };
    const rodGeo = new THREE.CylinderGeometry(0.022, 0.022, 1, 6, 1, true);
    rodGeo.translate(0, -0.5, 0);
    const chimeGroup = new THREE.Group();
    const chimeMirror = new THREE.Group();
    chimeMirror.scale.y = -1;
    chimeMirror.renderOrder = 1;
    for (let i = 0; i < TUBES_MAX; i++) {
      const u = { uHue: { value: 0 }, uE: { value: 0 } };
      const make = (dim: number) => {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(rodGeo, mat(S.ROD_VERT, S.ROD_FRAG, { ...u, ...this.rodShared, uDim: { value: dim } })));
        return g;
      };
      const pivot = make(1);
      const mirror = make(0.32);
      chimeGroup.add(pivot);
      chimeMirror.add(mirror);
      this.rods.push({ pivot, mirror, u });
    }
    this.chimeGroups = [chimeGroup, chimeMirror];

    // ---------------------------------------------------------------- the place
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: S.SKY_VERT, fragmentShader: S.SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false,
      uniforms: { uTime: this.shapeU.uTime, uHue: this.lookU.uHue, uSat: this.lookU.uSat, uWind: { value: 0 }, uWindPhase: { value: 0 }, uTrip: { value: 0.6 }, uRain: { value: 0 } },
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(200, 48, 24), this.skyMat);
    sky.renderOrder = -10;
    sky.name = 'sky';
    sky.frustumCulled = false;
    this.bg.add(sky);

    this.terrainMat = new THREE.ShaderMaterial({
      vertexShader: S.TERRAIN_VERT, fragmentShader: S.TERRAIN_FRAG,
      uniforms: { uHue: this.lookU.uHue, uSat: this.lookU.uSat, uWet: { value: 0 }, uCam: { value: new THREE.Vector3() }, uGustPhase: { value: 0 }, uGust: { value: 0 } },
    });
    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(220, 220, 240, 240), this.terrainMat);
    terrain.frustumCulled = false;
    terrain.name = 'terrain';
    this.bg.add(terrain);
    this.bg.add(this.mirrorGroup);
    this.bg.add(...this.chimeGroups);

    this.lakeMat = new THREE.ShaderMaterial({
      vertexShader: S.LAKE_VERT, fragmentShader: S.LAKE_FRAG, transparent: true, depthWrite: false,
      uniforms: {
        uTime: { value: 0 }, uHue: this.lookU.uHue, uSat: this.lookU.uSat, uGain: this.lookU.uGain, uReduced: this.lookU.uReduced,
        uWet: { value: 0 }, uEdit: { value: 0 }, uCam: { value: new THREE.Vector3() },
        uRip: { value: Array.from({ length: RIPPLES }, () => new THREE.Vector4(0, 0, -99, 0)) },
        uRipK: { value: Array.from({ length: RIPPLES }, () => new THREE.Vector4()) },
      },
    });
    const lake = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), this.lakeMat);
    lake.rotation.x = -Math.PI / 2;
    lake.renderOrder = 2;
    lake.name = 'lake';
    this.bg.add(lake);

    // Rain streaks.
    const N = 2400;
    const rainGeo = new THREE.BufferGeometry();
    const seeds = new Float32Array(N * 2 * 4);
    const ends = new Float32Array(N * 2);
    const idx = new Float32Array(N * 2);
    const rr = mulberry(11);
    for (let i = 0; i < N; i++) {
      const s = [(rr() - 0.5) * 44, -26 + rr() * 34, rr(), 0.8 + rr() * 0.5];
      for (let e = 0; e < 2; e++) {
        seeds.set(s, (i * 2 + e) * 4);
        ends[i * 2 + e] = e;
        idx[i * 2 + e] = rr();
      }
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    rainGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    rainGeo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    rainGeo.setAttribute('aIndex', new THREE.BufferAttribute(idx, 1));
    this.rainMat = mat(S.RAIN_VERT, S.RAIN_FRAG, { uTime: { value: 0 }, uDensity: { value: 0 }, uWind: { value: 0 }, uHue: this.lookU.uHue });
    const rain = new THREE.LineSegments(rainGeo, this.rainMat);
    rain.frustumCulled = false;
    rain.renderOrder = 3;
    rain.name = 'rain';
    this.bg.add(rain);

    // Wind haze.
    const H = 3200;
    const hz = new Float32Array(H * 3);
    const hr = mulberry(23);
    for (let i = 0; i < H; i++) hz.set([(hr() - 0.5) * 60, 0.3 + hr() * 12, -30 + hr() * 38], i * 3);
    const hazeGeo = new THREE.BufferGeometry();
    hazeGeo.setAttribute('position', new THREE.BufferAttribute(hz, 3));
    this.hazeMat = mat(S.HAZE_VERT, S.HAZE_FRAG, { uTime: this.shapeU.uTime, uWindPhase: { value: 0 }, uPixel: { value: 1 }, uWind: { value: 0 }, uHue: this.lookU.uHue, uEdit: { value: 0 } });
    const haze = new THREE.Points(hazeGeo, this.hazeMat);
    haze.frustumCulled = false;
    haze.renderOrder = 3;
    haze.name = 'haze';
    this.bg.add(haze);

    // ---------------------------------------------------------------- post
    const quadMat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: S.QUAD_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.fbMat = quadMat(S.FEEDBACK_FRAG, {
      tCur: { value: null }, tPrev: { value: null }, uDecay: { value: 0 }, uZoom: { value: 1 }, uRot: { value: 0 }, uWarp: { value: 0 },
      uHueTurn: { value: 0 }, uTime: this.shapeU.uTime, uAspect: { value: 1 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    });
    this.compMat = quadMat(S.COMPOSITE_FRAG, { tBg: { value: null }, tFg: { value: null } });
    this.finalMat = quadMat(S.FINAL_FRAG, {
      tIn: { value: null }, uGrain: { value: 0.012 }, uKal: { value: 0 }, uSides: { value: 6 }, uKalRot: { value: 0 }, uCA: { value: 0.003 }, uExposure: { value: 1 },
      uTime: this.shapeU.uTime, uAspect: { value: 1 }, uCenter: this.fbMat.uniforms.uCenter,
    });
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.4, 0.8);

    this.setTubes([523, 587, 659, 784, 880, 1047]);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    Object.assign(window, { __tarnVisual: this });
  }

  // ------------------------------------------------------------------ inputs

  setTubes(freqs: number[]): void {
    this.tubeHz = freqs.slice(0, TUBES_MAX);
    const n = this.tubeHz.length;
    this.rods.forEach((r, i) => {
      const on = i < n;
      r.pivot.visible = r.mirror.visible = on;
      if (!on) return;
      const hz = this.tubeHz[i];
      r.u.uHue.value = pitchHue(hz) / 360;
      // An arc along the far shore, behind the object.
      const a = Math.PI * (1.18 + 0.64 * (n > 1 ? i / (n - 1) : 0.5));
      const len = Math.min(2.6, Math.max(1.1, 1.8 * Math.sqrt(523 / hz)));
      for (const g of [r.pivot, r.mirror]) {
        g.position.set(Math.cos(a) * 7.5, 4.4, Math.sin(a) * 7.5);
        g.children[0].scale.y = len;
      }
    });
  }

  setWorld(w: Partial<VisualWorld>): void {
    this.world = { ...this.world, ...w };
  }

  setTrip(v: number): void {
    this.trip = Math.min(1, Math.max(0, v));
  }

  setReduced(on: boolean): void {
    this.reduced = on;
  }

  /** A layer's dials have focus (or hover): frame it and show what its controls do. */
  setFocus(layer: LayerId | null): void {
    this.focus = layer;
  }

  /** A layer's control is being changed right now: exaggerate its visual for a moment. */
  poke(layer: LayerId): void {
    this.editing.add(layer);
    this.edit[layer] = Math.max(this.edit[layer], 0.6);
  }

  /** For tests and screenshots: fix the render scale instead of adapting it. */
  pinScale(scale: number | null): void {
    this.pinnedScale = scale;
    this.resize();
  }

  /**
   * For tests: read the flash probe synchronously. Software GL resolves async reads too late to
   * see every probe frame; on a real GPU the async path keeps up without stalling.
   */
  measureEveryProbe(on: boolean): void {
    this.syncProbe = on;
  }

  /**
   * For tests: stop the frame loop and advance in fixed steps. The audio clock is replaced by
   * the view's own clock, so pushed events land exactly when a test says they should.
   */
  step(dt: number): void {
    this.stop();
    this.manualDt = dt;
    this.frame();
  }

  /** For tests only: a deliberately unsafe full-screen strobe, to prove the flash meter catches one. */
  debugStrobe(on: boolean): void {
    this.strobe = on;
  }

  /** For tests: hide scene parts by name (sky, terrain, lake, rain, haze, shell, cage, core). */
  hide(names: string[]): void {
    for (const sc of [this.bg, this.fg]) sc.traverse((o) => { if (o.name) o.visible = !names.includes(o.name); });
  }

  /** The clock `step` runs on (seconds). */
  get clock(): number {
    return this.vt;
  }

  stats(): VisualStats {
    return { fps: 1000 / this.frameMs, frames: this.frameNo, scale: this.pinnedScale ?? this.scale, flash: this.flash.worst(), pressure: this.flash.pressure() };
  }

  /** Screen position (CSS px) of a layer's dial anchor, and a depth-based scale. */
  anchor(cluster: string): { x: number; y: number; depth: number } {
    const p = (ANCHORS[cluster] ?? ANCHORS.mood).clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.width, y: (-p.y * 0.5 + 0.5) * this.height, depth: p.z };
  }

  push(events: WorldEvents, features: WorldFeatures, timeOf: (frame: number) => number): void {
    this.features = features;
    for (const e of events.rain) {
      const t = timeOf(e.frame);
      this.queue.push({ time: t, fn: () => this.addRipple(e.pan, e.diameterMm, e.surface, e.bubbleHz, e.frame) });
    }
    for (const e of events.chimes) {
      this.queue.push({ time: timeOf(e.frame), fn: () => { if (e.tube < TUBES_MAX) this.chimeKick[e.tube] = Math.max(this.chimeKick[e.tube], e.velocity); } });
    }
    for (const e of events.music) {
      if (e.kind === 'chord') this.queue.push({ time: timeOf(e.frame), fn: () => this.onChord(e.hz, e.step) });
      else if (e.kind === 'beat') { if (e.step === 0) this.queue.push({ time: timeOf(e.frame), fn: () => (this.beatKick = Math.max(this.beatKick, e.velocity)) }); }
      else if (e.voice === 'bowl') this.queue.push({ time: timeOf(e.frame), fn: () => this.onBowl(e.hz, e.velocity) });
      else this.queue.push({ time: timeOf(e.frame), fn: () => this.onNote(e.hz, e.velocity) });
    }
    // Hidden tabs stop the frame loop; don't let the backlog grow without bound.
    if (this.queue.length - this.qHead > 4000) this.qHead = this.queue.length - 1000;
  }

  private addRipple(pan: number, dMm: number, surface: SurfaceId, bubbleHz: number, frame: number): void {
    if (this.ripTokens < 1) return;
    this.ripTokens -= 1;
    const h = ((frame * 2654435761) >>> 0) / 4294967296;
    const i = this.ripIdx++ % RIPPLES;
    const size = Math.min(1, dMm / 3.5);
    (this.lakeMat.uniforms.uRip.value as THREE.Vector4[])[i].set(pan * 7.5, -3 + h * 9, this.vt, size);
    const kind = SURFACE_KIND[surface] ?? 0;
    const hue = kind === 3 && bubbleHz > 0 ? pitchHue(bubbleHz) / 360 : 0;
    (this.lakeMat.uniforms.uRipK.value as THREE.Vector4[])[i].set(kind, hue, 0.45 + 0.55 * size, 0);
  }

  private onChord(hz: number, step: number): void {
    this.hueTarget = pitchHue(hz) / 360;
    const next = poseFor(step);
    if (this.morph >= 1) this.startMorph(next);
    else this.pendingPose = next;
    this.attrMixTarget = ((step % 3) + 3) % 3 === 1 ? 0.7 : ((step % 3) + 3) % 3 === 2 ? 0.35 : 0;
    this.attrDTarget = 3.1 + 0.8 * mulberry(step * 31 + 5)();
  }

  private startMorph(next: THREE.Vector4): void {
    (this.shapeU.uPoseA.value as THREE.Vector4).copy(this.shapeU.uPoseB.value as THREE.Vector4);
    (this.shapeU.uPoseB.value as THREE.Vector4).copy(next);
    this.morph = 0;
    this.morphDur = Math.min(8, Math.max(3, this.world.chordSeconds * 0.2)) * (this.reduced ? 1.6 : 1);
  }

  /** A bowl rings a cymatic pattern; its pitch class picks the pattern and colour. */
  private onBowl(hz: number, velocity: number): void {
    const pc = Math.round((((12 * Math.log2(hz / 261.63)) % 12) + 12) % 12);
    const slot = pc % TUBES_MAX;
    (this.shapeU.uTubeHue.value as number[])[slot] = pitchHue(hz) / 360;
    this.bowlKick[slot] = Math.max(this.bowlKick[slot], Math.min(1, velocity * 1.2));
  }

  private onNote(hz: number, velocity: number): void {
    const pc = (((12 * Math.log2(hz / 261.63)) % 12) + 12) % 12;
    const lon = (pc / 12) * Math.PI * 2;
    const oct = Math.min(1, Math.max(0, Math.log2(hz / 130.8) / 4));
    const ph = 2.3 - oct * 1.7;
    const i = this.nodeIdx++ % NODES;
    (this.shapeU.uNodes.value as THREE.Vector4[])[i].set(Math.sin(ph) * Math.cos(lon), Math.cos(ph), Math.sin(ph) * Math.sin(lon), 0);
    (this.shapeU.uNodeInfo.value as THREE.Vector4[])[i].set(pitchHue(hz) / 360, 0.5 + 0.5 * Math.min(1, velocity), 0, 0);
    this.nodeBirth[i] = this.vt;
    this.attrBoost = Math.min(1.5, this.attrBoost + 0.5 * velocity);
  }

  // ------------------------------------------------------------------ frame

  start(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.width = w;
    this.height = h;
    const s = this.pinnedScale ?? this.scale;
    this.renderer.setPixelRatio(s);
    this.renderer.setSize(w, h, false);
    const pw = Math.round(w * s);
    const ph = Math.round(h * s);
    const make = () => new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, depthBuffer: true });
    if (this.rt) Object.values(this.rt).forEach((t) => t.dispose());
    this.rt = { bg: make(), fg: make(), fbA: make(), fbB: make(), comp: make() };
    this.bloom.setSize(pw, ph);
    this.camera.aspect = w / h;
    // Keep the object comfortably in frame on tall, narrow screens.
    this.camera.fov = w / h < 1 ? 42 + (1 - w / h) * 30 : 42;
    this.camera.updateProjectionMatrix();
    this.fbMat.uniforms.uAspect.value = w / h;
    this.finalMat.uniforms.uAspect.value = w / h;
    this.hazeMat.uniforms.uPixel.value = s;
    this.attrMats.forEach((m) => (m.uniforms.uPixel.value = s * Math.min(1.4, h / 700)));
  }

  private adapt(dtMs: number): void {
    this.frameMs = this.frameMs * 0.95 + dtMs * 0.05;
    if (this.pinnedScale !== null) return;
    if (this.frameMs > 21) this.slowFor += dtMs; else this.slowFor = 0;
    if (this.frameMs < 14) this.fastFor += dtMs; else this.fastFor = 0;
    if (this.slowFor > 1500 && this.scale > 0.5) {
      this.scale = Math.max(0.5, this.scale * 0.85);
      this.slowFor = 0;
      this.resize();
    } else if (this.fastFor > 5000 && this.scale < this.maxScale) {
      this.scale = Math.min(this.maxScale, this.scale * 1.1);
      this.fastFor = 0;
      this.resize();
    }
  }

  private frame(): void {
    const nowMs = performance.now();
    const dtMs = this.manualDt !== null ? this.manualDt * 1000 : Math.min(100, nowMs - this.last);
    this.last = nowMs;
    const dt = dtMs / 1000;
    this.adapt(dtMs);
    // Events are scheduled on the audio clock; animation runs on its own clock so it keeps
    // moving while the audio is paused.
    const audio = this.manualDt !== null ? this.vt + dtMs / 1000 : this.audioNow();
    this.vt += dt;
    const now = this.vt;
    const rm = this.reduced;
    const trip = rm ? Math.min(this.trip, 0.35) : this.trip;

    // Events due by now (audio clock).
    this.ripTokens = Math.min(12, this.ripTokens + dt * 45);
    while (this.qHead < this.queue.length && this.queue[this.qHead].time <= audio) this.queue[this.qHead++].fn();
    if (this.qHead > 2000) { this.queue = this.queue.slice(this.qHead); this.qHead = 0; }

    // Levels and wind.
    const f = this.features;
    for (const id of ['rain', 'wind', 'chimes', 'music'] as LayerId[]) this.levels[id] = ease(this.levels[id], norm(f?.level[id] ?? 0), dt, 0.35);
    this.wind = ease(this.wind, f?.windSpeed ?? this.world.windAmount * 0.5, dt, 0.4);
    this.gust = ease(this.gust, f?.gust ?? 0, dt, 0.3);
    const motion = rm ? 0.3 : 1;
    this.windPhase += dt * this.wind * 2.2 * motion;
    this.gustPhase += dt * (0.3 + this.wind * 1.5) * motion;

    // Edit emphasis: rises while a control is being changed or focused, then settles.
    for (const id of ['rain', 'wind', 'chimes', 'music'] as LayerId[]) {
      const target = this.editing.has(id) ? 1 : this.focus === id ? 0.35 : 0;
      this.edit[id] = ease(this.edit[id], target, dt, target > this.edit[id] ? 0.15 : 0.7);
    }
    this.editing.clear();

    // Palette.
    let dh = this.hueTarget - this.hue;
    dh -= Math.round(dh);
    this.hue = (((this.hue + dh * (1 - Math.exp(-dt / 2.5))) % 1) + 1) % 1;
    this.frozen = ease(this.frozen, this.world.freeze ? 1 : 0, dt, 0.8);
    const sat = (0.68 + 0.27 * trip) * (1 - 0.3 * this.world.age);

    // Shape morph between chord poses.
    if (this.morph < 1) {
      this.morph = Math.min(1, this.morph + dt / this.morphDur);
      if (this.morph >= 1 && this.pendingPose) { const p = this.pendingPose; this.pendingPose = null; this.startMorph(p); }
    }
    const m = this.morph;
    const su = this.shapeU;
    su.uTime.value = now;
    su.uMorph.value = m * m * (3 - 2 * m);
    const music = this.levels.music;
    su.uNoise.value = 0.04 + 0.2 * trip + 0.06 * music + 0.12 * this.edit.music;
    su.uBreath.value = music * (0.025 + 0.02 * Math.sin(now * ((Math.PI * 2) / 9))) * (rm ? 0.5 : 1);
    (su.uGust.value as THREE.Vector3).set(1, 0, 0.35).multiplyScalar(Math.max(0, this.gust) * Math.min(1.5, this.wind) * 0.6 * motion);
    const nodes = su.uNodes.value as THREE.Vector4[];
    for (let i = 0; i < NODES; i++) nodes[i].w = now - this.nodeBirth[i] < 0 ? 99 : now - this.nodeBirth[i];

    // Event light: attacks limited to ~150 ms, releases no faster than 0.6 s, so hits can't strobe.
    const slew = (kick: Float32Array, e: Float32Array, tau: number) => {
      let total = 0;
      for (let i = 0; i < TUBES_MAX; i++) {
        kick[i] *= Math.exp(-dt / 0.12);
        const v = e[i];
        e[i] = kick[i] > v ? v + Math.min(kick[i] - v, dt * 6) : Math.max(kick[i], v * Math.exp(-dt / tau));
        total += e[i];
      }
      return total > 1.6 ? 1.6 / total : 1;
    };
    // Bowls (music) → cymatics on the shell.
    const bowlCap = slew(this.bowlKick, this.bowlE, 1.4);
    const tubeE = su.uTubeE.value as number[];
    const preview = 0.2 * this.edit.music;
    for (let i = 0; i < TUBES_MAX; i++) tubeE[i] = Math.max(this.bowlE[i] * bowlCap, preview * (i === 2 ? 1 : 0));
    // Chimes (ambience) → rods on the shore.
    const chimeCap = slew(this.chimeKick, this.chimeE, Math.max(0.6, 0.9 * this.world.sustain));
    for (let i = 0; i < TUBES_MAX; i++) {
      const rod = this.rods[i];
      rod.u.uE.value = this.chimeE[i] * chimeCap;
      const sway = rm ? 0 : Math.sin(now * (1.1 + i * 0.13) + i * 1.7) * 0.07 * this.wind;
      const lean = Math.max(-0.3, Math.min(0.3, this.gust * 0.12 * this.wind)) * motion;
      for (const g of [rod.pivot, rod.mirror]) { g.rotation.z = lean + sway; g.rotation.x = sway * 0.6; }
    }
    this.rodShared.uEdit.value = this.edit.chimes;
    // Beat: the kick swells the object a little; slow release so a pulse reads as breathing.
    this.beatKick *= Math.exp(-dt / 0.1);
    this.beatE = this.beatKick > this.beatE ? this.beatE + Math.min(this.beatKick - this.beatE, dt * 5) : this.beatE * Math.exp(-dt / 0.45);
    su.uBreath.value += 0.022 * this.beatE * (rm ? 0.4 : 1);

    // Flash guard: turn event light down quickly if any region nears the limit, recover slowly.
    const pressure = this.flash.pressure();
    const gTarget = pressure > 0.5 ? 1 - (pressure - 0.5) * 1.4 : 1;
    this.guard = ease(this.guard, gTarget, dt, gTarget < this.guard ? 0.08 : 2.5);

    const lu = this.lookU;
    lu.uHue.value = this.hue;
    lu.uSat.value = sat;
    lu.uLevel.value = Math.max(0.15, music);
    lu.uEdit.value = this.edit.music;
    lu.uEditHue.value = LAYER_HUE.music / 360;
    lu.uGain.value = this.guard;
    lu.uReduced.value = rm ? 1 : 0;

    // Attractor.
    this.attrMix = ease(this.attrMix, this.attrMixTarget, dt, 6);
    this.attrD = ease(this.attrD, this.attrDTarget, dt, 6);
    this.attrBoost *= Math.exp(-dt / 0.8);
    const pu = this.posVar.material.uniforms;
    pu.uDt.value = (rm ? 0.004 : 0.011) * (1 + 0.6 * this.attrBoost * (rm ? 0 : 1)) * Math.min(2, dt * 60) * (1 - 0.92 * this.frozen);
    pu.uMix.value = this.attrMix;
    pu.uD.value = this.attrD;
    pu.uSeed.value = (now * 0.37) % 100;
    this.gpu.compute();
    const posTex = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    this.attrMats.forEach((mm) => { mm.uniforms.tPos.value = posTex; mm.uniforms.uBoost.value = this.attrBoost * this.guard + 0.6 * this.world.texture; });

    // Place.
    const rainOn = this.levels.rain > 0.02 ? 1 : this.levels.rain / 0.02;
    const wet = Math.min(1, Math.log10(1 + this.world.rainRate) / 2) * rainOn;
    this.skyMat.uniforms.uWind.value = Math.min(1.2, this.wind) * (0.4 + 0.6 * this.levels.wind) + this.edit.wind * 0.3;
    this.skyMat.uniforms.uWindPhase.value = this.windPhase;
    this.skyMat.uniforms.uTrip.value = trip;
    this.skyMat.uniforms.uRain.value = wet * 0.6;
    this.terrainMat.uniforms.uWet.value = wet + this.edit.rain * 0.4;
    this.terrainMat.uniforms.uGustPhase.value = this.gustPhase;
    this.terrainMat.uniforms.uGust.value = Math.max(0, this.gust) * this.wind * motion;
    (this.terrainMat.uniforms.uCam.value as THREE.Vector3).copy(this.camera.position);
    this.lakeMat.uniforms.uTime.value = now;
    this.lakeMat.uniforms.uWet.value = wet;
    this.lakeMat.uniforms.uEdit.value = this.edit.rain;
    (this.lakeMat.uniforms.uCam.value as THREE.Vector3).copy(this.camera.position);
    if (this.edit.rain > 0.3 && now - this.lastEditRipple > 0.5) {
      this.lastEditRipple = now;
      this.ripTokens += 1;
      this.addRipple((Math.random() - 0.5) * 0.8, 2.5, 'water', 0, Math.floor(now * 1000));
    }
    this.rainMat.uniforms.uTime.value = now * motion;
    this.rainMat.uniforms.uDensity.value = Math.min(1, 0.05 + 0.3 * Math.log10(1 + this.world.rainRate)) * rainOn;
    this.rainMat.uniforms.uWind.value = Math.min(1.5, this.wind) * 0.8;
    this.hazeMat.uniforms.uWindPhase.value = this.windPhase;
    this.hazeMat.uniforms.uWind.value = Math.min(1.2, this.wind);
    this.hazeMat.uniforms.uEdit.value = this.edit.wind;

    // Camera: slow drift, eased toward the focused layer.
    const [fp, fl] = FRAMING[this.focus ?? 'none'];
    const driftAmt = rm ? 0 : 1;
    const yaw = Math.sin(now * 0.021) * 0.22 * driftAmt;
    const target = fp.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    target.y += Math.sin(now * 0.017) * 0.25 * driftAmt;
    const camTau = rm ? 0.25 : 1.1;
    this.camPos.lerp(target, 1 - Math.exp(-dt / camTau));
    this.camLook.lerp(fl, 1 - Math.exp(-dt / camTau));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.objectGroup.rotation.y += dt * (0.05 + 0.05 * trip) * motion * (1 - 0.85 * this.frozen);
    this.mirrorGroup.rotation.y = this.objectGroup.rotation.y;

    // ---------------------------------------------------------------- render
    const r = this.renderer;
    const c = new THREE.Vector3(0, OBJECT_Y, 0).project(this.camera);
    (this.fbMat.uniforms.uCenter.value as THREE.Vector2).set(c.x * 0.5 + 0.5, c.y * 0.5 + 0.5);

    r.setRenderTarget(this.rt.bg);
    r.render(this.bg, this.camera);
    r.setRenderTarget(this.rt.fg);
    r.render(this.fg, this.camera);

    const fb = this.fbMat.uniforms;
    fb.tCur.value = this.rt.fg.texture;
    fb.tPrev.value = this.rt.fbA.texture;
    fb.uDecay.value = rm ? 0 : Math.min(0.9, 0.2 + 0.7 * trip + 0.12 * this.world.layers + 0.1 * this.frozen) * (0.6 + 0.4 * this.guard);
    fb.uZoom.value = 1 + 0.0025 * trip + 0.0015 * music;
    fb.uRot.value = (0.0008 + 0.0025 * Math.min(1.2, this.wind)) * trip * (this.gust >= 0 ? 1 : -1);
    fb.uWarp.value = trip;
    fb.uHueTurn.value = 0.006 * trip;
    this.drawQuad(this.fbMat, this.rt.fbB);
    [this.rt.fbA, this.rt.fbB] = [this.rt.fbB, this.rt.fbA];

    this.compMat.uniforms.tBg.value = this.rt.bg.texture;
    this.compMat.uniforms.tFg.value = this.rt.fbA.texture;
    this.drawQuad(this.compMat, this.rt.comp);

    this.bloom.strength = 0.3 + 0.45 * trip;
    this.bloom.render(r, null as unknown as THREE.WebGLRenderTarget, this.rt.comp, dt, false);

    const fu = this.finalMat.uniforms;
    fu.tIn.value = this.rt.comp.texture;
    fu.uKal.value = rm ? 0 : (() => { const k = Math.min(1, Math.max(0, (this.trip - 0.8) / 0.17)); return k * k * (3 - 2 * k) * 0.85; })();
    fu.uKalRot.value = now * 0.02;
    fu.uCA.value = 0.0015 + 0.004 * trip;
    fu.uGrain.value = 0.012 + 0.03 * this.world.age;
    fu.uExposure.value = 1.05 * (0.85 + 0.15 * this.guard) * (this.strobe ? (this.frameNo % 4 < 2 ? 6 : 0.05) : 1);
    this.drawQuad(this.finalMat, null);

    // Flash probe: a tiny copy of the final frame, read back without stalling.
    this.frameNo++;
    if (this.syncProbe) {
      this.drawQuad(this.finalMat, this.probe);
      r.readRenderTargetPixels(this.probe, 0, 0, PROBE_W, PROBE_H, this.probeBuf);
      this.flash.push(this.manualDt !== null ? this.vt : performance.now() / 1000, this.probeBuf);
    } else if (this.frameNo % 3 === 0 && !this.probeBusy) {
      this.drawQuad(this.finalMat, this.probe);
      this.probeBusy = true;
      const t = performance.now() / 1000;
      r.readRenderTargetPixelsAsync(this.probe, 0, 0, PROBE_W, PROBE_H, this.probeBuf)
        .then(() => this.flash.push(t, this.probeBuf))
        .catch((e) => { if (!this.probeFailed) console.warn('flash probe', e); this.probeFailed = true; })
        .finally(() => (this.probeBusy = false));
    }
  }

  private drawQuad(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.post, this.postCam);
  }
}
