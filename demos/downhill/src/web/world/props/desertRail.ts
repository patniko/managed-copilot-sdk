import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ATMOSPHERE_GLSL, atmoUniforms, paintMaterial } from '../../render/globals';

const UP = new THREE.Vector3(0, 1, 0);

function tint(g: THREE.BufferGeometry, c: THREE.Color, top = 1, bottom = 1): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    const k = bottom + (top - bottom) * t;
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** A square beam between two points. */
function beam(a: THREE.Vector3, b: THREE.Vector3, th: number, c: THREE.Color): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const g = new THREE.BoxGeometry(th, len, th);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return tint(g, c);
}

export interface RailPath {
  curve: THREE.CatmullRomCurve3;
  len: number;
  /** Track height per metre of arc length. */
  y: Float32Array;
  /** Arc length where the trestle starts / ends. */
  trestleFrom: number;
  trestleTo: number;
}

/**
 * Lay out the railway: follow the (smoothed) ground until it falls below `deckStart`, then carry the line on a
 * trestle whose deck eases down to `deckEnd` at the far portal.
 */
export function planRailway(pts: Array<[number, number]>, groundH: (x: number, z: number) => number, deckStart: number, deckEnd: number): RailPath {
  const curve = new THREE.CatmullRomCurve3(
    pts.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'centripetal',
  );
  const len = curve.getLength();
  const n = Math.ceil(len) + 1;
  const g = new Float32Array(n);
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    curve.getPointAt(Math.min(1, i / len), p);
    g[i] = groundH(p.x, p.z);
  }
  // wide smoothing so the line flows
  const sm = new Float32Array(n);
  const R = 45;
  for (let i = 0; i < n; i++) {
    let s = 0;
    let w = 0;
    for (let k = -R; k <= R; k += 3) {
      const j = Math.min(n - 1, Math.max(0, i + k));
      const ww = Math.exp(-(k * k) / (2 * 20 * 20));
      s += g[j] * ww;
      w += ww;
    }
    sm[i] = s / w + 1.4;
  }
  let from = n - 1;
  for (let i = Math.floor(n * 0.4); i < n; i++)
    if (sm[i] < deckStart) {
      from = i;
      break;
    }
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i < from) y[i] = sm[i];
    else y[i] = deckStart + ((deckEnd - deckStart) * (i - from)) / Math.max(1, n - 1 - from);
  }
  // ease into the deck height
  for (let i = Math.max(0, from - 120); i < from; i++) {
    const t = (i - (from - 120)) / 120;
    y[i] = sm[i] + (deckStart - sm[i]) * t * t * (3 - 2 * t);
  }
  return { curve, len, y, trestleFrom: from - 60, trestleTo: n - 1 };
}

export function railY(path: RailPath, s: number) {
  const f = Math.min(path.y.length - 1.001, Math.max(0, s));
  const i = Math.floor(f);
  return path.y[i] + (path.y[i + 1] - path.y[i]) * (f - i);
}

