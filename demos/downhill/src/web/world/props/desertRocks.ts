import * as THREE from 'three';
import { Noise } from '../../core/noise';
import { Rng } from '../../core/rng';
import { smoothstep } from '../../core/math';
import { paintMaterial } from '../../render/globals';

/** World heights covered by the strata texture (bands line up across every landform, like real canyon country). */
export const STRATA_Y0 = -60;
export const STRATA_Y1 = 1140;
/** Horizontal texture repeat (metres of cliff per texture width). */
const U_SCALE = 1 / 520;

const noise = new Noise(808);

const vStrata = (y: number) => (y - STRATA_Y0) / (STRATA_Y1 - STRATA_Y0);

interface Formation {
  y0: number;
  y1: number;
  pal: string[];
  th: [number, number];
  ledges: number;
}

/** Bold sedimentary layers (from the floodplain up): shale slopes, massive orange cliffs, ledgy beds, pale caprock. */
const FORMATIONS: Formation[] = [
  { y0: -60, y1: 100, pal: ['#a8442e', '#c25a38', '#953c2c', '#d27a52', '#e4c09a'], th: [4, 11], ledges: 0.5 },
  { y0: 100, y1: 330, pal: ['#d6662f', '#df763a', '#c95c2c', '#e3843f'], th: [28, 70], ledges: 0.3 },
  { y0: 330, y1: 432, pal: ['#a55440', '#dc9e6c', '#8e4636', '#c4784e', '#ecc08e'], th: [5, 14], ledges: 0.85 },
  { y0: 432, y1: 690, pal: ['#efa86a', '#f5c995', '#f9e0b6', '#eba070'], th: [26, 60], ledges: 0.3 },
  { y0: 690, y1: 830, pal: ['#fae9c8', '#efcba0', '#e6ad86', '#f6dab0'], th: [7, 20], ledges: 0.7 },
  { y0: 830, y1: 1140, pal: ['#dc7a50', '#ea9468', '#d06a4a', '#f2aa7e'], th: [10, 30], ledges: 0.4 },
];

let strataCache: THREE.CanvasTexture | null = null;

