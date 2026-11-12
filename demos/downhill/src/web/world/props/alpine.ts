import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Noise } from '../../core/noise';
import { Rng } from '../../core/rng';
import { paintMaterial, patchMaterial } from '../../render/globals';
import type { JumpFeature } from '../features';
import type { SetPieceHandle, WorldContext } from '../types';
import { alpinePeaks, eastFloor, LAKE, lakeE, wallX } from '../envs/alpine';

const noise = new Noise(9031);

const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

/** Non-indexed copy with a flat vertex colour (uv dropped so parts merge cleanly). */
function tint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, k = 1): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const geo = ni(g);
  if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
  const p = geo.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.ColorRepresentation, rz = 0, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return tint(g, color);
}

/** Everything the set pieces must keep clear of: trails, jumps and freeride kickers (rebuilt deterministically). */
class Keepout {
  private feats: readonly JumpFeature[];
  constructor(private ctx: WorldContext) {
    this.feats = ctx.features;
  }
  /** True when a circle (x, z, r) is clear of trails (by `trail` m) and jump features. */
  clear(x: number, z: number, r: number, trail: number) {
    if (this.ctx.terrain.trailDistAt(x, z) < r + trail) return false;
    for (const f of this.feats) {
      const b = f.bbox;
      if (x > b.min.x - r - 6 && x < b.max.x + r + 6 && z > b.min.y - r - 6 && z < b.max.y + r + 6) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------- cliff wall + waterfalls

/** Granite cliff face: warm sunlit grey, blue joints, mossy ledges, dark wet streaks. */
function paintCliff(seed: number) {
  const W = 1024,
    H = 1024;
  const rng = new Rng(seed);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#b4ab9b');
  g.addColorStop(0.45, '#9a9895');
  g.addColorStop(0.8, '#858b90');
  g.addColorStop(1, '#5e7562');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 650; i++) {
    ctx.globalAlpha = 0.12 + rng.next() * 0.22;
    ctx.fillStyle = rng.pick(['#c2b8a4', '#7f8492', '#a49a88', '#6c7388', '#b0a898', '#8a90a0', '#9c8f7a']);
    const w = 20 + rng.next() * 140;
    ctx.fillRect(rng.next() * W - w / 2, rng.next() * H, w, 40 + rng.next() * 320);
  }
  // vertical joints and light edges
  for (let i = 0; i < 380; i++) {
    const dark = rng.chance(0.6);
    ctx.globalAlpha = dark ? 0.25 + rng.next() * 0.35 : 0.2 + rng.next() * 0.2;
    ctx.fillStyle = dark ? '#3f4554' : '#d6d0c2';
    ctx.fillRect(rng.next() * W, rng.next() * H, 1 + rng.next() * 4, 60 + rng.next() * 520);
  }
  // dark wet streaks below the fall lips
  for (let i = 0; i < 40; i++) {
    ctx.globalAlpha = 0.12 + rng.next() * 0.2;
    ctx.fillStyle = '#3c4656';
    const x = rng.next() * W;
    ctx.fillRect(x, rng.next() * H * 0.3, 8 + rng.next() * 30, H * (0.3 + rng.next() * 0.7));
  }
  // broad warm / cool pillars of rock
  for (let i = 0; i < 26; i++) {
    ctx.globalAlpha = 0.14 + rng.next() * 0.14;
    ctx.fillStyle = rng.pick(['#c9b89a', '#6d7896', '#b9a586', '#7c86a4']);
    ctx.fillRect(rng.next() * W, 0, 30 + rng.next() * 110, H);
  }
  // mossy ledges (irregular, slanting) with little pines
  for (let i = 0; i < 34; i++) {
    let y = rng.next() * H * 0.95;
    const x = rng.next() * W;
    const len = 40 + rng.next() * 200;
    const slope = (rng.next() - 0.5) * 0.5;
    ctx.globalAlpha = 0.8;
    for (let k = 0; k < len; k += 5) {
      const th = (4 + rng.next() * 7) * Math.sin((k / len) * Math.PI);
      ctx.fillStyle = '#323d3c';
      ctx.fillRect(x + k, y + th, 6, 3);
      ctx.fillStyle = rng.pick(['#4f8c3c', '#5f9c44', '#3e7438', '#6aa648']);
      ctx.fillRect(x + k, y, 6, th + 1);
      y += slope * 5;
    }
    if (rng.chance(0.6))
      for (let t = 0; t < 1 + rng.int(0, 3); t++) {
        const tx = x + rng.next() * len;
        const th = 10 + rng.next() * 18;
        ctx.fillStyle = rng.pick(['#1f4a30', '#2a5c3a']);
        ctx.beginPath();
        ctx.moveTo(tx, y - th);
        ctx.lineTo(tx - th * 0.35, y + 2);
        ctx.lineTo(tx + th * 0.35, y + 2);
        ctx.fill();
      }
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

interface WallInfo {
  mesh: THREE.Mesh;
  top: (z: number) => number;
  /** Ground (or lake bed) in front of the wall. */
  floor: (z: number) => number;
  faceX: (z: number) => number;
}

/** The Lauterbrunnen wall: a sheer cliff along wallX(z), from the valley floor (or lake) to the terrace. */
function buildCliffWall(farH: (x: number, z: number) => number): WallInfo {
  const z0 = 1700,
    z1 = -5300;
  const step = 12;
  const rows = 22;
  const segs = Math.ceil((z0 - z1) / step);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const top = (z: number) => farH(wallX(z) + 48, z) + 3;
  const floor = (z: number) => Math.min(eastFloor(z), farH(wallX(z) - 70, z));
  const base = (z: number) => floor(z) - 40;
  const faceX = (z: number) => wallX(z) - 22;
  let s = 0;
  let prevX = faceX(z0);
  for (let i = 0; i <= segs; i++) {
    const z = z0 - i * step;
    const fx = faceX(z);
    if (i > 0) s += Math.hypot(fx - prevX, step);
    prevX = fx;
    const yb = base(z);
    const yt = top(z);
    const butt = Math.pow(Math.max(0, Math.sin((s / 140) * Math.PI)), 4) * 14;
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      const y = yb + (yt - yb) * v;
      // overhangs, buttresses and a talus-like flare at the foot
      const relief = 13 * noise.fbm(s / 85, y / 60, 3) + butt * (1 - 0.4 * v) + 26 * Math.pow(1 - v, 4) - 6 * Math.pow(v, 6);
      pos.push(fx - relief, y, z);
      uv.push(s / 360, v);
    }
  }
  for (let i = 0; i < segs; i++)
    for (let j = 0; j < rows; j++) {
      const a = i * (rows + 1) + j;
      const b = a + rows + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = paintMaterial({ color: 0xffffff, map: paintCliff(23), side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  return { mesh, top, floor, faceX };
}

function waterfallTextures() {
  const a = document.createElement('canvas');
  a.width = 128;
  a.height = 512;
  const c = a.getContext('2d')!;
  const rng = new Rng(77);
  c.fillStyle = '#cfe6f2';
  c.fillRect(0, 0, 128, 512);
  for (let i = 0; i < 70; i++) {
    const x = rng.next() * 128;
    const w = 2 + rng.next() * 9;
    c.globalAlpha = 0.35 + rng.next() * 0.6;
    c.fillStyle = rng.pick(['#ffffff', '#f4fbff', '#b8d8ea', '#ffffff']);
    c.fillRect(x, 0, w, 512);
  }
  // falling clumps (tile vertically)
  for (let i = 0; i < 90; i++) {
    const x = rng.next() * 128,
      y = rng.next() * 512;
    c.globalAlpha = 0.4 + rng.next() * 0.5;
    c.fillStyle = '#ffffff';
    c.fillRect(x, y, 3 + rng.next() * 10, 10 + rng.next() * 40);
    c.fillRect(x, y - 512, 3 + rng.next() * 10, 10 + rng.next() * 40);
  }
  const map = new THREE.CanvasTexture(a);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1, 5);
  // alpha: soft edges, solid core, dissolving into spray at the bottom
  const b = document.createElement('canvas');
  b.width = 64;
  b.height = 256;
  const d = b.getContext('2d')!;
  const img = d.createImageData(64, 256);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 64; x++) {
      const u = Math.abs(x / 63 - 0.5) * 2;
      const v = 1 - y / 255; // canvas top = v 1 (top of the fall)
      const edge = 1 - Math.pow(u, 2.2);
      const prof = Math.min(1, v * 6) * (0.55 + 0.45 * Math.min(1, (1 - v) * 4));
      const a8 = Math.round(255 * Math.max(0, Math.min(1, edge * prof)));
      const o = (y * 64 + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = a8;
      img.data[o + 3] = 255;
    }
  d.putImageData(img, 0, 0);
  const alpha = new THREE.CanvasTexture(b);
  return { map, alpha };
}

function sprayTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 70, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.45, 'rgba(240,250,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

interface Falls {
  group: THREE.Group;
  map: THREE.Texture;
  sprays: THREE.InstancedMesh;
  spray: Float32Array;
}

/** Ribbon waterfalls leaping off the terrace edge, with billowing spray at the foot. */
function buildWaterfalls(wall: WallInfo, rng: Rng): Falls {
  const group = new THREE.Group();
  const tex = waterfallTextures();
  const spots = [
    { z: 380, w: 22 },
    { z: -520, w: 30 },
    { z: -950, w: 18 },
    { z: -1380, w: 44 },
    { z: -1900, w: 24 },
    { z: -2260, w: 34 },
    { z: -2900, w: 26 },
    { z: -3600, w: 40 },
  ];
  const parts: THREE.BufferGeometry[] = [];
  // spray billboards: x, y, z, size, phase per puff
  const spray = new Float32Array(spots.length * 3 * 5);
  let sc = 0;
  for (const sp of spots) {
    const z = sp.z;
    const yt = wall.top(z) - 2;
    const yb = Math.max(wall.floor(z), LAKE - 1);
    const fx = wall.faceX(z);
    const rows = 24;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      const y = yt + (yb - yt) * t;
      // leaps out over the lip, then falls almost straight, fanning out into spray
      const out = 30 + 26 * Math.sqrt(t);
      const hw = sp.w * (0.32 + 1.15 * t * t);
      for (const side of [-1, 1]) {
        pos.push(fx - out, y, z + side * hw);
        uv.push(side < 0 ? 0 : 1, 1 - t);
      }
      if (j < rows) {
        const a = j * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g);
    for (let k = 0; k < 3; k++) {
      const s = sp.w * (3.2 + rng.next() * 1.8);
      spray.set([fx - 50 - rng.next() * 25, yb + s * 0.22 + k * 6, z + (rng.next() - 0.5) * sp.w * 1.5, s, rng.next() * 6.28], sc++ * 5);
    }
  }
  const mat = paintMaterial({ map: tex.map, transparent: true, depthWrite: false, side: THREE.DoubleSide, emissive: '#cfeaf6', emissiveIntensity: 0.75 });
  mat.alphaMap = tex.alpha;
  const mesh = new THREE.Mesh(mergeGeometries(parts), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  group.add(mesh);
  const sprayMat = patchMaterial(new THREE.MeshBasicMaterial({ map: sprayTexture(), transparent: true, depthWrite: false, opacity: 0.6, color: 0xf2fbff }));
  const sprays = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), sprayMat, sc);
  sprays.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sprays.frustumCulled = false;
  sprays.renderOrder = 3;
  group.add(sprays);
  return { group, map: tex.map, sprays, spray };
}

// ---------------------------------------------------------------- gondola

interface Track {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  cum: Float32Array;
  len: number;
}

function buildTrack(pts: THREE.Vector3[]): Track {
  const n = pts.length;
  const x = new Float32Array(n),
    y = new Float32Array(n),
    z = new Float32Array(n),
    cum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = pts[i].x;
    y[i] = pts[i].y;
    z[i] = pts[i].z;
    if (i > 0) cum[i] = cum[i - 1] + pts[i].distanceTo(pts[i - 1]);
  }
  return { x, y, z, cum, len: cum[n - 1] };
}

function trackAt(t: Track, s: number, out: THREE.Vector3) {
  let lo = 0,
    hi = t.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const u = (s - t.cum[lo]) / Math.max(1e-6, t.cum[hi] - t.cum[lo]);
  out.set(t.x[lo] + (t.x[hi] - t.x[lo]) * u, t.y[lo] + (t.y[hi] - t.y[lo]) * u, t.z[lo] + (t.z[hi] - t.z[lo]) * u);
  return out;
}

function pylonGeometry(h: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // tubular steel mast (bold enough to survive the paint filter)
  const mast = new THREE.CylinderGeometry(1.1, 1.7, h, 10);
  mast.translate(0, h / 2, 0);
  parts.push(tint(mast, '#c3c8d0'));
  // cross arm carrying red sheave trains for both tracks
  parts.push(box(12.5, 1.8, 2.0, 0, h + 0.1, 0, '#8d95a3'));
  for (const sx of [-1, 1]) {
    parts.push(box(1.6, 1.2, 8.5, sx * 4.6, h + 1.2, 0, '#d0362b'));
    parts.push(box(0.8, 1.5, 0.8, sx * 4.6, h + 0.5, 0, '#5d6878'));
  }
  // service platform and footing
  parts.push(box(3.8, 0.4, 3.8, 0, h - 2, 0, '#7b828e'));
  parts.push(box(5.2, 2.4, 5.2, 0, 0.2, 0, '#d2cdc2'));
  return mergeGeometries(parts);
}

function cabinGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // hanger arm + grip
  parts.push(box(0.22, 3.4, 0.22, 0, 1.7, 0, '#3d4450'));
  parts.push(box(0.5, 0.5, 1.4, 0, 3.45, 0, '#3d4450'));
  // body (white, tinted per instance), glazing band and roof
  parts.push(box(2.6, 2.3, 2.4, 0, -1.15, 0, '#ffffff'));
  parts.push(box(2.66, 0.9, 2.46, 0, -0.75, 0, '#2c3e58'));
  parts.push(box(2.8, 0.35, 2.6, 0, 0.12, 0, '#f2f2f2'));
  parts.push(box(1.0, 0.25, 1.0, 0, 0.4, 0, '#d0d0d0'));
  return mergeGeometries(parts);
}

function stationGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(box(18, 7, 26, 0, 1.5, 0, '#e7e1d4'));
  parts.push(box(18.4, 3.2, 26.4, 0, 6.6, 0, '#8b5a33'));
  // big sloped roof
  const roofA = new THREE.BoxGeometry(11.5, 0.6, 30);
  roofA.rotateZ(0.42);
  roofA.translate(-5, 10.4, 0);
  const roofB = new THREE.BoxGeometry(11.5, 0.6, 30);
  roofB.rotateZ(-0.42);
  roofB.translate(5, 10.4, 0);
  parts.push(tint(roofA, '#4d525e'), tint(roofB, '#4d525e'));
  // the open bull-wheel bay
  parts.push(box(14, 1.2, 8, 0, 8.6, 15, '#5d6878'));
  parts.push(box(1.2, 8, 1.2, -6, 4.5, 17.5, '#5d6878'), box(1.2, 8, 1.2, 6, 4.5, 17.5, '#5d6878'));
  parts.push(box(0.6, 0.6, 9, 0, 9.4, 15, '#c9372c'));
  // windows
  for (let k = -2; k <= 2; k++) parts.push(box(18.6, 1.6, 2.2, 0, 3.2, k * 4.8, '#2b3a50'));
  return mergeGeometries(parts);
}

interface Gondola {
  group: THREE.Group;
  cabins: THREE.InstancedMesh;
  tracks: [Track, Track];
  phases: Float32Array;
  yaw: number;
}

/** Gondola line: top station behind the start, valley station by the lake. */
const GONDOLA_TOP = { x: 205, z: 96 };
const GONDOLA_BOT = { x: 268, z: -2905 };

function buildGondola(ctx: WorldContext, keep: Keepout): Gondola {
  const group = new THREE.Group();
  const H = (x: number, z: number) => ctx.terrain.heightAt(x, z);
  const top = new THREE.Vector3(GONDOLA_TOP.x, 0, GONDOLA_TOP.z);
  const bot = new THREE.Vector3(GONDOLA_BOT.x, 0, GONDOLA_BOT.z);
  const dir = bot.clone().sub(top);
  const L = Math.hypot(dir.x, dir.z);
  const fx = dir.x / L,
    fz = dir.z / L;
  const rx = -fz,
    rz = fx; // right-hand normal
  const yaw = Math.atan2(fx, fz);
  const nSpans = 13;
  const stationH = 9.4;
  // pylon stations along the line (endpoints are the stations); nudge pylons off trails and jumps
  const sPos: number[] = [];
  for (let i = 0; i <= nSpans; i++) {
    let s = (L * i) / nSpans;
    if (i > 0 && i < nSpans)
      for (let k = 0; k < 16; k++) {
        const ss = s + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 6;
        if (keep.clear(top.x + fx * ss, top.z + fz * ss, 4, 3)) {
          s = ss;
          break;
        }
      }
    sPos.push(s);
  }
  const groundAt = (s: number) => H(top.x + fx * s, top.z + fz * s);
  const tops = sPos.map((s, i) => groundAt(s) + (i === 0 || i === nSpans ? stationH : 24));
  const sag = (span: number) => span * 0.022;
  // raise pylons until the cable clears the slope everywhere
  for (let it = 0; it < 6; it++)
    for (let i = 0; i < nSpans; i++) {
      const a = sPos[i],
        b = sPos[i + 1];
      let worst = 0;
      for (let k = 1; k < 20; k++) {
        const t = k / 20;
        const y = tops[i] + (tops[i + 1] - tops[i]) * t - 4 * sag(b - a) * t * (1 - t);
        worst = Math.max(worst, groundAt(a + (b - a) * t) + 17 - y);
      }
      if (worst > 0) {
        if (i > 0) tops[i] += worst;
        if (i + 1 < nSpans) tops[i + 1] += worst;
      }
    }
  // pylons
  const pylonParts: THREE.BufferGeometry[] = [];
  for (let i = 1; i < nSpans; i++) {
    const s = sPos[i];
    const x = top.x + fx * s,
      z = top.z + fz * s;
    const g0 = groundAt(s);
    const h = tops[i] - g0 - 1.2;
    const g = pylonGeometry(h);
    g.rotateY(yaw);
    g.translate(x, g0 - 0.4, z);
    pylonParts.push(g);
    ctx.addCollider(x, z, 3.2, tops[i], 'solid');
  }
  const pylonMesh = new THREE.Mesh(mergeGeometries(pylonParts), paintMaterial({ vertexColors: true }));
  pylonMesh.castShadow = true;
  pylonMesh.receiveShadow = true;
  group.add(pylonMesh);
  // stations
  const stParts: THREE.BufferGeometry[] = [];
  for (const [i, flip] of [
    [0, 1],
    [nSpans, -1],
  ] as const) {
    const s = sPos[i];
    const x = top.x + fx * s,
      z = top.z + fz * s;
    const g = stationGeometry();
    g.rotateY(yaw + (flip > 0 ? 0 : Math.PI));
    const gy = Math.min(H(x - 8, z), H(x + 8, z), H(x, z - 12), H(x, z + 12));
    g.translate(x - fx * flip * 12, gy - 1.5, z - fz * flip * 12);
    stParts.push(g);
    ctx.addCollider(x - fx * flip * 12, z - fz * flip * 12, 15, gy + 12, 'solid');
  }
  const stMesh = new THREE.Mesh(mergeGeometries(stParts), paintMaterial({ vertexColors: true }));
  stMesh.castShadow = true;
  stMesh.receiveShadow = true;
  group.add(stMesh);
  // cables: catenary-ish sag per span, one per direction
  const cableParts: THREE.BufferGeometry[] = [];
  const tracks: Track[] = [];
  for (const side of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < nSpans; i++) {
      const a = sPos[i],
        b = sPos[i + 1];
      const segs = 18;
      for (let k = i === 0 ? 0 : 1; k <= segs; k++) {
        const t = k / segs;
        const s = a + (b - a) * t;
        const y = tops[i] + (tops[i + 1] - tops[i]) * t - 4 * sag(b - a) * t * (1 - t) + 0.1;
        pts.push(new THREE.Vector3(top.x + fx * s + rx * side * 4.6, y, top.z + fz * s + rz * side * 4.6));
      }
    }
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k],
        b = pts[k + 1];
      const len = a.distanceTo(b);
      const c = new THREE.CylinderGeometry(0.45, 0.45, len, 4, 1, true);
      c.rotateX(Math.PI / 2);
      c.lookAt(b.clone().sub(a));
      c.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      cableParts.push(tint(c, '#2f3540'));
    }
    tracks.push(buildTrack(side > 0 ? pts : pts.slice().reverse()));
  }
  const cableMesh = new THREE.Mesh(mergeGeometries(cableParts), paintMaterial({ vertexColors: true }));
  group.add(cableMesh);
  // cabins
  const spacing = 72;
  const per = Math.floor(tracks[0].len / spacing);
  const count = per * 2;
  const cabins = new THREE.InstancedMesh(cabinGeometry(), paintMaterial({ vertexColors: true }), count);
  const phases = new Float32Array(count);
  const palette = ['#d8342a', '#d8342a', '#f2c230', '#d8342a', '#e8e8e8'];
  const cRng = new Rng(311);
  for (let i = 0; i < count; i++) {
    phases[i] = ((i * (tracks[0].len * 2)) / count) % (tracks[0].len * 2);
    cabins.setColorAt(i, new THREE.Color(cRng.pick(palette)));
  }
  cabins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cabins.frustumCulled = false;
  cabins.castShadow = true;
  group.add(cabins);
  return { group, cabins, tracks: [tracks[0], tracks[1]], phases, yaw };
}