/** Ballast ribbon + timber trestle + tunnel portals (pos = base centre on the cliff face, out = outward normal). */
export function buildRailway(path: RailPath, groundH: (x: number, z: number) => number, portals: Array<{ pos: THREE.Vector3; out: THREE.Vector3 }>): THREE.Group {
  const group = new THREE.Group();
  group.name = 'railway';
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  // ballast / embankment ribbon
  const offs = [-4.2, -2.1, 2.1, 4.2];
  const drop = [2.4, 0, 0, 2.4];
  const step = 4;
  const ns = Math.floor(path.len / step) + 1;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const ballast = new THREE.Color('#6b5246');
  const bank = new THREE.Color('#a8603e');
  for (let k = 0; k < ns; k++) {
    const s = Math.min(path.len, k * step);
    path.curve.getPointAt(s / path.len, p);
    path.curve.getTangentAt(s / path.len, t);
    const rx = -t.z;
    const rz = t.x;
    const rl = Math.hypot(rx, rz) || 1;
    const yy = railY(path, s);
    for (let j = 0; j < 4; j++) {
      const x = p.x + (rx / rl) * offs[j];
      const z = p.z + (rz / rl) * offs[j];
      const outer = j === 0 || j === 3;
      const onTrestle = s > path.trestleFrom + 50;
      const y = outer && !onTrestle ? Math.min(yy - drop[j], Math.max(groundH(x, z) - 0.3, yy - 6)) : yy - (outer ? 0.6 : 0);
      pos.push(x, y + 0.15, z);
      const c = outer ? bank : ballast;
      col.push(c.r, c.g, c.b);
    }
  }
  for (let k = 0; k < ns - 1; k++)
    for (let j = 0; j < 3; j++) {
      const a = k * 4 + j;
      const b = a + 4;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  rg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  rg.setIndex(idx);
  rg.computeVertexNormals();
  const ribbon = new THREE.Mesh(rg, paintMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  ribbon.frustumCulled = false;
  group.add(ribbon);

  // timber trestle
  const timber = new THREE.Color('#6e4a2e');
  const timberLight = new THREE.Color('#8f6440');
  const parts: THREE.BufferGeometry[] = [];
  const bentStep = 15;
  const across = new THREE.Vector3();
  let prevTop: THREE.Vector3 | null = null;
  let prevTiers: Array<[THREE.Vector3, THREE.Vector3]> = [];
  let bentIdx = 0;
  for (let s = path.trestleFrom; s <= path.trestleTo - 4; s += bentStep) {
    path.curve.getPointAt(s / path.len, p);
    path.curve.getTangentAt(s / path.len, t);
    const rl = Math.hypot(t.x, t.z) || 1;
    const ux = -t.z / rl;
    const uz = t.x / rl;
    across.set(ux, 0, uz);
    const top = railY(path, s) - 1.8;
    const ground = Math.min(groundH(p.x + ux * 5, p.z + uz * 5), groundH(p.x - ux * 5, p.z - uz * 5)) - 1;
    const h = top - ground;
    if (h < 2) {
      prevTop = null;
      prevTiers = [];
      continue;
    }
    const halfTop = 2.6;
    const halfBot = 2.6 + h * 0.2;
    const posts: Array<[THREE.Vector3, THREE.Vector3]> = [];
    for (const side of [-1, 1]) {
      for (const inner of [0.35, 1]) {
        const a = new THREE.Vector3(p.x + ux * side * halfBot * inner, ground, p.z + uz * side * halfBot * inner);
        const b = new THREE.Vector3(p.x + ux * side * halfTop * inner, top, p.z + uz * side * halfTop * inner);
        posts.push([a, b]);
        parts.push(beam(a, b, inner === 1 ? 1.4 : 1.0, timber));
      }
    }
    // tiers: sills + X braces
    const tiers = Math.max(1, Math.round(h / 11));
    const tierPts: Array<[THREE.Vector3, THREE.Vector3]> = [];
    for (let k = 0; k <= tiers; k++) {
      const f = k / tiers;
      const l = posts[1][0].clone().lerp(posts[1][1], f).addScaledVector(across, -0.6);
      const r = posts[3][0].clone().lerp(posts[3][1], f).addScaledVector(across, 0.6);
      tierPts.push([l, r]);
      parts.push(beam(l, r, 0.8, timberLight));
      if (k > 0) {
        const [pl, pr] = tierPts[k - 1];
        parts.push(beam(pl, r, 0.55, timber));
        parts.push(beam(pr, l, 0.55, timber));
      }
    }
    // longitudinal girts between bents (every other tier) + diagonal sway bracing on alternating bays
    if (prevTop && prevTiers.length) {
      const m = Math.min(prevTiers.length, tierPts.length);
      for (let k = 0; k < m; k += 2) {
        const a = tierPts[tierPts.length - 1 - k];
        const b = prevTiers[prevTiers.length - 1 - k];
        parts.push(beam(a[0], b[0], 0.6, timberLight));
        parts.push(beam(a[1], b[1], 0.6, timberLight));
        if (bentIdx % 2 === 0 && k + 1 < m) {
          const bl = prevTiers[prevTiers.length - 2 - k];
          parts.push(beam(a[0], bl[0], 0.45, timber));
          parts.push(beam(a[1], bl[1], 0.45, timber));
        }
      }
    }
    // deck stringer
    const deckTop = new THREE.Vector3(p.x, top + 0.9, p.z);
    if (prevTop) parts.push(beam(prevTop, deckTop, 2.2, timber));
    prevTop = deckTop;
    prevTiers = tierPts;
    bentIdx++;
  }
  if (parts.length) {
    const tg = mergeGeometries(parts);
    parts.forEach((g) => g.dispose());
    const trestle = new THREE.Mesh(tg, paintMaterial({ vertexColors: true }));
    trestle.castShadow = true;
    trestle.frustumCulled = false;
    group.add(trestle);
  }

  // tunnel portals (stone frame + dark mouth), seated on the cliff faces
  const portalMat = paintMaterial({ vertexColors: true });
  const geos: THREE.BufferGeometry[] = [];
  for (const pt of portals) {
    const shape = new THREE.Shape();
    shape.moveTo(-8, -3);
    shape.lineTo(8, -3);
    shape.lineTo(8, 9);
    shape.absarc(0, 9, 8, 0, Math.PI, false);
    shape.lineTo(-8, -3);
    const hole = new THREE.Path();
    hole.moveTo(-4.8, -3);
    hole.lineTo(4.8, -3);
    hole.lineTo(4.8, 7.5);
    hole.absarc(0, 7.5, 4.8, 0, Math.PI, false);
    hole.lineTo(-4.8, -3);
    shape.holes.push(hole);
    const frame = new THREE.ExtrudeGeometry(shape, { depth: 12, bevelEnabled: false, curveSegments: 10 });
    frame.translate(0, 0, -9);
    tint(frame, new THREE.Color('#d2a070'), 1.05, 0.8);
    const dark = new THREE.ShapeGeometry(new THREE.Shape(hole.getPoints(12)), 1);
    dark.translate(0, 0, -6);
    tint(dark, new THREE.Color('#1a1016'));
    for (const g of [frame, dark]) {
      g.deleteAttribute('uv');
      g.lookAt(pt.out);
      g.translate(pt.pos.x, pt.pos.y, pt.pos.z);
      geos.push(g.index ? g.toNonIndexed() : g);
    }
  }
  const pm = new THREE.Mesh(mergeGeometries(geos), portalMat);
  pm.frustumCulled = false;
  group.add(pm);
  return group;
}

// ------------------------------------------------------------------------------------------
// Steam train
// ------------------------------------------------------------------------------------------

function box(w: number, h: number, l: number, x: number, y: number, z: number, c: string, top = 1.06, bottom = 0.8) {
  const g = new THREE.BoxGeometry(w, h, l);
  g.translate(x, y, z);
  g.deleteAttribute('uv');
  return tint(g, new THREE.Color(c), top, bottom);
}

function cyl(r0: number, r1: number, h: number, x: number, y: number, z: number, c: string, axis: 'y' | 'z' | 'x' = 'y', seg = 14) {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  g.deleteAttribute('uv');
  return tint(g, new THREE.Color(c), 1.08, 0.75);
}

function locomotive(): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  p.push(box(2.6, 0.8, 15, 0, 1.3, 0, '#2a2226'));
  p.push(cyl(1.45, 1.45, 9.5, 0, 3.15, 2.0, '#26242c', 'z', 18));
  p.push(cyl(1.55, 1.55, 0.6, 0, 3.15, 6.5, '#b8322a', 'z', 18));
  p.push(cyl(1.5, 1.5, 0.5, 0, 3.15, -1.2, '#d8a83a', 'z', 18));
  p.push(cyl(0.5, 0.75, 2.4, 0, 5.3, 5.4, '#1f1c22'));
  p.push(cyl(0.85, 0.55, 0.7, 0, 6.6, 5.4, '#1f1c22'));
  p.push(cyl(0.6, 0.65, 1.0, 0, 4.9, 2.3, '#e0b040'));
  p.push(box(3.2, 3.4, 3.6, 0, 3.9, -4.4, '#7c1f22'));
  p.push(box(3.6, 0.35, 4.2, 0, 5.75, -4.4, '#1e1a1e'));
  p.push(box(3.25, 0.9, 2.6, 0, 4.4, -4.4, '#f1d27a', 1, 1));
  // cow catcher + buffer beam
  const cc = new THREE.ConeGeometry(1.6, 1.4, 4, 1);
  cc.rotateX(-Math.PI / 2);
  cc.rotateZ(Math.PI / 4);
  cc.scale(1, 0.6, 1);
  cc.translate(0, 0.9, 8.1);
  cc.deleteAttribute('uv');
  p.push(tint(cc, new THREE.Color('#c63a2a')));
  p.push(box(3, 0.5, 0.4, 0, 1.4, 7.5, '#c63a2a'));
  p.push(cyl(0.45, 0.45, 0.5, 0, 3.8, 7.0, '#fff2c0', 'z', 10));
  for (const side of [-1, 1]) {
    for (const z of [-3.2, -0.6, 2.0]) p.push(cyl(1.05, 1.05, 0.4, side * 1.35, 1.05, z, '#c43a2c', 'x', 14));
    p.push(cyl(0.55, 0.55, 0.35, side * 1.3, 0.6, 5.6, '#c43a2c', 'x', 10));
    p.push(box(0.25, 0.3, 6.5, side * 1.6, 1.1, -0.6, '#d8d0c0'));
  }
  return mergeGeometries(p.map((g) => (g.index ? g.toNonIndexed() : g)));
}

function tender(): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  p.push(box(2.9, 2.7, 7, 0, 2.6, 0, '#2a2428'));
  p.push(box(2.5, 0.6, 5.5, 0, 4.1, 0.4, '#141216'));
  p.push(box(3.0, 0.3, 7.1, 0, 3.95, 0, '#b8322a'));
  for (const side of [-1, 1]) for (const z of [-2.3, 2.3]) p.push(cyl(0.65, 0.65, 0.35, side * 1.3, 0.75, z, '#c43a2c', 'x', 12));
  return mergeGeometries(p.map((g) => (g.index ? g.toNonIndexed() : g)));
}

