/**
 * GLSL for the world: an alien alpine valley (after the user's references: crystalline snow
 * peaks, teal shores, turquoise shallows, mirror water, a ringed planet over a nebula).
 *
 * The same integer-hash gradient noise exists in JS (world.ts), so the CPU knows the valley
 * floor exactly where the object travels.
 */

import { NOISE } from './shaders';

/** Integer-hash gradient noise; identical to `gnoise` in world.ts. */
export const GNOISE = /* glsl */ `
uint pcgh(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
vec2 grad2(ivec2 p){
  uint h = pcgh(uint(p.x + 65536) * 1973u + pcgh(uint(p.y + 65536)));
  float a = float(h) * (6.28318530718 / 4294967296.0);
  return vec2(cos(a), sin(a));
}
float gnoise(vec2 x){
  vec2 fl = floor(x);
  ivec2 i = ivec2(fl);
  vec2 f = x - fl;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad2(i), f);
  float b = dot(grad2(i + ivec2(1, 0)), f - vec2(1.0, 0.0));
  float c = dot(grad2(i + ivec2(0, 1)), f - vec2(0.0, 1.0));
  float d = dot(grad2(i + ivec2(1, 1)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4;
}
`;

/** Height of the world: a valley floor along the path (with lakes), sharp ridged peaks away from it. */
export const HEIGHT = /* glsl */ `
${GNOISE}
uniform sampler2D tDist;   // r = distance to the path, g = lake amount
uniform vec3 uDist;        // min x, min z, size
float floorH(vec2 p, float lake){
  float f = 3.5 + 2.5 * gnoise(p * 0.011) + 1.0 * gnoise(p * 0.037 + 5.3);
  return mix(f, -6.0, lake);
}
float ridged(vec2 p){
  float s = 0.0, a = 0.55, w = 1.0;
  for (int i = 0; i < 6; i++) {
    float n = 1.0 - abs(gnoise(p));
    n *= n;
    s += n * a * w;
    w = clamp(n * 1.6, 0.0, 1.0);
    p = p * 2.07 + vec2(17.3, -9.1);
    a *= 0.5;
  }
  return s;
}
float mountainH(vec2 p){
  vec2 warp = vec2(gnoise(p * 0.003 + 1.7), gnoise(p * 0.003 + 9.2)) * 60.0;
  float r = ridged((p + warp) * 0.0045);
  float mask = 0.55 + 0.45 * gnoise(p * 0.0012 + 3.3);
  float spire = pow(max(0.0, gnoise(p * 0.018 + 2.1)), 5.0) * 90.0;
  return 170.0 * pow(r, 1.7) * mask + spire;
}
float worldHeight(vec2 p){
  vec2 t = texture(tDist, (p - uDist.xy) / uDist.z).rg;
  float wall = smoothstep(20.0, 110.0, t.r);
  return floorH(p, t.g * (1.0 - wall)) + mountainH(p) * wall;
}
`;

/** Bake pass: one texel = one height sample over a square of the world. */
export const BAKE_FRAG = /* glsl */ `
${HEIGHT}
uniform vec3 uArea; // min x, min z, size
varying vec2 vUv;
void main(){
  vec2 p = uArea.xy + vUv * uArea.z;
  vec2 t = texture(tDist, (p - uDist.xy) / uDist.z).rg;
  gl_FragColor = vec4(worldHeight(p), t.g, t.r, 1.0);
}
`;

/** Sampling the baked maps (near, fine; far, coarse). */
export const SAMPLE = /* glsl */ `
uniform sampler2D tNear;
uniform sampler2D tFar;
uniform vec3 uNear;
uniform vec3 uFar;
vec4 mapAt(vec2 p){
  vec2 un = (p - uNear.xy) / uNear.z;
  if (un.x > 0.002 && un.y > 0.002 && un.x < 0.998 && un.y < 0.998) return texture(tNear, un);
  return texture(tFar, (p - uFar.xy) / uFar.z);
}
float H(vec2 p){ return mapAt(p).r; }
`;

/** Shared lighting and colour for everything in the landscape. */
export const LIGHT = /* glsl */ `
uniform vec3 uSun;        // direction towards the light (the planet's star)
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uCam;
uniform float uFogDensity;
uniform float uClipBelow; // discard anything under this height (reflection pass)
uniform float uFire;      // a faint, steady warm glow while the fire burns (never flickers)
vec3 fogIt(vec3 col, vec3 wp){
  col += vec3(1.0, 0.42, 0.12) * uFire * 0.025 * exp(-length(wp - uCam) * 0.02);
  float d = length(wp - uCam);
  float f = 1.0 - exp(-d * uFogDensity);
  // Low mist over water and valley floors.
  float mist = exp(-max(0.0, wp.y - 0.5) * 0.9) * (1.0 - exp(-d * 0.004)) * 0.12;
  return mix(col, uSkyHorizon, clamp(f + mist, 0.0, 1.0));
}
`;

