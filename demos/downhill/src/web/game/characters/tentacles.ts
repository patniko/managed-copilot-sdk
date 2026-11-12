import * as THREE from 'three';

/**
 * Several smooth, tapered tubes in ONE dynamic geometry (one draw call).
 * Each frame: write centreline points / radii, then call `rebuild()`. No per-frame allocation.
 */
export class TentacleBundle {
  readonly mesh: THREE.Mesh;
  /** Per tentacle: (segs + 1) * 3 floats, root first. */
  readonly points: Float32Array[] = [];
  /** Per tentacle: (segs + 1) radii. */
  readonly radii: Float32Array[] = [];

  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly nrmAttr: THREE.BufferAttribute;
  private readonly vertsPer: number;
  private readonly cosT: Float32Array;
  private readonly sinT: Float32Array;

  constructor(
    readonly count: number,
    readonly segs: number,
    readonly radial: number,
    material: THREE.Material,
    rootColor: THREE.ColorRepresentation,
    tipColor: THREE.ColorRepresentation,
  ) {
    const rings = segs + 1;
    this.vertsPer = rings * radial + 1;
    const nV = this.vertsPer * count;
    this.pos = new Float32Array(nV * 3);
    this.nrm = new Float32Array(nV * 3);
    const col = new Float32Array(nV * 3);
    const idx: number[] = [];
    const c0 = new THREE.Color(rootColor);
    const c1 = new THREE.Color(tipColor);
    const c = new THREE.Color();
    for (let t = 0; t < count; t++) {
      const base = t * this.vertsPer;
      for (let i = 0; i < segs; i++) {
        for (let j = 0; j < radial; j++) {
          const a = base + i * radial + j;
          const b = base + i * radial + ((j + 1) % radial);
          idx.push(a, b, a + radial, b, b + radial, a + radial);
        }
      }
      const last = base + segs * radial;
      const tip = base + rings * radial;
      for (let j = 0; j < radial; j++) idx.push(last + j, last + ((j + 1) % radial), tip);
      for (let i = 0; i <= rings; i++) {
        c.copy(c0).lerp(c1, Math.min(1, i / segs) ** 1.5);
        const n = i === rings ? 1 : radial;
        const off = i === rings ? tip : base + i * radial;
        for (let j = 0; j < n; j++) {
          col[(off + j) * 3] = c.r;
          col[(off + j) * 3 + 1] = c.g;
          col[(off + j) * 3 + 2] = c.b;
        }
      }
      this.points.push(new Float32Array(rings * 3));
      this.radii.push(new Float32Array(rings));
    }
    this.cosT = new Float32Array(radial);
    this.sinT = new Float32Array(radial);
    for (let j = 0; j < radial; j++) {
      this.cosT[j] = Math.cos((j / radial) * Math.PI * 2);
      this.sinT[j] = Math.sin((j / radial) * Math.PI * 2);
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr = new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.nrmAttr);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 3);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
  }

  /** Rebuild all tube vertices from the current centrelines (parallel-transport frames). */
  rebuild(): void {
    const R = this.radial;
    const segs = this.segs;
    const pos = this.pos;
    const nrm = this.nrm;
    for (let t = 0; t < this.count; t++) {
      const P = this.points[t];
      const rad = this.radii[t];
      const base = t * this.vertsPer;
      // initial normal perpendicular to the first tangent
      let tx = P[3] - P[0];
      let ty = P[4] - P[1];
      let tz = P[5] - P[2];
      let l = Math.hypot(tx, ty, tz) || 1;
      tx /= l;
      ty /= l;
      tz /= l;
      let nx: number;
      let ny: number;
      let nz: number;
      if (Math.abs(tx) < 0.9) {
        nx = 1 - tx * tx;
        ny = -tx * ty;
        nz = -tx * tz;
      } else {
        nx = -ty * tx;
        ny = 1 - ty * ty;
        nz = -ty * tz;
      }
      l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      for (let i = 0; i <= segs; i++) {
        const i0 = i > 0 ? i - 1 : 0;
        const i1 = i < segs ? i + 1 : segs;
        tx = P[i1 * 3] - P[i0 * 3];
        ty = P[i1 * 3 + 1] - P[i0 * 3 + 1];
        tz = P[i1 * 3 + 2] - P[i0 * 3 + 2];
        l = Math.hypot(tx, ty, tz) || 1;
        tx /= l;
        ty /= l;
        tz /= l;
        // transport the normal
        const d = nx * tx + ny * ty + nz * tz;
        let mx = nx - tx * d;
        let my = ny - ty * d;
        let mz = nz - tz * d;
        l = Math.hypot(mx, my, mz);
        if (l < 1e-5) {
          // tangent flipped onto the normal: pick a fresh perpendicular
          if (Math.abs(tx) < 0.9) {
            mx = 1 - tx * tx;
            my = -tx * ty;
            mz = -tx * tz;
          } else {
            mx = -ty * tx;
            my = 1 - ty * ty;
            mz = -ty * tz;
          }
          l = Math.hypot(mx, my, mz) || 1;
        }
        nx = mx / l;
        ny = my / l;
        nz = mz / l;
        const bx = ty * nz - tz * ny;
        const by = tz * nx - tx * nz;
        const bz = tx * ny - ty * nx;
        const px = P[i * 3];
        const py = P[i * 3 + 1];
        const pz = P[i * 3 + 2];
        const r = rad[i];
        for (let j = 0; j < R; j++) {
          const c = this.cosT[j];
          const s = this.sinT[j];
          const ex = c * nx + s * bx;
          const ey = c * ny + s * by;
          const ez = c * nz + s * bz;
          const o = (base + i * R + j) * 3;
          nrm[o] = ex;
          nrm[o + 1] = ey;
          nrm[o + 2] = ez;
          pos[o] = px + ex * r;
          pos[o + 1] = py + ey * r;
          pos[o + 2] = pz + ez * r;
        }
        if (i === segs) {
          const o = (base + (segs + 1) * R) * 3;
          nrm[o] = tx;
          nrm[o + 1] = ty;
          nrm[o + 2] = tz;
          pos[o] = px + tx * r * 0.9;
          pos[o + 1] = py + ty * r * 0.9;
          pos[o + 2] = pz + tz * r * 0.9;
        }
      }
    }
    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
  }
}
