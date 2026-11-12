import * as THREE from 'three';
import { clamp, smoothstep, wrapAngle } from '../core/math';
import { Rng } from '../core/rng';
import type { TerrainData } from './terrain';
import type { Trail, TrailNetwork } from './trails';

const D2R = Math.PI / 180;

export interface JumpShape {
  name: string;
  /** Kicker length / height / lip angle (relative to the base slope). */
  lk: number;
  hk: number;
  lip: number;
  /** Flat deck after the lip (tabletops, drop decks). */
  table: number;
  /** Open gap after the deck/lip (no surface). */
  gap: number;
  /** Landing top height, length and angle. */
  hl: number;
  ll: number;
  land: number;
  /** Half width of the riding surface. */
  hw: number;
  wood: boolean;
  /** Difficulty / scoring class. */
  size: 1 | 2 | 3 | 4;
}

export const SHAPES: Record<string, JumpShape> = {
  small: { name: 'Tabletop', lk: 3.4, hk: 0.95, lip: 27 * D2R, table: 4.5, gap: 0, hl: 0.95, ll: 10, land: 16 * D2R, hw: 1.6, wood: false, size: 1 },
  medium: { name: 'Tabletop', lk: 4.3, hk: 1.5, lip: 31 * D2R, table: 7, gap: 0, hl: 1.5, ll: 13, land: 20 * D2R, hw: 1.9, wood: false, size: 2 },
  large: { name: 'Big Table', lk: 5.3, hk: 2.2, lip: 34 * D2R, table: 10, gap: 0, hl: 2.2, ll: 16, land: 22 * D2R, hw: 2.2, wood: false, size: 3 },
  step: { name: 'Step-Down', lk: 3.8, hk: 1.25, lip: 28 * D2R, table: 0, gap: 4.5, hl: 0.45, ll: 9, land: 15 * D2R, hw: 1.9, wood: false, size: 2 },
  gap: { name: 'Gap Jump', lk: 5.0, hk: 2.3, lip: 34 * D2R, table: 0, gap: 9, hl: 2.2, ll: 16, land: 24 * D2R, hw: 2.1, wood: false, size: 3 },
  hero: { name: 'Hero Gap', lk: 6.6, hk: 3.3, lip: 38 * D2R, table: 0, gap: 15, hl: 3.1, ll: 22, land: 26 * D2R, hw: 2.7, wood: false, size: 4 },
  drop: { name: 'Wood Drop', lk: 6.5, hk: 1.7, lip: 2 * D2R, table: 3.2, gap: 2.4, hl: 0.55, ll: 9, land: 16 * D2R, hw: 1.3, wood: true, size: 2 },
};

const BACK_SLOPE = Math.tan(55 * D2R);
const SIDE_SLOPE = Math.tan(48 * D2R);