export const TERRAIN_VERT = /* glsl */ `
${SAMPLE}
uniform vec2 uCenter;   // grid centre (snapped)
uniform vec2 uCamXZ;
uniform float uInner;   // half-size of the finer grid inside this one (0 = none)
uniform float uSink;
uniform float uEps;
varying vec3 vW;
varying vec3 vN;
varying float vLake;
void main(){
  vec2 p = uCenter + vec2(position.x, -position.y);
  vec4 m = mapAt(p);
  float h = m.r;
  vec2 dc = abs(p - uCamXZ);
  // Hidden under the finer grid, so the two never fight.
  if (uInner > 0.0 && max(dc.x, dc.y) < uInner) h -= uSink;
  float hl = H(p - vec2(uEps, 0.0)), hr = H(p + vec2(uEps, 0.0));
  float hd = H(p - vec2(0.0, uEps)), hu = H(p + vec2(0.0, uEps));
  vN = normalize(vec3(hl - hr, 2.0 * uEps, hd - hu));
  vLake = m.g;
  vW = vec3(p.x, h, p.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;

export const TERRAIN_FRAG = /* glsl */ `
${NOISE}
${LIGHT}
uniform float uWorldHue;  // cool base (~0.66), nudged by the chord
uniform float uSat;
uniform float uSnowline;
uniform float uWet;
uniform float uTime;
uniform float uGlow;
varying vec3 vW;
varying vec3 vN;
varying float vLake;
void main(){
  if (vW.y < uClipBelow) discard;
  // Smooth normal from the map, sharpened by the screen-space facet normal: crystalline faces.
  vec3 facet = normalize(cross(dFdx(vW), dFdy(vW)));
  if (facet.y < 0.0) facet = -facet;
  vec3 n = normalize(mix(normalize(vN), facet, 0.55));
  float slope = 1.0 - n.y;
  float h = vW.y;
  float dist = length(vW - uCam);

  // Materials: alien meadow low and flat, pale shore, dark rock on steeps, snow up high.
  float detail = snoise(vW * 0.35) * 0.5 + snoise(vW * 1.3) * 0.25;
  float snow = smoothstep(uSnowline - 10.0, uSnowline + 6.0, h + detail * 8.0) * (1.0 - smoothstep(0.5, 0.78, slope + detail * 0.1));
  float meadow = (1.0 - smoothstep(9.0, 16.0, h)) * (1.0 - smoothstep(0.22, 0.4, slope)) * smoothstep(0.4, 1.4, h);
  float shore = 1.0 - smoothstep(0.2, 1.4, h);
  vec3 rock = vec3(0.05, 0.055, 0.08) * (0.8 + 0.4 * detail);
  // Snow with fine downhill streaks, like wind-carved ice.
  float streak = 1.0 - abs(snoise(vec3(vW.xz * vec2(0.6, 0.6) + n.xz * 8.0, 0.0) * 1.7));
  vec3 snowCol = vec3(0.62, 0.68, 0.86) * (0.82 + 0.18 * streak * streak);
  // Meadow: patchy alien moss, darker tufts, pale lichen, a few glowing specks.
  float patchN = snoise(vW * 0.08) * 0.6 + snoise(vW * 0.3) * 0.3;
  float tuft = smoothstep(0.1, 0.9, snoise(vW * 5.3)) * smoothstep(-0.2, 0.6, snoise(vW * 0.9));
  vec3 meadowCol = mix(hsv(vec3(uWorldHue - 0.2, 0.7, 0.3)), hsv(vec3(uWorldHue - 0.31, 0.7, 0.42)), smoothstep(-0.4, 0.5, patchN));
  meadowCol = mix(meadowCol, hsv(vec3(uWorldHue - 0.24, 0.55, 0.2)), tuft * 0.3);
  meadowCol = mix(meadowCol, vec3(0.42, 0.5, 0.52), smoothstep(0.7, 0.95, snoise(vW * 1.4 + 3.0)) * 0.18);
  vec3 shoreCol = vec3(0.5, 0.56, 0.62);
  vec3 alb = rock;
  alb = mix(alb, meadowCol, meadow);
  alb = mix(alb, shoreCol, shore * 0.8);
  alb = mix(alb, snowCol, snow);
  alb *= 1.0 - 0.35 * uWet * (1.0 - snow);

  // Light: the star, a sky-coloured fill, a violet rim on ridges.
  float sun = max(0.0, dot(n, normalize(uSun)));
  vec3 amb = mix(uSkyHorizon * 1.4, uSkyTop * 2.5, n.y * 0.5 + 0.5);
  vec3 V = normalize(uCam - vW);
  float rim = pow(1.0 - max(0.0, dot(n, V)), 4.0);
  vec3 col = alb * (amb * 0.9 + vec3(0.95, 0.9, 1.0) * sun * 1.1);
  col += hsv(vec3(uWorldHue + 0.1, 0.6, 1.0)) * rim * (0.05 + 0.12 * snow);
  // Glowing specks in the moss (static points, never flashing).
  col += hsv(vec3(uWorldHue + 0.15, 0.6, 1.0)) * meadow * pow(max(0.0, snoise(vW * 3.0)), 18.0) * 1.5 * exp(-dist * 0.03);
  // Snow glitter (static, fine: never a flash).
  col += vec3(0.7, 0.8, 1.0) * snow * pow(max(0.0, snoise(vW * 6.0)), 12.0) * 0.6;

  // Contour accent: the object's line language on the rock and ice, fading with distance.
  // Sparse and only on ridged rock and ice, so it reads as an accent, not stripes.
  float v = h * 0.12;
  float f = abs(fract(v) - 0.5) * 2.0;
  float w = fwidth(v);
  float line = smoothstep(1.0 - w * 1.6, 1.0, f) * (1.0 - smoothstep(0.2, 0.5, w)) * smoothstep(0.45, 0.75, slope) * smoothstep(8.0, 20.0, h);
  col += hsv(vec3(uWorldHue - 0.15, 0.7, 1.0)) * line * uGlow * 0.5 * exp(-dist * 0.004);

  gl_FragColor = vec4(fogIt(col, vW), 1.0);
}
`;

/** Water: mirror reflection of the whole scene, turquoise shallows, rain ripples. */
export const WATER_VERT = /* glsl */ `
uniform vec2 uCenter;
varying vec3 vW;
void main(){ vW = vec3(uCenter.x + position.x, 0.0, uCenter.y - position.y); gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }
`;

export const WATER_FRAG = /* glsl */ `
${NOISE}
${SAMPLE}
${LIGHT}
uniform sampler2D tRefl;
uniform mat4 uReflMat;
uniform float uHasRefl;
uniform float uTime;
uniform float uWorldHue;  // cool base (~0.66), nudged by the chord
uniform float uSat;
uniform float uGain;
uniform float uWet;
uniform float uEdit;
uniform float uReduced;
uniform float uFrozen;
uniform vec4 uRip[48];   // x, z, birth time, size
uniform vec4 uRipK[48];  // kind (0 water, 1 soft, 2 hard, 3 bell), hue, velocity, -
varying vec3 vW;
void main(){
  vec2 p = vW.xz;
  float depth = max(0.0, -H(p));
  float dist = length(vW - uCam);
  // Gentle swell (stilled when frozen) plus rain rings.
  float t = uTime * (1.0 - uFrozen);
  vec2 slope = vec2(snoise(vec3(p * 0.15, t * 0.2)), snoise(vec3(p * 0.15 + 7.0, t * 0.2))) * 0.25;
  float ring = 0.0;
  vec3 ripCol = vec3(0.0);
  for (int i = 0; i < 48; i++) {
    float age = uTime - uRip[i].z;
    if (age < 0.0 || age > 2.6) continue;
    vec2 dv = p - uRip[i].xy;
    float d = length(dv);
    float kind = uRipK[i].x;
    float s = uRip[i].w;
    float val = 0.0;
    if (kind < 0.5) {
      float r = age * (0.55 + 0.25 * s);
      val = (exp(-pow((d - r) / 0.03, 2.0)) + 0.5 * exp(-pow((d - r * 0.62) / 0.025, 2.0))) * exp(-age * 1.6);
    } else if (kind < 1.5) {
      val = exp(-d * d / (0.02 + 0.05 * s)) * exp(-age * 3.0) * 0.8;
    } else if (kind < 2.5) {
      float r = age * 1.4 * (0.6 + 0.4 * s);
      val = exp(-pow((d - r) / 0.012, 2.0)) * exp(-age * 5.0) * 1.2;
    } else {
      float r = age * 0.45;
      val = exp(-pow((d - r) / 0.03, 2.0)) * exp(-age * 1.0);
    }
    if (uReduced > 0.5) val = exp(-d * d / 0.03) * exp(-age * 2.0) * 0.5;
    val *= uRipK[i].z;
    slope += normalize(dv + 1e-4) * val * 0.08;
    float hue = kind > 2.5 ? uRipK[i].y : uWorldHue - 0.1;
    ripCol += hsv(vec3(hue, kind > 2.5 ? 0.6 : 0.25 * uSat, 1.0)) * val;
  }
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 V = normalize(uCam - vW);
  float fres = 0.04 + 0.96 * pow(1.0 - max(0.0, dot(n, V)), 5.0);
  vec3 shallow = hsv(vec3(uWorldHue - 0.16, 0.75, 0.35));
  vec3 deep = vec3(0.005, 0.015, 0.05);
  vec3 body = mix(shallow, deep, smoothstep(0.0, 4.5, depth)) * (0.5 + 0.5 * max(0.0, dot(n, normalize(uSun))));
  vec3 refl = uSkyHorizon;
  if (uHasRefl > 0.5) {
    vec4 pr = uReflMat * vec4(vW, 1.0);
    refl = texture2D(tRefl, pr.xy / pr.w + n.xz * 0.03).rgb;
  }
  vec3 col = mix(body, refl, clamp(0.55 + 0.45 * fres, 0.0, 1.0));
  // A thin luminous line where water meets shore, in the palette.
  col += hsv(vec3(uWorldHue + 0.14, 0.5, 1.0)) * (1.0 - smoothstep(0.0, 0.25, depth)) * 0.12;
  col += ripCol * uGain * (1.0 + uEdit) * exp(-dist * 0.05) * 0.8;
  gl_FragColor = vec4(fogIt(col, vW), 1.0);
}
`;

/** Sky: nebula band, stars, a ringed gas giant and a small cratered moon. */
export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }
`;

