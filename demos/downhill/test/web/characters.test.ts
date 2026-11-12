import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { meshSdf, sdSphere } from '../../src/web/game/characters/sdf';
import { generateHumanData, type HumanData } from '../../src/web/game/characters/human';
import { Cloth, type ClothBuild } from '../../src/web/game/characters/cloth';
import { RideDynamics } from '../../src/web/game/characters/dynamics';

describe('SDF meshing', () => {
  it('meshes a sphere onto its exact surface with outward normals and a closed surface', () => {
    const r = 0.1;
    const h = 0.01;
    const { positions, normals, indices } = meshSdf(sdSphere(0.01, -0.02, 0.03, r), new THREE.Box3(new THREE.Vector3(-0.15, -0.15, -0.15), new THREE.Vector3(0.15, 0.15, 0.15)), h);
    const nv = positions.length / 3;
    expect(nv).toBeGreaterThan(300);
    for (let v = 0; v < nv; v++) {
      const x = positions[v * 3] - 0.01,
        y = positions[v * 3 + 1] + 0.02,
        z = positions[v * 3 + 2] - 0.03;
      const len = Math.hypot(x, y, z);
      expect(Math.abs(len - r)).toBeLessThan(h * 0.05);
      // normal points away from the centre
      expect((normals[v * 3] * x + normals[v * 3 + 1] * y + normals[v * 3 + 2] * z) / len).toBeGreaterThan(0.98);
    }
    // closed 2-manifold: every edge is shared by exactly two triangles, with opposite orientations
    const edges = new Map<string, number>();
    let outward = 0;
    for (let t = 0; t < indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = indices[t + k],
          b = indices[t + ((k + 1) % 3)];
        const key = `${a},${b}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
      // the winding faces away from the centre (front faces survive back-face culling); zero-area triangles
      // (vertices that projected onto the same point where the surface passes exactly through grid nodes) are invisible
      const P = (k: number) => new THREE.Vector3(positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]);
      const a = P(indices[t]),
        b = P(indices[t + 1]),
        c = P(indices[t + 2]);
      const fn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (fn.length() < 1e-9 || fn.dot(a.sub(new THREE.Vector3(0.01, -0.02, 0.03))) > 0) outward++;
    }
    expect(outward).toBe(indices.length / 3);
    for (const [key, count] of edges) {
      const [a, b] = key.split(',');
      expect(count).toBe(1);
      expect(edges.get(`${b},${a}`)).toBe(1);
    }
  });
});

let data: HumanData | null = null;
const human = () => (data ??= generateHumanData());

describe('human rider data', () => {
  it('produces a finite, fully skinned body and well-formed cloth', () => {
    const d = human();
    const b = d.body;
    const nv = b.positions.length / 3;
    expect(nv).toBeGreaterThan(10000);
    expect(b.positions.every(Number.isFinite)).toBe(true);
    expect(b.colors.every((c) => c >= 0 && c <= 1.5)).toBe(true);
    for (let v = 0; v < nv; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        expect(b.skinIndex![v * 4 + k]).toBeLessThan(15);
        sum += b.skinWeight![v * 4 + k];
      }
      expect(Math.abs(sum - 1)).toBeLessThan(1e-4);
    }
    expect(d.bind.every(Number.isFinite)).toBe(true);
    const c = d.cloth;
    const n = c.rest.length / 3;
    expect(n).toBeGreaterThan(500);
    expect(c.rest.every(Number.isFinite)).toBe(true);
    const pinned = [...c.maxDist].filter((m) => m === 0).length;
    expect(pinned).toBeGreaterThan(40);
    expect(pinned).toBeLessThan(n / 4);
    for (let e = 0; e < c.edges.length; e++) expect(c.edges[e]).toBeLessThan(n);
    for (let t = 0; t < c.index.length; t++) expect(c.index[t]).toBeLessThan(n);
    expect(c.colliders.length).toBeGreaterThan(3);
  });
});

/** Bones posed at the bind pose, as the rig root's children (the cloth reads `bone.matrix`). */
function bindBones(d: HumanData): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (let i = 0; i < d.bind.length / 16; i++) {
    const o = new THREE.Object3D();
    new THREE.Matrix4().fromArray(d.bind, i * 16).decompose(o.position, o.quaternion, o.scale);
    o.updateMatrix();
    out.push(o);
  }
  return out;
}

function clothFrom(d: HumanData): { cloth: Cloth; build: ClothBuild; bones: THREE.Object3D[] } {
  const build: ClothBuild = {
    ...d.cloth,
    colliders: d.cloth.colliders.map((c) => ({ ...c, a: new THREE.Vector3(c.a.x, c.a.y, c.a.z), b: new THREE.Vector3(c.b.x, c.b.y, c.b.z) })),
  };
  const bind: THREE.Matrix4[] = [];
  for (let i = 0; i < d.bind.length / 16; i++) bind.push(new THREE.Matrix4().fromArray(d.bind, i * 16));
  return { cloth: new Cloth(build, bind, new THREE.MeshBasicMaterial()), build, bones: bindBones(d) };
}

describe('shirt cloth', () => {
  it('stays stable, tethered and outside the body at downhill speed with bumps', () => {
    const d = human();
    const { cloth, build, bones } = clothFrom(d);
    const root = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const wind = new THREE.Vector3();
    const dt = 1 / 60;
    const speed = 20;
    let flutter = 0;
    let prevHem: Float32Array | null = null;
    const geo = cloth.mesh.geometry as THREE.BufferGeometry;
    for (let f = 0; f < 360; f++) {
      const t = f * dt;
      // downhill along -z with a bumpy vertical motion and a hard landing at 3 s
      pos.set(0, Math.sin(t * 9) * 0.05 + (f === 180 ? -0.3 : 0), -speed * t);
      root.makeTranslation(pos.x, pos.y, pos.z);
      wind.set(0, -Math.cos(t * 9) * 0.45, speed);
      cloth.update(dt, root, bones, wind, speed, t);
      const p = geo.getAttribute('position').array as Float32Array;
      expect(p.every(Number.isFinite)).toBe(true);
      if (f > 240) {
        if (prevHem) for (let i = 0; i < p.length; i++) flutter = Math.max(flutter, Math.abs(p[i] - prevHem[i]));
        prevHem = Float32Array.from(p);
      }
    }
    // the rest pose stays fixed relative to the root (bind pose), so the tether invariant is checkable in root space
    const p = geo.getAttribute('position').array as Float32Array;
    const n = p.length / 3;
    let worstTether = 0;
    let worstBackstop = 0;
    for (let i = 0; i < n; i++) {
      const dx = p[i * 3] - build.rest[i * 3],
        dy = p[i * 3 + 1] - build.rest[i * 3 + 1],
        dz = p[i * 3 + 2] - build.rest[i * 3 + 2];
      worstTether = Math.max(worstTether, Math.hypot(dx, dy, dz) - build.maxDist[i]);
      const bs = build.backstop[i];
      if (bs === bs) {
        const along = dx * build.restNormal[i * 3] + dy * build.restNormal[i * 3 + 1] + dz * build.restNormal[i * 3 + 2];
        worstBackstop = Math.max(worstBackstop, bs - along);
      }
    }
    // tether / backstop are projected last, so they hold to float precision (collisions may nudge by < 1 mm)
    expect(worstTether).toBeLessThan(0.001);
    expect(worstBackstop).toBeLessThan(0.001);
    // and the fabric is visibly moving in the wind (more than 2 mm per frame somewhere)
    expect(flutter).toBeGreaterThan(0.002);
  });
});

describe('ride dynamics', () => {
  it('sinks into a landing in proportion to its impact, then settles back to neutral', () => {
    const landing = (fallSpeed: number) => {
      const dyn = new RideDynamics();
      const v = new THREE.Vector3(0, 0, -15);
      const dt = 1 / 60;
      for (let f = 0; f < 60; f++) dyn.update(dt, null, v, 0, 15, true, 1);
      expect(dyn.offset.length()).toBeLessThan(1e-6);
      // ballistic fall (weightless: the body floats a touch up on extended limbs), then the wheels touch down
      while (v.y > -fallSpeed) {
        v.y = Math.max(-fallSpeed, v.y - 9.81 * dt);
        dyn.update(dt, null, v, 0, 15, false, 1);
      }
      expect(dyn.offset.y).toBeGreaterThan(0);
      v.y = 0;
      let lowest = 0;
      for (let f = 0; f < 30; f++) {
        dyn.update(dt, null, v, 0, 15, true, 1);
        lowest = Math.min(lowest, dyn.offset.y);
      }
      for (let f = 0; f < 150; f++) dyn.update(dt, null, v, 0, 15, true, 1);
      expect(dyn.offset.length()).toBeLessThan(0.004);
      return lowest;
    };
    const soft = landing(2);
    const hard = landing(6);
    expect(soft).toBeLessThan(-0.008);
    expect(hard).toBeLessThan(soft * 1.8);
    expect(hard).toBeGreaterThanOrEqual(-0.09);
  });
});
