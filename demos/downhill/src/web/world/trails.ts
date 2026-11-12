import { clamp, smoothstep, wrapAngle } from '../core/math';
import { Rng } from '../core/rng';
import type { TerrainData, TrailPointArrays } from './terrain';
import type { CourseSpec } from './types';

export type TrailKind = 'main' | 'pro' | 'flow';

export interface Trail extends TrailPointArrays {
  id: number;
  kind: TrailKind;
  /** Arc length at each sample (1 m spacing). */
  s: Float32Array;
  /** Heading at each sample (0 = -Z, + = toward +X). */
  heading: Float32Array;
  length: number;
}

export interface TrailHit {
  trail: Trail;
  index: number;
  /** Arc length position. */
  s: number;
  /** Signed lateral offset (+ = right of travel direction). */
  lat: number;
  /** Distance from the centreline. */
  dist: number;
}

const SPACING = 1;

/** Resample a dense polyline to fixed arc-length spacing. */
function resample(px: number[], pz: number[], spacing: number) {
  const outX: number[] = [px[0]];
  const outZ: number[] = [pz[0]];
  let carry = 0;
  for (let i = 0; i < px.length - 1; i++) {
    const dx = px[i + 1] - px[i];
    const dz = pz[i + 1] - pz[i];
    const segLen = Math.hypot(dx, dz);
    let pos = spacing - carry;
    while (pos <= segLen) {
      const t = pos / segLen;
      outX.push(px[i] + dx * t);
      outZ.push(pz[i] + dz * t);
      pos += spacing;
    }
    carry = segLen - (pos - spacing);
  }
  return { x: outX, z: outZ };
}

function gaussianSmooth(src: Float32Array, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const w: number[] = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    let s = 0,
      ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = clamp(i + k, 0, src.length - 1);
      s += src[j] * w[k + r];
      ws += w[k + r];
    }
    out[i] = s / ws;
  }
  return out;
}

function buildTrail(id: number, kind: TrailKind, xs: number[], zs: number[], terrain: TerrainData, baseHalfWidth: number): Trail {
  const rs = resample(xs, zs, SPACING);
  const n = rs.x.length;
  const x = new Float32Array(rs.x);
  const z = new Float32Array(rs.z);
  const s = new Float32Array(n);
  const heading = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s[i] = i * SPACING;
    const a = Math.max(0, i - 2);
    const b = Math.min(n - 1, i + 2);
    heading[i] = Math.atan2(x[b] - x[a], -(z[b] - z[a]));
  }
  // profile: smoothed ground, then limit climbs so the line always flows downhill
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = terrain.heightAt(x[i], z[i]);
  let h = gaussianSmooth(raw, 9);
  for (let i = 1; i < n; i++) h[i] = Math.min(h[i], h[i - 1] + 0.025);
  h = gaussianSmooth(h, 3);
  for (let i = 0; i < n; i++) h[i] -= 0.12;
  // banking from curvature
  const bank = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 4);
    const b = Math.min(n - 1, i + 4);
    const k = wrapAngle(heading[b] - heading[a]) / Math.max(1, s[b] - s[a]);
    const v = 12;
    const tanB = (k * v * v) / 9.81;
    bank[i] = Math.abs(k) > 1 / 70 ? clamp(tanB, -0.55, 0.55) : 0;
  }
  const bankS = gaussianSmooth(bank, 4);
  const hw = new Float32Array(n).fill(baseHalfWidth);
  return { id, kind, x, z, h, hw, bank: bankS, s, heading, length: (n - 1) * SPACING };
}

export class TrailNetwork {
  trails: Trail[] = [];
  private grid = new Map<number, Array<[number, number]>>();
  private gridCell = 16;

  get main(): Trail {
    return this.trails[0];
  }

  static generate(course: CourseSpec, terrain: TerrainData, seed: number): TrailNetwork {
    const net = new TrailNetwork();
    const rng = new Rng(seed ^ 0x5eed);
    const { start, meander, wavelengths, length } = course;
    const minX = course.xRange ? course.xRange[0] : terrain.minX + course.marginX;
    const maxX = course.xRange ? course.xRange[1] : terrain.maxX - course.marginX;
    const ph = [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)];
    const amp = [0.55, 0.3, 0.15];
    const centre = course.centerline ? (zz: number) => clamp(course.centerline!(zz), minX, maxX) : (zz: number) => {
      const d = start.z - zz;
      const ramp = smoothstep(0, 70, d);
      let off = 0;
      for (let k = 0; k < 3; k++) off += amp[k] * Math.sin((d / wavelengths[k]) * Math.PI * 2 + ph[k]) - amp[k] * Math.sin(ph[k]);
      return clamp(start.x + off * meander * ramp, minX, maxX);
    };
    // main line: integrate along -Z until we reach the target arc length
    const xs: number[] = [];
    const zs: number[] = [];
    let arc = 0;
    let zz = start.z;
    let px = centre(zz);
    xs.push(px);
    zs.push(zz);
    const zMin = terrain.minZ + 140;
    while (arc < length && zz > zMin) {
      zz -= 0.5;
      const nx = centre(zz);
      arc += Math.hypot(nx - px, 0.5);
      px = nx;
      xs.push(nx);
      zs.push(zz);
    }
    const main = buildTrail(0, 'main', xs, zs, terrain, 0.62);
    net.trails.push(main);

