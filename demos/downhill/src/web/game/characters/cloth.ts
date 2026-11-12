import * as THREE from 'three';

/** Capsule collider riding on a bone, authored in bind space. */
export interface ClothCollider {
  bone: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
}

/** Everything needed to build a cloth piece (all positions in the rig's bind space). */
export interface ClothBuild {
  /** Rest positions, n*3. */
  rest: Float32Array;
  /** Four bone indices + weights per particle (linear blend skinning of the pin targets). */
  bones: Uint8Array;
  weights: Float32Array;
  /** Max distance from the skinned target (m); 0 pins the particle. */
  maxDist: Float32Array;
  /**
   * Rest-pose outward normal (bind space, n*3) and backstop: the particle may not move further than
   * `backstop` metres behind its target along the skinned normal (keeps it outside the body). NaN = off.
   */
  restNormal: Float32Array;
  backstop: Float32Array;
  /**
   * 0..1 per particle: blend the rendered normal towards the skinned body normal. Used where the cloth
   * emerges from the body so the seam between body and cloth shades identically (no visible edge).
   */
  normalBlend: Float32Array;
  /** Per particle: [u around, v along] for travelling flutter waves, and flutter strength. */
  wave: Float32Array;
  flutter: Float32Array;
  /** Distance constraints: pairs of particle indices, rest lengths, stretch / compression stiffness. */
  edges: Uint32Array;
  restLen: Float32Array;
  stretch: Float32Array;
  compress: Float32Array;
  /** Render triangles (outward-facing winding) and per-vertex colours (linear). */
  index: Uint32Array;
  colors: Float32Array;
  colliders: ClothCollider[];
}

export interface ClothTuning {
  /** Pressure coefficient: acceleration = k * (v_rel . n)|v_rel . n| along the normal. */
  aero: number;
  /** Turbulent flutter acceleration per (m/s)^2 of relative wind. */
  turbulence: number;
  /** Slow, large-scale billow acceleration per (m/s)^2 of relative wind. */
  billow: number;
  /** Relative-velocity damping (1/s). */
  damping: number;
  /** Gentle pull back towards the skinned rest shape (1/s); keeps the drape from drifting. */
  pull: number;
  iterations: number;
}

const GRAV = -9.81;
/** Sub-step limit: one PBD step per 60 Hz frame is plenty for a shirt (and keeps it well under a millisecond). */
const MAX_SUBSTEP = 1 / 55;

/**
 * Position-based cloth simulated in world space (so real inertia, gravity and wind act on it).
 * Particles are tethered to linear-blend-skinned targets on the body with per-particle max
 * distances, pushed out of bone-attached capsules, and rendered as a child of the rig root.
 */
export class Cloth {
  readonly mesh: THREE.Mesh;
  readonly tuning: ClothTuning = { aero: 0.05, turbulence: 0.13, billow: 0.03, damping: 2.0, pull: 1.2, iterations: 4 };
  private readonly n: number;
  private readonly x: Float64Array;
  private readonly v: Float64Array;
  private readonly xp: Float64Array;
  private readonly t0: Float64Array;
  private readonly t1: Float64Array;
  /** Skinned outward normals at the current targets (world). */
  private readonly tn: Float64Array;
  private readonly nw: Float32Array;
  private readonly invMass: Float32Array;
  private readonly bindInv: THREE.Matrix4[];
  /** World skinning matrices (3x4, column-major like THREE) per bone. */
  private readonly skin: Float64Array;
  private readonly colA: Float64Array;
  private readonly colB: Float64Array;
  private readonly colA0: Float64Array;
  private readonly colB0: Float64Array;
  private readonly colBind: Float32Array;
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly nrmAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly baseCol: Float32Array;
  private readonly strain: Float32Array;
  private readonly strainN: Float32Array;
  private started = false;
  private readonly lastRoot = new THREE.Vector3();
  private readonly inv = new THREE.Matrix4();
  private readonly m = new THREE.Matrix4();
  /** Collider segments interpolated for the current sub-step. */
  private readonly colS: Float64Array;
  /** Per particle: bit c set when collider c can ever reach it (broad phase, from the bind pose). */
  private readonly colMask: Uint32Array;
  /**
   * Distance constraints packed for the solver, sorted by colour. Symmetric edges (both ends free, stiffness
   * pre-halved): sA/sB particle offsets (index * 3), rest length, stretch / compress stiffness. Edges to a
   * pinned particle only move their free end pA. Fully pinned edges are dropped.
   */
  private readonly sA: Int32Array;
  private readonly sB: Int32Array;
  private readonly sL: Float32Array;
  private readonly sKs: Float32Array;
  private readonly sKc: Float32Array;
  private readonly pA: Int32Array;
  private readonly pB: Int32Array;
  private readonly pL: Float32Array;
  private readonly pKs: Float32Array;
  private readonly pKc: Float32Array;
  /** Structural edges and their fitted (no slack) length, for fold shading. */
  private readonly fA: Int32Array;
  private readonly fB: Int32Array;
  private readonly fL: Float32Array;
  /**
   * Per particle: [cos, sin] of the spatial phase offset of each of the five flutter waves, so the
   * per-step wave values are sin(globalPhase + offset) by angle addition (no sin() per particle).
   */
  private readonly phase: Float32Array;

