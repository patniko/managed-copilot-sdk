import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Noise } from '../../core/noise';
import { Rng } from '../../core/rng';
import { ATMOSPHERE_GLSL, G, atmoUniforms, paintMaterial, patchMaterial } from '../../render/globals';
import type { JumpFeature } from '../features';
import type { SetPieceHandle, WorldContext } from '../types';
import { CLOUD, dreamscape, MESAS, spineX } from '../envs/dream';

const noise = new Noise(5150);

const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

/** Normalise a part for merging: non-indexed, no uv, flat colour (or keep existing colour), glow attribute. */
function part(g: THREE.BufferGeometry, color: THREE.ColorRepresentation | null, glow = 0): THREE.BufferGeometry {
  const geo = ni(g);
  if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const p = geo.getAttribute('position');
  if (color !== null) {
    const c = new THREE.Color(color);
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  geo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(p.count).fill(glow), 1));
  return geo;
}

/** Lambert material whose emission follows the vertex colour, scaled per vertex by `aGlow`. */
function glowMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  return patchMaterial(m, {
    key: 'dreamglow',
    extend: (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow;');
    },
  });
}

/** Everything set pieces must keep clear of: trails, jumps and freeride kickers (rebuilt deterministically). */
class Keepout {
  private feats: readonly JumpFeature[];
  constructor(private ctx: WorldContext) {
    this.feats = ctx.features;
  }
  clear(x: number, z: number, r: number, trail: number) {
    if (this.ctx.terrain.trailDistAt(x, z) < r + trail) return false;
    for (const f of this.feats) {
      const b = f.bbox;
      if (x > b.min.x - r - 6 && x < b.max.x + r + 6 && z > b.min.y - r - 6 && z < b.max.y + r + 6) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------- cloud sea

const CLOUDSEA_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CLOUDSEA_FRAG = /* glsl */ `
uniform sampler2D uHeight;
uniform vec4 uRect;
uniform float uLevel;
uniform float uTime;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uDeep;
uniform vec3 uWarm;
uniform vec3 uHorizon;
${ATMOSPHERE_GLSL}
varying vec3 vWorld;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float billow(vec2 p, float lod) {
  vec2 d = vec2(uTime * 1.6, uTime * 0.6);
  float h = vnoise((p + d) / 520.0) * 0.55;
  h += vnoise((p - d * 0.7) / 190.0 + 3.1) * 0.3 * (1.0 - lod * 0.6);
  h += vnoise((p + d * 1.3) / 70.0 + 7.7) * 0.15 * (1.0 - lod);
  return h;
}
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  float lod = smoothstep(1500.0, 7000.0, dist);
  vec2 p = vWorld.xz;
  float e = mix(14.0, 60.0, lod);
  float h = billow(p, lod);
  float hx = billow(p + vec2(e, 0.0), lod);
  float hz = billow(p + vec2(0.0, e), lod);
  vec3 N = normalize(vec3(-(hx - h) * 900.0 / e, 1.0, -(hz - h) * 900.0 / e));
  float diff = clamp(dot(N, uSunDir), 0.0, 1.0);
  float lit = smoothstep(0.15, 0.85, diff * 0.75 + h * 0.55);
  vec3 col = mix(uShade, uLit, lit);
  col = mix(col, uWarm, pow(diff, 6.0) * 0.45);
  col = mix(uDeep, col, smoothstep(0.18, 0.5, h));
  // land rising through: thin the cloud and add a bright surf of mist
  vec2 huv = (vWorld.xz - uRect.xy) / uRect.zw;
  float ground = texture2D(uHeight, huv).r;
  float depth = uLevel - ground;
  float a = smoothstep(-25.0, 45.0, depth);
  if (a < 0.01) discard;
  col = mix(col, uLit, (1.0 - smoothstep(0.0, 90.0, abs(depth - 20.0))) * 0.35);
  // far away the billows merge into a soft pastel horizon
  col = mix(col, uHorizon, smoothstep(5000.0, 16000.0, dist) * 0.75);
  col = mix(col, applyAtmosphere(col, vWorld), 0.6);
  gl_FragColor = vec4(col, a);
}
`;

function buildCloudSea(farH: (x: number, z: number) => number, centre: THREE.Vector2): THREE.Mesh {
  const res = 192;
  const extent = 9000;
  const data = new Float32Array(res * res);
  const minX = centre.x - extent;
  const minZ = centre.y - extent;
  const size = extent * 2;
  for (let j = 0; j < res; j++)
    for (let i = 0; i < res; i++) data[j * res + i] = farH(minX + ((i + 0.5) / res) * size, minZ + ((j + 0.5) / res) * size);
  const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.FloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  const mat = new THREE.ShaderMaterial({
    vertexShader: CLOUDSEA_VERT,
    fragmentShader: CLOUDSEA_FRAG,
    transparent: true,
    depthWrite: true,
    uniforms: {
      uHeight: { value: tex },
      uRect: { value: new THREE.Vector4(minX, minZ, size, size) },
      uLevel: { value: CLOUD },
      uTime: G.uTime,
      uLit: { value: new THREE.Color('#fff2f6') },
      uShade: { value: new THREE.Color('#d6b4ee') },
      uDeep: { value: new THREE.Color('#b292e0') },
      uWarm: { value: new THREE.Color('#ffd9b0') },
      uHorizon: { value: new THREE.Color('#f6d4ee') },
      ...atmoUniforms(),
    },
  });
  const geo = new THREE.PlaneGeometry(60000, 60000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(centre.x, CLOUD, centre.y);
  mesh.frustumCulled = false;
  mesh.renderOrder = -4;
  return mesh;
}

// ---------------------------------------------------------------- billboard cloud puffs (one draw call)

const PUFF_VERT = /* glsl */ `
attribute vec4 iPos;
attribute vec2 iSize;
varying vec2 vUv;
varying vec3 vWorld;
varying float vTint;
void main() {
  vec3 toCam = cameraPosition - iPos.xyz;
  toCam.y = 0.0;
  vec3 fwd = normalize(toCam);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 wp = iPos.xyz + right * position.x * iSize.x + vec3(0.0, 1.0, 0.0) * position.y * iSize.y;
  vUv = uv;
  vWorld = wp;
  vTint = iPos.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const PUFF_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec3 uLit;
uniform vec3 uShade;
${ATMOSPHERE_GLSL}
varying vec2 vUv;
varying vec3 vWorld;
varying float vTint;
void main() {
  vec4 t = texture2D(uTex, vUv);
  if (t.a < 0.02) discard;
  vec3 col = mix(uShade, uLit, t.r) * (0.95 + 0.1 * vTint);
  col = mix(col, applyAtmosphere(col, vWorld), 0.6);
  gl_FragColor = vec4(col, t.a);
}
`;

function paintPuff(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const rng = new Rng(404);
  // canvas y grows downward and the texture is flipped on upload, so canvas top = top of the puff
  const puffs: Array<[number, number, number]> = [];
  for (let i = 0; i < 26; i++) {
    const x = S * (0.5 + rng.gauss() * 0.16);
    const env = Math.exp(-Math.pow((x - S / 2) / (S * 0.28), 2));
    const y = S * 0.82 - rng.next() * env * S * 0.42;
    const r = S * (0.07 + 0.08 * rng.next()) * (0.6 + 0.6 * env);
    puffs.push([x, y, r]);
  }
  ctx.filter = 'blur(2px)';
  for (const [x, y, r] of puffs) {
    ctx.fillStyle = 'rgba(70,0,0,1)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const [x, y, r] of puffs) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x - r * 0.15, y - r * 0.2, r);
    g.addColorStop(0, 'rgba(255,0,0,1)');
    g.addColorStop(0.7, 'rgba(230,0,0,0.8)');
    g.addColorStop(1, 'rgba(120,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x - r * 0.15, y - r * 0.2, r * 0.95, 0, Math.PI * 2);
    ctx.fill();
  }
  // soft base
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'destination-out';
  const fade = ctx.createLinearGradient(0, S * 0.7, 0, S);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Cumulus puffs sitting on the cloud sea along the island cliffs and around the mesas. */
function buildPuffs(farH: (x: number, z: number) => number, rng: Rng): THREE.Mesh {
  const pts: number[] = [];
  const sizes: number[] = [];
  let tries = 0;
  while (pts.length / 4 < 160 && tries++ < 30000) {
    const x = -60 + (rng.next() - 0.5) * 9000;
    const z = -1300 + (rng.next() - 0.5) * 9000;
    const w = 120 + rng.next() * 260;
    const h = farH(x, z);
    // where the land meets the clouds
    if (h > CLOUD + 20 || h < CLOUD - 140) continue;
    pts.push(x, CLOUD - w * 0.12, z, rng.next());
    sizes.push(w, w * (0.42 + rng.next() * 0.2));
  }
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.getAttribute('position'));
  g.setAttribute('uv', quad.getAttribute('uv'));
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(pts), 4));
  g.setAttribute('iSize', new THREE.InstancedBufferAttribute(new Float32Array(sizes), 2));
  g.instanceCount = pts.length / 4;
  const mat = new THREE.ShaderMaterial({
    vertexShader: PUFF_VERT,
    fragmentShader: PUFF_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTex: { value: paintPuff() },
      uLit: { value: new THREE.Color('#fff6fa') },
      uShade: { value: new THREE.Color('#c9aaf0') },
      ...atmoUniforms(),
    },
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -3;
  return mesh;
}

// ---------------------------------------------------------------- floating islands

function waterfallTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const rng = new Rng(88);
  ctx.fillStyle = '#bff4f4';
  ctx.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 40; i++) {
    ctx.globalAlpha = 0.4 + rng.next() * 0.6;
    ctx.fillStyle = rng.pick(['#ffffff', '#e6fcff', '#9ee6ee', '#ffffff']);
    ctx.fillRect(rng.next() * 64, 0, 1.5 + rng.next() * 5, 256);
  }
  for (let i = 0; i < 50; i++) {
    const x = rng.next() * 64,
      y = rng.next() * 256;
    ctx.globalAlpha = 0.5 + rng.next() * 0.5;
    ctx.fillStyle = '#ffffff';
    const h = 8 + rng.next() * 24;
    ctx.fillRect(x, y, 2 + rng.next() * 6, h);
    ctx.fillRect(x, y - 256, 2 + rng.next() * 6, h);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function fallAlpha(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(32, 128);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 32; x++) {
      const u = Math.abs(x / 31 - 0.5) * 2;
      const v = 1 - y / 127; // 1 at the top of the fall
      const a = (1 - Math.pow(u, 2.5)) * Math.min(1, (1 - v) * 10 + 0.2) * Math.pow(v, 0.7);
      const o = (y * 32 + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(255 * Math.max(0, Math.min(1, a)));
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

interface IslandDef {
  x: number;
  y: number;
  z: number;
  r: number;
  hue: string;
  falls: number;
  trees: number;
}

const ISLANDS: IslandDef[] = [
  { x: 430, y: 840, z: -760, r: 80, hue: '#ff8cc6', falls: 1, trees: 6 },
  { x: -700, y: 690, z: -1350, r: 120, hue: '#7fe6c6', falls: 2, trees: 9 },
  { x: 540, y: 540, z: -1950, r: 95, hue: '#c09cff', falls: 1, trees: 7 },
  { x: -560, y: 470, z: -2550, r: 75, hue: '#ffb08a', falls: 1, trees: 5 },
  { x: 330, y: 760, z: -3350, r: 170, hue: '#ff8cc6', falls: 2, trees: 12 },
  { x: -1450, y: 1150, z: -3850, r: 260, hue: '#8ef0d0', falls: 2, trees: 14 },
  { x: 1650, y: 1350, z: -2450, r: 300, hue: '#ffa6cc', falls: 3, trees: 16 },
  { x: -1850, y: 1000, z: -1600, r: 200, hue: '#c8a8ff', falls: 2, trees: 10 },
  { x: 150, y: 1650, z: -5300, r: 420, hue: '#ff9cc8', falls: 3, trees: 20 },
  { x: 2450, y: 950, z: -4800, r: 240, hue: '#8ef0dc', falls: 2, trees: 12 },
  { x: -2700, y: 1450, z: -5600, r: 380, hue: '#ffc29e', falls: 2, trees: 16 },
  { x: 900, y: 1150, z: 650, r: 120, hue: '#c09cff', falls: 1, trees: 6 },
  { x: -1050, y: 1250, z: 300, r: 180, hue: '#ff8cc6', falls: 2, trees: 9 },
  { x: 3000, y: 1750, z: -800, r: 350, hue: '#ffa0cc', falls: 2, trees: 14 },
];

const STRATA = ['#fff0dc', '#ffc2a4', '#d8b8f4', '#f4a6c4', '#fde0f0', '#c4a8ec'];

function candyTree(rng: Rng, x: number, y: number, z: number, s: number, parts: THREE.BufferGeometry[]) {
  const trunkH = 2.2 * s;
  const trunk = new THREE.CylinderGeometry(0.16 * s, 0.26 * s, trunkH, 6);
  trunk.translate(x, y + trunkH / 2, z);
  parts.push(part(trunk, '#f6e2d0'));
  const col = new THREE.Color(rng.pick(['#5fd6c8', '#8ef0d0', '#f7a0d0', '#c8b0ff', '#6ee0e4']));
  for (let k = 0; k < 3; k++) {
    let b: THREE.BufferGeometry = new THREE.IcosahedronGeometry((1.1 + rng.next() * 0.5) * s, 1);
    b.deleteAttribute('uv');
    b.deleteAttribute('normal');
    b = mergeVertices(b);
    b.translate(x + (rng.next() - 0.5) * 1.6 * s, y + trunkH + (0.6 + rng.next() * 0.9) * s, z + (rng.next() - 0.5) * 1.6 * s);
    b.computeVertexNormals();
    const g = part(b, null);
    const p = g.getAttribute('position');
    const nn = g.getAttribute('normal');
    const cc = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const k2 = 0.72 + 0.4 * (nn.getY(i) * 0.5 + 0.5);
      cc[i * 3] = col.r * k2;
      cc[i * 3 + 1] = col.g * k2;
      cc[i * 3 + 2] = col.b * k2;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    parts.push(g);
  }
}

/** Hexagonal crystal prism with a pointed tip (unit height along +y). */
function prism(r: number, h: number): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(r * 0.92, r, h * 0.78, 6);
  body.translate(0, h * 0.39, 0);
  const tip = new THREE.ConeGeometry(r * 0.92, h * 0.22, 6);
  tip.translate(0, h * 0.89, 0);
  const a = ni(body);
  const b = ni(tip);
  a.deleteAttribute('uv');
  b.deleteAttribute('uv');
  const g = mergeGeometries([a, b]);
  g.computeVertexNormals();
  return g;
}

/** Colour a prism brighter toward its tip, then normalise it for merging. */
function shadePrism(g: THREE.BufferGeometry, baseY: number, h: number, color: THREE.Color, glow: number, flip: boolean) {
  const p = g.getAttribute('position');
  const cc = new Float32Array(p.count * 3);
  const white = new THREE.Color('#ffffff');
  const tc = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, ((flip ? baseY - p.getY(i) : p.getY(i) - baseY) / h)));
    tc.copy(color).multiplyScalar(0.7 + 0.35 * t).lerp(white, Math.pow(t, 4) * 0.5);
    cc[i * 3] = tc.r;
    cc[i * 3 + 1] = tc.g;
    cc[i * 3 + 2] = tc.b;
  }
  const out = part(g, null, glow);
  out.setAttribute('color', new THREE.BufferAttribute(cc, 3));
  return out;
}

/** Cluster of crystal prisms; `flip` hangs them downward (under islands). */
function crystalCluster(rng: Rng, x: number, y: number, z: number, h: number, color: THREE.Color, parts: THREE.BufferGeometry[], glow: number, flip = false, spread = 0.4) {
  const n = 3 + rng.int(0, 3);
  for (let k = 0; k < n; k++) {
    const hh = h * (k === 0 ? 1 : 0.35 + rng.next() * 0.45);
    const g = prism(hh * (0.085 + rng.next() * 0.03), hh);
    g.rotateZ((rng.next() - 0.5) * (k === 0 ? 0.12 : 0.7));
    g.rotateX((rng.next() - 0.5) * (k === 0 ? 0.12 : 0.7));
    g.rotateY(rng.next() * Math.PI);
    if (flip) g.rotateX(Math.PI);
    const ox = k === 0 ? 0 : (rng.next() - 0.5) * h * spread;
    const oz = k === 0 ? 0 : (rng.next() - 0.5) * h * spread;
    g.translate(x + ox, y + (flip ? hh * 0.04 : -hh * 0.04), z + oz);
    parts.push(shadePrism(g, y, hh, color, glow, flip));
  }
}

/** One floating island: grassy dome, banded rock cone underneath, candy trees, hanging crystals, waterfalls. */
function buildIsland(def: IslandDef, rng: Rng, fallMat: THREE.Material, mat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const R = def.r;
  const segs = 30;
  const rows = 22;
  const depth = R * (1.25 + rng.next() * 0.45);
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const grass = new THREE.Color(def.hue);
  const grassDark = grass.clone().multiplyScalar(0.8);
  const rim = new THREE.Color(STRATA[0]);
  const radial: number[] = [];
  for (let a = 0; a < segs; a++) radial.push(1 + 0.16 * noise.noise2(Math.cos((a / segs) * Math.PI * 2) * 1.4 + def.x * 0.01, Math.sin((a / segs) * Math.PI * 2) * 1.4));
  const c = new THREE.Color();
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    for (let a = 0; a <= segs; a++) {
      const ang = ((a % segs) / segs) * Math.PI * 2;
      const rr = R * radial[a % segs];
      let r: number, y: number;
      if (v <= 0.36) {
        // grassy dome
        const t = v / 0.36;
        r = rr * t;
        y = R * 0.1 * (1 - t * t) + 0.02 * R * noise.noise2(Math.cos(ang) * t * 3, Math.sin(ang) * t * 3);
        c.copy(grass).lerp(grassDark, t * t * 0.6);
      } else if (v <= 0.44) {
        // rounded lip
        const t = (v - 0.36) / 0.08;
        r = rr * (1 + 0.04 * Math.sin(t * Math.PI));
        y = -R * 0.07 * t;
        c.copy(grass).lerp(rim, t * 0.7).multiplyScalar(1.08);
      } else {
        // underside: tapering banded rock
        const t = (v - 0.44) / 0.56;
        const taper = Math.pow(1 - t, 0.85);
        const wob = 1 + 0.18 * noise.noise3(Math.cos(ang) * 2, t * 4 + def.z * 0.01, Math.sin(ang) * 2);
        r = rr * taper * wob;
        y = -R * 0.07 - depth * t;
        const band = Math.floor(y / (R * 0.12) + noise.noise2(ang * 2, t * 3) * 0.8);
        c.set(STRATA[((band % STRATA.length) + STRATA.length) % STRATA.length]).multiplyScalar(0.98 - 0.3 * t);
      }
      pos.push(Math.cos(ang) * r, y, Math.sin(ang) * r);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < rows; j++)
    for (let a = 0; a < segs; a++) {
      const p0 = j * (segs + 1) + a;
      const p1 = p0 + 1;
      const p2 = p0 + segs + 1;
      const p3 = p2 + 1;
      idx.push(p0, p1, p2, p1, p3, p2);
    }
  const grid = new THREE.BufferGeometry();
  grid.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  grid.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  grid.setIndex(idx);
  grid.computeVertexNormals();
  const parts: THREE.BufferGeometry[] = [part(grid, null)];
  // candy trees on top
  for (let i = 0; i < def.trees; i++) {
    const a = rng.next() * Math.PI * 2;
    const d = Math.sqrt(rng.next()) * R * 0.75;
    const t = d / R;
    candyTree(rng, Math.cos(a) * d, R * 0.1 * (1 - t * t) - 0.5, Math.sin(a) * d, (R / 40) * (0.7 + rng.next() * 0.6) + 1.2, parts);
  }
  // crystals: one cluster on top, a few hanging below
  const cc = new THREE.Color(rng.pick(['#7ff4ff', '#e49cff', '#ffa6e0', '#a9b8ff']));
  crystalCluster(rng, (rng.next() - 0.5) * R * 0.6, R * 0.05, (rng.next() - 0.5) * R * 0.6, R * 0.32, cc, parts, 0.55);
  for (let k = 0; k < 3; k++) {
    const a = rng.next() * Math.PI * 2;
    const d = R * (0.25 + rng.next() * 0.3);
    crystalCluster(rng, Math.cos(a) * d, -R * 0.07 - depth * (0.3 + rng.next() * 0.2), Math.sin(a) * d, R * 0.25, cc, parts, 0.7, true);
  }
  const mesh = new THREE.Mesh(mergeGeometries(parts), mat);
  group.add(mesh);
  // waterfalls pouring off the lip
  if (def.falls > 0) {
    const fparts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < def.falls; k++) {
      const a = Math.floor(rng.next() * segs);
      const ang = (a / segs) * Math.PI * 2;
      const rr = R * radial[a] * 1.02;
      const w = R * (0.16 + rng.next() * 0.08);
      const L = depth * (1.6 + rng.next() * 0.8);
      const rows2 = 16;
      const fp: number[] = [];
      const fu: number[] = [];
      const fi: number[] = [];
      const ca = Math.cos(ang),
        sa = Math.sin(ang);
      for (let j = 0; j <= rows2; j++) {
        const t = j / rows2;
        const out = rr + R * 0.12 * Math.sqrt(t) + R * 0.05;
        const y = -R * 0.03 - L * t;
        const hw = w * (0.6 + 1.4 * t);
        for (const side of [-1, 1]) {
          fp.push(ca * out - sa * side * hw, y, sa * out + ca * side * hw);
          fu.push(side < 0 ? 0 : 1, 1 - t);
        }
        if (j < rows2) {
          const b = j * 2;
          fi.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(fu, 2));
      g.setIndex(fi);
      g.computeVertexNormals();
      fparts.push(g);
    }
    const fm = new THREE.Mesh(mergeGeometries(fparts), fallMat);
    fm.renderOrder = 2;
    group.add(fm);
  }
  group.position.set(def.x, def.y, def.z);
  group.rotation.y = rng.next() * Math.PI * 2;
  return group;
}

// ---------------------------------------------------------------- hero mushrooms

function heroMushroom(rng: Rng, x: number, y: number, z: number, h: number, capCol: THREE.Color, parts: THREE.BufferGeometry[]) {
  const lean = (rng.next() - 0.5) * 0.25;
  const stemR = h * 0.075;
  const stem = new THREE.CylinderGeometry(stemR * 0.8, stemR * 1.25, h, 10, 4);
  const sp = stem.getAttribute('position');
  for (let i = 0; i < sp.count; i++) {
    const t = sp.getY(i) / h + 0.5;
    sp.setX(i, sp.getX(i) + Math.sin(t * Math.PI) * h * 0.06);
  }
  stem.computeVertexNormals();
  stem.translate(0, h / 2, 0);
  stem.rotateZ(lean);
  stem.translate(x, y - 0.5, z);
  parts.push(part(stem, '#fff1e2', 0.06));
  const top = new THREE.Vector3(x - Math.sin(lean) * h, y + Math.cos(lean) * h - 0.5, z);
  const capR = h * (0.42 + rng.next() * 0.12);
  const cap = new THREE.SphereGeometry(capR, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.55, 1);
  cap.translate(top.x, top.y, top.z);
  const cg = part(cap, null, 0.12);
  const cp = cg.getAttribute('position');
  const ccol = new Float32Array(cp.count * 3);
  const white = new THREE.Color('#fff8f2');
  for (let i = 0; i < cp.count; i++) {
    const spot = noise.noise3(cp.getX(i) * (3 / capR), cp.getY(i) * (3 / capR), cp.getZ(i) * (3 / capR)) > 0.42;
    const tc = spot ? white : capCol;
    ccol[i * 3] = tc.r;
    ccol[i * 3 + 1] = tc.g;
    ccol[i * 3 + 2] = tc.b;
  }
  cg.setAttribute('color', new THREE.BufferAttribute(ccol, 3));
  parts.push(cg);
  // glowing gills underneath
  const gills = new THREE.CircleGeometry(capR * 0.98, 20);
  gills.rotateX(Math.PI / 2);
  gills.translate(top.x, top.y + 0.05, top.z);
  parts.push(part(gills, new THREE.Color(capCol).lerp(new THREE.Color('#fff0a8'), 0.6), 0.9));
}

// ---------------------------------------------------------------- sky: ringed planet, moon, rainbows

const SPHERE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  vLocal = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const PLANET_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform vec3 uRim;
uniform vec3 uHaze;
uniform float uRadius;
uniform float uTime;
varying vec3 vN;
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(vN);
  float lat = vLocal.y / uRadius;
  float swirl = sin(lat * 9.0 + sin(vLocal.x / uRadius * 3.0 + uTime * 0.01) * 0.9);
  float bands = sin(lat * 22.0 + swirl * 1.6);
  vec3 col = mix(uA, uB, smoothstep(-0.6, 0.6, bands));
  col = mix(col, uC, smoothstep(0.55, 0.95, sin(lat * 7.0 + 1.3 + swirl * 0.5)) * 0.8);
  float d = dot(n, uSunDir);
  float lit = smoothstep(-0.25, 0.45, d);
  col *= 0.42 + 0.78 * lit;
  vec3 V = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - max(dot(n, V), 0.0), 2.5);
  col += uRim * rim * (0.35 + 0.65 * lit);
  col = mix(col, uHaze, 0.22);
  gl_FragColor = vec4(col, 1.0);
}
`;

const MOON_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uHaze;
uniform float uRadius;
varying vec3 vN;
varying vec3 vLocal;
varying vec3 vWorld;
float hash(vec3 p) { return fract(sin(dot(p, vec3(17.1, 113.7, 51.3))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
void main() {
  vec3 n = normalize(vN);
  vec3 q = vLocal / uRadius;
  float m = vnoise(q * 2.5) * 0.65 + vnoise(q * 6.0) * 0.35;
  vec3 col = mix(uA, uB, smoothstep(0.45, 0.7, m));
  float lit = smoothstep(-0.2, 0.5, dot(n, uSunDir));
  col *= 0.5 + 0.7 * lit;
  vec3 V = normalize(cameraPosition - vWorld);
  col += vec3(1.0, 0.9, 1.0) * pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.4;
  col = mix(col, uHaze, 0.25);
  gl_FragColor = vec4(col, 1.0);
}
`;