function coach(body: string, band: string): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  p.push(box(3.0, 3.0, 13, 0, 2.7, 0, body));
  p.push(box(3.05, 0.9, 12, 0, 3.0, 0, band, 1, 1));
  const roof = new THREE.CylinderGeometry(1.75, 1.75, 13.4, 14, 1, false, -Math.PI / 2, Math.PI);
  roof.rotateX(Math.PI / 2);
  roof.scale(1, 0.42, 1);
  roof.translate(0, 4.2, 0);
  roof.deleteAttribute('uv');
  p.push(tint(roof, new THREE.Color('#3a3036')));
  for (const side of [-1, 1]) for (const z of [-4.6, -3.2, 3.2, 4.6]) p.push(cyl(0.6, 0.6, 0.35, side * 1.25, 0.75, z, '#3a2c2c', 'x', 10));
  return mergeGeometries(p.map((g) => (g.index ? g.toNonIndexed() : g)));
}

export interface Train {
  group: THREE.Group;
  cars: THREE.Mesh[];
  offsets: number[];
  /** Local chimney position on the locomotive. */
  chimney: THREE.Vector3;
}

export function buildTrain(): Train {
  const group = new THREE.Group();
  group.name = 'train';
  const mat = paintMaterial({ vertexColors: true, saturation: 1.1 });
  const geos = [locomotive(), tender(), coach('#9a2a2a', '#f0c050'), coach('#2e6a4a', '#f2dca0'), coach('#9a2a2a', '#f0c050'), coach('#2a4a8a', '#f2dca0')];
  const lens = [16, 7.6, 14, 14, 14, 14];
  const cars: THREE.Mesh[] = [];
  const offsets: number[] = [];
  let off = 0;
  geos.forEach((g, i) => {
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.visible = false;
    group.add(m);
    cars.push(m);
    if (i > 0) off += (lens[i - 1] + lens[i]) / 2 + 0.8;
    offsets.push(off);
  });
  return { group, cars, offsets, chimney: new THREE.Vector3(0, 7.0, 5.4) };
}

