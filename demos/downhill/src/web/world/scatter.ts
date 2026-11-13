import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Noise } from '../core/noise';
import { Rng } from '../core/rng';
import { paintMaterial } from '../render/globals';
import type { Ground } from './ground';
import type { TerrainData } from './terrain';
import type { BushKind, GroundSample, RockKind, ScatterLayer, TerrainSpec } from './types';

const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

type Kind = BushKind | RockKind;

const noise = new Noise(4242);
/** Merge parts after normalising attributes (scatter meshes only need position/normal/color). */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('color')) {
      const n = g.getAttribute('position').count;
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    }
    return g;
  });
  return mergeGeometries(clean);
}

function colorize(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => [number, number, number]) {
  const p = g.getAttribute('position');
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const n = g.getAttribute('normal');
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const col = fn(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i));
    c[i * 3] = col[0];
    c[i * 3 + 1] = col[1];
    c[i * 3 + 2] = col[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function displace(g: THREE.BufferGeometry, amp: number, freq: number, seed: number) {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const d = 1 + amp * noise.noise3(x * freq + seed, y * freq, z * freq - seed);
    p.setXYZ(i, x * d, y * d, z * d);
  }
  g.computeVertexNormals();
  return g;
}

function blob(r: number, detail: number, seed: number, squash = 0.8) {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(r, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  displace(g, 0.22, 2.2 / r, seed);
  g.scale(1, squash, 1);
  return g;
}

function shadeFoliage(g: THREE.BufferGeometry, base: THREE.Color, top: number, bottom: number, height: number) {
  return colorize(g, (x, y, z, nx, ny) => {
    const t = THREE.MathUtils.clamp(y / height, 0, 1);
    const k = bottom + (top - bottom) * (0.5 * t + 0.5 * (ny * 0.5 + 0.5));
    const n = 0.9 + 0.2 * (noise.noise3(x * 3, y * 3, z * 3) * 0.5 + 0.5);
    return [base.r * k * n, base.g * k * n, base.b * k * n];
  });
}

function solid(g: THREE.BufferGeometry, c: THREE.Color, k = 1) {
  return colorize(g, () => [c.r * k, c.g * k, c.b * k]);
}

/** Build a unit-scale geometry for a kind. `lod` 0 = detailed, 1 = far/low. */
function makeGeometry(kind: Kind, base: THREE.Color, lod: number, seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const det = lod === 0 ? 2 : 0;
  const parts: THREE.BufferGeometry[] = [];
  const trunkC = new THREE.Color(0x5b4031);
  switch (kind) {
    case 'round': {
      const n = lod === 0 ? 4 : 2;
      for (let i = 0; i < n; i++) {
        const r = 0.45 + rng.next() * 0.25;
        const b = blob(r, det, seed + i, 0.8);
        b.translate((rng.next() - 0.5) * 0.7, r * 0.7 + rng.next() * 0.15, (rng.next() - 0.5) * 0.7);
        parts.push(b);
      }
      const g = merge(parts.map((p) => ni(p)));
      return shadeFoliage(g, base, 1.18, 0.5, 1.3);
    }
    case 'broadleaf': {
      const trunk = new THREE.CylinderGeometry(0.12, 0.2, 2.2, lod === 0 ? 7 : 4);
      trunk.translate(0, 1.1, 0);
      parts.push(solid(ni(trunk), trunkC));
      const n = lod === 0 ? 5 : 3;
      for (let i = 0; i < n; i++) {
        const r = 0.9 + rng.next() * 0.5;
        const b = blob(r, det, seed + i * 3, 0.85);
        b.translate((rng.next() - 0.5) * 1.4, 2.4 + rng.next() * 1.2, (rng.next() - 0.5) * 1.4);
        parts.push(shadeFoliage(ni(b), base, 1.2, 0.45, 4));
      }
      return merge(parts);
    }
    case 'pine': {
      const trunk = new THREE.CylinderGeometry(0.08, 0.16, 1.2, 5);
      trunk.translate(0, 0.6, 0);
      parts.push(solid(ni(trunk), trunkC));
      const tiers = lod === 0 ? 4 : 2;
      for (let i = 0; i < tiers; i++) {
        const t = i / tiers;
        const r = 1.25 * (1 - t * 0.7);
        const h = 1.9 * (1 - t * 0.3);
        const c = new THREE.ConeGeometry(r, h, lod === 0 ? 9 : 5, 1);
        if (lod === 0) displace(c, 0.08, 2.5, seed + i);
        c.translate(0, 1.0 + i * (4.2 / tiers) + h / 2, 0);
        parts.push(shadeFoliage(ni(c), base, 1.15, 0.55, 6));
      }
      return merge(parts);
    }
    case 'palm': {
      const segs = lod === 0 ? 7 : 3;
      let x = 0,
        y = 0;
      const lean = 0.25 + rng.next() * 0.25;
      for (let i = 0; i < segs; i++) {
        const h = 5.5 / segs;
        const c = new THREE.CylinderGeometry(0.14 - i * 0.008, 0.17 - i * 0.008, h * 1.05, 6);
        c.rotateZ(-lean * (i / segs));
        c.translate(x, y + h / 2, 0);
        parts.push(solid(ni(c), new THREE.Color(0x8a6a48), 0.9 + (i % 2) * 0.1));
        x += Math.sin(lean * (i / segs)) * h;
        y += Math.cos(lean * (i / segs)) * h;
      }
      const fronds = lod === 0 ? 9 : 5;
      for (let i = 0; i < fronds; i++) {
        const a = (i / fronds) * Math.PI * 2;
        const f = new THREE.PlaneGeometry(0.55, 2.6, 1, 4);
        const p = f.getAttribute('position');
        for (let k = 0; k < p.count; k++) {
          const yy = p.getY(k) + 1.3;
          p.setXYZ(k, p.getX(k) * (1 - yy / 2.8), yy, -0.35 * yy * yy);
        }
        f.rotateX(-0.25);
        f.rotateY(a);
        f.translate(x, y, 0);
        parts.push(shadeFoliage(ni(f), base, 1.15, 0.7, 10));
      }
      return merge(parts);
    }
    case 'cactus': {
      const body = new THREE.CapsuleGeometry(0.28, 3, 4, lod === 0 ? 10 : 6);
      body.translate(0, 1.8, 0);
      parts.push(ni(body));
      const arms = 1 + rng.int(0, 2);
      for (let i = 0; i < arms; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const h0 = 1.4 + rng.next() * 1.0;
        const horiz = new THREE.CapsuleGeometry(0.18, 0.55, 3, 6);
        horiz.rotateZ(Math.PI / 2);
        horiz.translate(side * 0.5, h0, 0);
        const up = new THREE.CapsuleGeometry(0.18, 1.0 + rng.next() * 0.6, 3, 6);
        up.translate(side * 0.82, h0 + 0.7, 0);
        parts.push(ni(horiz), ni(up));
      }
      const g = merge(parts);
      return colorize(g, (x, y, z) => {
        const ribs = 0.88 + 0.12 * Math.cos(Math.atan2(z, x) * 12);
        return [base.r * ribs, base.g * ribs, base.b * ribs];
      });
    }
    case 'mushroom': {
      const stem = new THREE.CylinderGeometry(0.22, 0.32, 2.2, 8);
      stem.translate(0, 1.1, 0);
      parts.push(solid(ni(stem), new THREE.Color(0xf4ead8)));
      const cap = new THREE.SphereGeometry(1.1, lod === 0 ? 16 : 8, lod === 0 ? 8 : 4, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.scale(1, 0.62, 1);
      cap.translate(0, 2.05, 0);
      parts.push(
        colorize(ni(cap), (x, y, z) => {
          const spot = noise.noise3(x * 2.4, y * 2.4, z * 2.4) > 0.45 ? 1 : 0;
          return spot ? [1, 0.97, 0.92] : [base.r, base.g, base.b];
        }),
      );
      return merge(parts);
    }
    case 'crystal': {
      const n = lod === 0 ? 5 : 3;
      for (let i = 0; i < n; i++) {
        const h = 1 + rng.next() * 1.6;
        const c = new THREE.CylinderGeometry(0, 0.22, h, 6);
        c.translate(0, h / 2, 0);
        c.rotateZ((rng.next() - 0.5) * 0.8);
        c.rotateX((rng.next() - 0.5) * 0.8);
        c.translate((rng.next() - 0.5) * 0.5, 0, (rng.next() - 0.5) * 0.5);
        parts.push(ni(c));
      }
      const g = merge(parts);
      return colorize(g, (x, y) => {
        const k = 0.75 + 0.45 * Math.min(1, y / 2);
        return [base.r * k, base.g * k, base.b * k];
      });
    }
    case 'deadTree': {
      const trunk = new THREE.CylinderGeometry(0.07, 0.16, 2.6, 5);
      trunk.translate(0, 1.3, 0);
      parts.push(ni(trunk));
      for (let i = 0; i < 4; i++) {
        const b = new THREE.CylinderGeometry(0.03, 0.06, 1.1, 4);
        b.translate(0, 0.55, 0);
        b.rotateZ(0.6 + rng.next() * 0.4);
        b.rotateY(rng.next() * 6.28);
        b.translate(0, 1.2 + rng.next() * 1.2, 0);
        parts.push(ni(b));
      }
      return solid(merge(parts), base);
    }
    case 'marram': {
      const blades = lod === 0 ? 14 : 6;
      for (let i = 0; i < blades; i++) {
        const c = new THREE.ConeGeometry(0.035, 0.9 + rng.next() * 0.5, 3);
        c.translate(0, 0.5, 0);
        c.rotateZ((rng.next() - 0.5) * 0.9);
        c.rotateY(rng.next() * 6.28);
        parts.push(ni(c));
      }
      return colorize(merge(parts), (x, y) => {
        const k = 0.7 + 0.5 * Math.min(1, y);
        return [base.r * k, base.g * k, base.b * k];
      });
    }
    case 'boulder':
    case 'granite':
    case 'crystalRock': {
      let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(0.6, kind === 'granite' ? (lod === 0 ? 1 : 0) : det === 2 ? 2 : 0);
      if (kind !== 'granite') {
        g.deleteAttribute('normal');
        g.deleteAttribute('uv');
        g = mergeVertices(g);
      }
      displace(g, 0.3, 1.8, seed);
      g.scale(1, 0.62 + rng.next() * 0.2, 0.85);
      g.translate(0, 0.25, 0);
      const ng = ni(g);
      if (kind === 'granite') ng.computeVertexNormals();
      const out = colorize(ng, (x, y, z, nx, ny) => {
        const k = 0.72 + 0.4 * (ny * 0.5 + 0.5) + 0.08 * noise.noise3(x * 4, y * 4, z * 4);
        return [base.r * k, base.g * k, base.b * k];
      });
      if (kind === 'crystalRock') {
        const c = makeGeometry('crystal', new THREE.Color(0xb9a2ff), lod, seed + 9);
        c.scale(0.6, 0.6, 0.6);
        c.translate(0, 0.35, 0);
        return merge([out, c]);
      }
      return out;
    }
    case 'sandstone': {
      const g = new THREE.BoxGeometry(1.2, 0.9, 1, lod === 0 ? 4 : 1, lod === 0 ? 6 : 2, lod === 0 ? 4 : 1);
      displace(g, 0.18, 1.6, seed);
      g.translate(0, 0.35, 0);
      return colorize(ni(g), (x, y, z, nx, ny) => {
        const band = 0.86 + 0.14 * Math.sin(y * 18 + noise.noise3(x, y, z) * 2);
        const k = (0.75 + 0.35 * (ny * 0.5 + 0.5)) * band;
        return [base.r * k, base.g * k, base.b * k];
      });
    }
    case 'driftwood': {
      const c = new THREE.CylinderGeometry(0.1, 0.14, 2.4, 6);
      c.rotateZ(Math.PI / 2);
      c.translate(0, 0.1, 0);
      return solid(ni(c), base);
    }
  }
  return new THREE.BoxGeometry(1, 1, 1);
}

interface KindInfo {
  collideR: number;
  near: number;
  max: number;
  sink: number;
  shadow: boolean;
}

const INFO: Record<Kind, KindInfo> = {
  round: { collideR: 0.55, near: 140, max: 1500, sink: 0.12, shadow: true },
  broadleaf: { collideR: 0.3, near: 220, max: 3200, sink: 0.1, shadow: true },
  pine: { collideR: 0.28, near: 220, max: 3200, sink: 0.1, shadow: true },
  palm: { collideR: 0.25, near: 220, max: 2500, sink: 0.1, shadow: true },
  cactus: { collideR: 0.33, near: 180, max: 2000, sink: 0.1, shadow: true },
  mushroom: { collideR: 0.3, near: 220, max: 3000, sink: 0.05, shadow: true },
  crystal: { collideR: 0.4, near: 180, max: 2200, sink: 0.1, shadow: true },
  deadTree: { collideR: 0.2, near: 180, max: 1800, sink: 0.05, shadow: true },
  marram: { collideR: 0, near: 90, max: 420, sink: 0.05, shadow: false },
  boulder: { collideR: 0.5, near: 140, max: 1200, sink: 0.18, shadow: true },
  granite: { collideR: 0.5, near: 140, max: 1400, sink: 0.18, shadow: true },
  crystalRock: { collideR: 0.5, near: 140, max: 1400, sink: 0.18, shadow: true },
  sandstone: { collideR: 0.6, near: 160, max: 1600, sink: 0.2, shadow: true },
  driftwood: { collideR: 0, near: 100, max: 500, sink: 0.05, shadow: true },
};

/** Culling tile size (m) for the detailed region and for the cheap distant ring. */
const TILE_NEAR = 64;
const TILE_FAR = 256;
/** Shadow casters are kept within this distance of the shadow focus even when off-screen. */
const SHADOW_R2 = 60 * 60;

interface Bucket {
  box: THREE.Box3;
  start: number;
  end: number;
}

const tmpV = new THREE.Vector3();

/**
 * One geometry variant of a layer: instances + near/far meshes with CPU culling.
 * Instances are stored tile-contiguously, culled per tile, and the GPU buffers are
 * only rewritten (and only the used range uploaded) when the visible tile set changes.
 */
class VariantSet {
  readonly near: THREE.InstancedMesh;
  readonly far: THREE.InstancedMesh;
  private mats: Float32Array;
  private pending = new Map<string, { box: THREE.Box3; idx: number[] }>();
  private buckets: Bucket[] = [];
  private count = 0;
  private nearList = new Int32Array(0);
  private farList = new Int32Array(0);
  private prevNear = new Int32Array(0);
  private prevFar = new Int32Array(0);
  private prevNearN = -1;
  private prevFarN = -1;

  constructor(
    geoNear: THREE.BufferGeometry,
    geoFar: THREE.BufferGeometry,
    material: THREE.Material,
    private info: KindInfo,
    capacity: number,
  ) {
    this.near = new THREE.InstancedMesh(geoNear, material, Math.max(1, capacity));
    this.far = new THREE.InstancedMesh(geoFar, material, Math.max(1, capacity));
    for (const m of [this.near, this.far]) {
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.near.castShadow = info.shadow;
    this.near.receiveShadow = true;
    this.mats = new Float32Array(capacity * 16);
  }

  add(m: THREE.Matrix4, x: number, y: number, z: number, r: number, tile: number) {
    const i = this.count++;
    m.toArray(this.mats, i * 16);
    const key = `${tile}:${Math.floor(x / tile)}:${Math.floor(z / tile)}`;
    let b = this.pending.get(key);
    if (!b) this.pending.set(key, (b = { box: new THREE.Box3(), idx: [] }));
    b.idx.push(i);
    b.box.expandByPoint(tmpV.set(x - r, y - r, z - r));
    b.box.expandByPoint(tmpV.set(x + r, y + r * 3, z + r));
  }

  /** Reorder instances so that every tile is one contiguous range of matrices. */
  finalize() {
    const sorted = new Float32Array(this.mats.length);
    let o = 0;
    for (const b of this.pending.values()) {
      const start = o;
      for (const i of b.idx) sorted.set(this.mats.subarray(i * 16, i * 16 + 16), o++ * 16);
      this.buckets.push({ box: b.box, start, end: o });
    }
    this.mats = sorted;
    this.pending.clear();
    const nb = this.buckets.length;
    this.nearList = new Int32Array(nb);
    this.farList = new Int32Array(nb);
    this.prevNear = new Int32Array(nb);
    this.prevFar = new Int32Array(nb);
  }

  get size() {
    return this.count;
  }

  cull(frustum: THREE.Frustum, cam: THREE.Vector3, shadowFocus: THREE.Vector3) {
    const maxD2 = this.info.max * this.info.max;
    const nearD2 = this.info.near * this.info.near;
    const bs = this.buckets;
    let nN = 0,
      nF = 0;
    for (let k = 0; k < bs.length; k++) {
      const box = bs[k].box;
      const dx = Math.max(box.min.x - cam.x, 0, cam.x - box.max.x);
      const dz = Math.max(box.min.z - cam.z, 0, cam.z - box.max.z);
      const d2 = dx * dx + dz * dz;
      if (d2 > maxD2) continue;
      if (d2 < nearD2) {
        let keep = frustum.intersectsBox(box);
        if (!keep && this.info.shadow) {
          const sx = Math.max(box.min.x - shadowFocus.x, 0, shadowFocus.x - box.max.x);
          const sz = Math.max(box.min.z - shadowFocus.z, 0, shadowFocus.z - box.max.z);
          keep = sx * sx + sz * sz < SHADOW_R2;
        }
        if (keep) this.nearList[nN++] = k;
      } else if (frustum.intersectsBox(box)) this.farList[nF++] = k;
    }
    this.prevNearN = this.apply(this.near, this.nearList, nN, this.prevNear, this.prevNearN);
    this.prevFarN = this.apply(this.far, this.farList, nF, this.prevFar, this.prevFarN);
  }

  /** Rebuild a mesh's instance buffer from visible tiles, only when the tile list changed. */
  private apply(mesh: THREE.InstancedMesh, list: Int32Array, n: number, prev: Int32Array, prevN: number) {
    let same = n === prevN;
    for (let k = 0; same && k < n; k++) same = list[k] === prev[k];
    if (same) return prevN;
    const arr = mesh.instanceMatrix.array as Float32Array;
    let c = 0;
    for (let k = 0; k < n; k++) {
      const b = this.buckets[list[k]];
      arr.set(this.mats.subarray(b.start * 16, b.end * 16), c * 16);
      c += b.end - b.start;
      prev[k] = list[k];
    }
    mesh.count = c;
    if (c > 0) {
      // upload only the used prefix (a zero-length range would mean "whole buffer" to WebGL)
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, c * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
    return n;
  }
}

export class ScatterSystem {
  readonly group = new THREE.Group();
  private sets: VariantSet[] = [];
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  instanceCount = 0;

  constructor(layers: ScatterLayer[], terrain: TerrainData, spec: TerrainSpec, ground: Ground, n: Noise, seed: number, avoid: (x: number, z: number) => boolean) {
    this.group.name = 'scatter';
    const rng = new Rng(seed ^ 0x5ca7);
    const sample: GroundSample = { x: 0, z: 0, h: 0, ny: 1, trailDist: 0 };
    const nn = { x: 0, y: 1, z: 0 };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const sc = new THREE.Vector3();
    const p = new THREE.Vector3();
    layers.forEach((layer, li) => {
      const info = INFO[layer.kind as Kind];
      const ca = new THREE.Color(layer.colorA);
      const cb = new THREE.Color(layer.colorB);
      const variants = 3;
      const cell = Math.sqrt(10000 / layer.perHectare);
      const r = terrain.spec.region;
      const pts: Array<{ x: number; y: number; z: number; s: number; v: number; ry: number; far: boolean }> = [];
      // detailed region
      for (let z = r.minZ + cell / 2; z < r.maxZ; z += cell)
        for (let x = r.minX + cell / 2; x < r.maxX; x += cell) {
          const px = x + (rng.next() - 0.5) * cell;
          const pz = z + (rng.next() - 0.5) * cell;
          const h = terrain.heightAt(px, pz);
          terrain.normalAt(px, pz, nn, 1);
          sample.x = px;
          sample.z = pz;
          sample.h = h;
          sample.ny = nn.y;
          sample.trailDist = terrain.trailDistAt(px, pz);
          if (sample.trailDist < layer.trailClearance) continue;
          if (rng.next() > layer.density(sample, n)) continue;
          if (ground.featureHeight(px, pz).h > -Infinity) continue;
          if (avoid(px, pz)) continue;
          const s = layer.scale[0] + (layer.scale[1] - layer.scale[0]) * rng.next();
          pts.push({ x: px, y: h - info.sink * s, z: pz, s, v: rng.int(0, variants - 1), ry: rng.next() * 6.283, far: false });
          if (info.collideR > 0 && layer.collide !== 'none') {
            ground.addCollider({ x: px, z: pz, r: info.collideR * s, top: h + s * 1.2, kind: layer.collide });
          }
        }
      // distant ring (cheap)
      if (layer.far) {
        const fc = cell * 2.2;
        const ext = 5200;
        const cx = (r.minX + r.maxX) / 2;
        const cz = (r.minZ + r.maxZ) / 2;
        for (let z = cz - ext; z < cz + ext; z += fc)
          for (let x = cx - ext; x < cx + ext; x += fc) {
            const px = x + (rng.next() - 0.5) * fc;
            const pz = z + (rng.next() - 0.5) * fc;
            if (px > r.minX - 20 && px < r.maxX + 20 && pz > r.minZ - 20 && pz < r.maxZ + 20) continue;
            const h = spec.farHeight(px, pz);
            const e2 = 6;
            const hx = spec.farHeight(px + e2, pz) - spec.farHeight(px - e2, pz);
            const hz = spec.farHeight(px, pz + e2) - spec.farHeight(px, pz - e2);
            const ny = (2 * e2) / Math.hypot(hx, 2 * e2, hz);
            sample.x = px;
            sample.z = pz;
            sample.h = h;
            sample.ny = ny;
            sample.trailDist = 1e4;
            if (rng.next() > layer.density(sample, n)) continue;
            const s = (layer.scale[0] + (layer.scale[1] - layer.scale[0]) * rng.next()) * 1.4;
            pts.push({ x: px, y: h - info.sink * s, z: pz, s, v: rng.int(0, variants - 1), ry: rng.next() * 6.283, far: true });
          }
      }
      const counts = [0, 0, 0];
      for (const pt of pts) counts[pt.v]++;
      const sets: VariantSet[] = [];
      for (let v = 0; v < variants; v++) {
        const col = new THREE.Color().copy(ca).lerp(cb, v / (variants - 1));
        const gNear = makeGeometry(layer.kind as Kind, col, 0, seed + li * 17 + v);
        const gFar = makeGeometry(layer.kind as Kind, col, 1, seed + li * 17 + v);
        const mat = paintMaterial({ vertexColors: true, side: layer.kind === 'palm' || layer.kind === 'marram' ? THREE.DoubleSide : THREE.FrontSide });
        if (layer.kind === 'crystal' || layer.kind === 'crystalRock' || layer.kind === 'mushroom') {
          mat.emissive = new THREE.Color(layer.kind === 'mushroom' ? 0x000000 : col).multiplyScalar(0.35);
        }
        const set = new VariantSet(gNear, gFar, mat, info, counts[v]);
        sets.push(set);
        this.sets.push(set);
        this.group.add(set.near, set.far);
      }
      for (const pt of pts) {
        const tilt = layer.kind === 'boulder' || layer.kind === 'granite' || layer.kind === 'sandstone' ? 0.25 : 0.06;
        e.set((rng.next() - 0.5) * tilt, pt.ry, (rng.next() - 0.5) * tilt);
        q.setFromEuler(e);
        sc.setScalar(pt.s);
        p.set(pt.x, pt.y, pt.z);
        m.compose(p, q, sc);
        sets[pt.v].add(m, pt.x, pt.y, pt.z, pt.s * 1.2, pt.far ? TILE_FAR : TILE_NEAR);
      }
      for (const set of sets) set.finalize();
      this.instanceCount += pts.length;
    });
  }

  update(camera: THREE.Camera, shadowFocus: THREE.Vector3) {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, THREE.WebGLCoordinateSystem, (camera as unknown as { reversedDepth?: boolean }).reversedDepth);
    for (const s of this.sets) s.cull(this.frustum, camera.position, shadowFocus);
  }

  dispose() {
    for (const s of this.sets) {
      s.near.geometry.dispose();
      s.far.geometry.dispose();
      (s.near.material as THREE.Material).dispose();
      s.near.dispose();
      s.far.dispose();
    }
  }
}