const RING_VERT = /* glsl */ `
varying vec2 vLocal;
varying vec3 vWorld;
void main() {
  vLocal = position.xy;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RING_FRAG = /* glsl */ `
uniform float uInner;
uniform float uOuter;
uniform float uTime;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uHaze;
varying vec2 vLocal;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float r = length(vLocal);
  float t = (r - uInner) / (uOuter - uInner);
  if (t < 0.0 || t > 1.0) discard;
  float bands = 0.7 + 0.2 * sin(t * 60.0) + 0.15 * sin(t * 23.0 + 1.0);
  float gap = smoothstep(0.015, 0.035, abs(t - 0.62)) * smoothstep(0.008, 0.02, abs(t - 0.31));
  float edge = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.9, 1.0, t));
  float a = clamp(bands, 0.0, 1.0) * gap * edge * 0.95;
  vec3 col = mix(uA, uB, smoothstep(0.2, 0.8, t + 0.15 * sin(t * 40.0)));
  // twinkling ice glitter
  float ang = atan(vLocal.y, vLocal.x);
  vec2 cell = floor(vec2(ang * 260.0, t * 70.0));
  float h = hash(cell);
  float tw = step(0.965, h) * pow(0.5 + 0.5 * sin(uTime * (1.5 + h * 4.0) + h * 40.0), 6.0);
  col += vec3(1.0, 0.97, 0.9) * tw * 1.6;
  a = max(a, tw * edge * gap);
  col = mix(col, uHaze, 0.2);
  gl_FragColor = vec4(col, a);
}
`;

const RAINBOW_FRAG = /* glsl */ `
uniform float uInner;
uniform float uOuter;
uniform float uOpacity;
uniform float uTime;
${ATMOSPHERE_GLSL}
varying vec2 vLocal;
varying vec3 vWorld;
vec3 spectrum(float t) {
  vec3 c = vec3(0.0);
  c += vec3(1.0, 0.36, 0.42) * smoothstep(0.0, 0.17, t) * (1.0 - smoothstep(0.17, 0.33, t));
  c += vec3(1.0, 0.72, 0.32) * smoothstep(0.13, 0.3, t) * (1.0 - smoothstep(0.3, 0.46, t));
  c += vec3(1.0, 0.96, 0.46) * smoothstep(0.28, 0.44, t) * (1.0 - smoothstep(0.44, 0.58, t));
  c += vec3(0.5, 0.95, 0.62) * smoothstep(0.42, 0.56, t) * (1.0 - smoothstep(0.56, 0.7, t));
  c += vec3(0.42, 0.78, 1.0) * smoothstep(0.55, 0.7, t) * (1.0 - smoothstep(0.7, 0.85, t));
  c += vec3(0.72, 0.5, 1.0) * smoothstep(0.68, 0.84, t) * (1.0 - smoothstep(0.88, 1.0, t));
  return c;
}
void main() {
  float r = length(vLocal);
  float t = (r - uInner) / (uOuter - uInner);
  if (t < 0.0 || t > 1.0 || vLocal.y < 0.0) discard;
  vec3 col = spectrum(t) * 1.15;
  float edge = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.88, 1.0, t));
  // fade where the bow dips into the cloud sea
  float foot = smoothstep(0.0, 0.25, vLocal.y / uOuter);
  float shimmer = 0.9 + 0.1 * sin(uTime * 0.7 + r * 0.01);
  col = mix(col, applyAtmosphere(col, vWorld), 0.5);
  gl_FragColor = vec4(col, uOpacity * edge * foot * shimmer);
}
`;

function buildSky(): THREE.Group {
  const group = new THREE.Group();
  const sun = G.uSunDir;
  const haze = new THREE.Color('#f8d8f0');
  // colossal ringed planet ahead-right of the run
  const pR = 2900;
  const pPos = new THREE.Vector3(8100, 5300, -18800);
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(pR, 64, 40),
    new THREE.ShaderMaterial({
      vertexShader: SPHERE_VERT,
      fragmentShader: PLANET_FRAG,
      uniforms: {
        uSunDir: sun,
        uA: { value: new THREE.Color('#f6c8b8') },
        uB: { value: new THREE.Color('#d4a6ec') },
        uC: { value: new THREE.Color('#9fd2f0') },
        uRim: { value: new THREE.Color('#ffe8f8') },
        uHaze: { value: haze },
        uRadius: { value: pR },
        uTime: G.uTime,
      },
    }),
  );
  planet.position.copy(pPos);
  planet.rotation.set(0.35, 0, -0.32);
  planet.frustumCulled = false;
  group.add(planet);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(pR * 1.32, pR * 2.35, 160, 1),
    new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uInner: { value: pR * 1.32 },
        uOuter: { value: pR * 2.35 },
        uTime: G.uTime,
        uA: { value: new THREE.Color('#fff4e6') },
        uB: { value: new THREE.Color('#e2c8ff') },
        uHaze: { value: haze },
      },
    }),
  );
  ring.position.copy(pPos);
  // tilt so the ring reads as a broad ellipse from the run
  ring.rotation.set(-Math.PI / 2 + 0.78, 0, 0);
  ring.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), -0.38);
  ring.frustumCulled = false;
  ring.renderOrder = -7;
  group.add(ring);
  // second moon, ahead-left
  const mR = 760;
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(mR, 40, 24),
    new THREE.ShaderMaterial({
      vertexShader: SPHERE_VERT,
      fragmentShader: MOON_FRAG,
      uniforms: {
        uSunDir: sun,
        uA: { value: new THREE.Color('#fff4ec') },
        uB: { value: new THREE.Color('#c9b8e8') },
        uHaze: { value: haze },
        uRadius: { value: mR },
      },
    }),
  );
  moon.position.set(-8000, 6300, -12600);
  moon.frustumCulled = false;
  group.add(moon);
  return group;
}

function buildRainbows(): THREE.Group {
  const group = new THREE.Group();
  const bows: Array<{ x: number; y: number; z: number; r: number; w: number; rotY: number; o: number }> = [
    { x: -60, y: CLOUD - 250, z: -4300, r: 1700, w: 150, rotY: 0, o: 0.55 },
    { x: 2500, y: CLOUD - 150, z: -1500, r: 900, w: 95, rotY: -1.2, o: 0.5 },
    { x: -1500, y: 700, z: -2600, r: 420, w: 48, rotY: 1.0, o: 0.5 },
  ];
  for (const b of bows) {
    const inner = b.r - b.w / 2,
      outer = b.r + b.w / 2;
    const mat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RAINBOW_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uInner: { value: inner },
        uOuter: { value: outer },
        uOpacity: { value: b.o },
        uTime: G.uTime,
        ...atmoUniforms(),
      },
    });
    const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 128, 1, 0, Math.PI), mat);
    m.position.set(b.x, b.y, b.z);
    m.rotation.y = b.rotY;
    m.frustumCulled = false;
    m.renderOrder = 1;
    group.add(m);
  }
  return group;
}

// ---------------------------------------------------------------- floating shards (small drifting islets)

function shardGeometry(): { cap: THREE.BufferGeometry; spike: THREE.BufferGeometry } {
  const rng = new Rng(61);
  const segs = 9;
  // grassy cap (white: tinted per instance) over a banded rock spike
  const cap = new THREE.CylinderGeometry(1, 0.96, 0.22, segs, 1);
  cap.translate(0, 0.11, 0);
  const spike = new THREE.ConeGeometry(0.98, 1.9, segs, 3);
  spike.rotateX(Math.PI);
  spike.translate(0, -0.95, 0);
  const sp = spike.getAttribute('position');
  for (let i = 0; i < sp.count; i++) {
    const y = sp.getY(i);
    if (y > -0.01) continue;
    const k = 1 + 0.25 * (rng.next() - 0.5);
    sp.setXYZ(i, sp.getX(i) * k, y, sp.getZ(i) * k);
  }
  const capP = part(cap, '#ffffff');
  const spikeP = part(spike, null);
  const p = spikeP.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const band = Math.floor(-p.getY(i) * 2.6);
    c.set(STRATA[band % STRATA.length]).multiplyScalar(0.95 + (0.25 * p.getY(i)) / 1.9);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  spikeP.setAttribute('color', new THREE.BufferAttribute(col, 3));
  spikeP.computeVertexNormals();
  return { cap: capP, spike: spikeP };
}

interface Shards {
  caps: THREE.InstancedMesh;
  spikes: THREE.InstancedMesh;
  /** x, y, z, scale, phase, yaw per shard. */
  data: Float32Array;
}

function buildShards(ctx: WorldContext, keep: Keepout, rng: Rng): Shards {
  const n = 46;
  const data = new Float32Array(n * 6);
  let k = 0;
  const t = ctx.terrain;
  for (let tries = 0; tries < 3000 && k < n; tries++) {
    const z = 60 - rng.next() * 2800;
    const x = spineX(z) + (rng.chance(0.5) ? -1 : 1) * (35 + rng.next() * 380);
    if (x < t.minX + 10 || x > t.maxX - 10) continue;
    const s = 3 + Math.pow(rng.next(), 1.6) * 12;
    if (!keep.clear(x, z, s, 4)) continue;
    const y = t.heightAt(x, z) + 22 + rng.next() * 70 + s;
    data.set([x, y, z, s, rng.next() * 6.28, rng.next() * 6.28], k * 6);
    k++;
  }
  const mat = glowMaterial();
  const geo = shardGeometry();
  const caps = new THREE.InstancedMesh(geo.cap, mat, k);
  const spikes = new THREE.InstancedMesh(geo.spike, mat, k);
  const grass = ['#ff8cc6', '#8ef0d0', '#c09cff', '#ffb08a', '#ffa6d8'].map((c) => new THREE.Color(c));
  for (let i = 0; i < k; i++) caps.setColorAt(i, rng.pick(grass));
  for (const m of [caps, spikes]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.castShadow = true;
    m.frustumCulled = false;
  }
  return { caps, spikes, data: data.subarray(0, k * 6) };
}

// ---------------------------------------------------------------- floating motes

const MOTE_VERT = /* glsl */ `
attribute vec4 aData;
uniform float uTime;
uniform float uScale;
varying float vTw;
varying vec3 vCol;
void main() {
  vec3 p = position;
  float ph = aData.x * 6.2831;
  p.y += sin(uTime * 0.6 + ph) * 1.6;
  p.x += sin(uTime * 0.37 + ph * 1.7) * 1.2;
  p.z += cos(uTime * 0.31 + ph * 2.3) * 1.2;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vTw = 0.55 + 0.45 * sin(uTime * (1.2 + aData.y * 2.5) + ph * 3.0);
  vCol = aData.z > 0.66 ? vec3(1.0, 0.85, 0.55) : aData.z > 0.33 ? vec3(0.65, 1.0, 0.95) : vec3(1.0, 0.7, 0.95);
  gl_PointSize = uScale * (0.6 + aData.w) / max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const MOTE_FRAG = /* glsl */ `
varying float vTw;
varying vec3 vCol;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vCol * (1.2 + vTw), a * vTw);
}
`;

function buildMotes(ctx: WorldContext, rng: Rng): THREE.Points {
  const n = 2600;
  const pos = new Float32Array(n * 3);
  const data = new Float32Array(n * 4);
  const t = ctx.terrain;
  for (let i = 0; i < n; i++) {
    const x = t.minX + 40 + rng.next() * (t.maxX - t.minX - 80);
    const z = t.minZ + 40 + rng.next() * (t.maxZ - t.minZ - 80);
    const y = t.heightAt(x, z) + 1.2 + Math.pow(rng.next(), 2) * 14;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    for (let k = 0; k < 4; k++) data[i * 4 + k] = rng.next();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aData', new THREE.BufferAttribute(data, 4));
  const mat = new THREE.ShaderMaterial({
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: G.uTime, uScale: { value: 160 } },
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  return pts;
}

// ---------------------------------------------------------------- assembly

interface Floater {
  g: THREE.Group;
  y0: number;
  ph: number;
  spin: number;
  amp: number;
}

export function buildDreamSetPieces(ctx: WorldContext): SetPieceHandle {
  const farH = dreamscape.terrain.farHeight;
  const rng = new Rng(2024);
  const root = new THREE.Group();
  root.name = 'dream';
  ctx.scene.add(root);
  const keep = new Keepout(ctx);
  const r = ctx.terrain;
  const centre = new THREE.Vector2((r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2);

  root.add(buildCloudSea(farH, centre));
  root.add(buildPuffs(farH, rng));

  // floating islands (one glow-material mesh + one waterfall mesh each)
  const fallTex = waterfallTexture();
  fallTex.repeat.set(1, 3);
  const fallMat = paintMaterial({ map: fallTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, emissive: '#c8f6f4', emissiveIntensity: 0.6 });
  fallMat.alphaMap = fallAlpha();
  const islandMat = glowMaterial();
  const islands: Floater[] = [];
  for (const def of ISLANDS) {
    const g = buildIsland(def, rng, fallMat, islandMat);
    root.add(g);
    islands.push({ g, y0: def.y, ph: rng.next() * 6.28, spin: (rng.chance(0.5) ? 1 : -1) * (0.004 + rng.next() * 0.008), amp: 4 + def.r * 0.04 });
  }

  // crystal spires: near-course clusters on the meadows, big spires on the island shoulders, giants on the mesas
  const glowParts: THREE.BufferGeometry[] = [];
  const crystalCols = ['#6ff0ff', '#d58cff', '#ff8ed8', '#8fa6ff', '#7dffd0'].map((c) => new THREE.Color(c));
  let placed = 0;
  for (let k = 0; k < 600 && placed < 22; k++) {
    const z = 60 - rng.next() * 2750;
    const x = spineX(z) + (rng.chance(0.5) ? -1 : 1) * (60 + rng.next() * 240);
    const h = 14 + rng.next() * 26;
    if (x < r.minX + 20 || x > r.maxX - 20 || !keep.clear(x, z, h * 0.35, 12)) continue;
    const y = r.heightAt(x, z);
    crystalCluster(rng, x, y, z, h, rng.pick(crystalCols), glowParts, 0.5, false, 0.3);
    ctx.addCollider(x, z, h * 0.3, y + h, 'solid');
    placed++;
  }
  let side = 1;
  for (let z = -150; z > -3000; z -= 330 + rng.next() * 160) {
    side = -side;
    for (let k = 0; k < 12; k++) {
      const x = spineX(z) + side * (330 + rng.next() * 110);
      const y = farH(x, z);
      if (y < CLOUD + 80) continue;
      const inside = x > r.minX + 4 && x < r.maxX - 4;
      const h = 55 + rng.next() * 60;
      if (inside && !keep.clear(x, z, h * 0.3, 20)) continue;
      crystalCluster(rng, x, (inside ? r.heightAt(x, z) : y) - 2, z, h, rng.pick(crystalCols), glowParts, 0.45, false, 0.3);
      if (inside) ctx.addCollider(x, z, h * 0.25, y + h, 'solid');
      break;
    }
  }
  for (const m of MESAS) {
    if (m.cone > 0.5) continue;
    const y = farH(m.x, m.z);
    crystalCluster(rng, m.x, y - 4, m.z, 140 + m.h * 0.3, rng.pick(crystalCols), glowParts, 0.45, false, 0.35);
  }
  // colossal glowing spires rising out of the cloud sea, visible from the whole run
  const colossi: Array<[number, number, number, string]> = [
    [330, -3720, 620, '#7ff0ff'],
    [-1150, -950, 520, '#e09cff'],
    [1150, -1900, 460, '#ff9ee0'],
    [-900, -3300, 420, '#8fa6ff'],
  ];
  for (const [x, z, h, col] of colossi) crystalCluster(rng, x, CLOUD - 60, z, h, new THREE.Color(col), glowParts, 0.6, false, 0.22);
  // hero mushrooms on the meadow
  const capCols = ['#ff5f9e', '#9a6cff', '#ff7f5a', '#3ccfc0', '#f04fb6'].map((c) => new THREE.Color(c));
  placed = 0;
  for (let k = 0; k < 500 && placed < 16; k++) {
    const z = 40 - rng.next() * 2720;
    const x = spineX(z) + (rng.next() - 0.5) * 640;
    const h = 10 + rng.next() * 22;
    if (x < r.minX + 20 || x > r.maxX - 20 || !keep.clear(x, z, h * 0.5, 10)) continue;
    const y = r.heightAt(x, z);
    heroMushroom(rng, x, y, z, h, rng.pick(capCols), glowParts);
    ctx.addCollider(x, z, h * 0.12, y + h, 'solid');
    placed++;
  }
  const glowMesh = new THREE.Mesh(mergeGeometries(glowParts), glowMaterial());
  glowMesh.castShadow = true;
  glowMesh.receiveShadow = true;
  glowMesh.frustumCulled = false;
  root.add(glowMesh);

  root.add(buildSky());
  root.add(buildRainbows());
  root.add(buildMotes(ctx, rng));
  const shards = buildShards(ctx, keep, rng);
  root.add(shards.caps, shards.spikes);

  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const eul = new THREE.Euler();
  return {
    update(dt, time) {
      fallTex.offset.y = (time * 0.6) % 1;
      for (let i = 0; i < islands.length; i++) {
        const isl = islands[i];
        isl.g.position.y = isl.y0 + Math.sin(time * 0.25 + isl.ph) * isl.amp;
        isl.g.rotation.y += isl.spin * dt;
      }
      const d = shards.data;
      for (let i = 0; i < shards.caps.count; i++) {
        const o = i * 6;
        const ph = d[o + 4];
        pos.set(d[o], d[o + 1] + Math.sin(time * 0.5 + ph) * 1.8, d[o + 2]);
        eul.set(Math.sin(time * 0.3 + ph) * 0.06, d[o + 5] + time * 0.05 * (i % 2 ? 1 : -1), Math.cos(time * 0.27 + ph) * 0.06);
        quat.setFromEuler(eul);
        scl.setScalar(d[o + 3]);
        m4.compose(pos, quat, scl);
        shards.caps.setMatrixAt(i, m4);
        shards.spikes.setMatrixAt(i, m4);
      }
      shards.caps.instanceMatrix.needsUpdate = true;
      shards.spikes.instanceMatrix.needsUpdate = true;
    },
  };
}
