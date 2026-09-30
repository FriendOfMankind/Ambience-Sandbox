/**
 * GLSL for the 3D view. Grammar (see docs/VISUALS.md):
 *   music  → the object: shape family per chord, palette from the chord root, note nodes
 *   chimes → filaments around the object and cymatic nodal lines across its skin
 *   rain   → ripples on the lake, falling streaks, a wetter landscape
 *   wind   → the air: curl-noise haze, aurora, gusts bending lines and warping contours
 */

export const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){float a=0.5,s=0.0;for(int i=0;i<4;i++){s+=a*snoise(p);p=p*2.03+17.1;a*=0.5;}return s;}
vec3 hsv(vec3 c){vec3 p=abs(fract(c.xxx+vec3(0.0,2.0/3.0,1.0/3.0))*6.0-3.0);return c.z*mix(vec3(1.0),clamp(p-1.0,0.0,1.0),c.y);}
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*0.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
`;

/** Shape of the object: a chord pose (morphing), domain-warped noise, note bulges and cymatics. */
export const SHAPE = /* glsl */ `
uniform float uTime;
uniform vec4 uPoseA;   // lobes around, lobes down, amplitude, twist
uniform vec4 uPoseB;
uniform float uMorph;
uniform float uNoise;
uniform float uBreath;
uniform vec3 uGust;
uniform vec4 uNodes[12];     // direction xyz, age (s)
uniform vec4 uNodeInfo[12];  // hue, velocity, -, -
uniform float uTubeE[8];
uniform float uTubeHue[8];
uniform float uTubes;