// ------------------------------------------------------------------------------------------
// Steam puffs (one Points draw call)
// ------------------------------------------------------------------------------------------

const STEAM_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
varying float vAlpha;
varying vec3 vWorld;
uniform float uScale;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 1.0), 0.0, 512.0);
  gl_Position = projectionMatrix * mv;
  vAlpha = aAlpha;
}
`;

const STEAM_FRAG = /* glsl */ `
${ATMOSPHERE_GLSL}
varying float vAlpha;
varying vec3 vWorld;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.18, d) * vAlpha;
  if (a < 0.01) discard;
  vec3 col = mix(vec3(0.78, 0.74, 0.8), vec3(1.0, 0.96, 0.9), clamp(0.6 - c.y * 1.4, 0.0, 1.0));
  col = mix(col, applyAtmosphere(col, vWorld), 0.85);
  gl_FragColor = vec4(col, a);
}
`;

export class Steam {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private age: Float32Array;
  private vel: Float32Array;
  private next = 0;
  private emitT = 0;

  constructor(private count = 64) {
    this.pos = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.age = new Float32Array(count).fill(99);
    this.vel = new Float32Array(count * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      vertexShader: STEAM_VERT,
      fragmentShader: STEAM_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: 720 }, ...atmoUniforms() },
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  /** Advance; emit from (x,y,z) while `emit` is true. */
  update(dt: number, emit: boolean, x: number, y: number, z: number) {
    const life = 4.2;
    if (emit) {
      this.emitT -= dt;
      while (this.emitT <= 0) {
        this.emitT += 0.11;
        const i = this.next;
        this.next = (this.next + 1) % this.count;
        this.age[i] = 0;
        this.pos[i * 3] = x;
        this.pos[i * 3 + 1] = y;
        this.pos[i * 3 + 2] = z;
        const r = Math.sin(i * 12.9898) * 43758.5453;
        const f = r - Math.floor(r);
        this.vel[i * 3] = (f - 0.5) * 1.6 + 1.2;
        this.vel[i * 3 + 1] = 6 + f * 3;
        this.vel[i * 3 + 2] = (0.5 - f) * 1.6;
      }
    }
    for (let i = 0; i < this.count; i++) {
      const a = (this.age[i] += dt);
      if (a > life) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      const k = a / life;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt * (1 - k * 0.6);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = 5 + 26 * Math.sqrt(k);
      this.alpha[i] = Math.min(1, a * 6) * (1 - k) * 0.85;
    }
    const g = this.points.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('aSize').needsUpdate = true;
    g.getAttribute('aAlpha').needsUpdate = true;
  }
}