/** Hand-painted strata: horizontal bands, ledge lines, blotches and dripping desert-varnish streaks. */
export function strataTexture(): THREE.CanvasTexture {
  if (strataCache) return strataCache;
  const W = 1024;
  const H = 2048;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  const rng = new Rng(9091);
  const py = (y: number) => H * (1 - vStrata(y));
  const tops: number[] = [];
  for (const f of FORMATIONS) {
    let y = f.y0;
    let last = '';
    while (y < f.y1) {
      const t = Math.min(rng.range(f.th[0], f.th[1]), f.y1 - y);
      let col = rng.pick(f.pal);
      if (col === last) col = rng.pick(f.pal);
      last = col;
      const top = py(y + t);
      const bot = py(y);
      ctx.fillStyle = col;
      ctx.fillRect(0, top, W, bot - top + 1);
      if (rng.chance(f.ledges)) {
        // ledge: sunlit lip on top, shadow line beneath
        ctx.fillStyle = 'rgba(255,236,200,0.35)';
        ctx.fillRect(0, top, W, 2);
        ctx.fillStyle = 'rgba(70,24,20,0.35)';
        ctx.fillRect(0, top + 2, W, 3);
      }
      tops.push(y + t);
      y += t;
    }
  }
  // blotchy horizontal smears for painterly variation
  for (let i = 0; i < 1400; i++) {
    const x = rng.next() * W;
    const yy = rng.next() * H;
    const w = 30 + rng.next() * 260;
    const h = 2 + rng.next() * 14;
    ctx.globalAlpha = 0.06 + rng.next() * 0.12;
    ctx.fillStyle = rng.chance(0.5) ? '#ffe0b8' : '#7a2e22';
    for (const ox of [0, -W, W]) ctx.fillRect(x + ox, yy, w, h);
  }
  // desert varnish: dark streaks dripping down from ledges and rims
  for (let i = 0; i < 900; i++) {
    const x = rng.next() * W;
    const y0 = rng.chance(0.65) ? rng.pick(tops) : rng.range(80, 1000);
    const len = 15 + Math.pow(rng.next(), 1.4) * 300;
    const w = 2 + Math.pow(rng.next(), 2) * 16;
    const top = py(y0);
    const bot = py(y0 - len);
    const g = ctx.createLinearGradient(0, top, 0, bot);
    const a = 0.14 + rng.next() * 0.3;
    const c = rng.pick(['62,30,28', '52,28,36', '84,38,30', '40,26,30']);
    g.addColorStop(0, `rgba(${c},${a})`);
    g.addColorStop(0.6, `rgba(${c},${a * 0.6})`);
    g.addColorStop(1, `rgba(${c},0)`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    for (const ox of [0, -W, W]) ctx.fillRect(x + ox, top, w, bot - top);
  }
  // a few pale mineral streaks
  for (let i = 0; i < 90; i++) {
    const x = rng.next() * W;
    const y0 = rng.range(100, 900);
    const top = py(y0);
    const bot = py(y0 - 20 - rng.next() * 90);
    ctx.globalAlpha = 0.1 + rng.next() * 0.12;
    ctx.fillStyle = '#fff1d8';
    for (const ox of [0, -W, W]) ctx.fillRect(x + ox, top, 2 + rng.next() * 5, bot - top);
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  strataCache = tex;
  return tex;
}

let rockMat: THREE.MeshLambertMaterial | null = null;
/** Shared rock material: strata texture × vertex colour (ambient occlusion, scree tint). */
export function strataMaterial(): THREE.MeshLambertMaterial {
  if (!rockMat) rockMat = paintMaterial({ map: strataTexture(), vertexColors: true });
  return rockMat;
}

export interface MesaOpts {
  /** Closed outline (x, z); any orientation. */
  pts: Array<[number, number]>;
  /** Flat cap elevation (world). */
  top: number;
  /** Fraction of the (top - mean ground) height covered by the talus skirt. */
  talus?: number;
  /** Absolute talus-top elevation (overrides `talus`). */
  talusTop?: number;
  /** Step-backs: [world y, setback metres]. */
  benches?: Array<[number, number]>;
  /** Column spacing along the outline (m). */
  spacing?: number;
  /** Relief scale. */
  rough?: number;
  /** Max row spacing (m). */
  rowStep?: number;
  seed?: number;
  /** Column spacing multiplier at a point (e.g. coarse on sides nobody sees). */
  coarse?: (x: number, z: number) => number;
  /** Plan-view relief amplitude (promontories/alcoves, m) and vertical buttress fluting amplitude (m). */
  relief?: number;
  flute?: number;
  /** Flatten the relief around these points (x, z, radius) so props (portals) can be seated exactly. */
  pins?: Array<[number, number, number]>;
  /** Texture V for a world height (default: shared strata bands) and metres → U scale. */
  vMap?: (y: number) => number;
  uScale?: number;
  /** Paint the cap (and the top `rimDepth` metres of wall) with a flat vertex colour (texture V = `flatV`, a white strip). */
  capColor?: THREE.Color;
  rimDepth?: number;
  flatV?: number;
}

/** Wall surface point + outward normal at the column nearest (x, z), height y (filled by mesaGeometry). */
export interface WallProbe {
  x: number;
  z: number;
  y: number;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
}

/**
 * Mesa / butte / spire: a vertical prism around a smoothed outline with a flared talus skirt,
 * stepped benches, vertical fluting, a slightly rounded rim and a flat cap. Indexed; position/normal/uv/color.
 */
export function mesaGeometry(o: MesaOpts, groundH: (x: number, z: number) => number, probes: WallProbe[] = []): THREE.BufferGeometry {
  let area = 0;
  for (let i = 0; i < o.pts.length; i++) {
    const [x1, z1] = o.pts[i];
    const [x2, z2] = o.pts[(i + 1) % o.pts.length];
    area += x1 * z2 - x2 * z1;
  }
  const v3 = o.pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
  if (area < 0) v3.reverse();
  const curve = new THREE.CatmullRomCurve3(v3, true, 'centripetal');
  const L = curve.getLength();
  const sp = o.spacing ?? 10;
  // column parameters (arc-length fractions), adaptive when `coarse` is given
  const us: number[] = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  if (o.coarse) {
    let u = 0;
    while (u < 1 - 1e-6) {
      us.push(u);
      curve.getPointAt(u, p);
      u += (sp * Math.max(1, o.coarse(p.x, p.z))) / L;
    }
  } else {
    const nn = Math.max(14, Math.ceil(L / sp));
    for (let i = 0; i < nn; i++) us.push(i / nn);
  }
  const N = us.length;
  const px = new Float32Array(N);
  const pz = new Float32Array(N);
  const nx = new Float32Array(N);
  const nz = new Float32Array(N);
  const g = new Float32Array(N);
  let gSum = 0;
  let gCount = 0;
  let gMin = Infinity;
  for (let i = 0; i < N; i++) {
    curve.getPointAt(us[i], p);
    curve.getTangentAt(us[i], t);
    const tl = Math.hypot(t.x, t.z) || 1;
    px[i] = p.x;
    pz[i] = p.z;
    nx[i] = t.z / tl;
    nz[i] = -t.x / tl;
    g[i] = groundH(p.x + nx[i] * 12, p.z + nz[i] * 12);
    gMin = Math.min(gMin, g[i]);
    // ground statistics only from the visible (fine) sides
    if (!o.coarse || o.coarse(p.x, p.z) <= 1.01) {
      gSum += g[i];
      gCount++;
    }
  }
  const gAvg = gSum / Math.max(1, gCount);
  const top = o.top;
  const talusTop = o.talusTop ?? gAvg + (o.talus ?? 0.3) * Math.max(10, top - gAvg);
  const yBot = gMin - 30;
  const rough = o.rough ?? 1;
  const seed = o.seed ?? 0;
  const vMap = o.vMap ?? vStrata;
  const uScale = o.uScale ?? U_SCALE;
  // rows at absolute heights (shared by all columns so strata/benches stay level)
  const rowsSet: number[] = [];
  const step = o.rowStep ?? 12;
  const tH = talusTop - yBot;
  // the talus skirt is a smooth slope: cap its row count
  const nt = Math.max(3, Math.ceil(tH / Math.max(Math.min(step, 10), tH / 14)));
  for (let k = 0; k < nt; k++) rowsSet.push(yBot + (tH * k) / nt);
  const cH = top - 8 - talusTop;
  const nc = Math.max(2, Math.ceil(cH / step));
  for (let k = 0; k <= nc; k++) rowsSet.push(talusTop + (cH * k) / nc);
  for (const [by] of o.benches ?? []) if (by > talusTop + 6 && by < top - 12) rowsSet.push(by - 3.5, by + 3.5);
  rowsSet.push(top - 4, top - 1.2, top);
  if (o.rimDepth) rowsSet.push(top - o.rimDepth - 0.1, top - o.rimDepth);
  const Y = [...new Set(rowsSet.map((y) => Math.round(y * 10) / 10))].sort((a, b) => a - b);
  const R = Y.length;
  const C = N + 1;
  const pos = new Float32Array(C * R * 3);
  const uv = new Float32Array(C * R * 2);
  const col = new Float32Array(C * R * 3);
  const H = Math.max(10, top - gAvg);
  const relief = (o.relief ?? Math.min(55, Math.max(6, 0.075 * H))) * rough;
  const flute = (o.flute ?? Math.min(12, Math.max(2, 0.024 * H))) * rough;
  const dispRaw = (s: number, y: number) => {
    let d = relief * noise.fbm(s / (relief * 7 + 60) + seed, seed * 0.37, 2);
    // occasional deep alcoves / side-canyon heads
    d -= relief * 1.1 * smoothstep(0.3, 0.75, noise.noise2(s / (relief * 4 + 40) + seed * 1.7, 9.1 + seed));
    // vertical buttresses and flutes
    d += flute * noise.noise2(s / (flute * 4 + 10) + seed * 3.1, y / 150);
    if (y < talusTop) d += rough * 7 * noise.noise2(s / 38 - seed, y / 26) * smoothstep(talusTop, talusTop - 25, y);
    return d;
  };
  // blend toward the start near the seam so the closed loop has no step
  const seamed = (fn: (s: number, y: number) => number, i: number, y: number) => {
    const s = us[i] * L;
    const w = smoothstep(L - 400, L, s);
    return w > 0 ? fn(s, y) * (1 - w) + fn(s - L, y) * w : fn(s, y);
  };
  const benchRaw = (s: number, y: number) => 0.5 + 0.9 * (noise.noise2(s / 330 + y * 0.01, seed + 4.4) * 0.5 + 0.5);
  const pinW = new Float32Array(N).fill(1);
  for (const [qx, qz, qr] of o.pins ?? [])
    for (let i = 0; i < N; i++) pinW[i] = Math.min(pinW[i], smoothstep(qr * 0.35, qr, Math.hypot(px[i] - qx, pz[i] - qz)));
  const disp = (i: number, y: number) => seamed(dispRaw, i, y) * pinW[i];
  /** Radial offset of the wall from the outline at column i, height y. */
  const radial = (i: number, y: number) => {
    let r = 0;
    if (y < talusTop) {
      const f = talusTop - y;
      r += f * 1.45 * (1 + (0.7 * f) / Math.max(tH, 1));
    }
    for (const [by, bw] of o.benches ?? []) r -= bw * seamed(benchRaw, i, by) * smoothstep(by - 4, by + 4, y);
    r -= 0.035 * Math.max(0, y - talusTop);
    r -= 3.2 * smoothstep(top - 7, top, y);
    return r;
  };
  for (const pr of probes) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(px[i] - pr.x, pz[i] - pr.z);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const r = radial(bi, pr.y) + disp(bi, pr.y);
    pr.pos.set(px[bi] + nx[bi] * r, pr.y, pz[bi] + nz[bi] * r);
    pr.normal.set(nx[bi], 0, nz[bi]);
  }
  for (let ci = 0; ci < C; ci++) {
    const i = ci % N;
    const tint = 0.95 + 0.1 * noise.noise2(i * 0.31 + seed, 7.7);
    for (let j = 0; j < R; j++) {
      const y = Y[j];
      const d = disp(i, y);
      const r = radial(i, y) + d;
      const o3 = (ci * R + j) * 3;
      pos[o3] = px[i] + nx[i] * r;
      pos[o3 + 1] = y;
      pos[o3 + 2] = pz[i] + nz[i] * r;
      const o2 = (ci * R + j) * 2;
      uv[o2] = (ci === N ? 1 : us[ci]) * L * uScale;
      // talus: stretch the bands just below the cliff foot so scree reads as smooth slopes, not terraces
      uv[o2 + 1] = vMap(y >= talusTop ? y : talusTop - (talusTop - y) * 0.16);
      let k = (0.7 + 0.3 * smoothstep(gAvg - 25, talusTop + 25, y)) * tint;
      k *= 1 + Math.max(-0.16, Math.min(0.06, d * 0.01));
      const scree = smoothstep(talusTop + 4, talusTop - 30, y);
      col[o3] = k * (1 - 0.04 * scree);
      col[o3 + 1] = k * (1 - 0.16 * scree);
      col[o3 + 2] = k * (1 - 0.22 * scree);
      if (o.capColor && y > top - (o.rimDepth ?? 0) - 0.01) {
        uv[o2 + 1] = o.flatV ?? 0.999;
        col[o3] = o.capColor.r * tint;
        col[o3 + 1] = o.capColor.g * tint;
        col[o3 + 2] = o.capColor.b * tint;
      }
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < R - 1; j++) {
      const a = i * R + j;
      const b = (i + 1) * R + j;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const wall = new THREE.BufferGeometry();
  wall.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  wall.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  wall.setAttribute('color', new THREE.BufferAttribute(col, 3));
  wall.setIndex(idx);
  wall.computeVertexNormals();
  // weld the seam normals
  const nor = wall.getAttribute('normal') as THREE.BufferAttribute;
  for (let j = 0; j < R; j++) {
    const a = j;
    const b = N * R + j;
    const sx = nor.getX(a) + nor.getX(b);
    const sy = nor.getY(a) + nor.getY(b);
    const sz = nor.getZ(a) + nor.getZ(b);
    const l = Math.hypot(sx, sy, sz) || 1;
    nor.setXYZ(a, sx / l, sy / l, sz / l);
    nor.setXYZ(b, sx / l, sy / l, sz / l);
  }
  // flat cap
  const contour: THREE.Vector2[] = [];
  for (let i = 0; i < N; i++) {
    const o3 = (i * R + R - 1) * 3;
    contour.push(new THREE.Vector2(pos[o3], pos[o3 + 2]));
  }
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const cpos = new Float32Array(N * 3);
  const cnor = new Float32Array(N * 3);
  const cuv = new Float32Array(N * 2);
  const ccol = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    cpos[i * 3] = contour[i].x;
    cpos[i * 3 + 1] = top;
    cpos[i * 3 + 2] = contour[i].y;
    cnor[i * 3 + 1] = 1;
    cuv[i * 2] = contour[i].x * uScale;
    cuv[i * 2 + 1] = o.capColor ? (o.flatV ?? 0.999) : vMap(top - 1.5);
    if (o.capColor) {
      ccol[i * 3] = o.capColor.r;
      ccol[i * 3 + 1] = o.capColor.g;
      ccol[i * 3 + 2] = o.capColor.b;
    } else ccol[i * 3] = ccol[i * 3 + 1] = ccol[i * 3 + 2] = 1.02;
  }
  const cidx: number[] = [];
  for (const [a, b, c] of tris) {
    const e1x = contour[b].x - contour[a].x;
    const e1z = contour[b].y - contour[a].y;
    const e2x = contour[c].x - contour[a].x;
    const e2z = contour[c].y - contour[a].y;
    if (e1z * e2x - e1x * e2z >= 0) cidx.push(a, b, c);
    else cidx.push(a, c, b);
  }
  const cap = new THREE.BufferGeometry();
  cap.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
  cap.setAttribute('normal', new THREE.BufferAttribute(cnor, 3));
  cap.setAttribute('uv', new THREE.BufferAttribute(cuv, 2));
  cap.setAttribute('color', new THREE.BufferAttribute(ccol, 3));
  cap.setIndex(cidx);
  return mergeIndexed([wall, cap]);
}

/** Merge indexed geometries that share position/normal/uv/color layouts. */
export function mergeIndexed(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const g of geos) {
    nv += g.getAttribute('position').count;
    ni += g.index!.count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const col = new Float32Array(nv * 3);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const c = g.getAttribute('position').count;
    pos.set(g.getAttribute('position').array as Float32Array, vo * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, vo * 3);
    uv.set(g.getAttribute('uv').array as Float32Array, vo * 2);
    col.set(g.getAttribute('color').array as Float32Array, vo * 3);
    const src = g.index!.array;
    for (let k = 0; k < src.length; k++) idx[io + k] = src[k] + vo;
    vo += c;
    io += src.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Wobbly closed outline around an ellipse. */
export function ellipseOutline(cx: number, cz: number, rx: number, rz: number, rot: number, seed: number, count = 11, wobble = 0.16): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const k = 1 + wobble * noise.noise2(Math.cos(a) * 1.3 + seed, Math.sin(a) * 1.3 - seed);
    const lx = Math.cos(a) * rx * k;
    const lz = Math.sin(a) * rz * k;
    out.push([cx + lx * c - lz * s, cz + lx * s + lz * c]);
  }
  return out;
}

export interface ArchOpts {
  /** Ground point under the middle of the opening. */
  x: number;
  z: number;
  ground: number;
  /** Unit vector along the span (leg to leg). */
  sx: number;
  sz: number;
  /** Clear span between the legs at the ground, crown underside height. */
  span: number;
  height: number;
  /** Crown rock thickness (radial) and depth (through the arch). */
  thick: number;
  depth: number;
  seed: number;
}

/** A natural sandstone arch: a rugged tube along a flattened ellipse, legs swelling into the ground. */
export function archGeometry(o: ArchOpts): THREE.BufferGeometry {
  const K = 18;
  const fx = -o.sz;
  const fz = o.sx;
  const cl: Array<{ x: number; y: number; r: number; d: number }> = [];
  const legR = o.thick * 2.4;
  const a = o.span / 2 + legR / 2;
  const b = o.height + o.thick / 2;
  const M = 44;
  // below-ground leg extensions + arc
  cl.push({ x: -a - 6, y: -16, r: legR * 1.25, d: o.depth * 1.9 });
  for (let i = 0; i <= M; i++) {
    const th = Math.PI * (1 - i / M);
    const sn = Math.sin(th);
    const w = Math.pow(1 - sn, 1.6);
    cl.push({ x: a * Math.cos(th), y: b * Math.pow(sn, 0.82), r: o.thick * (1 + 1.4 * w), d: o.depth * (1 + 0.8 * w) });
  }
  cl.push({ x: a + 6, y: -16, r: legR * 1.25, d: o.depth * 1.9 });
  const P = cl.length;
  const C = K + 1;
  const pos = new Float32Array(P * C * 3);
  const uv = new Float32Array(P * C * 2);
  const col = new Float32Array(P * C * 3);
  for (let i = 0; i < P; i++) {
    const prev = cl[Math.max(0, i - 1)];
    const next = cl[Math.min(P - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    // in-plane normal pointing away from the opening (outward/up at the crown)
    const qx = -ty;
    const qy = tx;
    const c = cl[i];
    for (let k = 0; k < C; k++) {
      const phi = ((k % K) / K) * Math.PI * 2;
      const cs = Math.cos(phi);
      const sn = Math.sin(phi);
      const sq = Math.sign(cs) * Math.pow(Math.abs(cs), 0.62);
      const sw = Math.sign(sn) * Math.pow(Math.abs(sn), 0.62);
      const rr = 1 + 0.16 * noise.noise3(i * 0.33 + o.seed, cs * 1.4, sn * 1.4) + 0.06 * noise.noise3(i * 1.1, cs * 4 + o.seed, sn * 4);
      const lq = (c.r / 2) * sq * rr;
      const lw = (c.d / 2) * sw * rr;
      const lx = c.x + qx * lq;
      const ly = c.y + qy * lq;
      const o3 = (i * C + k) * 3;
      pos[o3] = o.x + o.sx * lx + fx * lw;
      pos[o3 + 1] = o.ground + ly;
      pos[o3 + 2] = o.z + o.sz * lx + fz * lw;
      const o2 = (i * C + k) * 2;
      uv[o2] = ((k / K) * (c.r + c.d) * 1.6 + i * 3) * U_SCALE;
      uv[o2 + 1] = vStrata(pos[o3 + 1]);
      // underside darker (bounce-lit), crown top lighter
      const ao = 0.78 + 0.22 * (sq * 0.5 + 0.5);
      col[o3] = ao;
      col[o3 + 1] = ao * 0.97;
      col[o3 + 2] = ao * 0.95;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < P - 1; i++)
    for (let k = 0; k < K; k++) {
      const a0 = i * C + k;
      const b0 = (i + 1) * C + k;
      idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // make sure faces point outward: compare a crown vertex normal with its offset from the centreline
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const mid = Math.floor(P / 2);
  const kk = 0;
  const o3 = (mid * C + kk) * 3;
  const cx = o.x;
  const cy = o.ground + cl[mid].y;
  const cz = o.z;
  const dot = nor.getX(mid * C + kk) * (pos[o3] - cx) + nor.getY(mid * C + kk) * (pos[o3 + 1] - cy) + nor.getZ(mid * C + kk) * (pos[o3 + 2] - cz);
  if (dot < 0) {
    const arr = geo.index!.array as Uint16Array | Uint32Array;
    for (let t = 0; t < arr.length; t += 3) {
      const tmp = arr[t + 1];
      arr[t + 1] = arr[t + 2];
      arr[t + 2] = tmp;
    }
    geo.computeVertexNormals();
  }
  for (let i = 0; i < P; i++) {
    const a0 = i * C;
    const b0 = i * C + K;
    const sx = nor.getX(a0) + nor.getX(b0);
    const sy = nor.getY(a0) + nor.getY(b0);
    const sz = nor.getZ(a0) + nor.getZ(b0);
    const l = Math.hypot(sx, sy, sz) || 1;
    nor.setXYZ(a0, sx / l, sy / l, sz / l);
    nor.setXYZ(b0, sx / l, sy / l, sz / l);
  }
  return geo;
}

/** Unit-height hoodoo variants (Bryce-style spires with caprocks), vertex coloured in pink/orange/cream bands. */
export function hoodooGeometries(): THREE.BufferGeometry[] {
  const pal = ['#e8845a', '#f3b68a', '#f9dcc0', '#d8663f', '#eea070', '#f6c8a0', '#cf5a3a'];
  const out: THREE.BufferGeometry[] = [];
  for (let v = 0; v < 4; v++) {
    const rng = new Rng(300 + v * 17);
    const prof: THREE.Vector2[] = [];
    const H = 1;
    const base = 0.15 + rng.next() * 0.05;
    const phase = rng.next() * 6.28;
    const freq = 17 + rng.next() * 9;
    const segs = 30;
    for (let k = 0; k <= segs; k++) {
      const h = (k / segs) * 0.9 * H;
      const taper = 1 - 0.5 * (h / H);
      let r = base * taper * (1 + 0.2 * Math.sin(h * freq + phase) * smoothstep(0.05, 0.2, h));
      if (h < 0.08) r *= 1 + (0.08 - h) * 3.5;
      if (h > 0.78) r *= 1 - 0.32 * smoothstep(0.78, 0.9, h);
      prof.push(new THREE.Vector2(Math.max(0.02, r), h - 0.05));
    }
    // caprock
    const capR = base * (0.75 + rng.next() * 0.25);
    prof.push(new THREE.Vector2(capR * 1.05, 0.88));
    prof.push(new THREE.Vector2(capR, 0.94));
    prof.push(new THREE.Vector2(capR * 0.7, 0.985));
    prof.push(new THREE.Vector2(0.001, 1.0));
    const lathe = new THREE.LatheGeometry(prof, 8);
    const p = lathe.getAttribute('position');
    // wobble the cross-section
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const k = 1 + 0.14 * noise.noise3(x * 9 + v * 3, y * 6, z * 9);
      p.setXYZ(i, x * k, y, z * k);
    }
    lathe.computeVertexNormals();
    // bands
    const bands: Array<[number, THREE.Color]> = [];
    let y = -0.05;
    while (y < 0.86) {
      bands.push([y, new THREE.Color(rng.pick(pal))]);
      y += 0.04 + rng.next() * 0.08;
    }
    const capC = new THREE.Color('#9a5c46');
    const c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const yy = p.getY(i);
      let cc = bands[0][1];
      for (const [b0, bc] of bands) if (yy >= b0) cc = bc;
      if (yy > 0.875) cc = capC;
      const ao = 0.72 + 0.28 * smoothstep(-0.05, 0.3, yy);
      c[i * 3] = cc.r * ao;
      c[i * 3 + 1] = cc.g * ao;
      c[i * 3 + 2] = cc.b * ao;
    }
    lathe.setAttribute('color', new THREE.BufferAttribute(c, 3));
    lathe.deleteAttribute('uv');
    out.push(lathe);
  }
  return out;
}