    // side lines branch from and rejoin the main line
    course.sideLines.forEach((sl, idx) => {
      const i0 = clamp(Math.round(sl.from), 0, main.x.length - 1);
      const i1 = clamp(Math.round(sl.to), i0 + 50, main.x.length - 1);
      const sx: number[] = [];
      const sz: number[] = [];
      for (let i = i0; i <= i1; i++) {
        const t = (i - i0) / (i1 - i0);
        const shape = Math.pow(Math.sin(Math.PI * t), 0.6);
        const hd = main.heading[i];
        // lateral offset perpendicular to the main heading
        const ox = Math.cos(hd) * sl.offset * shape;
        const oz = Math.sin(hd) * sl.offset * shape;
        sx.push(clamp(main.x[i] + ox, minX, maxX));
        sz.push(main.z[i] + oz);
      }
      net.trails.push(buildTrail(idx + 1, sl.kind, sx, sz, terrain, sl.kind === 'pro' ? 0.85 : 0.75));
    });
    net.buildIndex();
    return net;
  }

  /** Build the spatial hash used by nearest-trail queries. */
  buildIndex() {
    this.grid.clear();
    const c = this.gridCell;
    for (const t of this.trails) {
      for (let i = 0; i < t.x.length - 1; i++) {
        const minx = Math.min(t.x[i], t.x[i + 1]);
        const maxx = Math.max(t.x[i], t.x[i + 1]);
        const minz = Math.min(t.z[i], t.z[i + 1]);
        const maxz = Math.max(t.z[i], t.z[i + 1]);
        for (let gx = Math.floor(minx / c); gx <= Math.floor(maxx / c); gx++)
          for (let gz = Math.floor(minz / c); gz <= Math.floor(maxz / c); gz++) {
            const key = gx * 73856093 + gz * 19349663;
            let arr = this.grid.get(key);
            if (!arr) this.grid.set(key, (arr = []));
            arr.push([t.id, i]);
          }
      }
    }
  }

  /** Nearest point on any trail within `radius` metres (or null). */
  nearest(x: number, z: number, radius = 24, filter?: (t: Trail) => boolean): TrailHit | null {
    const c = this.gridCell;
    const r = Math.ceil(radius / c);
    const gx0 = Math.floor(x / c);
    const gz0 = Math.floor(z / c);
    let best: TrailHit | null = null;
    let bestD = radius;
    for (let gx = gx0 - r; gx <= gx0 + r; gx++)
      for (let gz = gz0 - r; gz <= gz0 + r; gz++) {
        const arr = this.grid.get(gx * 73856093 + gz * 19349663);
        if (!arr) continue;
        for (const [tid, i] of arr) {
          const t = this.trails[tid];
          if (filter && !filter(t)) continue;
          const ax = t.x[i],
            az = t.z[i];
          const sx = t.x[i + 1] - ax,
            sz = t.z[i + 1] - az;
          const len2 = sx * sx + sz * sz || 1e-6;
          let u = ((x - ax) * sx + (z - az) * sz) / len2;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const dx = x - (ax + sx * u);
          const dz = z - (az + sz * u);
          const d = Math.hypot(dx, dz);
          if (d < bestD) {
            bestD = d;
            const len = Math.sqrt(len2);
            best = { trail: t, index: i, s: t.s[i] + u * SPACING, lat: (dx * -sz + dz * sx) / len, dist: d };
          }
        }
      }
    return best;
  }

  /** Interpolated sample along a trail at arc length s. */
  sample(t: Trail, s: number) {
    const f = clamp(s / SPACING, 0, t.x.length - 1.001);
    const i = Math.floor(f);
    const u = f - i;
    return {
      x: t.x[i] + (t.x[i + 1] - t.x[i]) * u,
      z: t.z[i] + (t.z[i + 1] - t.z[i]) * u,
      h: t.h[i] + (t.h[i + 1] - t.h[i]) * u,
      heading: t.heading[i] + wrapAngle(t.heading[i + 1] - t.heading[i]) * u,
      hw: t.hw[i] + (t.hw[i + 1] - t.hw[i]) * u,
    };
  }
}