// ---------------------------------------------------------------- chalets, barns, village

function chaletGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const W = 10,
    D = 8,
    RH = 4.9;
  // whitewashed stone ground floor (deep footing for slopes) and honey-wood upper floor
  parts.push(box(W, 5.2, D, 0, 0.4, 0, '#efe8dc'));
  parts.push(box(W + 0.1, 3.2, D + 0.1, 0, 4.6, 0, '#a2622e'));
  // gable (attic) prism, ridge along z
  const gable = new THREE.Shape();
  gable.moveTo(-W / 2, 0);
  gable.lineTo(W / 2, 0);
  gable.lineTo(0, RH);
  gable.lineTo(-W / 2, 0);
  const ge = new THREE.ExtrudeGeometry(gable, { depth: D, bevelEnabled: false });
  ge.translate(0, 6.2, -D / 2);
  parts.push(tint(ge, '#93552a'));
  // steep roof slabs with deep overhangs
  const ridge = 6.2 + RH;
  const pitch = Math.atan2(RH, W / 2);
  const ov = 1.6;
  const slab = Math.hypot(W / 2, RH) + ov + 0.3;
  for (const sx of [-1, 1]) {
    const r = new THREE.BoxGeometry(slab, 0.5, D + 3.2);
    r.rotateZ(-sx * pitch);
    const along = slab / 2 - 0.3;
    r.translate(sx * (Math.cos(pitch) * along + Math.sin(pitch) * 0.25), ridge - Math.sin(pitch) * along + Math.cos(pitch) * 0.25, 0);
    parts.push(tint(r, '#4a4c56'));
  }
  // balcony with red geraniums on the front gable (+z)
  parts.push(box(W + 0.8, 0.3, 1.5, 0, 6.3, D / 2 + 0.75, '#6e4424'));
  parts.push(box(W + 0.8, 1.0, 0.2, 0, 6.9, D / 2 + 1.45, '#7a4a26'));
  parts.push(box(W + 0.4, 0.5, 0.45, 0, 7.55, D / 2 + 1.5, '#e2402f'));
  // windows (dark with white frames) front/back and sides
  for (const zf of [1, -1])
    for (const wx of [-3, 0, 3]) {
      parts.push(box(1.5, 1.6, 0.25, wx, 2.2, zf * (D / 2 + 0.05), '#f6f2ea'));
      parts.push(box(1.1, 1.2, 0.3, wx, 2.2, zf * (D / 2 + 0.06), '#2a2522'));
      parts.push(box(1.1, 1.2, 0.3, wx, 4.8, zf * (D / 2 + 0.08), '#2a2522'));
    }
  for (const xf of [1, -1])
    for (const wz of [-2.2, 2.2]) {
      parts.push(box(0.3, 1.2, 1.1, xf * (W / 2 + 0.06), 4.8, wz, '#2a2522'));
      parts.push(box(0.3, 1.2, 1.1, xf * (W / 2 + 0.06), 2.2, wz, '#2a2522'));
    }
  // chimney
  parts.push(box(0.9, 2.6, 0.9, 2.2, ridge - 2.2 * Math.tan(pitch) + 0.9, -1.5, '#d8d2c6'));
  return mergeGeometries(parts);
}

function churchGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // nave
  parts.push(box(11, 10, 22, 0, 3, 0, '#f4f0e8'));
  const pitch = 0.75;
  for (const sx of [-1, 1]) {
    const r = new THREE.BoxGeometry(8.6, 0.5, 23.5);
    r.rotateZ(-sx * pitch);
    r.translate(sx * 2.9, 10.6, 0);
    parts.push(tint(r, '#3f4552'));
  }
  const gable = new THREE.Shape();
  gable.moveTo(-5.5, 0);
  gable.lineTo(5.5, 0);
  gable.lineTo(0, 5.1);
  gable.lineTo(-5.5, 0);
  const ge = new THREE.ExtrudeGeometry(gable, { depth: 22, bevelEnabled: false });
  ge.translate(0, 8, -11);
  parts.push(tint(ge, '#f4f0e8'));
  // bell tower with clock and tall spire
  parts.push(box(6, 26, 6, 0, 11, 13, '#f7f3ec'));
  parts.push(box(6.2, 2.4, 6.2, 0, 21.5, 13, '#e6dfd2'));
  for (const [ox, oz] of [
    [0, 3.1],
    [3.1, 0],
    [-3.1, 0],
  ])
    parts.push(box(oz ? 2.2 : 0.2, 2.2, oz ? 0.2 : 2.2, ox, 19.2, 13 + oz, '#2b2f3a'));
  const spire = new THREE.ConeGeometry(4.4, 16, 8);
  spire.rotateY(Math.PI / 8);
  spire.translate(0, 32.5, 13);
  parts.push(tint(spire, '#3a6f62'));
  parts.push(box(0.3, 3.5, 0.3, 0, 42, 13, '#d9b44a'));
  // arched windows
  for (const zz of [-6, 0, 6]) for (const sx of [-1, 1]) parts.push(box(0.3, 4, 1.6, sx * 5.55, 4.5, zz, '#3a3550'));
  return mergeGeometries(parts);
}

