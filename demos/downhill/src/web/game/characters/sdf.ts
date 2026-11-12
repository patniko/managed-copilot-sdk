import * as THREE from 'three';

/**
 * Small signed-distance-field toolkit used to sculpt organic character meshes procedurally
 * (continuous skinned bodies, curly hair, shoes). Shapes are unions of smooth primitives that are
 * meshed once with narrow-band naive surface nets and refined onto the exact surface.
 */

/** Signed distance in a primitive's local frame (negative inside). */
export type LocalSdf = (x: number, y: number, z: number) => number;

/** Polynomial smooth minimum; `k` is the blend radius in metres. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
}

/** Polynomial smooth maximum (smooth subtraction / intersection helper). */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/* ------------------------------------------------------------------ primitives */

export function sdSphere(cx: number, cy: number, cz: number, r: number): LocalSdf {
  return (x, y, z) => {
    const dx = x - cx,
      dy = y - cy,
      dz = z - cz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
  };
}

/** Axis-aligned ellipsoid (IQ's bound-friendly approximation). */
export function sdEllipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): LocalSdf {
  const ix = 1 / rx,
    iy = 1 / ry,
    iz = 1 / rz;
  const ix2 = ix * ix,
    iy2 = iy * iy,
    iz2 = iz * iz;
  const rmin = Math.min(rx, ry, rz);
  return (x, y, z) => {
    const px = x - cx,
      py = y - cy,
      pz = z - cz;
    const ax = px * ix,
      ay = py * iy,
      az = pz * iz;
    const bx = px * ix2,
      by = py * iy2,
      bz = pz * iz2;
    const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
    const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
    if (k1 < 1e-9) return -rmin;
    return (k0 * (k0 - 1)) / k1;
  };
}

/** Capsule with different end radii between a and b (IQ's exact round cone). */
export function sdRoundCone(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r1: number,
  r2: number,
): LocalSdf {
  const bax = bx - ax,
    bay = by - ay,
    baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  if (l2 < 1e-12) return sdSphere(ax, ay, az, Math.max(r1, r2));
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  return (x, y, z) => {
    const pax = x - ax,
      pay = y - ay,
      paz = z - az;
    const yy = pax * bax + pay * bay + paz * baz;
    const zz = yy - l2;
    const qx = pax * l2 - bax * yy,
      qy = pay * l2 - bay * yy,
      qz = paz * l2 - baz * yy;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = yy * yy * l2;
    const z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
}

export function sdCapsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): LocalSdf {
  const bax = bx - ax,
    bay = by - ay,
    baz = bz - az;
  const il2 = 1 / Math.max(1e-12, bax * bax + bay * bay + baz * baz);
  return (x, y, z) => {
    const pax = x - ax,
      pay = y - ay,
      paz = z - az;
    let h = (pax * bax + pay * bay + paz * baz) * il2;
    h = h < 0 ? 0 : h > 1 ? 1 : h;
    const qx = pax - bax * h,
      qy = pay - bay * h,
      qz = paz - baz * h;
    return Math.sqrt(qx * qx + qy * qy + qz * qz) - r;
  };
}

/** Rounded box centred at c with half extents h (corner radius r). */
export function sdRoundBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, r: number): LocalSdf {
  return (x, y, z) => {
    const qx = Math.abs(x - cx) - hx + r,
      qy = Math.abs(y - cy) - hy + r,
      qz = Math.abs(z - cz) - hz + r;
    const ox = qx > 0 ? qx : 0,
      oy = qy > 0 ? qy : 0,
      oz = qz > 0 ? qz : 0;
    const inner = Math.min(Math.max(qx, qy, qz), 0);
    return Math.sqrt(ox * ox + oy * oy + oz * oz) + inner - r;
  };
}

/** Wrap a primitive with a rigid local transform (rotation about / translation to `pos`). */
export function transformed(f: LocalSdf, pos: THREE.Vector3, rot: THREE.Euler | THREE.Quaternion): LocalSdf {
  const q = rot instanceof THREE.Quaternion ? rot.clone() : new THREE.Quaternion().setFromEuler(rot);
  const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)).invert();
  const e = m.elements;
  return (x, y, z) =>
    f(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
}

