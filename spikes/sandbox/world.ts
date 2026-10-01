/**
 * The landscape the object travels through: a winding valley loop between sharp crystalline
 * peaks, with lakes on the way, a ringed planet in the sky and chime trees on the shores.
 *
 *   path      a closed loop; the object follows it forever (about 2.3 km)
 *   distance  a CPU-computed field: distance to the path + how much of a lake each point is
 *   heights   baked once on the GPU from the field and noise (near map fine, far map coarse)
 *   terrain   three camera-following grids (fine, mid, far) reading the maps
 *   water     one plane at y = 0 with a real planar reflection of the whole scene
 *
 * The valley floor uses the same integer-hash noise on CPU and GPU, so the object and camera
 * know the ground height exactly where they are.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as W from './worldShaders';
import { QUAD_VERT, ROD_FRAG, ROD_VERT } from './shaders';

// ------------------------------------------------------------------ noise (matches GNOISE)

function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
function grad(ix: number, iy: number): [number, number] {
  const h = pcg((Math.imul((ix + 65536) >>> 0, 1973) + pcg((iy + 65536) >>> 0)) >>> 0);
  const a = h * ((Math.PI * 2) / 4294967296);
  return [Math.cos(a), Math.sin(a)];
}
export function gnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const q = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const ux = q(fx), uy = q(fy);
  const g00 = grad(ix, iy), g10 = grad(ix + 1, iy), g01 = grad(ix, iy + 1), g11 = grad(ix + 1, iy + 1);
  const a = g00[0] * fx + g00[1] * fy;
  const b = g10[0] * (fx - 1) + g10[1] * fy;
  const c = g01[0] * fx + g01[1] * (fy - 1);
  const d = g11[0] * (fx - 1) + g11[1] * (fy - 1);
  return (a + (b - a) * ux + (c - a + (a - b + d - c) * ux) * uy) * 1.4;
}
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ path

/** Lakes along the loop: centre angle and half-width (radians). The first is the Tarn. */
const LAKES: [number, number][] = [[0, 0.22], [1.75, 0.16], [3.2, 0.2], [4.7, 0.18]];
const PATH_SAMPLES = 4096;

export class Path {
  readonly x = new Float64Array(PATH_SAMPLES + 1);
  readonly z = new Float64Array(PATH_SAMPLES + 1);
  readonly cum = new Float64Array(PATH_SAMPLES + 1);
  readonly length: number;

  constructor() {
    for (let i = 0; i <= PATH_SAMPLES; i++) {
      const th = (i / PATH_SAMPLES) * Math.PI * 2;
      const r = 300 + 60 * Math.sin(3 * th + 0.4) + 30 * Math.cos(5 * th + 1.3);
      this.x[i] = r * Math.cos(th);
      this.z[i] = r * Math.sin(th);
      if (i > 0) this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
    }
    this.length = this.cum[PATH_SAMPLES];
  }

  static theta(i: number): number {
    return (i / PATH_SAMPLES) * Math.PI * 2;
  }

  /** Position and unit tangent at arc length s (wraps). */
  at(s: number): { x: number; z: number; tx: number; tz: number } {
    const L = this.length;
    const u = ((s % L) + L) % L;
    let lo = 0, hi = PATH_SAMPLES;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.cum[mid] <= u) lo = mid; else hi = mid; }
    const f = (u - this.cum[lo]) / (this.cum[hi] - this.cum[lo] || 1);
    const x = this.x[lo] + (this.x[hi] - this.x[lo]) * f;
    const z = this.z[lo] + (this.z[hi] - this.z[lo]) * f;
    const tx = this.x[hi] - this.x[lo], tz = this.z[hi] - this.z[lo];
    const m = Math.hypot(tx, tz) || 1;
    return { x, z, tx: tx / m, tz: tz / m };
  }

  /** Arc length at a path angle. */
  sAtTheta(theta: number): number {
    const i = Math.round((((theta / (Math.PI * 2)) % 1) + 1) % 1 * PATH_SAMPLES);
    return this.cum[i];
  }
}