function buildSettlements(ctx: WorldContext, keep: Keepout, rng: Rng, avoid: Array<[number, number, number]>): THREE.Group {
  const group = new THREE.Group();
  const H = (x: number, z: number) => ctx.terrain.heightAt(x, z);
  const nrm = { x: 0, y: 1, z: 0 };
  const slopeOk = (x: number, z: number, lim: number) => {
    const e = 6;
    const hx = H(x + e, z) - H(x - e, z);
    const hz = H(x, z + e) - H(x, z - e);
    nrm.y = (2 * e) / Math.hypot(hx, 2 * e, hz);
    return nrm.y > lim;
  };
  const placed: Array<[number, number, number]> = [];
  const mats: THREE.Matrix4[] = [];
  const cols: THREE.Color[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const free = (x: number, z: number, r: number) => !placed.some(([px, pz, pr]) => Math.hypot(px - x, pz - z) < pr + r + 4) && !avoid.some(([ax, az, ar]) => Math.hypot(ax - x, az - z) < ar + r);
  const r0 = ctx.terrain;
  const inRegion = (x: number, z: number) => x > r0.minX + 4 && x < r0.maxX - 4 && z > r0.minZ + 4 && z < r0.maxZ - 4;
  const add = (x: number, z: number, s: number, barn: boolean, face: number) => {
    const rad = 6.2 * s;
    const y = Math.min(H(x - 4 * s, z), H(x + 4 * s, z), H(x, z - 4 * s), H(x, z + 4 * s)) + 0.2;
    q.setFromAxisAngle(up, face);
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s));
    mats.push(m.clone());
    cols.push(barn ? new THREE.Color('#9a7254').multiplyScalar(0.95 + rng.next() * 0.15) : new THREE.Color(1, 1, 1).multiplyScalar(0.94 + rng.next() * 0.08));
    placed.push([x, z, rad]);
    if (inRegion(x, z)) ctx.addCollider(x, z, rad * 0.9, y + 9 * s, 'solid');
  };
  const tryPlace = (x: number, z: number, s: number, barn: boolean, face: number, trail: number) => {
    const rad = 6.2 * s;
    if (!free(x, z, rad)) return false;
    if (H(x, z) < LAKE + 2.5) return false;
    if (!slopeOk(x, z, 0.86)) return false;
    if (inRegion(x, z) && !keep.clear(x, z, rad, trail)) return false;
    add(x, z, s, barn, face);
    return true;
  };
  // meadow chalets & hay barns beside the run (facing down the valley)
  let tries = 0;
  let count = 0;
  while (count < 46 && tries++ < 3000) {
    const z = 60 - rng.next() * 2700;
    const side = rng.next();
    const x = side < 0.28 ? -495 + rng.next() * 120 : side < 0.55 ? 175 + rng.next() * 140 : -330 + rng.next() * 500;
    const barn = rng.chance(0.45);
    const face = rng.chance(0.65) ? Math.PI + (rng.next() - 0.5) * 0.7 : Math.PI / 2 + (rng.next() - 0.5) * 0.5;
    if (tryPlace(x, z, barn ? 0.45 + rng.next() * 0.15 : 0.85 + rng.next() * 0.35, barn, face, barn ? 14 : 24)) count++;
  }
  // lakeside village around the valley station
  const village: Array<[number, number, number, number]> = [
    [150, -2930, 230, 70],
    [520, -3020, 160, 60],
    [-260, -2990, 160, 50],
  ];
  for (const [cx, cz, rx, rz] of village)
    for (let i = 0; i < 70; i++) {
      const x = cx + rng.gauss() * rx * 0.55;
      const z = cz + rng.gauss() * rz * 0.55;
      if (lakeE(x, z) < 1.0) continue;
      tryPlace(x, z, 0.8 + rng.next() * 0.45, rng.chance(0.15), rng.next() * 0.5 + (rng.chance(0.5) ? 0 : Math.PI / 2), 18);
    }
  // valley floor farms and the clifftop village on the terrace
  for (let i = 0; i < 70; i++) {
    const z = 400 - rng.next() * 3400;
    const x = 560 + rng.next() * 520;
    tryPlace(x, z, rng.chance(0.4) ? 0.5 : 0.9 + rng.next() * 0.3, rng.chance(0.4), rng.next() * 6.28, 10);
  }
  for (let i = 0; i < 60; i++) {
    const z = -700 - rng.gauss() * 260;
    const x = wallX(z) + 120 + Math.abs(rng.gauss()) * 260;
    tryPlace(x, z, 0.85 + rng.next() * 0.3, rng.chance(0.2), rng.next() * 6.28, 10);
  }
  const geo = chaletGeometry();
  const im = new THREE.InstancedMesh(geo, paintMaterial({ vertexColors: true }), mats.length);
  mats.forEach((mm, i) => {
    im.setMatrixAt(i, mm);
    im.setColorAt(i, cols[i]);
  });
  im.castShadow = true;
  im.receiveShadow = true;
  im.frustumCulled = false;
  group.add(im);
  // village church on a knoll by the shore
  {
    let best: [number, number] = [60, -2960];
    for (let i = 0; i < 40; i++) {
      const x = 60 + rng.gauss() * 120;
      const z = -2950 + rng.gauss() * 40;
      if (lakeE(x, z) > 1.02 && free(x, z, 20) && slopeOk(x, z, 0.9)) {
        best = [x, z];
        break;
      }
    }
    const [x, z] = best;
    const g = churchGeometry();
    g.rotateY(0.25);
    g.translate(x, Math.min(H(x - 8, z), H(x + 8, z), H(x, z - 14), H(x, z + 14)) - 0.5, z);
    const ch = new THREE.Mesh(g, paintMaterial({ vertexColors: true }));
    ch.castShadow = true;
    group.add(ch);
    placed.push([x, z, 20]);
  }
  return group;
}