float pose(vec4 P, float th, float ph){
  return P.z * sin(P.x * th + P.w * ph + uTime * 0.06) * sin(P.y * ph);
}
float chladni(int i, float th, float ph){
  float l = float(2 + i);
  float m = float(1 + (i * 3) % (2 + i));
  return cos(l * ph) * cos(m * th) - cos(m * ph) * cos(l * th);
}
float radiusAt(vec3 d){
  float th = atan(d.z, d.x);
  float ph = acos(clamp(d.y, -1.0, 1.0));
  float r = mix(pose(uPoseA, th, ph), pose(uPoseB, th, ph), uMorph);
  vec3 q = d * 1.3 + vec3(0.0, uTime * 0.05, 0.0);
  vec3 w = vec3(snoise(q + 3.1), snoise(q + 7.7), snoise(q + 11.3));
  r += uNoise * snoise(d * 1.7 + w * 0.9 + uTime * 0.03);
  for (int i = 0; i < 12; i++) {
    float age = uNodes[i].w;
    if (age > 6.0) continue;
    float c = dot(d, uNodes[i].xyz);
    float a2 = max(0.0, 1.0 - c) * 2.0;           // ≈ angle² for small angles
    r += uNodeInfo[i].y * 0.16 * exp(-a2 * 14.0) * exp(-age * 0.9);
  }
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uTubes || uTubeE[i] < 0.01) continue;
    r += 0.035 * uTubeE[i] * chladni(i, th, ph);
  }
  return 1.0 + r;
}
vec3 shapePoint(vec3 d){
  vec3 p = d * radiusAt(d) * (1.0 + uBreath);
  p += uGust * (p.y + 1.2) * 0.12;
  return p;
}
`;

export const SHELL_VERT = /* glsl */ `
${NOISE}
${SHAPE}
varying vec3 vDir;
varying vec3 vN;
varying vec3 vV;
varying float vR;
void main(){
  vec3 d = normalize(position);
  vec3 up = abs(d.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t1 = normalize(cross(d, up));
  vec3 t2 = cross(d, t1);
  float e = 0.012;
  vec3 p0 = shapePoint(d);
  vec3 p1 = shapePoint(normalize(d + t1 * e));
  vec3 p2 = shapePoint(normalize(d + t2 * e));
  vec3 n = normalize(cross(p1 - p0, p2 - p0));
  if (dot(n, d) < 0.0) n = -n;
  vDir = d;
  vR = length(p0);
  vec4 mv = modelViewMatrix * vec4(p0, 1.0);
  vN = normalize(normalMatrix * n);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const SHELL_FRAG = /* glsl */ `
${NOISE}
uniform float uTime;
uniform float uHue;
uniform float uSat;
uniform float uLevel;
uniform float uEdit;
uniform float uEditHue;
uniform float uGain;       // flash-guard gain on event light
uniform float uDim;        // reflection copies render dimmer
uniform float uReduced;
uniform vec4 uNodes[12];
uniform vec4 uNodeInfo[12];
uniform float uTubeE[8];
uniform float uTubeHue[8];
uniform float uTubes;
varying vec3 vDir;
varying vec3 vN;
varying vec3 vV;
varying float vR;
float chladni(int i, float th, float ph){
  float l = float(2 + i);
  float m = float(1 + (i * 3) % (2 + i));
  return cos(l * ph) * cos(m * th) - cos(m * ph) * cos(l * th);
}
float lineAA(float v, float width){
  float f = abs(fract(v) - 0.5) * 2.0;           // 1 on the line, 0 halfway between
  float w = fwidth(v) * width;
  return smoothstep(1.0 - w * 2.0, 1.0, f);
}
void main(){
  vec3 N = normalize(gl_FrontFacing ? vN : -vN);
  float fres = pow(1.0 - abs(dot(N, normalize(vV))), 2.2);
  vec3 d = normalize(vDir);
  float th = atan(d.z, d.x);
  float ph = acos(clamp(d.y, -1.0, 1.0));

  // Thin-film sheen: hue slides with viewing angle and with the surface height.
  vec3 film = hsv(vec3(uHue + 0.18 * fres + 0.9 * (vR - 1.0) + 0.03 * sin(uTime * 0.2), uSat, 1.0));
  vec3 col = film * (0.004 + 0.1 * fres);

  // Contour lines of the radius: the same topographic language as the landscape.
  float contour = lineAA(vR * 11.0, 0.9);
  col += hsv(vec3(uHue + 0.06, uSat, 1.0)) * contour * (0.03 + 0.07 * uLevel);

  // Cymatics: nodal lines of each ringing tube glow in that tube's colour.
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uTubes || uTubeE[i] < 0.01) continue;
    float f = chladni(i, th, ph);
    float nl = 1.0 - smoothstep(0.0, fwidth(f) * 0.9, abs(f));
    col += hsv(vec3(uTubeHue[i], 0.6, 1.0)) * nl * uTubeE[i] * uTubeE[i] * 0.4 * uGain;
  }

  // Notes: a small core and a ring travelling out across the skin.
  for (int i = 0; i < 12; i++) {
    float age = uNodes[i].w;
    if (age > 6.0) continue;
    float ang = acos(clamp(dot(d, uNodes[i].xyz), -1.0, 1.0));
    vec3 hc = hsv(vec3(uNodeInfo[i].x, 0.65, 1.0));
    float v = uNodeInfo[i].y;
    float core = exp(-ang * ang * 160.0) * smoothstep(0.0, 0.12, age) * exp(-age * 1.1);
    float ringR = uReduced > 0.5 ? 0.18 : age * 0.55;
    float ring = exp(-pow((ang - ringR) / 0.018, 2.0)) * exp(-age * 0.8) * smoothstep(0.0, 0.1, age);
    col += hc * (core * 1.4 + ring * 0.7) * v * uGain;
  }

  col += hsv(vec3(uEditHue, 0.45, 1.0)) * (contour * 0.5 + fres * 0.25) * uEdit;
  gl_FragColor = vec4(col * uDim, 1.0);
}
`;

/** The geodesic cage: a sparse icosahedron wireframe riding the same shape. */
export const CAGE_VERT = /* glsl */ `
${NOISE}
${SHAPE}
varying float vGlow;
varying float vR;
void main(){
  vec3 d = normalize(position);
  vec3 p = shapePoint(d) * 1.015;
  vR = length(p);
  float g = 0.0;
  for (int i = 0; i < 12; i++) {
    float age = uNodes[i].w;
    if (age > 6.0) continue;
    float c = dot(d, uNodes[i].xyz);
    g += uNodeInfo[i].y * smoothstep(0.93, 1.0, c) * exp(-age * 0.9);
  }
  vGlow = g;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const CAGE_FRAG = /* glsl */ `
${NOISE}
uniform float uHue;
uniform float uSat;
uniform float uLevel;
uniform float uGain;
uniform float uDim;
uniform float uEdit;
varying float vGlow;
varying float vR;
void main(){
  vec3 c = hsv(vec3(uHue - 0.08 + 0.4 * (vR - 1.0), uSat * 0.9, 1.0));
  float a = 0.06 + 0.1 * uLevel + 0.7 * vGlow * uGain + 0.2 * uEdit;
  gl_FragColor = vec4(c * a * uDim, 1.0);
}
`;

/** Strange-attractor core: Aizawa blended with Thomas, integrated on the GPU. */
export const ATTRACTOR_SIM = /* glsl */ `
uniform float uDt;
uniform float uMix;      // 0 Aizawa … 1 Thomas
uniform float uA;
uniform float uD;
uniform float uSeed;
float h(vec2 p){vec3 p3=fract(vec3(p.xyx)*0.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
vec3 aizawa(vec3 p){
  float a=uA,b=0.7,c=0.6,d=uD,e=0.25,f=0.1;
  return vec3((p.z-b)*p.x-d*p.y, d*p.x+(p.z-b)*p.y, c+a*p.z-p.z*p.z*p.z/3.0-(p.x*p.x+p.y*p.y)*(1.0+e*p.z)+f*p.z*p.x*p.x*p.x);
}
vec3 thomas(vec3 p){
  float b=0.19;
  vec3 q=p*2.6;
  return vec3(sin(q.y)-b*q.x, sin(q.z)-b*q.y, sin(q.x)-b*q.z)/2.6*1.6;
}
void main(){
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 s = texture2D(tPos, uv);
  vec3 p = s.xyz;
  vec3 v = mix(aizawa(p), thomas(p - vec3(0.0, 0.0, 0.3)), uMix);
  p += v * uDt;
  float bad = (any(isnan(p)) || length(p) > 4.0) ? 1.0 : 0.0;
  float respawn = step(h(uv * 91.7 + uSeed), 0.0025);
  if (bad + respawn > 0.0) {
    p = vec3(h(uv + uSeed) - 0.5, h(uv * 3.1 + uSeed) - 0.5, h(uv * 7.3 + uSeed)) * 0.6;
  }
  gl_FragColor = vec4(p, length(v));
}
`;

export const ATTRACTOR_VERT = /* glsl */ `
uniform sampler2D tPos;
uniform float uSize;
uniform float uPixel;
varying float vSpeed;
varying float vHeight;
varying float vArea;
void main(){
  vec4 s = texture2D(tPos, position.xy);
  vec3 p = vec3(s.x, s.z - 0.35, s.y) * 0.62;
  vSpeed = s.w;
  vHeight = s.z;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // Sub-pixel points rasterise unstably (they shimmer as they move); draw them at least 1.5 px
  // and dim them by the area they gained, so total light is unchanged at any resolution.
  float sz = uSize * uPixel / max(0.5, -mv.z);
  vArea = min(1.0, (sz * sz) / 2.25);
  gl_PointSize = max(sz, 1.5);
  gl_Position = projectionMatrix * mv;
}
`;

export const ATTRACTOR_FRAG = /* glsl */ `
${NOISE}
uniform float uHue;
uniform float uSat;
uniform float uLevel;
uniform float uDim;
uniform float uBoost;
varying float vSpeed;
varying float vHeight;
varying float vArea;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.25, 0.0, dot(c, c));
  vec3 col = hsv(vec3(uHue + 0.5 + 0.12 * clamp(vSpeed * 0.4, 0.0, 1.0) - 0.08 * vHeight, uSat * 0.85, 1.0));
  gl_FragColor = vec4(col * a * vArea * (0.08 + 0.11 * uLevel + 0.11 * uBoost) * uDim, 1.0);
}
`;

/** Chime filaments: thin rods whose glow follows the tube's ring. */
export const ROD_VERT = /* glsl */ `
varying float vY;
void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
export const ROD_FRAG = /* glsl */ `
${NOISE}
uniform float uHue;
uniform float uE;
uniform float uGain;
uniform float uDim;
uniform float uEdit;
varying float vY;
void main(){
  vec3 c = hsv(vec3(uHue, 0.5, 1.0));
  float a = 0.12 + 0.2 * uEdit + 1.6 * uE * uGain * (0.5 + 0.5 * vY);
  gl_FragColor = vec4(c * a * uDim, 1.0);
}
`;




/** Rain streaks: line segments falling through a box around the view, slanted by the wind. */
export const RAIN_VERT = /* glsl */ `
attribute vec4 aSeed;   // x, z, phase, speed
attribute float aEnd;   // 0 top, 1 bottom
attribute float aIndex; // 0..1
uniform float uTime;
uniform float uDensity;
uniform float uWind;
uniform vec3 uCenter;   // the camera: the rain box wraps around it
varying float vFade;
varying float vEnd;
void main(){
  if (aIndex > uDensity) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float fall = fract(aSeed.z - uTime * aSeed.w * 0.55);
  vec2 rel = mod(aSeed.xy - uCenter.xz + 22.0, 44.0) - 22.0;
  vec3 p = vec3(uCenter.x + rel.x, uCenter.y - 6.0 + fall * 18.0, uCenter.z + rel.y);
  vec3 vel = normalize(vec3(uWind * 0.9, -1.0, 0.0));
  p -= vel * aEnd * 0.55;
  vFade = smoothstep(0.0, 0.1, fall) * smoothstep(1.0, 0.8, fall);
  vEnd = aEnd;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;
export const RAIN_FRAG = /* glsl */ `
${NOISE}
uniform float uHue;
varying float vFade;
varying float vEnd;
void main(){ gl_FragColor = vec4(hsv(vec3(uHue + 0.5, 0.2, 1.0)) * 0.05 * vFade * (1.0 - vEnd * 0.8), 1.0); }
`;

/** Wind haze: points carried by the wind through a curl-noise field. */
export const HAZE_VERT = /* glsl */ `
${NOISE}
uniform float uTime;
uniform float uWindPhase;
uniform float uPixel;
uniform float uWind;
uniform vec3 uCenter;
varying float vA;
vec3 curl(vec3 p){
  float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  float x = snoise(p + dy) - snoise(p - dy) - snoise(p + dz + 31.0) + snoise(p - dz + 31.0);
  float y = snoise(p + dz + 17.0) - snoise(p - dz + 17.0) - snoise(p + dx) + snoise(p - dx);
  float z = snoise(p + dx + 31.0) - snoise(p - dx + 31.0) - snoise(p + dy + 17.0) + snoise(p - dy + 17.0);
  return vec3(x, y, z) / (2.0 * e);
}
void main(){
  vec3 p = position;
  vec2 rel = mod(vec2(p.x + uWindPhase, p.z) - uCenter.xz + 30.0, 60.0) - 30.0;
  p = vec3(uCenter.x + rel.x, uCenter.y - 3.0 + p.y, uCenter.z + rel.y);
  p += curl(p * 0.07 + vec3(0.0, uTime * 0.02, uWindPhase * 0.01)) * (0.8 + 1.5 * uWind);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vA = smoothstep(30.0, 5.0, -mv.z);
  gl_PointSize = 1.6 * uPixel * (4.0 / max(1.0, -mv.z * 0.4));
  gl_Position = projectionMatrix * mv;
}
`;
export const HAZE_FRAG = /* glsl */ `
${NOISE}
uniform float uHue;
uniform float uWind;
uniform float uEdit;
varying float vA;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.25, 0.0, dot(c, c));
  gl_FragColor = vec4(hsv(vec3(uHue + 0.35, 0.35, 1.0)) * a * vA * (0.02 + 0.09 * uWind + 0.06 * uEdit), 1.0);
}
`;

// ------------------------------------------------------------------ post

export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Feedback: the object layer is kept, warped, rotated and hue-turned each frame (MilkDrop-style). */
export const FEEDBACK_FRAG = /* glsl */ `
${NOISE}
uniform sampler2D tCur;
uniform sampler2D tPrev;
uniform float uDecay;
uniform float uZoom;
uniform float uRot;
uniform float uWarp;
uniform float uHueTurn;
uniform float uTime;
uniform float uAspect;
uniform vec2 uCenter;
varying vec2 vUv;
vec3 hueTurn(vec3 c, float a){
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
void main(){
  vec3 cur = texture2D(tCur, vUv).rgb;
  vec2 c = vUv - uCenter;
  c.x *= uAspect;
  float s = sin(uRot), co = cos(uRot);
  c = mat2(co, -s, s, co) * c / uZoom;
  c += uWarp * 0.004 * vec2(snoise(vec3(c * 3.0, uTime * 0.1)), snoise(vec3(c * 3.0 + 9.0, uTime * 0.1)));
  c.x /= uAspect;
  vec3 prev = hueTurn(texture2D(tPrev, c + uCenter).rgb, uHueTurn);
  // Lighten, not add: trails never get brighter than what made them.
  gl_FragColor = vec4(max(cur, prev * uDecay), 1.0);
}
`;

export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tBg;
uniform sampler2D tFg;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(texture2D(tBg, vUv).rgb + texture2D(tFg, vUv).rgb, 1.0); }
`;

/** Final: kaleidoscope fold at high Trip, chromatic aberration, vignette, grain, tone map. */
export const FINAL_FRAG = /* glsl */ `
${NOISE}
uniform sampler2D tIn;
uniform float uKal;
uniform float uSides;
uniform float uKalRot;
uniform float uCA;
uniform float uGrain;
uniform float uExposure;
uniform float uTime;
uniform float uAspect;
uniform vec2 uCenter;
varying vec2 vUv;
vec2 fold(vec2 uv){
  vec2 c = uv - uCenter;
  c.x *= uAspect;
  float r = length(c);
  float a = atan(c.y, c.x) + uKalRot;
  float seg = 6.2831853 / uSides;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  c = r * vec2(cos(a), sin(a));
  c.x /= uAspect;
  return c + uCenter;
}
vec3 sampleCA(vec2 uv){
  vec2 dir = (uv - 0.5) * uCA;
  return vec3(texture2D(tIn, uv + dir).r, texture2D(tIn, uv).g, texture2D(tIn, uv - dir).b);
}
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main(){
  // Fold space, not the picture: coordinates bend toward their mirrored positions, starting at
  // the screen edge and creeping inward as uKal rises, so there is never a double image.
  vec2 uv = vUv;
  if (uKal > 0.001) {
    vec2 c = vUv - uCenter;
    c.x *= uAspect;
    float reach = mix(1.3, 0.28, uKal);
    float k = smoothstep(reach, reach + 0.4, length(c)) * uKal * 0.92;
    uv = mix(vUv, fold(vUv), k);
  }
  vec3 col = sampleCA(uv);
  vec2 v = vUv - 0.5;
  col *= 1.0 - dot(v, v) * 0.9;
  col = aces(col * uExposure);
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  col += (hash12(vUv * 1000.0 + fract(uTime * 7.0) * 100.0) - 0.5) * uGrain;
  gl_FragColor = vec4(col, 1.0);
}
`;