/** A jump on a straight local frame: u along travel direction, v to the right. */
export class JumpFeature {
  readonly dirX: number;
  readonly dirZ: number;
  readonly rightX: number;
  readonly rightZ: number;
  readonly length: number;
  readonly lipU: number;
  readonly landU: number;
  readonly maxHW: number;
  /** Base (ground) height every 0.5 m along u. */
  base: Float32Array = new Float32Array(0);
  readonly bbox = new THREE.Box2();
  id = 0;

  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly heading: number,
    readonly shape: JumpShape,
    readonly trailKind: string,
  ) {
    this.dirX = Math.sin(heading);
    this.dirZ = -Math.cos(heading);
    this.rightX = Math.cos(heading);
    this.rightZ = Math.sin(heading);
    const s = shape;
    this.lipU = s.lk;
    this.landU = s.lk + s.table + s.gap;
    this.length = this.landU + s.ll;
    this.maxHW = s.hw + Math.max(s.hk, s.hl) / SIDE_SLOPE + 0.5;
    const pts = [
      [0, -this.maxHW],
      [0, this.maxHW],
      [this.length, -this.maxHW],
      [this.length, this.maxHW],
    ];
    this.bbox.makeEmpty();
    for (const [u, v] of pts) this.bbox.expandByPoint(new THREE.Vector2(x0 + this.dirX * u + this.rightX * v, z0 + this.dirZ * u + this.rightZ * v));
  }

  /** Sample base heights from the (carved) terrain along the centreline. */
  bake(terrain: TerrainData) {
    const n = Math.ceil(this.length / 0.5) + 2;
    this.base = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const u = k * 0.5;
      this.base[k] = terrain.heightAt(this.x0 + this.dirX * u, this.z0 + this.dirZ * u);
    }
  }

  baseAt(u: number) {
    const f = clamp(u / 0.5, 0, this.base.length - 1.001);
    const i = Math.floor(f);
    return this.base[i] + (this.base[i + 1] - this.base[i]) * (f - i);
  }

  /** Height of the riding surface above the base along the centreline, or -Infinity where there is none. */
  profile(u: number): number {
    const s = this.shape;
    if (u < 0 || u > this.length) return -Infinity;
    if (u <= s.lk) {
      const t = u / s.lk;
      return s.hk * (3 * t * t - 2 * t * t * t) + Math.tan(s.lip) * s.lk * (t * t * t - t * t);
    }
    const deckEnd = s.lk + s.table;
    if (u <= deckEnd) return s.hk;
    if (u < this.landU) {
      // open gap: kicker/deck backside (dirt) and landing front face
      let h = -Infinity;
      if (!s.wood) h = s.hk - (u - deckEnd) * BACK_SLOPE;
      const front = s.hl - (this.landU - u) * BACK_SLOPE;
      h = Math.max(h, front);
      return h > 0 ? h : -Infinity;
    }
    const t = (u - this.landU) / s.ll;
    const m = -Math.tan(s.land) * s.ll;
    return s.hl * (2 * t * t * t - 3 * t * t + 1) + m * (t * t * t - 2 * t * t + t);
  }

  /** World-space surface height at (x,z) or -Infinity. */
  heightAt(x: number, z: number): number {
    const dx = x - this.x0;
    const dz = z - this.z0;
    const u = dx * this.dirX + dz * this.dirZ;
    if (u < 0 || u > this.length) return -Infinity;
    const v = Math.abs(dx * this.rightX + dz * this.rightZ);
    if (v > this.maxHW) return -Infinity;
    let p = this.profile(u);
    if (p === -Infinity) return p;
    const s = this.shape;
    if (v > s.hw) {
      if (s.wood) return -Infinity;
      p -= (v - s.hw) * SIDE_SLOPE;
      if (p <= 0) return -Infinity;
    }
    return this.baseAt(u) + p;
  }

  /** Local frame helper. */
  toLocal(x: number, z: number) {
    const dx = x - this.x0;
    const dz = z - this.z0;
    return { u: dx * this.dirX + dz * this.dirZ, v: dx * this.rightX + dz * this.rightZ };
  }
}

export interface FeaturePlan {
  trail: Trail;
  s0: number;
  shape: JumpShape;
}

function straightEnough(t: Trail, s0: number, len: number) {
  const i0 = Math.max(0, Math.floor(s0 - 8));
  const i1 = Math.min(t.x.length - 1, Math.ceil(s0 + len + 8));
  if (i1 - i0 < len) return false;
  const h0 = t.heading[i0];
  for (let i = i0; i <= i1; i += 2) if (Math.abs(wrapAngle(t.heading[i] - h0)) > 0.1) return false;
  return true;
}

/** Choose jump locations along each trail (before carving, so trails can be widened). */
export function planFeatures(net: TrailNetwork, jumpsOnMain: number, seed: number): FeaturePlan[] {
  const rng = new Rng(seed ^ 0x1337);
  const plans: FeaturePlan[] = [];
  const main = net.main;
  const order = ['small', 'small', 'medium', 'step', 'medium', 'drop', 'medium', 'large', 'medium', 'step', 'large', 'medium', 'large', 'drop', 'large', 'medium'];
  const usable = main.length - 260;
  for (let k = 0; k < jumpsOnMain; k++) {
    const shape = SHAPES[order[k % order.length]];
    const len = shape.lk + shape.table + shape.gap + shape.ll;
    const target = 120 + (usable * (k + 0.5)) / jumpsOnMain;
    let placed = false;
    for (let off = 0; off < 45 && !placed; off += 3) {
      for (const sgn of [1, -1]) {
        const s0 = target + off * sgn;
        if (s0 < 90 || s0 + len > main.length - 90) continue;
        if (plans.some((p) => p.trail === main && Math.abs(p.s0 - s0) < len + 30)) continue;
        if (straightEnough(main, s0, len)) {
          plans.push({ trail: main, s0, shape });
          placed = true;
          break;
        }
      }
    }
  }
  for (const t of net.trails.slice(1)) {
    const kinds = t.kind === 'pro' ? ['gap', 'hero', 'drop', 'gap', 'large', 'hero'] : ['small', 'medium', 'small', 'medium', 'small', 'medium', 'small'];
    const count = Math.min(kinds.length, Math.floor((t.length - 120) / (t.kind === 'pro' ? 85 : 55)));
    for (let k = 0; k < count; k++) {
      const shape = SHAPES[kinds[k]];
      const len = shape.lk + shape.table + shape.gap + shape.ll;
      const target = 60 + ((t.length - 120 - len) * (k + 0.5)) / count;
      for (let off = 0; off < 30; off += 3) {
        const s0 = target + off * (rng.next() < 0.5 ? 1 : -1);
        if (s0 < 50 || s0 + len > t.length - 50) continue;
        if (straightEnough(t, s0, len)) {
          plans.push({ trail: t, s0, shape });
          break;
        }
      }
    }
  }
  return plans;
}