// ---------------------------------------------------------------- granite tors

function buildTors(ctx: WorldContext, keep: Keepout, rng: Rng, avoid: Array<[number, number, number]>): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const grey = new THREE.Color('#d2cfc6');
  const cool = new THREE.Color('#a9aebb');
  const lichen = new THREE.Color('#b9b860');
  const moss = new THREE.Color('#4f8a3c');
  const spots: Array<[number, number, number]> = [];
  for (let z = -60; z > -2650; z -= 110 + rng.next() * 150) {
    for (let k = 0; k < 3; k++) {
      const x = -480 + rng.next() * 780;
      const s = 4 + rng.next() * 6;
      if (avoid.some(([ax, az, ar]) => Math.hypot(ax - x, az - z) < ar + s * 2)) continue;
      if (!keep.clear(x, z, s * 1.4, 9)) continue;
      spots.push([x, z, s]);
      break;
    }
  }
  for (const [x, z, s] of spots) {
    const h = ctx.terrain.heightAt(x, z);
    // a low cluster of weathered pillows, sometimes with one perched on top
    const blocks: Array<[number, number, number, number, number]> = [];
    const nb = 2 + rng.int(0, 2);
    for (let k = 0; k < nb; k++) {
      const a = (k / nb) * Math.PI * 2 + rng.next();
      const off = k === 0 ? 0 : s * (0.45 + rng.next() * 0.3);
      blocks.push([x + Math.cos(a) * off, z + Math.sin(a) * off, s * (0.8 + rng.next() * 0.5), s * (0.42 + rng.next() * 0.22), h - s * 0.12]);
    }
    if (rng.chance(0.55)) blocks.push([x + (rng.next() - 0.5) * s * 0.3, z + (rng.next() - 0.5) * s * 0.3, s * (0.55 + rng.next() * 0.25), s * (0.32 + rng.next() * 0.15), h + s * 0.32]);
    for (const [bx, bz, lw, lh, by] of blocks) {
      let b: THREE.BufferGeometry = new THREE.BoxGeometry(lw, lh, lw * (0.7 + rng.next() * 0.35), 4, 3, 4);
      b = ni(b);
      const p = b.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const px = p.getX(i),
          py = p.getY(i),
          pz = p.getZ(i);
        // superellipsoid rounding: granite weathers into pillows
        const r = Math.hypot(px / (lw * 0.5), py / (lh * 0.5), pz / (lw * 0.5));
        const k2 = 1 / Math.max(1, r * 0.72) + 0.07 * noise.noise3(px * 0.3 + bx, py * 0.3, pz * 0.3 + bz);
        p.setXYZ(i, px * k2, py * k2, pz * k2);
      }
      b.rotateY(rng.next() * Math.PI);
      b.translate(bx, by + lh * 0.45, bz);
      b.computeVertexNormals();
      const nr = b.getAttribute('normal');
      const pp = b.getAttribute('position');
      const col = new Float32Array(pp.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < pp.count; i++) {
        c.copy(grey).lerp(cool, 0.5 + 0.5 * noise.noise2(pp.getX(i) * 0.2, pp.getY(i) * 0.2));
        if (nr.getY(i) > 0.75) c.lerp(moss, 0.5);
        else if (noise.noise3(pp.getX(i) * 0.5, pp.getY(i) * 0.5, pp.getZ(i) * 0.5) > 0.45) c.lerp(lichen, 0.45);
        const kk = 0.85 + 0.2 * Math.max(0, nr.getY(i));
        col[i * 3] = c.r * kk;
        col[i * 3 + 1] = c.g * kk;
        col[i * 3 + 2] = c.b * kk;
      }
      if (b.getAttribute('uv')) b.deleteAttribute('uv');
      b.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(b);
    }
    ctx.addCollider(x, z, s * 0.95, h + s * 0.9, 'solid');
  }
  const mesh = new THREE.Mesh(mergeGeometries(parts), paintMaterial({ vertexColors: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------- assembly

export function buildAlpineSetPieces(ctx: WorldContext): SetPieceHandle {
  const farH = alpinePeaks.terrain.farHeight;
  const rng = new Rng(8080);
  const root = new THREE.Group();
  root.name = 'alpine';
  ctx.scene.add(root);
  const keep = new Keepout(ctx);

  const wall = buildCliffWall(farH);
  root.add(wall.mesh);
  const falls = buildWaterfalls(wall, rng);
  root.add(falls.group);

  const gondola = buildGondola(ctx, keep);
  root.add(gondola.group);

  // keep chalets and tors off the gondola footprint
  const avoid: Array<[number, number, number]> = [];
  for (let s = 0; s <= 1; s += 0.01) avoid.push([GONDOLA_TOP.x + (GONDOLA_BOT.x - GONDOLA_TOP.x) * s, GONDOLA_TOP.z + (GONDOLA_BOT.z - GONDOLA_TOP.z) * s, 20]);
  root.add(buildSettlements(ctx, keep, rng, avoid));
  root.add(buildTors(ctx, keep, rng, avoid));

  const tmp = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qBack = new THREE.Quaternion();
  const CAB = 1.9;
  const scl = new THREE.Vector3(CAB, CAB, CAB);
  const hang = 3.55 * CAB;
  const sprayScl = new THREE.Vector3();
  q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), gondola.yaw);
  qBack.setFromAxisAngle(new THREE.Vector3(0, 1, 0), gondola.yaw + Math.PI);
  const [down, upT] = gondola.tracks;
  const loop = down.len + upT.len;
  return {
    update(_dt, time, camera) {
      // waterfalls pour, spray billows (camera-facing)
      falls.map.offset.y = (time * 0.55) % 1;
      const sp = falls.spray;
      for (let i = 0; i < falls.sprays.count; i++) {
        const o = i * 5;
        const k = sp[o + 3] * (1 + 0.08 * Math.sin(time * 1.3 + sp[o + 4]));
        tmp.set(sp[o], sp[o + 1], sp[o + 2]);
        sprayScl.set(k, k * 0.7, 1);
        m4.compose(tmp, camera.quaternion, sprayScl);
        falls.sprays.setMatrixAt(i, m4);
      }
      falls.sprays.instanceMatrix.needsUpdate = true;
      // gondola cabins circulate on the loop (down one cable, up the other)
      const cab = gondola.cabins;
      for (let i = 0; i < cab.count; i++) {
        let s = (gondola.phases[i] + time * 6) % loop;
        if (s < down.len) {
          trackAt(down, s, tmp);
          m4.compose(tmp.setY(tmp.y - hang), q, scl);
        } else {
          s -= down.len;
          trackAt(upT, s, tmp);
          m4.compose(tmp.setY(tmp.y - hang), qBack, scl);
        }
        cab.setMatrixAt(i, m4);
      }
      cab.instanceMatrix.needsUpdate = true;
    },
  };
}