/* ------------------------------------------------------------------ parts */

export interface PrimEntry {
  f: LocalSdf;
  /** Smooth subtraction instead of union. */
  sub?: boolean;
  /** Blend radius with the part so far (defaults to the part's k). */
  k?: number;
}

/**
 * A rigid group of primitives authored in a bone's local frame. `toLocal` maps bind space -> local.
 */
export class SdfPart {
  readonly prims: PrimEntry[] = [];
  readonly toLocal = new THREE.Matrix4();
  readonly toBind = new THREE.Matrix4();
  /** Bind-space AABB of the part (filled by `computeBounds`). */
  readonly bounds = new THREE.Box3();
  private e!: Float64Array;

  constructor(
    readonly name: string,
    /** Index of the skeleton bone this part rides on. */
    readonly bone: number,
    toBind: THREE.Matrix4,
    /** Default smooth-union radius between the part's primitives. */
    readonly k: number,
  ) {
    this.toBind.copy(toBind);
    this.toLocal.copy(toBind).invert();
    this.e = Float64Array.from(this.toLocal.elements);
  }

  add(f: LocalSdf, opts: { sub?: boolean; k?: number } = {}): this {
    this.prims.push({ f, sub: opts.sub, k: opts.k });
    return this;
  }

  /** Distance at a local-frame point. */
  evalLocal(x: number, y: number, z: number): number {
    const P = this.prims;
    let d = P[0].f(x, y, z);
    for (let i = 1; i < P.length; i++) {
      const p = P[i];
      const di = p.f(x, y, z);
      d = p.sub ? smax(d, -di, p.k ?? this.k) : smin(d, di, p.k ?? this.k);
    }
    return d;
  }

  /** Distance at a bind-space point. */
  eval(x: number, y: number, z: number): number {
    const e = this.e;
    return this.evalLocal(
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14],
    );
  }

  /** Bind -> local into `out`. */
  local(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = this.e;
    return out.set(
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14],
    );
  }

  /** Estimate the bind-space bounds by sampling a local box known to contain the part. */
  computeBounds(localMin: THREE.Vector3, localMax: THREE.Vector3): void {
    const b = this.bounds.makeEmpty();
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? localMax.x : localMin.x, i & 2 ? localMax.y : localMin.y, i & 4 ? localMax.z : localMin.z).applyMatrix4(this.toBind);
      b.expandByPoint(v);
    }
  }
}