/** Widen trails around planned jumps and add rollers to flow lines (modifies trail arrays in place). */
export function prepareTrailsForFeatures(net: TrailNetwork, plans: FeaturePlan[]) {
  for (const p of plans) {
    const t = p.trail;
    const len = p.shape.lk + p.shape.table + p.shape.gap + p.shape.ll;
    const want = p.shape.hw + 0.9;
    for (let i = Math.max(0, Math.floor(p.s0 - 18)); i < Math.min(t.x.length, Math.ceil(p.s0 + len + 18)); i++) {
      const s = t.s[i];
      const w = smoothstep(p.s0 - 18, p.s0 - 4, s) * (1 - smoothstep(p.s0 + len + 4, p.s0 + len + 18, s));
      t.hw[i] = Math.max(t.hw[i], t.hw[i] + (want - t.hw[i]) * w);
      t.bank[i] *= 1 - w;
    }
    // flatten the profile under the jump: straight line between entry and exit heights
    const i0 = Math.max(0, Math.floor(p.s0 - 6));
    const i1 = Math.min(t.x.length - 1, Math.ceil(p.s0 + len + 6));
    const h0 = t.h[i0];
    const h1 = t.h[i1];
    for (let i = i0; i <= i1; i++) {
      const f = (i - i0) / Math.max(1, i1 - i0);
      t.h[i] = h0 + (h1 - h0) * f;
    }
  }
  // rollers on flow lines between jumps
  for (const t of net.trails) {
    if (t.kind !== 'flow') continue;
    const busy = plans.filter((p) => p.trail === t).map((p) => [p.s0 - 25, p.s0 + p.shape.lk + p.shape.table + p.shape.gap + p.shape.ll + 25]);
    for (let i = 40; i < t.x.length - 40; i++) {
      const s = t.s[i];
      if (busy.some(([a, b]) => s > a && s < b)) continue;
      t.h[i] += 0.55 * (0.5 - 0.5 * Math.cos((s / 8.5) * Math.PI * 2)) * smoothstep(40, 70, s) * (1 - smoothstep(t.length - 70, t.length - 40, s));
    }
  }
}

/** Build feature objects from plans after the terrain has been carved. */
export function buildFeatures(plans: FeaturePlan[], net: TrailNetwork, terrain: TerrainData): JumpFeature[] {
  const out: JumpFeature[] = [];
  for (const p of plans) {
    const smp = net.sample(p.trail, p.s0);
    const end = net.sample(p.trail, p.s0 + p.shape.lk + p.shape.table + p.shape.gap + p.shape.ll);
    const heading = Math.atan2(end.x - smp.x, -(end.z - smp.z));
    const f = new JumpFeature(smp.x, smp.z, heading, p.shape, p.trail.kind);
    f.bake(terrain);
    out.push(f);
  }
  return out;
}

/** Scatter standalone freeride kickers along the fall line, away from the trails. */
export function scatterFreeride(count: number, terrain: TerrainData, existing: JumpFeature[], seed: number): JumpFeature[] {
  const rng = new Rng(seed ^ 0xfeed);
  const out: JumpFeature[] = [];
  const n = { x: 0, y: 1, z: 0 };
  let attempts = 0;
  while (out.length < count && attempts++ < count * 60) {
    const x = rng.range(terrain.minX + 120, terrain.maxX - 120);
    const z = rng.range(terrain.minZ + 160, terrain.maxZ - 140);
    if (terrain.trailDistAt(x, z) < 16) continue;
    terrain.normalAt(x, z, n, 3);
    if (n.y < 0.94 || n.y > 0.999) continue;
    const heading = Math.atan2(n.x, -n.z);
    const shape = SHAPES[rng.pick(['small', 'medium', 'medium', 'large', 'step', 'gap'])];
    const f = new JumpFeature(x, z, heading, shape, 'free');
    const ex = f.x0 + f.dirX * f.length;
    const ez = f.z0 + f.dirZ * f.length;
    if (terrain.trailDistAt(ex, ez) < 14) continue;
    const all = existing.concat(out);
    if (all.some((o) => Math.hypot(o.x0 - x, o.z0 - z) < 45)) continue;
    f.bake(terrain);
    out.push(f);
  }
  return out;
}
