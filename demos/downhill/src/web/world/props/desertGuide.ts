import { TerrainData } from '../terrain';
import { TrailNetwork, type Trail } from '../trails';
import type { CourseSpec, TerrainSpec } from '../types';

type Region = TerrainSpec['region'];

/**
 * Trail guide: the engine's own trail generator run on a flat dummy terrain yields the exact trail polylines
 * (trail x/z never depend on terrain heights), so a landscape and its set pieces can be shaped around the course.
 */
export class TrailGuide {
  readonly trails: Trail[];
  readonly main: Trail;
  private readonly cell = 4;
  private readonly gx: number;
  private readonly gz: number;
  /** Distance (m) to the nearest centreline of any trail / of the side lines only. */
  private readonly all: Float32Array;
  private readonly side: Float32Array;

  constructor(
    course: CourseSpec,
    readonly region: Region,
    seed: number,
  ) {
    const flat: TerrainSpec = {
      region,
      cell: 16,
      height: () => 0,
      farHeight: () => 0,
      groundColor: (_s, o) => o.fill(0),
      farColor: (_x, _z, _h, _n, o) => o.fill(0),
      surface: () => 'dirt',
    };
    const net = TrailNetwork.generate(course, new TerrainData(flat), seed);
    this.trails = net.trails;
    this.main = net.main;
    this.gx = Math.round((region.maxX - region.minX) / this.cell) + 1;
    this.gz = Math.round((region.maxZ - region.minZ) / this.cell) + 1;
    this.all = this.field(this.trails);
    this.side = this.field(this.trails.slice(1));
  }

  private field(trails: Trail[]): Float32Array {
    const { gx, gz, cell, region } = this;
    const d = new Float32Array(gx * gz).fill(1e5);
    for (const t of trails) {
      for (let k = 0; k < t.x.length; k += 2) {
        const px = t.x[k];
        const pz = t.z[k];
        const ci = Math.round((px - region.minX) / cell);
        const cj = Math.round((pz - region.minZ) / cell);
        for (let dj = -3; dj <= 3; dj++)
          for (let di = -3; di <= 3; di++) {
            const i = ci + di;
            const j = cj + dj;
            if (i < 0 || j < 0 || i >= gx || j >= gz) continue;
            const dd = Math.hypot(region.minX + i * cell - px, region.minZ + j * cell - pz);
            const o = j * gx + i;
            if (dd < d[o]) d[o] = dd;
          }
      }
    }
    // two-pass chamfer distance transform
    const a = cell;
    const b = cell * Math.SQRT2;
    for (let j = 0; j < gz; j++)
      for (let i = 0; i < gx; i++) {
        const o = j * gx + i;
        let v = d[o];
        if (i > 0) v = Math.min(v, d[o - 1] + a);
        if (j > 0) {
          v = Math.min(v, d[o - gx] + a);
          if (i > 0) v = Math.min(v, d[o - gx - 1] + b);
          if (i < gx - 1) v = Math.min(v, d[o - gx + 1] + b);
        }
        d[o] = v;
      }
    for (let j = gz - 1; j >= 0; j--)
      for (let i = gx - 1; i >= 0; i--) {
        const o = j * gx + i;
        let v = d[o];
        if (i < gx - 1) v = Math.min(v, d[o + 1] + a);
        if (j < gz - 1) {
          v = Math.min(v, d[o + gx] + a);
          if (i < gx - 1) v = Math.min(v, d[o + gx + 1] + b);
          if (i > 0) v = Math.min(v, d[o + gx - 1] + b);
        }
        d[o] = v;
      }
    return d;
  }

  private sample(f: Float32Array, x: number, z: number): number {
    const fx = (x - this.region.minX) / this.cell;
    const fz = (z - this.region.minZ) / this.cell;
    if (fx < 0 || fz < 0 || fx >= this.gx - 1 || fz >= this.gz - 1) return 1e4;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const o = j * this.gx + i;
    const r0 = f[o] + (f[o + 1] - f[o]) * tx;
    const r1 = f[o + this.gx] + (f[o + this.gx + 1] - f[o + this.gx]) * tx;
    return r0 + (r1 - r0) * tz;
  }

  /** Approximate distance to the nearest trail centreline (large outside the region). */
  dist(x: number, z: number): number {
    return this.sample(this.all, x, z);
  }

  /** Approximate distance to the nearest side-line centreline. */
  sideDist(x: number, z: number): number {
    return this.sample(this.side, x, z);
  }

  /** Point on a trail at arc length s (clamped). */
  at(t: Trail, s: number) {
    const f = Math.max(0, Math.min(t.x.length - 1.001, s));
    const i = Math.floor(f);
    const u = f - i;
    return { x: t.x[i] + (t.x[i + 1] - t.x[i]) * u, z: t.z[i] + (t.z[i + 1] - t.z[i]) * u, heading: t.heading[i] };
  }
}