/** Distance from a point to an AABB (0 inside). */
function boxDist(b: THREE.Box3, x: number, y: number, z: number): number {
  const dx = Math.max(b.min.x - x, 0, x - b.max.x);
  const dy = Math.max(b.min.y - y, 0, y - b.max.y);
  const dz = Math.max(b.min.z - z, 0, z - b.max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Union of parts. Adjacent parts are blended pairwise through `joints` (so e.g. a thigh blends into the
 * pelvis but never webs onto the belly), everything else is a hard union.
 */
export class SdfModel {
  readonly parts: SdfPart[] = [];
  readonly joints: Array<{ a: number; b: number; k: number }> = [];
  /** Parts further than this from a point are not evaluated (their box distance is used). */
  cull = 0.07;
  private readonly dist: Float64Array;

  constructor(parts: SdfPart[], joints: Array<[string, string, number]>) {
    this.parts.push(...parts);
    const idx = (n: string) => {
      const i = parts.findIndex((p) => p.name === n);
      if (i < 0) throw new Error(`[sdf] unknown part ${n}`);
      return i;
    };
    for (const [a, b, k] of joints) this.joints.push({ a: idx(a), b: idx(b), k });
    this.dist = new Float64Array(parts.length);
  }

  /** Per-part distances at a bind-space point (written into `out`), returns the model distance. */
  evalParts(x: number, y: number, z: number, out: Float64Array = this.dist): number {
    const P = this.parts;
    let d = Infinity;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      const bd = boxDist(p.bounds, x, y, z);
      const di = bd > this.cull ? bd : p.eval(x, y, z);
      out[i] = di;
      if (di < d) d = di;
    }
    for (const j of this.joints) {
      const s = smin(out[j.a], out[j.b], j.k);
      if (s < d) d = s;
    }
    return d;
  }

  eval(x: number, y: number, z: number): number {
    return this.evalParts(x, y, z);
  }

  bounds(pad: number): THREE.Box3 {
    const b = new THREE.Box3();
    for (const p of this.parts) b.union(p.bounds);
    return b.expandByScalar(pad);
  }
}

/* ------------------------------------------------------------------ meshing */

export interface SdfMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Narrow-band naive surface nets. Evaluates the field on a coarse grid first and only fills fine
 * cells near the surface, then projects vertices onto the exact surface (one Newton step).
 */
export function meshSdf(sdf: (x: number, y: number, z: number) => number, bounds: THREE.Box3, h: number): SdfMesh {
  const C = 4;
  const min = bounds.min;
  const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
  // fine node counts rounded up to a multiple of the coarse step
  const nx = Math.ceil(size.x / h / C) * C + 1;
  const ny = Math.ceil(size.y / h / C) * C + 1;
  const nz = Math.ceil(size.z / h / C) * C + 1;
  const sxy = nx * ny;
  const f = new Float32Array(nx * ny * nz).fill(NaN);
  const at = (i: number, j: number, k: number) => i + j * nx + k * sxy;
  const cx = (nx - 1) / C,
    cy = (ny - 1) / C,
    cz = (nz - 1) / C;
  // coarse nodes
  for (let k = 0; k <= cz; k++)
    for (let j = 0; j <= cy; j++)
      for (let i = 0; i <= cx; i++) {
        const I = i * C,
          J = j * C,
          K = k * C;
        f[at(I, J, K)] = sdf(min.x + I * h, min.y + J * h, min.z + K * h);
      }
  // a coarse cell can only contain surface if a corner is within its diagonal of it (1.15 = safety
  // margin for the not-quite-Lipschitz ellipsoid / smooth-min distances)
  const band = C * h * 0.87 * 1.15;
  const nearCells: number[] = [];
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let near = false;
        let sgn = 0;
        for (let c = 0; c < 8 && !near; c++) {
          const v = f[at((i + (c & 1)) * C, (j + ((c >> 1) & 1)) * C, (k + ((c >> 2) & 1)) * C)];
          if (Math.abs(v) < band) near = true;
          sgn += v < 0 ? 1 : 0;
        }
        if (near || (sgn > 0 && sgn < 8)) nearCells.push(i, j, k);
      }
  // fill fine nodes of near coarse cells
  for (let n = 0; n < nearCells.length; n += 3) {
    const I0 = nearCells[n] * C,
      J0 = nearCells[n + 1] * C,
      K0 = nearCells[n + 2] * C;
    for (let k = K0; k <= K0 + C; k++)
      for (let j = J0; j <= J0 + C; j++)
        for (let i = I0; i <= I0 + C; i++) {
          const id = at(i, j, k);
          if (Number.isNaN(f[id])) f[id] = sdf(min.x + i * h, min.y + j * h, min.z + k * h);
        }
  }

  // one vertex per fine cell straddling the surface
  const cellVert = new Map<number, number>();
  const pos: number[] = [];
  const corner = new Float32Array(8);
  const EDGES = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  for (let n = 0; n < nearCells.length; n += 3) {
    const I0 = nearCells[n] * C,
      J0 = nearCells[n + 1] * C,
      K0 = nearCells[n + 2] * C;
    for (let k = K0; k < K0 + C; k++)
      for (let j = J0; j < J0 + C; j++)
        for (let i = I0; i < I0 + C; i++) {
          let inside = 0;
          let ok = true;
          for (let c = 0; c < 8; c++) {
            const v = f[at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
            if (Number.isNaN(v)) {
              ok = false;
              break;
            }
            corner[c] = v;
            if (v < 0) inside++;
          }
          if (!ok || inside === 0 || inside === 8) continue;
          let ax = 0,
            ay = 0,
            az = 0,
            cnt = 0;
          for (const [e0, e1] of EDGES) {
            const a = corner[e0],
              b = corner[e1];
            if (a < 0 === b < 0) continue;
            const t = a / (a - b);
            const x0 = e0 & 1,
              y0 = (e0 >> 1) & 1,
              z0 = (e0 >> 2) & 1;
            const x1 = e1 & 1,
              y1 = (e1 >> 1) & 1,
              z1 = (e1 >> 2) & 1;
            ax += x0 + (x1 - x0) * t;
            ay += y0 + (y1 - y0) * t;
            az += z0 + (z1 - z0) * t;
            cnt++;
          }
          cellVert.set(at(i, j, k), pos.length / 3);
          pos.push(min.x + (i + ax / cnt) * h, min.y + (j + ay / cnt) * h, min.z + (k + az / cnt) * h);
        }
  }

  // quads across every fine edge with a sign change. Each quad's cell cycle winds counter-clockwise
  // about the +axis direction, so it faces +axis when the edge's lower node is inside (the outward side
  // is towards the upper node) and is reversed otherwise: consistent outward winding by construction.
  // Quads are triangulated after the vertices are projected (see below).
  const quads: number[] = [];
  const quad = (c0: number, c1: number, c2: number, c3: number, lowerInside: boolean) => {
    const a = cellVert.get(c0),
      b = cellVert.get(c1),
      c = cellVert.get(c2),
      d = cellVert.get(c3);
    if (a === undefined || b === undefined || c === undefined || d === undefined) return;
    if (lowerInside) quads.push(a, b, c, d);
    else quads.push(a, d, c, b);
  };
  for (const [key] of cellVert) {
    const i = key % nx;
    const j = Math.floor(key / nx) % ny;
    const k = Math.floor(key / sxy);
    // each sign-changing edge is visited once: from the cell whose max corner it starts at
    const ii = i + 1,
      jj = j + 1,
      kk = k + 1;
    // x-edge from (i, jj, kk) to (ii, jj, kk): shared by cells (i, j..jj, k..kk)
    if (jj < ny - 1 && kk < nz - 1) {
      const a = f[at(i, jj, kk)],
        b = f[at(ii, jj, kk)];
      if (!Number.isNaN(a) && !Number.isNaN(b) && a < 0 !== b < 0)
        quad(at(i, j, k), at(i, jj, k), at(i, jj, kk), at(i, j, kk), a < 0);
    }
    // y-edge from (ii, j, kk) to (ii, jj, kk): shared by cells (i..ii, j, k..kk)
    if (ii < nx - 1 && kk < nz - 1) {
      const a = f[at(ii, j, kk)],
        b = f[at(ii, jj, kk)];
      if (!Number.isNaN(a) && !Number.isNaN(b) && a < 0 !== b < 0)
        quad(at(i, j, k), at(i, j, kk), at(ii, j, kk), at(ii, j, k), a < 0);
    }
    // z-edge from (ii, jj, k) to (ii, jj, kk): shared by cells (i..ii, j..jj, k)
    if (ii < nx - 1 && jj < ny - 1) {
      const a = f[at(ii, jj, k)],
        b = f[at(ii, jj, kk)];
      if (!Number.isNaN(a) && !Number.isNaN(b) && a < 0 !== b < 0)
        quad(at(i, j, k), at(ii, j, k), at(ii, jj, k), at(i, jj, k), a < 0);
    }
  }

  // project onto the exact surface and take normals from the field gradient (tetrahedral 4-tap
  // gradients: the average of the four taps doubles as the distance estimate)
  const nv = pos.length / 3;
  const positions = new Float32Array(pos);
  const normals = new Float32Array(nv * 3);
  const e = h * 0.3;
  const grad = (x: number, y: number, z: number, out: Float64Array) => {
    const a = sdf(x + e, y - e, z - e),
      b = sdf(x - e, y - e, z + e),
      c = sdf(x - e, y + e, z - e),
      d = sdf(x + e, y + e, z + e);
    out[0] = a - b - c + d;
    out[1] = -a - b + c + d;
    out[2] = -a + b - c + d;
    out[3] = (a + b + c + d) * 0.25;
  };
  const g = new Float64Array(4);
  for (let v = 0; v < nv; v++) {
    let x = positions[v * 3],
      y = positions[v * 3 + 1],
      z = positions[v * 3 + 2];
    for (let it = 0; it < 2; it++) {
      grad(x, y, z, g);
      // |grad| of the 4-tap stencil is 4e for a unit-gradient field
      const gl = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
      if (gl < 1e-9) break;
      const s = Math.max(-h * 0.6, Math.min(h * 0.6, g[3] * ((4 * e) / gl))) / gl;
      x -= g[0] * s;
      y -= g[1] * s;
      z -= g[2] * s;
    }
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    grad(x, y, z, g);
    const l = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) || 1;
    normals[v * 3] = g[0] / l;
    normals[v * 3 + 1] = g[1] / l;
    normals[v * 3 + 2] = g[2] / l;
  }
  // split each (oriented) quad along the diagonal whose two triangles agree best with the surface
  // normal; the other split of a skewed quad folds one triangle inwards
  const indices = new Uint32Array((quads.length / 4) * 6);
  const P = positions;
  const N = normals;
  /** Cosine between triangle (a, b, c)'s face normal and its averaged vertex normal. */
  const agree = (a: number, b: number, c: number) => {
    const e1x = P[b * 3] - P[a * 3],
      e1y = P[b * 3 + 1] - P[a * 3 + 1],
      e1z = P[b * 3 + 2] - P[a * 3 + 2];
    const e2x = P[c * 3] - P[a * 3],
      e2y = P[c * 3 + 1] - P[a * 3 + 1],
      e2z = P[c * 3 + 2] - P[a * 3 + 2];
    const fx = e1y * e2z - e1z * e2y,
      fy = e1z * e2x - e1x * e2z,
      fz = e1x * e2y - e1y * e2x;
    const nx = N[a * 3] + N[b * 3] + N[c * 3],
      ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1],
      nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    return (fx * nx + fy * ny + fz * nz) / (Math.sqrt(fx * fx + fy * fy + fz * fz) * Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
  };
  for (let q = 0, t = 0; q < quads.length; q += 4, t += 6) {
    const a = quads[q],
      b = quads[q + 1],
      c = quads[q + 2],
      d = quads[q + 3];
    if (Math.min(agree(a, b, c), agree(a, c, d)) >= Math.min(agree(a, b, d), agree(b, c, d))) {
      indices.set([a, b, c, a, c, d], t);
    } else {
      indices.set([a, b, d, b, c, d], t);
    }
  }
  return { positions, normals, indices };
}

/** Ambient occlusion from the field (IQ): darker where other surfaces are close along the normal. */
export function sdfOcclusion(
  sdf: (x: number, y: number, z: number) => number,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  scale = 0.012,
): number {
  let occ = 0;
  let w = 1;
  for (let i = 1; i <= 5; i++) {
    const hh = scale * i;
    const d = sdf(x + nx * hh, y + ny * hh, z + nz * hh);
    occ += (hh - d) * w;
    w *= 0.6;
  }
  return Math.max(0, Math.min(1, 1 - (occ / scale) * 0.32));
}

/** Vertex adjacency (unique neighbours) of an indexed triangle mesh. */
export function adjacency(nv: number, indices: Uint32Array): Int32Array[] {
  const sets: Array<Set<number>> = Array.from({ length: nv }, () => new Set<number>());
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t],
      b = indices[t + 1],
      c = indices[t + 2];
    sets[a].add(b).add(c);
    sets[b].add(a).add(c);
    sets[c].add(a).add(b);
  }
  return sets.map((s) => Int32Array.from(s));
}
