import { smoothstep, clamp } from '../core/math';
import type { TerrainSpec } from './types';

/** One trail polyline sample: position, profile height, half width and bank (tan of bank angle, + = right turn). */
export interface TrailPointArrays {
  x: Float32Array;
  z: Float32Array;
  h: Float32Array;
  hw: Float32Array;
  bank: Float32Array;
}

/**
 * Heightfield for the rideable region. Heights are sampled with a cubic B-spline so the
 * ground (and therefore physics + rendering) is C2-smooth regardless of the grid resolution.
 */
export class TerrainData {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  readonly h: Float32Array;
  /** Signed distance (m) to the nearest trail edge; negative on the trail. Large when far. */
  readonly trailDist: Float32Array;

  constructor(readonly spec: TerrainSpec) {
    const r = spec.region;
    this.cell = spec.cell;
    this.minX = r.minX;
    this.minZ = r.minZ;
    this.maxX = r.maxX;
    this.maxZ = r.maxZ;
    this.nx = Math.round((r.maxX - r.minX) / spec.cell) + 1;
    this.nz = Math.round((r.maxZ - r.minZ) / spec.cell) + 1;
    this.h = new Float32Array(this.nx * this.nz);
    this.trailDist = new Float32Array(this.nx * this.nz).fill(1e4);
  }

  /** Fill from the spec, blending to the far height near the region border so the backdrop joins seamlessly. */
  fill() {
    const { nx, nz, cell, minX, minZ, maxX, maxZ } = this;
    const spec = this.spec;
    const blend = 90;
    for (let j = 0; j < nz; j++) {
      const z = minZ + j * cell;
      const dz = Math.min(z - minZ, maxZ - z);
      for (let i = 0; i < nx; i++) {
        const x = minX + i * cell;
        const d = Math.min(dz, x - minX, maxX - x);
        const w = smoothstep(0, blend, d);
        const hf = w < 1 ? spec.farHeight(x, z) : 0;
        const hd = w > 0 ? spec.height(x, z) : 0;
        this.h[j * nx + i] = hf + (hd - hf) * w;
      }
    }
  }

  inside(x: number, z: number, margin = 0) {
    return x >= this.minX + margin && x <= this.maxX - margin && z >= this.minZ + margin && z <= this.maxZ - margin;
  }

  private raw(i: number, j: number) {
    i = i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
    j = j < 0 ? 0 : j >= this.nz ? this.nz - 1 : j;
    return this.h[j * this.nx + i];
  }

  /** Smooth height (cubic B-spline). Outside the region falls back to the far height. */
  heightAt(x: number, z: number): number {
    const gx = (x - this.minX) / this.cell;
    const gz = (z - this.minZ) / this.cell;
    if (gx < 1 || gz < 1 || gx > this.nx - 2 || gz > this.nz - 2) {
      if (gx < 0 || gz < 0 || gx > this.nx - 1 || gz > this.nz - 1) return this.spec.farHeight(x, z);
    }
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const tx = gx - i;
    const tz = gz - j;
    const ax0 = bs0(tx),
      ax1 = bs1(tx),
      ax2 = bs2(tx),
      ax3 = bs3(tx);
    const az0 = bs0(tz),
      az1 = bs1(tz),
      az2 = bs2(tz),
      az3 = bs3(tz);
    const nx = this.nx;
    if (i >= 1 && j >= 1 && i < nx - 2 && j < this.nz - 2) {
      const h = this.h;
      let o = (j - 1) * nx + (i - 1);
      const r0 = ax0 * h[o] + ax1 * h[o + 1] + ax2 * h[o + 2] + ax3 * h[o + 3];
      o += nx;
      const r1 = ax0 * h[o] + ax1 * h[o + 1] + ax2 * h[o + 2] + ax3 * h[o + 3];
      o += nx;
      const r2 = ax0 * h[o] + ax1 * h[o + 1] + ax2 * h[o + 2] + ax3 * h[o + 3];
      o += nx;
      const r3 = ax0 * h[o] + ax1 * h[o + 1] + ax2 * h[o + 2] + ax3 * h[o + 3];
      return az0 * r0 + az1 * r1 + az2 * r2 + az3 * r3;
    }
    let sum = 0;
    const az = [az0, az1, az2, az3];
    const ax = [ax0, ax1, ax2, ax3];
    for (let b = 0; b < 4; b++) {
      let row = 0;
      for (let a = 0; a < 4; a++) row += ax[a] * this.raw(i - 1 + a, j - 1 + b);
      sum += az[b] * row;
    }
    return sum;
  }