function lakeAtTheta(th: number): number {
  let best = 0;
  for (const [c, w] of LAKES) {
    let d = Math.abs(th - c) % (Math.PI * 2);
    if (d > Math.PI) d = Math.PI * 2 - d;
    best = Math.max(best, 1 - smooth(w * 0.55, w, d));
  }
  return best;
}

// ------------------------------------------------------------------ distance field

const DIST_N = 512;
const DIST_MIN = -640;
const DIST_SIZE = 1280;

class DistanceField {
  readonly d = new Float32Array(DIST_N * DIST_N);
  readonly lake = new Float32Array(DIST_N * DIST_N);
  readonly texture: THREE.DataTexture;

  constructor(path: Path) {
    // Coarse pass: nearest path sample on a 10 m grid (path subsampled), to seed the fine search.
    const C = 128;
    const coarseIdx = new Int32Array(C * C);
    const coarseD = new Float32Array(C * C);
    for (let j = 0; j < C; j++) {
      for (let i = 0; i < C; i++) {
        const x = DIST_MIN + ((i + 0.5) / C) * DIST_SIZE;
        const z = DIST_MIN + ((j + 0.5) / C) * DIST_SIZE;
        let best = Infinity, bi = 0;
        for (let k = 0; k < PATH_SAMPLES; k += 8) {
          const dd = (path.x[k] - x) ** 2 + (path.z[k] - z) ** 2;
          if (dd < best) { best = dd; bi = k; }
        }
        coarseIdx[j * C + i] = bi;
        coarseD[j * C + i] = Math.sqrt(best);
      }
    }
    // Fine pass: search near the coarse answer only where it matters (within ~150 m).
    for (let j = 0; j < DIST_N; j++) {
      for (let i = 0; i < DIST_N; i++) {
        const x = DIST_MIN + ((i + 0.5) / DIST_N) * DIST_SIZE;
        const z = DIST_MIN + ((j + 0.5) / DIST_N) * DIST_SIZE;
        const ci = Math.min(C - 1, Math.floor((i / DIST_N) * C));
        const cj = Math.min(C - 1, Math.floor((j / DIST_N) * C));
        const k0 = coarseIdx[cj * C + ci];
        let dist = coarseD[cj * C + ci];
        let bi = k0;
        if (dist < 160) {
          let best = Infinity;
          for (let o = -320; o <= 320; o += 4) {
            const k = (k0 + o + PATH_SAMPLES) % PATH_SAMPLES;
            const dd = (path.x[k] - x) ** 2 + (path.z[k] - z) ** 2;
            if (dd < best) { best = dd; bi = k; }
          }
          for (let o = -4; o <= 4; o++) {
            const k = (bi + o + PATH_SAMPLES) % PATH_SAMPLES;
            const dd = (path.x[k] - x) ** 2 + (path.z[k] - z) ** 2;
            if (dd < best) { best = dd; bi = k; }
          }
          dist = Math.sqrt(best);
        }
        const idx = j * DIST_N + i;
        this.d[idx] = Math.min(dist, 250);
        this.lake[idx] = lakeAtTheta(Path.theta(bi)) * (1 - smooth(24, 60, dist));
      }
    }
    const data = new Uint16Array(DIST_N * DIST_N * 4);
    for (let k = 0; k < DIST_N * DIST_N; k++) {
      data[k * 4] = THREE.DataUtils.toHalfFloat(this.d[k]);
      data[k * 4 + 1] = THREE.DataUtils.toHalfFloat(this.lake[k]);
    }
    this.texture = new THREE.DataTexture(data, DIST_N, DIST_N, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
  }

  /** Bilinear sample, matching the GPU's texel-centre convention. */
  sample(x: number, z: number): { d: number; lake: number } {
    const fx = Math.min(DIST_N - 1.001, Math.max(0, ((x - DIST_MIN) / DIST_SIZE) * DIST_N - 0.5));
    const fz = Math.min(DIST_N - 1.001, Math.max(0, ((z - DIST_MIN) / DIST_SIZE) * DIST_N - 0.5));
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const at = (a: Float32Array, ii: number, jj: number) => a[jj * DIST_N + ii];
    const bl = (a: Float32Array) =>
      (at(a, i, j) * (1 - u) + at(a, i + 1, j) * u) * (1 - v) + (at(a, i, j + 1) * (1 - u) + at(a, i + 1, j + 1) * u) * v;
    return { d: bl(this.d), lake: bl(this.lake) };
  }
}

// ------------------------------------------------------------------ world

export type Quality = 'low' | 'med' | 'high';

const NEAR_AREA = { min: DIST_MIN, size: DIST_SIZE };
const FAR_AREA = { min: -3200, size: 6400 };

interface Grid { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; size: number; n: number }

export class World {
  readonly path = new Path();
  private readonly field: DistanceField;
  private readonly nearMap: THREE.WebGLRenderTarget;
  private readonly farMap: THREE.WebGLRenderTarget;
  readonly light: Record<string, THREE.IUniform>;
  readonly skyMat: THREE.ShaderMaterial;
  readonly sky: THREE.Mesh;
  readonly waterMat: THREE.ShaderMaterial;
  readonly water: THREE.Mesh;
  private readonly grids: Grid[] = [];
  private readonly terrainShared: Record<string, THREE.IUniform>;
  private readonly refl: THREE.WebGLRenderTarget;
  private reflScale = 0.5;
  private readonly virtualCam = new THREE.PerspectiveCamera();
  readonly trees: THREE.Group[] = [];
  /** Per tube index: shared by every tree, so all trees ring the same tube together. */
  readonly tubeU: { uHue: THREE.IUniform; uE: THREE.IUniform }[] = [];
  private readonly tubePivots: THREE.Group[][] = [];
  readonly rodShared: Record<string, THREE.IUniform>;
  readonly group = new THREE.Group();
  /** The world's cool base hue, nudged a little by the chord (the object carries the full hue). */
  readonly worldHue: THREE.IUniform = { value: 0.66 };

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    look: Record<string, THREE.IUniform>,
    quality: Quality,
  ) {
    this.field = new DistanceField(this.path);

    // Shared light and fog for all landscape materials.
    this.light = {
      uSun: { value: new THREE.Vector3(-0.8, 0.5, 0.3).normalize() },
      uSkyTop: { value: new THREE.Color() },
      uSkyHorizon: { value: new THREE.Color() },
      uCam: { value: new THREE.Vector3() },
      uFogDensity: { value: 0.0022 },
      uClipBelow: { value: -1e9 },
      uFire: { value: 0 },
    };

    // Bake the height maps once.
    const nearRes = quality === 'low' ? 1024 : 2048;
    this.nearMap = this.bake(NEAR_AREA, nearRes);
    this.farMap = this.bake(FAR_AREA, 512);
    const sample = {
      tNear: { value: this.nearMap.texture },
      tFar: { value: this.farMap.texture },
      uNear: { value: new THREE.Vector3(NEAR_AREA.min, NEAR_AREA.min, NEAR_AREA.size) },
      uFar: { value: new THREE.Vector3(FAR_AREA.min, FAR_AREA.min, FAR_AREA.size) },
    };

    // Terrain: fine, mid and far grids following the camera.
    this.terrainShared = {
      ...sample,
      ...this.light,
      uWorldHue: this.worldHue,
      uSat: look.uSat,
      uTime: { value: 0 },
      uSnowline: { value: 30 },
      uWet: { value: 0 },
      uGlow: { value: 0.6 },
      uCamXZ: { value: new THREE.Vector2() },
    };
    const nearN = quality === 'low' ? 256 : quality === 'med' ? 384 : 512;
    this.addGrid(240, nearN, 0, 0);
    this.addGrid(1400, 280, 118, 1.5);
    this.addGrid(7000, 200, 690, 4);

    // Water with a planar reflection.
    this.reflScale = quality === 'low' ? 0.3 : quality === 'med' ? 0.5 : 0.75;
    this.refl = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: W.WATER_VERT,
      fragmentShader: W.WATER_FRAG,
      uniforms: {
        ...sample,
        ...this.light,
        tRefl: { value: this.refl.texture },
        uReflMat: { value: new THREE.Matrix4() },
        uHasRefl: { value: this.reflScale > 0 ? 1 : 0 },
        uCenter: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uWorldHue: this.worldHue,
        uSat: look.uSat,
        uGain: look.uGain,
        uReduced: look.uReduced,
        uWet: { value: 0 },
        uEdit: { value: 0 },
        uFrozen: { value: 0 },
        uRip: { value: Array.from({ length: 48 }, () => new THREE.Vector4(0, 0, -99, 0)) },
        uRipK: { value: Array.from({ length: 48 }, () => new THREE.Vector4()) },
      },
    });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), this.waterMat);
    this.water.frustumCulled = false;
    this.water.renderOrder = 2;
    this.water.name = 'lake';
    this.group.add(this.water);

    // Sky.
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: W.SKY_VERT,
      fragmentShader: W.SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTime: { value: 0 }, uWorldHue: this.worldHue, uSat: look.uSat, uWind: { value: 0 }, uWindPhase: { value: 0 }, uTrip: { value: 0.6 }, uRain: { value: 0 },
        uSun: this.light.uSun, uSkyTop: this.light.uSkyTop, uSkyHorizon: this.light.uSkyHorizon,
        uPlanet: { value: new THREE.Vector3(-0.28, 0.24, 1).normalize() },
        uMoon: { value: new THREE.Vector3(0.75, 0.42, 0.55).normalize() },
      },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(3500, 48, 24), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.sky.name = 'sky';
    this.group.add(this.sky);

    // Chime trees on lake shores.
    this.rodShared = { uGain: look.uGain, uEdit: { value: 0 }, uDim: { value: 1 } };
    for (let i = 0; i < 8; i++) this.tubeU.push({ uHue: { value: 0 }, uE: { value: 0 } });
    this.plantTrees(look);
  }

  private bake(area: { min: number; size: number }, res: number): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, depthBuffer: false });
    rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
    const mat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: W.BAKE_FRAG,
      uniforms: {
        tDist: { value: this.field.texture },
        uDist: { value: new THREE.Vector3(DIST_MIN, DIST_MIN, DIST_SIZE) },
        uArea: { value: new THREE.Vector3(area.min, area.min, area.size) },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    this.renderer.setRenderTarget(prev);
    mat.dispose();
    quad.geometry.dispose();
    return rt;
  }

  private addGrid(size: number, n: number, inner: number, sink: number): void {
    const mat = new THREE.ShaderMaterial({
      vertexShader: W.TERRAIN_VERT,
      fragmentShader: W.TERRAIN_FRAG,
      side: THREE.DoubleSide,
      uniforms: {
        ...this.terrainShared,
        uCenter: { value: new THREE.Vector2() },
        uInner: { value: inner },
        uSink: { value: sink },
        uEps: { value: Math.max(0.6, size / n) },
      },
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size, n, n), mat);
    mesh.frustumCulled = false;
    mesh.name = 'terrain';
    this.group.add(mesh);
    this.grids.push({ mesh, mat, size, n });
  }

  private plantTrees(look: Record<string, THREE.IUniform>): void {
    const barkMat = new THREE.ShaderMaterial({
      vertexShader: W.BARK_VERT,
      fragmentShader: W.BARK_FRAG,
      side: THREE.DoubleSide,
      uniforms: { ...this.light, uWorldHue: this.worldHue, uSat: look.uSat, uGlow: this.terrainShared.uGlow },
    });
    const tubeGeo = new THREE.CylinderGeometry(0.045, 0.045, 1, 8, 1, true);
    tubeGeo.translate(0, -0.5, 0);
    const tubeMats = this.tubeU.map((u) =>
      new THREE.ShaderMaterial({ vertexShader: ROD_VERT, fragmentShader: ROD_FRAG, uniforms: { ...u, ...this.rodShared }, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (const [c, w] of LAKES) {
      for (const side of [1, -1]) {
        const th = c + side * w * 0.95;
        const at = this.path.at(this.path.sAtTheta(th));
        for (const off of [13, 9, -12]) {
          const x = at.x - at.tz * off, z = at.z + at.tx * off;
          const g = this.floorAt(x, z);
          if (g < 0.8) continue;
          const { geo, hangs } = makeTree(rnd);
          const tree = new THREE.Group();
          tree.add(new THREE.Mesh(geo, barkMat));
          tree.position.set(x, g - 0.3, z);
          tree.rotation.y = rnd() * Math.PI * 2;
          tree.scale.setScalar(0.9 + rnd() * 0.4);
          const pivots: THREE.Group[] = [];
          hangs.forEach((h, i) => {
            if (i >= this.tubeU.length) return;
            const pivot = new THREE.Group();
            pivot.position.copy(h);
            pivot.add(new THREE.Mesh(tubeGeo, tubeMats[i]));
            tree.add(pivot);
            pivots.push(pivot);
          });
          tree.name = 'trees';
          this.group.add(tree);
          this.trees.push(tree);
          this.tubePivots.push(pivots);
          break;
        }
      }
    }
  }

  /** Tube pitches set the hue and length of each tube on every tree. */
  setTubes(hues: number[], lengths: number[]): void {
    this.tubeU.forEach((u, i) => (u.uHue.value = hues[i] ?? 0));
    for (const pivots of this.tubePivots) {
      pivots.forEach((p, i) => {
        const on = i < hues.length;
        p.visible = on;
        if (on) p.children[0].scale.y = lengths[i];
      });
    }
  }

  /** Swing every tube with the wind (sway per tube, lean with the gust). */
  swing(now: number, wind: number, gust: number, motion: number): void {
    for (const pivots of this.tubePivots) {
      pivots.forEach((p, i) => {
        const sway = Math.sin(now * (1.1 + i * 0.13) + i * 1.7) * 0.09 * wind * motion;
        p.rotation.z = Math.max(-0.35, Math.min(0.35, gust * 0.14 * wind)) * motion + sway;
        p.rotation.x = sway * 0.6;
      });
    }
  }

  /** Ground height along the valley (exact where the object travels; the floor elsewhere). */
  floorAt(x: number, z: number): number {
    const { d, lake } = this.field.sample(x, z);
    const wall = smooth(20, 110, d);
    const f = 3.5 + 2.5 * gnoise(x * 0.011, z * 0.011) + 1.0 * gnoise(x * 0.037 + 5.3, z * 0.037 + 5.3);
    return f + (-6 - f) * lake * (1 - wall);
  }

  /** Per-frame: follow the camera, set the palette, light and fog. */
  update(camera: THREE.Camera, now: number, hue: number, sat: number, wet: number): void {
    const cam = camera.position;
    (this.light.uCam.value as THREE.Vector3).copy(cam);
    (this.terrainShared.uCamXZ.value as THREE.Vector2).set(cam.x, cam.z);
    this.terrainShared.uTime.value = now;
    this.terrainShared.uWet.value = wet;
    for (const g of this.grids) {
      const step = g.size / g.n;
      (g.mat.uniforms.uCenter.value as THREE.Vector2).set(Math.round(cam.x / step) * step, Math.round(cam.z / step) * step);
    }
    (this.waterMat.uniforms.uCenter.value as THREE.Vector2).set(cam.x, cam.z);
    this.waterMat.uniforms.uTime.value = now;
    this.waterMat.uniforms.uWet.value = wet;
    this.sky.position.copy(cam);
    this.skyMat.uniforms.uTime.value = now;
    // Deep navy-violet overhead, violet haze at the horizon, drifting with the chord.
    const wh = 0.66 + 0.07 * Math.sin(hue * Math.PI * 2);
    this.worldHue.value = wh;
    (this.light.uSkyTop.value as THREE.Color).setHSL(wh, 0.65, 0.022 + 0.008 * (1 - wet));
    (this.light.uSkyHorizon.value as THREE.Color).setHSL((wh + 0.07) % 1, 0.4 + 0.15 * sat, 0.075 + 0.03 * wet);
  }

  /** Render the mirrored scene into the reflection target. */
  renderReflection(camera: THREE.PerspectiveCamera, scenes: THREE.Scene[], hide: THREE.Object3D[], width: number, height: number, dim?: THREE.IUniform[]): void {
    if (this.reflScale <= 0) return;
    const w = Math.max(2, Math.round(width * this.reflScale));
    const h = Math.max(2, Math.round(height * this.reflScale));
    if (this.refl.width !== w || this.refl.height !== h) this.refl.setSize(w, h);
    const S = new THREE.Matrix4().makeScale(1, -1, 1);
    const vc = this.virtualCam;
    vc.projectionMatrix.copy(camera.projectionMatrix);
    vc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    vc.matrixAutoUpdate = false;
    vc.matrixWorldAutoUpdate = false;
    vc.matrixWorld.multiplyMatrices(S, camera.matrixWorld);
    vc.matrixWorldInverse.copy(vc.matrixWorld).invert();
    vc.position.set(camera.position.x, -camera.position.y, camera.position.z);
    const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    (this.waterMat.uniforms.uReflMat.value as THREE.Matrix4).multiplyMatrices(bias, vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    this.light.uClipBelow.value = -0.05;
    // Glowing things reflect dimmer, so the reflection doesn't bloom brighter than the source.
    const dims = (dim ?? []).map((u) => u.value as number);
    (dim ?? []).forEach((u) => (u.value = (u.value as number) * 0.15));
    const r = this.renderer;
    r.setRenderTarget(this.refl);
    r.setClearColor(0x000000, 1);
    r.clear();
    const auto = r.autoClear;
    r.autoClear = false;
    for (const s of scenes) r.render(s, vc);
    r.autoClear = auto;
    this.light.uClipBelow.value = -1e9;
    (dim ?? []).forEach((u, i) => (u.value = dims[i]));
    hide.forEach((o, i) => (o.visible = vis[i]));
  }

  get hasReflection(): boolean {
    return this.reflScale > 0;
  }
}

// ------------------------------------------------------------------ chime tree

/** A gnarled tree: twisting trunk, a few reaching branches; tubes hang from the branches. */
function makeTree(rnd: () => number): { geo: THREE.BufferGeometry; hangs: THREE.Vector3[] } {
  const parts: THREE.BufferGeometry[] = [];
  const hangs: THREE.Vector3[] = [];
  const trunkPts: THREE.Vector3[] = [];
  let x = 0, z = 0;
  for (let i = 0; i <= 6; i++) {
    const y = i * 1.6;
    x += (rnd() - 0.5) * 0.9;
    z += (rnd() - 0.5) * 0.9;
    trunkPts.push(new THREE.Vector3(x, y, z));
  }
  const trunk = new THREE.CatmullRomCurve3(trunkPts);
  // Taper by stacking segments of falling radius.
  for (let k = 0; k < 3; k++) {
    const pts = trunk.getPoints(30).slice(k * 10, k * 10 + 11);
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.38 - k * 0.1, 7, false));
  }
  const branches = 5;
  for (let b = 0; b < branches; b++) {
    const t = 0.5 + 0.45 * (b / (branches - 1));
    const start = trunk.getPoint(t);
    const ang = (b / branches) * Math.PI * 2 + rnd() * 0.8;
    const len = 3 + rnd() * 2.5;
    const dir = new THREE.Vector3(Math.cos(ang), 0.55 + rnd() * 0.3, Math.sin(ang)).normalize();
    const p1 = start.clone().addScaledVector(dir, len * 0.5).add(new THREE.Vector3(0, 0.6, 0));
    const p2 = start.clone().addScaledVector(dir, len).add(new THREE.Vector3(0, 0.1 - rnd() * 0.6, 0));
    const curve = new THREE.CatmullRomCurve3([start, p1, p2]);
    parts.push(new THREE.TubeGeometry(curve, 12, 0.12, 5, false));
    hangs.push(curve.getPoint(0.95), curve.getPoint(0.6));
  }
  const geo = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  parts.forEach((g) => g.dispose());
  // Interleave so the first tubes spread across branches.
  const ordered = [...hangs.filter((_, i) => i % 2 === 0), ...hangs.filter((_, i) => i % 2 === 1)];
  return { geo, hangs: ordered };
}