  constructor(
    private readonly b: ClothBuild,
    bindMatrices: THREE.Matrix4[],
    material: THREE.Material,
  ) {
    const n = (this.n = b.rest.length / 3);
    this.x = new Float64Array(n * 3);
    this.v = new Float64Array(n * 3);
    this.xp = new Float64Array(n * 3);
    this.t0 = new Float64Array(n * 3);
    this.t1 = new Float64Array(n * 3);
    this.tn = new Float64Array(n * 3);
    this.nw = new Float32Array(n * 3);
    this.invMass = new Float32Array(n);
    for (let i = 0; i < n; i++) this.invMass[i] = b.maxDist[i] > 0 ? 1 : 0;
    this.bindInv = bindMatrices.map((m) => m.clone().invert());
    this.skin = new Float64Array(bindMatrices.length * 12);
    const nc = b.colliders.length;
    this.colA = new Float64Array(nc * 3);
    this.colB = new Float64Array(nc * 3);
    this.colA0 = new Float64Array(nc * 3);
    this.colB0 = new Float64Array(nc * 3);
    this.colBind = new Float32Array(nc * 6);
    this.colS = new Float64Array(nc * 6);
    b.colliders.forEach((c, i) => {
      this.colBind.set([c.a.x, c.a.y, c.a.z, c.b.x, c.b.y, c.b.z], i * 6);
    });
    // broad phase: a particle only ever tests capsules within reach of it (poses move limbs ~20 cm at most)
    this.colMask = new Uint32Array(n);
    const pa = new THREE.Vector3();
    const seg = new THREE.Line3();
    const q = new THREE.Vector3();
    b.colliders.slice(0, 32).forEach((c, ci) => {
      seg.set(c.a, c.b);
      for (let i = 0; i < n; i++) {
        pa.set(b.rest[i * 3], b.rest[i * 3 + 1], b.rest[i * 3 + 2]);
        seg.closestPointToPoint(pa, true, q);
        if (q.distanceTo(pa) < c.r + b.maxDist[i] + 0.12) this.colMask[i] |= 1 << ci;
      }
    });

    this.pos = new Float32Array(n * 3);
    this.nrm = new Float32Array(n * 3);
    this.pos.set(b.rest);
    this.phase = new Float32Array(n * 10);
    for (let i = 0; i < n; i++) {
      // u around, w along (metres): ripples run from the pinned edge towards the free hem
      const u = b.wave[i * 2],
        w = b.wave[i * 2 + 1];
      const o1 = -w * 38 + u * 17;
      const offs = [o1, 1.73 * o1 + u * 31 + 1.3, 0.53 * o1 - u * 23, u * 5.5 - w * 6, -u * 9 + 0.7];
      offs.forEach((a, k) => {
        this.phase[i * 10 + k * 2] = Math.cos(a);
        this.phase[i * 10 + k * 2 + 1] = Math.sin(a);
      });
    }
    this.baseCol = Float32Array.from(b.colors);
    this.strain = new Float32Array(n);
    this.strainN = new Float32Array(n);
    const keep: number[] = [];
    for (let e = 0; e < b.edges.length / 2; e++) if (this.invMass[b.edges[e * 2]] + this.invMass[b.edges[e * 2 + 1]] > 0) keep.push(e);
    // greedy edge colouring, then sweep colour by colour: consecutive constraints never share a particle,
    // so the CPU overlaps their sqrt / divide latency instead of waiting on the previous store (~2.5x faster)
    const used = Array.from({ length: n }, () => 0);
    const colourOf = new Map<number, number>();
    for (const e of keep) {
      const i = b.edges[e * 2],
        j = b.edges[e * 2 + 1];
      let c = 0;
      while (c < 31 && ((used[i] | used[j]) & (1 << c)) !== 0) c++;
      used[i] |= 1 << c;
      used[j] |= 1 << c;
      colourOf.set(e, c);
    }
    keep.sort((p, q) => colourOf.get(p)! - colourOf.get(q)! || p - q);
    const sym = keep.filter((e) => this.invMass[b.edges[e * 2]] > 0 && this.invMass[b.edges[e * 2 + 1]] > 0);
    const pin = keep.filter((e) => !(this.invMass[b.edges[e * 2]] > 0 && this.invMass[b.edges[e * 2 + 1]] > 0));
    const fit = keep.filter((e) => b.stretch[e] >= 0.99);
    this.sA = new Int32Array(sym.length);
    this.sB = new Int32Array(sym.length);
    this.sL = new Float32Array(sym.length);
    this.sKs = new Float32Array(sym.length);
    this.sKc = new Float32Array(sym.length);
    sym.forEach((e, k) => {
      this.sA[k] = b.edges[e * 2] * 3;
      this.sB[k] = b.edges[e * 2 + 1] * 3;
      this.sL[k] = b.restLen[e];
      this.sKs[k] = b.stretch[e] * 0.5;
      this.sKc[k] = b.compress[e] * 0.5;
    });
    this.pA = new Int32Array(pin.length);
    this.pB = new Int32Array(pin.length);
    this.pL = new Float32Array(pin.length);
    this.pKs = new Float32Array(pin.length);
    this.pKc = new Float32Array(pin.length);
    pin.forEach((e, k) => {
      const i = b.edges[e * 2],
        j = b.edges[e * 2 + 1];
      const freeFirst = this.invMass[i] > 0;
      this.pA[k] = (freeFirst ? i : j) * 3;
      this.pB[k] = (freeFirst ? j : i) * 3;
      this.pL[k] = b.restLen[e];
      this.pKs[k] = b.stretch[e];
      this.pKc[k] = b.compress[e];
    });
    const r = b.rest;
    this.fA = new Int32Array(fit.length);
    this.fB = new Int32Array(fit.length);
    this.fL = new Float32Array(fit.length);
    fit.forEach((e, k) => {
      const a = b.edges[e * 2] * 3,
        c = b.edges[e * 2 + 1] * 3;
      this.fA[k] = a;
      this.fB[k] = c;
      this.fL[k] = Math.sqrt((r[a] - r[c]) ** 2 + (r[a + 1] - r[c + 1]) ** 2 + (r[a + 2] - r[c + 2]) ** 2);
    });
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr = new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(Float32Array.from(b.colors), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.nrmAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setIndex(new THREE.BufferAttribute(b.index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'cloth';
    this.computeNormals();
  }

  /** Forget the simulation state (next update snaps to the body). */
  reset(): void {
    this.started = false;
  }

  /** World-space skinning matrices from bone matrices relative to the rig root. */
  private updateSkin(rootWorld: THREE.Matrix4, bones: THREE.Object3D[]): void {
    const s = this.skin;
    for (let k = 0; k < bones.length; k++) {
      const m = this.m.multiplyMatrices(rootWorld, bones[k].matrix).multiply(this.bindInv[k]);
      const e = m.elements;
      const o = k * 12;
      s[o] = e[0];
      s[o + 1] = e[1];
      s[o + 2] = e[2];
      s[o + 3] = e[4];
      s[o + 4] = e[5];
      s[o + 5] = e[6];
      s[o + 6] = e[8];
      s[o + 7] = e[9];
      s[o + 8] = e[10];
      s[o + 9] = e[12];
      s[o + 10] = e[13];
      s[o + 11] = e[14];
    }
  }

  private skinPoint(bone: number, x: number, y: number, z: number, out: Float64Array, o: number, w: number): void {
    const s = this.skin;
    const k = bone * 12;
    out[o] += w * (s[k] * x + s[k + 3] * y + s[k + 6] * z + s[k + 9]);
    out[o + 1] += w * (s[k + 1] * x + s[k + 4] * y + s[k + 7] * z + s[k + 10]);
    out[o + 2] += w * (s[k + 2] * x + s[k + 5] * y + s[k + 8] * z + s[k + 11]);
  }

  private computeTargets(out: Float64Array): void {
    const { rest, bones, weights, restNormal } = this.b;
    out.fill(0);
    const tn = this.tn;
    tn.fill(0);
    for (let i = 0; i < this.n; i++) {
      const x = rest[i * 3],
        y = rest[i * 3 + 1],
        z = rest[i * 3 + 2];
      const nx = restNormal[i * 3],
        ny = restNormal[i * 3 + 1],
        nz = restNormal[i * 3 + 2];
      for (let k = 0; k < 4; k++) {
        const w = weights[i * 4 + k];
        if (w <= 0) continue;
        const bn = bones[i * 4 + k];
        this.skinPoint(bn, x, y, z, out, i * 3, w);
        // rotate the normal with the same blend (direction only)
        const s = this.skin;
        const kk = bn * 12;
        tn[i * 3] += w * (s[kk] * nx + s[kk + 3] * ny + s[kk + 6] * nz);
        tn[i * 3 + 1] += w * (s[kk + 1] * nx + s[kk + 4] * ny + s[kk + 7] * nz);
        tn[i * 3 + 2] += w * (s[kk + 2] * nx + s[kk + 5] * ny + s[kk + 8] * nz);
      }
      const l = Math.sqrt(tn[i * 3] * tn[i * 3] + tn[i * 3 + 1] * tn[i * 3 + 1] + tn[i * 3 + 2] * tn[i * 3 + 2]) || 1;
      tn[i * 3] /= l;
      tn[i * 3 + 1] /= l;
      tn[i * 3 + 2] /= l;
    }
    const cb = this.colBind;
    this.colA.fill(0);
    this.colB.fill(0);
    this.b.colliders.forEach((c, i) => {
      this.skinPoint(c.bone, cb[i * 6], cb[i * 6 + 1], cb[i * 6 + 2], this.colA, i * 3, 1);
      this.skinPoint(c.bone, cb[i * 6 + 3], cb[i * 6 + 4], cb[i * 6 + 5], this.colB, i * 3, 1);
    });
  }

  /**
   * Advance the cloth.
   * @param rootWorld world matrix of the rig root
   * @param bones bone objects (index order of the skin weights), matrices relative to the root up to date
   * @param wind world-space air velocity relative to the ground minus the bike velocity (i.e. the airflow the rider feels)
   * @param speed riding speed (m/s), scales the flutter frequency
   */
  update(dt: number, rootWorld: THREE.Matrix4, bones: THREE.Object3D[], wind: THREE.Vector3, speed: number, time: number): void {
    const n = this.n;
    this.updateSkin(rootWorld, bones);
    // previous-frame collider positions for sub-step interpolation
    this.colA0.set(this.colA);
    this.colB0.set(this.colB);
    this.computeTargets(this.t1);
    const rx = rootWorld.elements[12],
      ry = rootWorld.elements[13],
      rz = rootWorld.elements[14];
    const jump = Math.hypot(rx - this.lastRoot.x, ry - this.lastRoot.y, rz - this.lastRoot.z);
    this.lastRoot.set(rx, ry, rz);
    // teleports (respawn, restart) snap the cloth instead of whipping it across the world
    if (!this.started || !(dt > 0) || dt > 0.25 || jump > 1 + 45 * dt) {
      this.x.set(this.t1);
      this.xp.set(this.t1);
      this.t0.set(this.t1);
      this.v.fill(0);
      this.colA0.set(this.colA);
      this.colB0.set(this.colB);
      this.started = true;
      this.writeMesh(rootWorld);
      return;
    }
    const steps = Math.min(4, Math.max(1, Math.ceil(dt / MAX_SUBSTEP - 1e-6)));
    const h = dt / steps;
    const iters = this.tuning.iterations;
    for (let s = 1; s <= steps; s++) {
      const al = s / steps;
      this.interpolateColliders(al);
      this.integrate(al, time - dt + al * dt, h, dt, wind, speed);
      for (let it = 0; it < iters; it++) {
        this.solveEdges();
        // hard constraints (body collision, backstop, tether) half-way through and last
        if (it === iters - 1 || it === (iters >> 1) - 1) this.project(al);
      }
      this.updateVelocities(h);
    }
    this.t0.set(this.t1);
    this.writeMesh(rootWorld);
  }

  /** Collider segments at sub-step fraction `al`: [ax ay az bx-ax by-ay bz-az]. */
  private interpolateColliders(al: number): void {
    const cs = this.colS;
    const A0 = this.colA0,
      A1 = this.colA,
      B0 = this.colB0,
      B1 = this.colB;
    for (let c = 0, nc = this.b.colliders.length; c < nc; c++) {
      const c3 = c * 3,
        c6 = c * 6;
      cs[c6] = A0[c3] + (A1[c3] - A0[c3]) * al;
      cs[c6 + 1] = A0[c3 + 1] + (A1[c3 + 1] - A0[c3 + 1]) * al;
      cs[c6 + 2] = A0[c3 + 2] + (A1[c3 + 2] - A0[c3 + 2]) * al;
      cs[c6 + 3] = B0[c3] + (B1[c3] - B0[c3]) * al - cs[c6];
      cs[c6 + 4] = B0[c3 + 1] + (B1[c3 + 1] - B0[c3 + 1]) * al - cs[c6 + 1];
      cs[c6 + 5] = B0[c3 + 2] + (B1[c3 + 2] - B0[c3 + 2]) * al - cs[c6 + 2];
    }
  }

  /** Forces (gravity, airflow, flutter), body-relative damping and the pull to the rest shape, then a position step. */
  private integrate(al: number, tt: number, h: number, dt: number, wind: THREE.Vector3, speed: number): void {
    const { x, v, xp, t0, t1, nw, invMass, n } = this;
    const { flutter } = this.b;
    const ph = this.phase;
    const tu = this.tuning;
    const aero = tu.aero,
      turbK = tu.turbulence,
      billowK = tu.billow;
    const damp = Math.exp(-tu.damping * h);
    const pull = 1 - Math.exp(-tu.pull * h);
    const ripple = 6.2832 * (1.6 + 0.32 * Math.min(speed, 24)) * tt;
    const s0 = Math.sin(ripple),
      c0 = Math.cos(ripple),
      s1 = Math.sin(ripple * 1.73),
      c1 = Math.cos(ripple * 1.73),
      s2 = Math.sin(ripple * 0.53),
      c2 = Math.cos(ripple * 0.53),
      s3 = Math.sin(6.2832 * 1.3 * tt),
      c3 = Math.cos(6.2832 * 1.3 * tt),
      s4 = Math.sin(6.2832 * 2.1 * tt),
      c4 = Math.cos(6.2832 * 2.1 * tt);
    const invDt = 1 / dt;
    const wx = wind.x,
      wy = wind.y,
      wz = wind.z;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const tx = t0[o] + (t1[o] - t0[o]) * al,
        ty = t0[o + 1] + (t1[o + 1] - t0[o + 1]) * al,
        tz = t0[o + 2] + (t1[o + 2] - t0[o + 2]) * al;
      const vtx = (t1[o] - t0[o]) * invDt,
        vty = (t1[o + 1] - t0[o + 1]) * invDt,
        vtz = (t1[o + 2] - t0[o + 2]) * invDt;
      xp[o] = x[o];
      xp[o + 1] = x[o + 1];
      xp[o + 2] = x[o + 2];
      if (invMass[i] === 0) {
        x[o] = tx;
        x[o + 1] = ty;
        x[o + 2] = tz;
        v[o] = vtx;
        v[o + 1] = vty;
        v[o + 2] = vtz;
        continue;
      }
      // airflow over the fabric: pressure along the normal + travelling turbulent flutter
      const nx = nw[o],
        ny = nw[o + 1],
        nz = nw[o + 2];
      const rvx = wx - (v[o] - vtx),
        rvy = wy - (v[o + 1] - vty),
        rvz = wz - (v[o + 2] - vtz);
      const vn = rvx * nx + rvy * ny + rvz * nz;
      const q = rvx * rvx + rvy * rvy + rvz * rvz;
      // ripples running towards the free hem + slow billowing of whole panels (sin(a + b) with per-particle b)
      const f = i * 10;
      const turb =
        0.62 * (s0 * ph[f] + c0 * ph[f + 1]) + 0.38 * (s1 * ph[f + 2] + c1 * ph[f + 3]) + 0.25 * (s2 * ph[f + 4] + c2 * ph[f + 5]);
      const gust = 0.6 * (s3 * ph[f + 6] + c3 * ph[f + 7]) + 0.4 * (s4 * ph[f + 8] + c4 * ph[f + 9]);
      let an = aero * vn * (vn < 0 ? -vn : vn) + q * flutter[i] * (turbK * turb + billowK * gust);
      if (an > 70) an = 70;
      else if (an < -70) an = -70;
      // body-relative damping keeps the cloth riding along at 20 m/s without lag
      const vx = vtx + (v[o] - vtx) * damp + an * nx * h,
        vy = vty + (v[o + 1] - vty) * damp + (an * ny + GRAV) * h,
        vz = vtz + (v[o + 2] - vtz) * damp + an * nz * h;
      v[o] = vx;
      v[o + 1] = vy;
      v[o + 2] = vz;
      x[o] += vx * h + (tx - x[o]) * pull;
      x[o + 1] += vy * h + (ty - x[o + 1]) * pull;
      x[o + 2] += vz * h + (tz - x[o + 2]) * pull;
    }
  }

  /** One Gauss-Seidel sweep over the (pre-packed, colour-ordered) distance constraints. */
  private solveEdges(): void {
    const { x, sA, sB, sL, sKs, sKc, pA, pB, pL, pKs, pKc } = this;
    for (let e = 0, ne = sL.length; e < ne; e++) {
      const oa = sA[e],
        ob = sB[e];
      const dx = x[ob] - x[oa],
        dy = x[ob + 1] - x[oa + 1],
        dz = x[ob + 2] - x[oa + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-18) continue;
      // (len - L) / len, times the stiffness for stretching or (softer) compression
      let k = 1 - sL[e] / Math.sqrt(d2);
      k *= k > 0 ? sKs[e] : sKc[e];
      x[oa] += dx * k;
      x[oa + 1] += dy * k;
      x[oa + 2] += dz * k;
      x[ob] -= dx * k;
      x[ob + 1] -= dy * k;
      x[ob + 2] -= dz * k;
    }
    for (let e = 0, ne = pL.length; e < ne; e++) {
      const oa = pA[e],
        ob = pB[e];
      const dx = x[ob] - x[oa],
        dy = x[ob + 1] - x[oa + 1],
        dz = x[ob + 2] - x[oa + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-18) continue;
      let k = 1 - pL[e] / Math.sqrt(d2);
      k *= k > 0 ? pKs[e] : pKc[e];
      x[oa] += dx * k;
      x[oa + 1] += dy * k;
      x[oa + 2] += dz * k;
    }
  }

  /** Velocities from the corrected positions (position-based dynamics). */
  private updateVelocities(h: number): void {
    const { x, v, xp, invMass, n } = this;
    const ih = 1 / h;
    for (let i = 0; i < n; i++) {
      if (invMass[i] === 0) continue;
      const o = i * 3;
      v[o] = (x[o] - xp[o]) * ih;
      v[o + 1] = (x[o + 1] - xp[o + 1]) * ih;
      v[o + 2] = (x[o + 2] - xp[o + 2]) * ih;
    }
  }

  /** Body collision (only the capsules near each particle), backstop and tether, at sub-step fraction `al`. */
  private project(al: number): void {
    const { x, t0, t1, tn, invMass, colMask } = this;
    const { maxDist, backstop } = this.b;
    const cr = this.b.colliders;
    const cs = this.colS;
    for (let i = 0; i < this.n; i++) {
      if (invMass[i] === 0) continue;
      const o = i * 3;
      let px = x[o],
        py = x[o + 1],
        pz = x[o + 2];
      for (let mask = colMask[i], c = 0; mask !== 0; mask >>>= 1, c++) {
        if ((mask & 1) === 0) continue;
        const c6 = c * 6;
        const r = cr[c].r;
        const bx = cs[c6 + 3],
          by = cs[c6 + 4],
          bz = cs[c6 + 5];
        const ax = px - cs[c6],
          ay = py - cs[c6 + 1],
          az = pz - cs[c6 + 2];
        const bb = bx * bx + by * by + bz * bz;
        let t = bb > 1e-12 ? (ax * bx + ay * by + az * bz) / bb : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax - bx * t,
          qy = ay - by * t,
          qz = az - bz * t;
        const d2 = qx * qx + qy * qy + qz * qz;
        if (d2 < r * r && d2 > 1e-12) {
          const f = r / Math.sqrt(d2);
          px = cs[c6] + bx * t + qx * f;
          py = cs[c6 + 1] + by * t + qy * f;
          pz = cs[c6 + 2] + bz * t + qz * f;
        }
      }
      const tx = t0[o] + (t1[o] - t0[o]) * al,
        ty = t0[o + 1] + (t1[o + 1] - t0[o + 1]) * al,
        tz = t0[o + 2] + (t1[o + 2] - t0[o + 2]) * al;
      let dx = px - tx,
        dy = py - ty,
        dz = pz - tz;
      // backstop: never sink behind the skinned body surface
      const bs = backstop[i];
      if (bs === bs) {
        const nx = tn[o],
          ny = tn[o + 1],
          nz = tn[o + 2];
        const along = dx * nx + dy * ny + dz * nz;
        if (along < bs) {
          const push = bs - along;
          px += nx * push;
          py += ny * push;
          pz += nz * push;
          dx += nx * push;
          dy += ny * push;
          dz += nz * push;
        }
      }
      const d2 = dx * dx + dy * dy + dz * dz;
      const md = maxDist[i];
      if (d2 > md * md) {
        const f = md / Math.sqrt(d2);
        px = tx + dx * f;
        py = ty + dy * f;
        pz = tz + dz * f;
      }
      x[o] = px;
      x[o + 1] = py;
      x[o + 2] = pz;
    }
  }

  /** World positions -> rig-root-local render buffer, plus fresh normals (render + aero). */
  private writeMesh(rootWorld: THREE.Matrix4): void {
    const inv = this.inv.copy(rootWorld).invert();
    const e = inv.elements;
    const x = this.x;
    const p = this.pos;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const X = x[o],
        Y = x[o + 1],
        Z = x[o + 2];
      p[o] = e[0] * X + e[4] * Y + e[8] * Z + e[12];
      p[o + 1] = e[1] * X + e[5] * Y + e[9] * Z + e[13];
      p[o + 2] = e[2] * X + e[6] * Y + e[10] * Z + e[14];
    }
    this.computeNormals();
    // seam rows: shade like the body underneath (skinned target normal, world -> root-local)
    const nb = this.b.normalBlend;
    const tn = this.tn;
    const nr = this.nrm;
    for (let i = 0; i < this.n; i++) {
      const w = nb[i];
      if (!(w > 0)) continue;
      const o = i * 3;
      const a = tn[o],
        b = tn[o + 1],
        c = tn[o + 2];
      let lx = e[0] * a + e[4] * b + e[8] * c,
        ly = e[1] * a + e[5] * b + e[9] * c,
        lz = e[2] * a + e[6] * b + e[10] * c;
      const ll = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
      lx = nr[o] + (lx / ll - nr[o]) * w;
      ly = nr[o + 1] + (ly / ll - nr[o + 1]) * w;
      lz = nr[o + 2] + (lz / ll - nr[o + 2]) * w;
      const l2 = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
      nr[o] = lx / l2;
      nr[o + 1] = ly / l2;
      nr[o + 2] = lz / l2;
    }
    // world-space normals for next frame's aerodynamics (rotation part of the root)
    const r = rootWorld.elements;
    const sx = Math.hypot(r[0], r[1], r[2]) || 1;
    const nw = this.nw;
    const nl = this.nrm;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const a = nl[o],
        b = nl[o + 1],
        c = nl[o + 2];
      nw[o] = (r[0] * a + r[4] * b + r[8] * c) / sx;
      nw[o + 1] = (r[1] * a + r[5] * b + r[9] * c) / sx;
      nw[o + 2] = (r[2] * a + r[6] * b + r[10] * c) / sx;
    }
    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
    this.shadeFolds();
  }

