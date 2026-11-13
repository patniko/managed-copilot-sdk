import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { paintMaterial, patchMaterial } from '../render/globals';
import { hash2 } from '../core/rng';
import type { JumpFeature } from './features';
import { TRAIL_LIFT } from './ground';
import type { TerrainData } from './terrain';
import type { Trail, TrailNetwork } from './trails';
import type { CourseSpec } from './types';

const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

/** Soft-edged dirt ribbons draped over the terrain along every trail. */
export function buildTrailRibbons(net: TrailNetwork, terrain: TerrainData, course: CourseSpec): THREE.Mesh {
  const geos: THREE.BufferGeometry[] = [];
  const [cr, cg, cb] = course.trailColor;
  const [er, eg, eb] = course.trailEdgeColor;
  for (const t of net.trails) geos.push(ribbon(t, terrain, [cr, cg, cb], [er, eg, eb]));
  const g = mergeGeometries(geos);
  geos.forEach((x) => x.dispose());
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: 0,
  });
  patchMaterial(mat);
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  mesh.name = 'trails';
  return mesh;
}

function ribbon(t: Trail, terrain: TerrainData, c: number[], e: number[]): THREE.BufferGeometry {
  const n = t.x.length;
  // the ribbon's outermost vertices: 1.35 × the half-width (TRAIL_FADE past the edge), faded out
  const offs = [-1.35, -1.0, -0.55, 0, 0.55, 1.0, 1.35];
  const k = offs.length;
  const pos = new Float32Array(n * k * 3);
  const col = new Float32Array(n * k * 4);
  const nor = new Float32Array(n * k * 3);
  const nn = { x: 0, y: 1, z: 0 };
  for (let i = 0; i < n; i++) {
    const rx = Math.cos(t.heading[i]);
    const rz = Math.sin(t.heading[i]);
    const hw = t.hw[i];
    for (let j = 0; j < k; j++) {
      const o = offs[j];
      const v = Math.sign(o) * (Math.abs(o) <= 1 ? Math.abs(o) * hw : hw + (Math.abs(o) - 1) * 0.9);
      const x = t.x[i] + rx * v;
      const z = t.z[i] + rz * v;
      const p = (i * k + j) * 3;
      pos[p] = x;
      pos[p + 1] = terrain.heightAt(x, z) + TRAIL_LIFT;
      pos[p + 2] = z;
      terrain.normalAt(x, z, nn, 0.6);
      nor[p] = nn.x;
      nor[p + 1] = nn.y;
      nor[p + 2] = nn.z;
      const q = (i * k + j) * 4;
      const jitter = 0.92 + 0.16 * hash2(i, j, t.id);
      const centre = Math.abs(o) < 0.1 ? 0.94 : 1;
      const edge = Math.abs(o) >= 1;
      col[q] = (edge ? e[0] : c[0]) * jitter * centre;
      col[q + 1] = (edge ? e[1] : c[1]) * jitter * centre;
      col[q + 2] = (edge ? e[2] : c[2]) * jitter * centre;
      col[q + 3] = Math.abs(o) > 1.2 ? 0 : Math.abs(o) >= 1 ? 0.55 : 1;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < k - 1; j++) {
      const a = i * k + j;
      const b = a + 1;
      const c2 = a + k;
      const d = c2 + 1;
      idx.push(a, b, c2, b, d, c2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

/** Packed-dirt / timber meshes for all jump features. */
export function buildJumpMeshes(features: JumpFeature[], terrain: TerrainData, dirt: number[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'jumps';
  const geos: THREE.BufferGeometry[] = [];
  const posts: THREE.Matrix4[] = [];
  for (const f of features) {
    const s = f.shape;
    const du = 0.25;
    const nu = Math.ceil((f.length + 1) / du) + 1;
    const vs: number[] = [];
    const nv = 16;
    for (let j = 0; j <= nv; j++) vs.push(-f.maxHW + (2 * f.maxHW * j) / nv);
    const pos = new Float32Array(nu * vs.length * 3);
    const col = new Float32Array(nu * vs.length * 3);
    for (let i = 0; i < nu; i++) {
      const u = -0.5 + i * du;
      for (let j = 0; j < vs.length; j++) {
        const v = vs[j];
        const x = f.x0 + f.dirX * u + f.rightX * v;
        const z = f.z0 + f.dirZ * u + f.rightZ * v;
        const th = terrain.heightAt(x, z);
        const fh = f.heightAt(x, z);
        const h = Math.max(fh, th - 0.3);
        const o = (i * vs.length + j) * 3;
        pos[o] = x;
        pos[o + 1] = h;
        pos[o + 2] = z;
        const top = Math.abs(v) <= s.hw;
        const lip = Math.abs(u - f.lipU) < 0.6 && top;
        let r = dirt[0],
          g = dirt[1],
          b = dirt[2];
        if (s.wood) {
          const plank = Math.floor(u / 0.32) % 2 === 0 ? 1 : 0.86;
          r = 0.42 * plank;
          g = 0.27 * plank;
          b = 0.14 * plank;
          if (!top) {
            r *= 0.6;
            g *= 0.6;
            b *= 0.6;
          }
        } else {
          const shade = top ? 1.0 : 0.78;
          const noise = 0.92 + 0.16 * hash2(i, j, f.id);
          r *= shade * noise;
          g *= shade * noise;
          b *= shade * noise;
          if (lip) {
            r *= 1.08;
            g *= 1.06;
          }
        }
        col[o] = r;
        col[o + 1] = g;
        col[o + 2] = b;
      }
    }
    const idx: number[] = [];
    const k = vs.length;
    for (let i = 0; i < nu - 1; i++)
      for (let j = 0; j < k - 1; j++) {
        const a = i * k + j;
        const b = a + 1;
        const c = a + k;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Bend normals toward +Y: in back-lit worlds the take-off faces would otherwise face away
    // from the sun and read as dark slabs instead of sunlit dirt like the trail.
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < nrm.count; i++) {
      const nx = nrm.getX(i),
        ny = nrm.getY(i) + 1.6,
        nz = nrm.getZ(i);
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm.setXYZ(i, nx / l, ny / l, nz / l);
    }
    geos.push(ni(g));
    g.dispose();
    if (s.wood) {
      const deckEnd = s.lk + s.table;
      for (const u of [s.lk * 0.5, s.lk, deckEnd - 0.2])
        for (const side of [-1, 1]) {
          const v = side * (s.hw - 0.15);
          const x = f.x0 + f.dirX * u + f.rightX * v;
          const z = f.z0 + f.dirZ * u + f.rightZ * v;
          const top = f.heightAt(f.x0 + f.dirX * u, f.z0 + f.dirZ * u);
          const bottom = terrain.heightAt(x, z) - 0.3;
          const hgt = Math.max(0.2, top - bottom);
          posts.push(new THREE.Matrix4().compose(new THREE.Vector3(x, bottom + hgt / 2, z), new THREE.Quaternion(), new THREE.Vector3(0.18, hgt, 0.18)));
        }
    }
  }
  if (geos.length) {
    const merged = mergeGeometries(geos);
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, paintMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    // One-sheet surface: only faces turned away from the sun may cast, else it shadows itself.
    (mesh.material as THREE.Material).shadowSide = THREE.BackSide;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (posts.length) {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), paintMaterial({ color: 0x5a3a20 }), posts.length);
    posts.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = true;
    group.add(im);
  }
  return group;
}

export interface GateDef {
  s: number;
  kind: 'start' | 'checkpoint' | 'finish';
  x: number;
  z: number;
  h: number;
  heading: number;
  width: number;
}

function bannerTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 192;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < 12; i++) ctx.fillRect(0, i * 16, c.width, 6);
  ctx.font = '900 118px "Segoe UI Black", "Arial Black", Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.strokeText(text, c.width / 2, c.height / 2 + 6);
  ctx.fillStyle = fg;
  ctx.fillText(text, c.width / 2, c.height / 2 + 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Start / checkpoint / finish arches spanning the main trail. */
export function buildGates(gates: GateDef[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'gates';
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.11, 1, 8);
  const poleMat = paintMaterial({ color: 0xf2efe6 });
  const tex = {
    start: bannerTexture('START', '#d9452b', '#fff6e0'),
    checkpoint: bannerTexture('CHECKPOINT', '#3c62d6', '#fff6e0'),
    finish: bannerTexture('FINISH', '#1f1f28', '#ffd84a'),
  };
  for (const g of gates) {
    const w = g.width;
    const height = g.kind === 'checkpoint' ? 3.4 : 4.2;
    const root = new THREE.Group();
    root.position.set(g.x, g.h, g.z);
    root.rotation.y = -g.heading;
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.scale.set(1, height + 0.6, 1);
      pole.position.set((side * w) / 2, (height + 0.6) / 2 - 0.3, 0);
      pole.castShadow = true;
      root.add(pole);
    }
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.3, g.kind === 'checkpoint' ? 0.7 : 0.95, 0.06),
      paintMaterial({ map: tex[g.kind], saturation: 1.1 }),
    );
    banner.position.set(0, height, 0);
    banner.castShadow = true;
    root.add(banner);
    // pennant flags
    const flagMat = paintMaterial({ color: g.kind === 'finish' ? 0xffd84a : g.kind === 'start' ? 0xd9452b : 0x3c62d6, side: THREE.DoubleSide });
    for (const side of [-1, 1]) {
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.38), flagMat);
      flag.position.set((side * w) / 2 + side * 0.32, height + 0.45, 0);
      root.add(flag);
    }
    group.add(root);
  }
  return group;
}