export const SKY_FRAG = /* glsl */ `
${NOISE}
uniform float uTime;
uniform float uWorldHue;  // cool base (~0.66), nudged by the chord
uniform float uSat;
uniform float uWind;
uniform float uWindPhase;
uniform float uTrip;
uniform float uRain;
uniform vec3 uSun;
uniform vec3 uPlanet;     // direction of the planet's centre
uniform vec3 uMoon;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
varying vec3 vDir;

vec3 basis1(vec3 n){ return normalize(cross(abs(n.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0), n)); }

void main(){
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -0.3, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyTop, smoothstep(-0.05, 0.6, up));

  // Nebula: a warped band across the sky in the vibe's colours.
  vec3 bandN = normalize(vec3(0.35, 0.8, -0.5));
  float band = exp(-pow(dot(d, bandN) / 0.35, 2.0));
  vec3 q = d * 2.4 + vec3(0.0, 0.0, uTime * 0.003 + uWindPhase * 0.01);
  vec3 w = vec3(fbm(q), fbm(q + 5.2), fbm(q + 9.7));
  float neb = fbm(q * 1.4 + w * (1.0 + uTrip));
  vec3 nebCol = mix(hsv(vec3(uWorldHue + 0.12, 0.7, 1.0)), hsv(vec3(uWorldHue + 0.24, 0.55, 1.0)), smoothstep(-0.3, 0.5, w.x));
  col += nebCol * pow(max(0.0, neb + 0.35), 2.2) * band * 0.35 * (1.0 - 0.6 * uRain);
  // Wind aurora low over the ridges.
  float curtain = fbm(vec3(d.x * 3.0 + uWindPhase * 0.12, up * 8.0, d.z * 3.0 + uTime * 0.02));
  col += hsv(vec3(uWorldHue - 0.25, 0.7, 1.0)) * smoothstep(0.08, 0.3, up) * smoothstep(0.55, 0.3, up) * smoothstep(0.0, 0.6, curtain) * 0.12 * uWind;

  // Stars: round points on a 3D cell grid, denser inside the band.
  vec3 cell = floor(d * 420.0);
  float hsh = hash12(cell.xy + cell.z * 17.13);
  if (hsh > 0.9965 - band * 0.004) {
    vec3 c = (cell + 0.5 + (vec3(hash12(cell.yz), hash12(cell.zx), hsh) - 0.5) * 0.6) / 420.0;
    float s = exp(-dot(d - normalize(c), d - normalize(c)) * 420.0 * 420.0 * 3.0);
    col += vec3(0.85, 0.9, 1.0) * s * (0.4 + 0.6 * fract(hsh * 91.0)) * smoothstep(-0.02, 0.1, up) * (1.0 - uRain);
  }

  // Ringed planet: ray-sphere and ray-plane in "sky units" (planet centre at distance 1).
  vec3 P = normalize(uPlanet);
  float Rp = 0.2;
  float b = dot(d, P);
  float disc = b * b - (1.0 - Rp * Rp);
  float tPlanet = disc > 0.0 ? b - sqrt(disc) : 1e9;
  vec3 ringN = normalize(vec3(0.25, 1.0, 0.45));
  float tRing = dot(P, ringN) / dot(d, ringN);
  vec3 rp = d * tRing - P;
  float rr = length(rp) / Rp;
  vec3 ringCol = vec3(0.0);
  float ringA = 0.0;
  if (tRing > 0.0 && rr > 1.35 && rr < 2.35) {
    float bands = 0.55 + 0.45 * sin(rr * 38.0) * sin(rr * 11.0 + 1.0);
    ringA = bands * smoothstep(1.35, 1.45, rr) * smoothstep(2.35, 2.2, rr) * 0.55;
    // Spectral ring colours, as in the reference: rose → gold → teal outward.
    ringCol = hsv(vec3(0.95 - (rr - 1.35) * 0.45 + (uWorldHue - 0.66), 0.65, 1.0)) * 0.8;
  }
  if (disc > 0.0) {
    vec3 hit = d * tPlanet;
    vec3 nrm = normalize(hit - P);
    vec3 T = basis1(P);
    float lat = dot(nrm, cross(P, T));
    float bandsP = fbm(vec3(lat * 9.0, dot(nrm, T) * 1.5, 0.3));
    vec3 surf = mix(hsv(vec3(0.03, 0.4, 0.95)), hsv(vec3(uWorldHue - 0.12, 0.45, 0.8)), smoothstep(-0.4, 0.4, bandsP + lat * 0.8));
    float lit = max(0.0, dot(nrm, normalize(uSun)));
    float rim = pow(1.0 - max(0.0, dot(nrm, -d)), 3.0);
    vec3 pc = surf * (0.03 + lit * 0.9) + hsv(vec3(uWorldHue - 0.16, 0.7, 1.0)) * rim * 0.6;
    col = mix(col, pc, smoothstep(0.0, 0.0015, disc));
  }
  // The ring shows unless the planet is in front of it.
  if (ringA > 0.0 && !(disc > 0.0 && tRing > tPlanet)) col = mix(col, ringCol, ringA);
  // Small cratered moon.
  vec3 M = normalize(uMoon);
  float Rm = 0.045;
  float bm = dot(d, M);
  float dm = bm * bm - (1.0 - Rm * Rm);
  if (dm > 0.0) {
    vec3 hit = d * (bm - sqrt(dm));
    vec3 nrm = normalize(hit - M);
    float crater = fbm(nrm * 6.0);
    float lit = max(0.0, dot(nrm, normalize(uSun)));
    vec3 mc = vec3(0.6, 0.75, 0.95) * (0.08 + 0.9 * lit) * (0.8 + 0.3 * crater);
    col = mix(col, mc, smoothstep(0.0, 0.0004, dm));
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Bark of the chime trees: dark wood, a palette rim, faint glowing grain. */
export const BARK_VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }
`;
export const BARK_FRAG = /* glsl */ `
${NOISE}
${LIGHT}
uniform float uWorldHue;  // cool base (~0.66), nudged by the chord
uniform float uSat;
uniform float uGlow;
varying vec3 vW;
varying vec3 vN;
void main(){
  if (vW.y < uClipBelow) discard;
  vec3 n = normalize(gl_FrontFacing ? vN : -vN);
  vec3 V = normalize(uCam - vW);
  float sun = max(0.0, dot(n, normalize(uSun)));
  vec3 col = vec3(0.03, 0.025, 0.03) * (0.4 + sun) + uSkyTop * 0.6;
  float rim = pow(1.0 - max(0.0, dot(n, V)), 3.0);
  col += hsv(vec3(uWorldHue + 0.1, 0.55, 1.0)) * rim * 0.35;
  float grain = abs(fract(vW.y * 2.2 + snoise(vW * 0.8) * 0.6) - 0.5) * 2.0;
  col += hsv(vec3(uWorldHue - 0.15, 0.7, 1.0)) * smoothstep(0.93, 1.0, grain) * 0.25 * uGlow;
  gl_FragColor = vec4(fogIt(col, vW), 1.0);
}
`;