  /** Darken fabric where it bunches up (folds) and lighten it slightly where it is pulled taut. */
  private shadeFolds(): void {
    const { fA, fB, fL, x } = this;
    const s = this.strain;
    const sn = this.strainN;
    s.fill(0);
    sn.fill(0);
    for (let e = 0, ne = fL.length; e < ne; e++) {
      const L0 = fL[e];
      const oa = fA[e],
        ob = fB[e];
      const dx = x[oa] - x[ob],
        dy = x[oa + 1] - x[ob + 1],
        dz = x[oa + 2] - x[ob + 2];
      const st = Math.sqrt(dx * dx + dy * dy + dz * dz) / L0 - 1;
      const i = oa / 3,
        j = ob / 3;
      s[i] += st;
      s[j] += st;
      sn[i]++;
      sn[j]++;
    }
    const c = this.colAttr.array as Float32Array;
    const b = this.baseCol;
    for (let i = 0; i < this.n; i++) {
      const st = sn[i] > 0 ? s[i] / sn[i] : 0;
      const k = 1 + 3.0 * Math.max(-0.16, Math.min(0.05, st));
      c[i * 3] = b[i * 3] * k;
      c[i * 3 + 1] = b[i * 3 + 1] * k;
      c[i * 3 + 2] = b[i * 3 + 2] * k;
    }
    this.colAttr.needsUpdate = true;
  }

