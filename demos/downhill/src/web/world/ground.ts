import type { Surface } from '../core/audioTypes';
import type { JumpFeature } from './features';
import type { TerrainData } from './terrain';
import type { TrailNetwork } from './trails';
import type { GroundSample, TerrainSpec } from './types';

export interface Collider {
  x: number;
  z: number;
  r: number;
  top: number;
  kind: 'solid' | 'soft';
}

export interface GroundHit {
  h: number;
  nx: number;
  ny: number;
  nz: number;
  surface: Surface;
  feature: JumpFeature | null;
  trailDist: number;
}

export function makeHit(): GroundHit {
  return { h: 0, nx: 0, ny: 1, nz: 0, surface: 'grass', feature: null, trailDist: 1e4 };
}

/** How far the trail ribbons sit above the terrain they drape over, m (it keeps them clear of the terrain mesh). */
export const TRAIL_LIFT = 0.06;
/** How far past a trail's edge its ribbon fades out, m (its outermost vertices, at 1.35 × the half-width). */
export const TRAIL_FADE = 0.35 * 0.9;

/** How far above the terrain the drawn trail is at `trailDist` (m past the trail's edge; negative on the trail). */
export function trailLift(trailDist: number): number {
  return TRAIL_LIFT * Math.min(1, Math.max(0, 1 - trailDist / TRAIL_FADE));
}

/** Physics-facing view of the world surface. */
export class Ground {
  private featureGrid = new Map<number, JumpFeature[]>();
  private colliderGrid = new Map<number, Collider[]>();
  private readonly fc = 32;
  private readonly cc = 8;
  private sample: GroundSample = { x: 0, z: 0, h: 0, ny: 1, trailDist: 0 };

  constructor(
    readonly terrain: TerrainData,
    readonly trails: TrailNetwork,
    readonly features: JumpFeature[],
    readonly spec: TerrainSpec,
  ) {
    features.forEach((f, i) => {
      f.id = i;
      const b = f.bbox;
      for (let gx = Math.floor(b.min.x / this.fc); gx <= Math.floor(b.max.x / this.fc); gx++)
        for (let gz = Math.floor(b.min.y / this.fc); gz <= Math.floor(b.max.y / this.fc); gz++) {
          const k = gx * 73856093 + gz * 19349663;
          let a = this.featureGrid.get(k);
          if (!a) this.featureGrid.set(k, (a = []));
          a.push(f);
        }
    });
  }

  addCollider(c: Collider) {
    const r = c.r;
    for (let gx = Math.floor((c.x - r) / this.cc); gx <= Math.floor((c.x + r) / this.cc); gx++)
      for (let gz = Math.floor((c.z - r) / this.cc); gz <= Math.floor((c.z + r) / this.cc); gz++) {
        const k = gx * 73856093 + gz * 19349663;
        let a = this.colliderGrid.get(k);
        if (!a) this.colliderGrid.set(k, (a = []));
        a.push(c);
      }
  }

  /** Highest jump surface at (x,z), or -Infinity. */
  featureHeight(x: number, z: number): { h: number; f: JumpFeature | null } {
    const arr = this.featureGrid.get(Math.floor(x / this.fc) * 73856093 + Math.floor(z / this.fc) * 19349663);
    let best = -Infinity;
    let bf: JumpFeature | null = null;
    if (arr)
      for (const f of arr) {
        const h = f.heightAt(x, z);
        if (h > best) {
          best = h;
          bf = f;
        }
      }
    return { h: best, f: bf };
  }

  heightAt(x: number, z: number): number {
    const t = this.terrain.heightAt(x, z);
    const f = this.featureHeight(x, z).h;
    return f > t ? f : t;
  }

  /**
   * The ground's height as drawn: like `heightAt`, but on a trail its ribbon sits TRAIL_LIFT above the terrain. Wheels
   * stand on this, or the ribbon paints over the bottom of the tyres.
   */
  drawnHeightAt(x: number, z: number): number {
    const t = this.terrain.heightAt(x, z) + trailLift(this.terrain.trailDistAt(x, z));
    const f = this.featureHeight(x, z).h;
    return f > t ? f : t;
  }

  /** Full query: height, normal, surface. */
  query(x: number, z: number, out: GroundHit): GroundHit {
    const th = this.terrain.heightAt(x, z);
    const fh = this.featureHeight(x, z);
    const onFeature = fh.h > th + 0.01;
    out.h = fh.h > th ? fh.h : th;
    out.feature = onFeature ? fh.f : null;
    const e = 0.25;
    const hx1 = this.heightAt(x + e, z);
    const hx0 = this.heightAt(x - e, z);
    const hz1 = this.heightAt(x, z + e);
    const hz0 = this.heightAt(x, z - e);
    let nx = -(hx1 - hx0),
      ny = 2 * e,
      nz = -(hz1 - hz0);
    const l = Math.hypot(nx, ny, nz);
    nx /= l;
    ny /= l;
    nz /= l;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    const td = this.terrain.trailDistAt(x, z);
    out.trailDist = td;
    if (onFeature) out.surface = fh.f!.shape.wood ? 'wood' : 'dirt';
    else if (td < 0.15) out.surface = 'dirt';
    else {
      const s = this.sample;
      s.x = x;
      s.z = z;
      s.h = th;
      s.ny = ny;
      s.trailDist = td;
      out.surface = this.spec.surface(s);
    }
    return out;
  }

  /** First collider overlapping a circle at (x,z) whose top is above y. */
  collide(x: number, z: number, y: number, radius: number): Collider | null {
    const arr = this.colliderGrid.get(Math.floor(x / this.cc) * 73856093 + Math.floor(z / this.cc) * 19349663);
    if (!arr) return null;
    for (const c of arr) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < c.r + radius && y < c.top) return c;
    }
    return null;
  }

  /** Nearest collider whose surface lies within `radius` of (x,z) and whose top is above y (searches neighbouring cells). */
  nearest(x: number, z: number, y: number, radius: number): { c: Collider; gap: number } | null {
    let best: Collider | null = null;
    let bestGap = radius;
    const r = Math.ceil(radius / this.cc);
    const gx = Math.floor(x / this.cc);
    const gz = Math.floor(z / this.cc);
    for (let i = gx - r; i <= gx + r; i++)
      for (let k = gz - r; k <= gz + r; k++) {
        const arr = this.colliderGrid.get(i * 73856093 + k * 19349663);
        if (!arr) continue;
        for (const c of arr) {
          const gap = Math.hypot(c.x - x, c.z - z) - c.r;
          if (gap < bestGap && y < c.top) {
            bestGap = gap;
            best = c;
          }
        }
      }
    return best ? { c: best, gap: bestGap } : null;
  }
}