  /** Writes the unit normal into out (x,y,z). */
  normalAt(x: number, z: number, out: { x: number; y: number; z: number }, e = 0.5) {
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -hx,
      ny = 2 * e,
      nz = -hz;
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l;
    out.y = ny / l;
    out.z = nz / l;
    return out;
  }

  /** Bilinear trail distance. */
  trailDistAt(x: number, z: number): number {
    const gx = (x - this.minX) / this.cell;
    const gz = (z - this.minZ) / this.cell;
    if (gx < 0 || gz < 0 || gx >= this.nx - 1 || gz >= this.nz - 1) return 1e4;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const tx = gx - i;
    const tz = gz - j;
    const o = j * this.nx + i;
    const d = this.trailDist;
    const a = d[o] + (d[o + 1] - d[o]) * tx;
    const b = d[o + this.nx] + (d[o + this.nx + 1] - d[o + this.nx]) * tx;
    return a + (b - a) * tz;
  }

  /**
   * Carve trails into the heightfield: flatten across the trail width (with berm banking in turns)
   * and blend smoothly back to the natural ground.
   */
  carve(trails: TrailPointArrays[], falloff = 9) {
    const { nx, nz, cell, minX, minZ } = this;
    const n = nx * nz;
    const bestD = new Float32Array(n).fill(1e9);
    const bestLat = new Float32Array(n);
    const bestH = new Float32Array(n);
    const bestHW = new Float32Array(n);
    const bestBank = new Float32Array(n);
    for (const t of trails) {
      const count = t.x.length;
      for (let k = 0; k < count - 1; k++) {
        const ax = t.x[k],
          az = t.z[k],
          bx = t.x[k + 1],
          bz = t.z[k + 1];
        const hwMax = Math.max(t.hw[k], t.hw[k + 1]);
        const R = hwMax + falloff + 1;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - minX) / cell));
        const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + R - minX) / cell));
        const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R - minZ) / cell));
        const j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz) + R - minZ) / cell));
        const sx = bx - ax,
          sz = bz - az;
        const len2 = sx * sx + sz * sz || 1e-6;
        const len = Math.sqrt(len2);
        for (let j = j0; j <= j1; j++) {
          const z = minZ + j * cell;
          for (let i = i0; i <= i1; i++) {
            const x = minX + i * cell;
            let u = ((x - ax) * sx + (z - az) * sz) / len2;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const px = ax + sx * u,
              pz = az + sz * u;
            const dx = x - px,
              dz = z - pz;
            const d = Math.sqrt(dx * dx + dz * dz);
            const o = j * nx + i;
            if (d < bestD[o]) {
              bestD[o] = d;
              // right-hand normal of direction (sx,sz) heading -Z: right = (-sz, sx)/len  -> for dir (0,-1): (1,0)
              bestLat[o] = (dx * -sz + dz * sx) / len;
              bestH[o] = t.h[k] + (t.h[k + 1] - t.h[k]) * u;
              bestHW[o] = t.hw[k] + (t.hw[k + 1] - t.hw[k]) * u;
              bestBank[o] = t.bank[k] + (t.bank[k + 1] - t.bank[k]) * u;
            }
          }
        }
      }
    }
    for (let o = 0; o < n; o++) {
      const d = bestD[o];
      if (d > 1e8) continue;
      const hw = bestHW[o];
      this.trailDist[o] = d - hw;
      if (d > hw + falloff) continue;
      const lat = clamp(bestLat[o], -(hw + 2.5), hw + 2.5);
      const target = bestH[o] - bestBank[o] * lat;
      const w = 1 - smoothstep(hw + 0.4, hw + falloff, d);
      this.h[o] += (target - this.h[o]) * w;
    }
  }
}

function bs0(t: number) {
  const u = 1 - t;
  return (u * u * u) / 6;
}
function bs1(t: number) {
  return (3 * t * t * t - 6 * t * t + 4) / 6;
}
function bs2(t: number) {
  return (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6;
}
function bs3(t: number) {
  return (t * t * t) / 6;
}