  private computeNormals(): void {
    const p = this.pos;
    const nr = this.nrm;
    nr.fill(0);
    const idx = this.b.index;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3,
        b = idx[t + 1] * 3,
        c = idx[t + 2] * 3;
      const e1x = p[b] - p[a],
        e1y = p[b + 1] - p[a + 1],
        e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a],
        e2y = p[c + 1] - p[a + 1],
        e2z = p[c + 2] - p[a + 2];
      const fx = e1y * e2z - e1z * e2y,
        fy = e1z * e2x - e1x * e2z,
        fz = e1x * e2y - e1y * e2x;
      nr[a] += fx;
      nr[a + 1] += fy;
      nr[a + 2] += fz;
      nr[b] += fx;
      nr[b + 1] += fy;
      nr[b + 2] += fz;
      nr[c] += fx;
      nr[c + 1] += fy;
      nr[c + 2] += fz;
    }
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const l = Math.sqrt(nr[o] * nr[o] + nr[o + 1] * nr[o + 1] + nr[o + 2] * nr[o + 2]) || 1;
      nr[o] /= l;
      nr[o + 1] /= l;
      nr[o + 2] /= l;
    }
  }
}

/* ------------------------------------------------------------------ grid builder helpers */

/**
 * Distance constraints for a ring grid (`cols` around, closed; `rows` along): structural, shear and
 * bending edges, with softer compression so the fabric buckles into folds instead of resisting.
 * `slackU` / `slackV` add spare fabric around / along (a loose fit that has to fold somewhere).
 */
export function ringGridConstraints(
  rest: Float32Array,
  cols: number,
  rows: number,
  base: number,
  out: { edges: number[]; len: number[]; stretch: number[]; compress: number[] },
  slackU = 0,
  slackV = 0,
): void {
  const id = (i: number, j: number) => base + j * cols + (((i % cols) + cols) % cols);
  const push = (a: number, b: number, st: number, co: number, slack: number) => {
    out.edges.push(a, b);
    out.len.push(Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]) * (1 + slack));
    out.stretch.push(st);
    out.compress.push(co);
  };
  // spare fabric grows towards the free edge (the pinned row is a tight seam)
  const su = (j: number) => slackU * Math.min(1, j / Math.max(1, rows - 1) * 1.6);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      push(id(i, j), id(i + 1, j), 1, 0.3, su(j));
      if (j + 1 < rows) {
        push(id(i, j), id(i, j + 1), 1, 0.3, slackV);
        push(id(i, j), id(i + 1, j + 1), 0.5, 0.2, (su(j) + slackV) * 0.5);
        push(id(i + 1, j), id(i, j + 1), 0.5, 0.2, (su(j) + slackV) * 0.5);
      }
      // bending: resists grid-scale zig-zags so the spare fabric gathers into wider, smoother folds
      push(id(i, j), id(i + 2, j), 0.35, 0.3, su(j));
      if (j + 2 < rows) push(id(i, j), id(i, j + 2), 0.35, 0.3, slackV);
    }
}

/** Triangles of a closed ring grid; winding chosen so normals point away from `axisCentre(j)`. */
export function ringGridTriangles(
  rest: Float32Array,
  cols: number,
  rows: number,
  base: number,
  centre: (j: number) => THREE.Vector3,
  out: number[],
): void {
  const id = (i: number, j: number) => base + j * cols + (i % cols);
  // test the winding on the first quad of the middle row
  const j0 = Math.floor((rows - 1) / 2);
  const a = id(0, j0),
    b = id(1, j0),
    c = id(1, j0 + 1);
  const P = (k: number) => new THREE.Vector3(rest[k * 3], rest[k * 3 + 1], rest[k * 3 + 2]);
  const fn = new THREE.Vector3().subVectors(P(b), P(a)).cross(new THREE.Vector3().subVectors(P(c), P(a)));
  const outward = P(a).sub(centre(j0));
  const flip = fn.dot(outward) < 0;
  for (let j = 0; j + 1 < rows; j++)
    for (let i = 0; i < cols; i++) {
      const p00 = id(i, j),
        p10 = id(i + 1, j),
        p01 = id(i, j + 1),
        p11 = id(i + 1, j + 1);
      if (flip) out.push(p00, p11, p10, p00, p01, p11);
      else out.push(p00, p10, p11, p00, p11, p01);
    }
}
