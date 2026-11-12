import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { paintMaterial, patchMaterial } from '../../render/globals';
import { END_DEPTH, ROOF_BEGIN, ROOF_END, XB, XR, groundY } from '../envs/city';
import { ATLAS_BAYS, SWATCH, facadeV, paintBlockAtlas } from './cityTextures';
import { Geo } from './cityMega';

/** Boulevard cross-section (offsets from XB). */
export const BLVD = { median: 3, lanes: 16, verge: 21, service: 21, walk: 25 };
/** Comb pitch along the boulevard. */
const PITCH = 96;
/** City extent along the boulevard (z). */
export const CITY_Z0 = 3200;
export const CITY_Z1 = -14000;
/** The megastructure's base occupies x < XR + 12 between these z (the left comb starts beyond it). */
const megaZ0 = () => -(ROOF_BEGIN - END_DEPTH);
const megaZ1 = () => -(ROOF_END + END_DEPTH);

export interface Block {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  h: number;
  kind: 'slab' | 'low';
  variant: number;
  u0: number;
}

/** Lay out the micro-districts: one clean comb of slab blocks each side of the boulevard, yards in between. */
export function layoutBlocks(rng: Rng): Block[] {
  const out: Block[] = [];
  const slab = (x0: number, x1: number, zc: number, storeys = 16, depth = 14) => {
    out.push({ x0, x1, z0: zc - depth / 2, z1: zc + depth / 2, h: storeys * 2.8 + 1.2, kind: 'slab', variant: rng.int(0, 2), u0: rng.next() });
  };
  const low = (xc: number, zc: number, w: number, d: number) => {
    out.push({ x0: xc - w / 2, x1: xc + w / 2, z0: zc - d / 2, z1: zc + d / 2, h: 7 + rng.int(0, 1) * 3.4, kind: 'low', variant: 2, u0: rng.next() });
  };
  for (let k = Math.floor(-CITY_Z0 / PITCH); k * PITCH < -CITY_Z1; k++) {
    const zc = -(k * PITCH + 30);
    // right comb: identical long slabs perpendicular to the boulevard, ends toward it (the video's "comb")
    slab(XB + 31, XB + 31 + 116 + rng.next() * 10, zc);
    if (rng.chance(0.28)) low(XB + 70 + rng.next() * 40, zc - PITCH / 2, 30 + rng.next() * 14, 18 + rng.next() * 6);
    // left of the boulevard: past the megastructure's ends a comb like the right one (the video's last shot);
    // at its foot a shorter comb between the cliff and the avenue, with low blue-roofed annexes
    const zl = zc - PITCH / 2;
    const megaHere = zl < megaZ0() && zl > megaZ1() - 30;
    if (megaHere) {
      const r = rng.next();
      if (r < 0.8) slab(XR + 9, XB - BLVD.walk - 4 - rng.next() * 6, zl, rng.chance(0.6) ? 16 : 14);
      else low(XR + 30, zl, 26 + rng.next() * 10, 18 + rng.next() * 8);
      if (rng.chance(0.3)) low(XB - BLVD.walk - 18, zl - PITCH / 2, 20 + rng.next() * 8, 14 + rng.next() * 6);
    } else {
      slab(XB - 143, XB - 31, zl);
      if (rng.chance(0.4)) low(XB - 70 - rng.next() * 20, zl - PITCH / 2, 24 + rng.next() * 10, 16 + rng.next() * 6);
    }
  }
  return out;
}

/** One merged mesh for every block (single draw call): atlas facades, flat roofs with machine rooms. */
function buildBlockGeometry(blocks: Block[], rng: Rng): THREE.BufferGeometry {
  const geo = new Geo();
  const bay = 4.2;
  const P = SWATCH.plinth;
  for (const b of blocks) {
    const y0 = Math.min(groundY(b.z0), groundY(b.z1)) - 3;
    const yGround = Math.max(groundY(b.z0), groundY(b.z1));
    const y1 = yGround + b.h;
    const [vb, vt] = facadeV(b.variant);
    const rowsV = (vt - vb) / 16;
    const vTop = Math.min(vt - 0.0005, vb + (b.h / (b.kind === 'low' ? 3.4 : 2.8)) * rowsV);
    const t = 0.92 + rng.next() * 0.1;
    // a wall from A to B (outward normal n): dark plinth below the ground floor, the atlas facade above it
    const wall = (xA: number, zA: number, xB: number, zB: number, nx: number, nz: number, uA: number, uB: number) => {
      const p0 = geo.vert(xA, y0, zA, nx, 0, nz, P[0], P[1], t, t, t);
      const p1 = geo.vert(xB, y0, zB, nx, 0, nz, P[0], P[1], t, t, t);
      const p2 = geo.vert(xB, yGround, zB, nx, 0, nz, P[0], P[1], t, t, t);
      const p3 = geo.vert(xA, yGround, zA, nx, 0, nz, P[0], P[1], t, t, t);
      geo.quad(p0, p1, p2, p3);
      const f0 = geo.vert(xA, yGround, zA, nx, 0, nz, uA, vb, t, t, t);
      const f1 = geo.vert(xB, yGround, zB, nx, 0, nz, uB, vb, t, t, t);
      const f2 = geo.vert(xB, y1, zB, nx, 0, nz, uB, vTop, t, t, t);
      const f3 = geo.vert(xA, y1, zA, nx, 0, nz, uA, vTop, t, t, t);
      geo.quad(f0, f1, f2, f3);
    };
    const span = (m: number) => m / (bay * ATLAS_BAYS);
    const L = b.x1 - b.x0;
    const D = b.z1 - b.z0;
    const g = b.u0 + span(L) + 0.01;
    wall(b.x0, b.z1, b.x1, b.z1, 0, 1, b.u0, b.u0 + span(L)); // +z long facade (faces the run)
    wall(b.x1, b.z0, b.x0, b.z0, 0, -1, b.u0 + 0.37, b.u0 + 0.37 + span(L)); // -z long facade
    wall(b.x1, b.z1, b.x1, b.z0, 1, 0, g, g + span(D * 0.7)); // gables
    wall(b.x0, b.z0, b.x0, b.z1, -1, 0, g + 0.2, g + 0.2 + span(D * 0.7));
    const roof = b.kind === 'low' ? SWATCH.blueRoof : SWATCH.roof;
    geo.box(b.x0, y1 - 0.2, b.z0, b.x1, y1, b.z1, b.kind === 'low' ? 1 : 0.95, b.kind === 'low' ? 1 : 0.95, 1, 0b000100, () => [roof[0], roof[1]]);
    // roof machine rooms on the slabs (the little boxes in the video)
    if (b.kind === 'slab') {
      const n = 1 + Math.floor(L / 40);
      for (let i = 0; i < n; i++) {
        const cx = b.x0 + ((i + 0.5) * L) / n + (rng.next() - 0.5) * 6;
        const cz = (b.z0 + b.z1) / 2 + (rng.next() - 0.5) * 3;
        const w = 3 + rng.next() * 3;
        const d = 3 + rng.next() * 2;
        geo.box(cx - w / 2, y1, cz - d / 2, cx + w / 2, y1 + 2.6 + rng.next(), cz + d / 2, 0.95, 0.95, 1, 0b110111, () => [SWATCH.wall[0], SWATCH.wall[1]]);
      }
    } else {
      // low buildings: a light rim around the blue roof
      geo.box(b.x0 - 0.3, y1, b.z0 - 0.3, b.x1 + 0.3, y1 + 0.5, b.z1 + 0.3, 1, 1, 1, 0b110011, () => [SWATCH.wall[0], SWATCH.wall[1]]);
    }
  }
  return geo.build();
}

/** Spatial hash over block footprints (yard placement queries). */
class BlockGrid {
  private cells = new Map<number, Block[]>();
  constructor(
    blocks: Block[],
    private readonly c = 64,
  ) {
    for (const b of blocks)
      for (let gx = Math.floor((b.x0 - 8) / c); gx <= Math.floor((b.x1 + 8) / c); gx++)
        for (let gz = Math.floor((b.z0 - 8) / c); gz <= Math.floor((b.z1 + 8) / c); gz++) {
          const k = gx * 73856093 + gz * 19349663;
          let a = this.cells.get(k);
          if (!a) this.cells.set(k, (a = []));
          a.push(b);
        }
  }
  hit(x: number, z: number, pad: number) {
    const a = this.cells.get(Math.floor(x / this.c) * 73856093 + Math.floor(z / this.c) * 19349663);
    if (a) for (const b of a) if (x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad) return true;
    return false;
  }
}

/** Flat paving: the boulevard (median, carriageways, verges, service roads, walks), cross streets, yard paths. */
function buildFloor(blocks: Block[], rng: Rng): THREE.BufferGeometry {
  const geo = new Geo();
  const strip = (x0: number, x1: number, z0: number, z1: number, lift: number, c: readonly [number, number, number]) => {
    // split along z so the strip follows the sloping ground
    const n = Math.max(1, Math.ceil((z1 - z0) / 60));
    let prev: number[] | null = null;
    for (let i = 0; i <= n; i++) {
      const z = z0 + ((z1 - z0) * i) / n;
      const y = groundY(z) + lift;
      const v = [geo.vert(x0, y, z, 0, 1, 0, 0, 0, ...c), geo.vert(x1, y, z, 0, 1, 0, 0, 0, ...c)];
      if (prev) geo.quad(prev[0], prev[1], v[1], v[0]);
      prev = v;
    }
  };
  const ASPH: [number, number, number] = [0.06, 0.065, 0.12];
  const WALK: [number, number, number] = [0.32, 0.31, 0.46];
  const MEDIAN: [number, number, number] = [0.05, 0.13, 0.07];
  const LINE: [number, number, number] = [0.5, 0.5, 0.62];
  const z0 = CITY_Z1;
  const z1 = CITY_Z0;
  for (const side of [-1, 1]) {
    const a = (o: number) => XB + side * o;
    const lo = (p: number, q: number) => [Math.min(a(p), a(q)), Math.max(a(p), a(q))] as const;
    let [p, q] = lo(BLVD.median, BLVD.lanes);
    strip(p, q, z0, z1, 0.25, ASPH);
    [p, q] = lo(BLVD.lanes, BLVD.verge);
    strip(p, q, z0, z1, 0.22, MEDIAN);
    if (BLVD.service > BLVD.verge) {
      [p, q] = lo(BLVD.verge, BLVD.service);
      strip(p, q, z0, z1, 0.25, ASPH);
    }
    [p, q] = lo(BLVD.service, BLVD.walk);
    strip(p, q, z0, z1, 0.28, WALK);
    // lane lines
    for (const o of [6.25, 9.5, 12.75]) strip(a(o) - 0.08, a(o) + 0.08, z0, z1, 0.3, LINE);
  }
  strip(XB - BLVD.median, XB + BLVD.median, z0, z1, 0.24, MEDIAN);
  // cross streets every few blocks, and yard paths along each slab's long side
  for (let z = 30 - PITCH * 2; z > CITY_Z1; z -= PITCH * 4) {
    const zc = z - PITCH * 0.75;
    const w = 7;
    for (const [xa, xb] of [
      [XB + BLVD.walk, XB + 470],
      [XB - 470, XB - BLVD.walk],
    ]) {
      if (xa < XR + 14 && zc < megaZ0() && zc > megaZ1()) continue;
      const n = Math.ceil((xb - xa) / 40);
      let prev: number[] | null = null;
      for (let i = 0; i <= n; i++) {
        const x = xa + ((xb - xa) * i) / n;
        const v = [geo.vert(x, groundY(zc + w) + 0.26, zc + w, 0, 1, 0, 0, 0, ...ASPH), geo.vert(x, groundY(zc - w) + 0.26, zc - w, 0, 1, 0, 0, 0, ...ASPH)];
        if (prev) geo.quad(prev[0], v[0], v[1], prev[1]);
        prev = v;
      }
    }
  }
  for (const b of blocks) {
    if (b.kind !== 'slab' || b.x1 - b.x0 < 40) continue;
    const front = b.z1 + 7 + rng.next() * 3;
    // a walk in front of the entrances and a parking strip next to it
    const pts = (zA: number, zB: number, c: readonly [number, number, number], lift: number) => {
      const n = Math.ceil((b.x1 - b.x0 + 8) / 30);
      let prev: number[] | null = null;
      for (let i = 0; i <= n; i++) {
        const x = b.x0 - 4 + ((b.x1 - b.x0 + 8) * i) / n;
        const v = [geo.vert(x, groundY(zB) + lift, zB, 0, 1, 0, 0, 0, ...c), geo.vert(x, groundY(zA) + lift, zA, 0, 1, 0, 0, 0, ...c)];
        if (prev) geo.quad(prev[0], v[0], v[1], prev[1]);
        prev = v;
      }
    };
    pts(front - 1.4, front + 1.4, WALK, 0.3);
    if (rng.chance(0.6)) pts(front + 1.6, front + 7.5, [0.12, 0.12, 0.2], 0.27);
  }
  return geo.build();
}

/** Tree canopies: boulevard rows, yard clusters, and the forest beyond the districts. */
function buildTrees(blocks: Block[], rng: Rng): THREE.InstancedMesh {
  const base = new THREE.IcosahedronGeometry(1, 0);
  base.scale(1, 0.72, 1);
  base.translate(0, 0.55, 0);
  const pos = base.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = 0.55 + 0.45 * Math.min(1, Math.max(0, y / 1.2));
    col[i * 3] = 0.12 * k;
    col[i * 3 + 1] = 0.3 * k;
    col[i * 3 + 2] = 0.16 * k;
  }
  base.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mats: Array<[number, number, number, number]> = [];
  const grid = new BlockGrid(blocks);
  const megaBase = (x: number, z: number) => x < XR + 12 && z < megaZ0() && z > megaZ1();
  const add = (x: number, z: number, s: number) => {
    if (megaBase(x, z)) return;
    mats.push([x, groundY(z) - 0.5, z, s]);
  };
  // boulevard rows
  for (let z = CITY_Z0; z > CITY_Z1; z -= 9) {
    for (const o of [-18.5, 18.5]) if (rng.chance(0.9)) add(XB + o + (rng.next() - 0.5), z + rng.next() * 3, 3.0 + rng.next() * 1.4);
    if (rng.chance(0.55)) add(XB + (rng.next() - 0.5) * 3, z, 2.6 + rng.next() * 1.2);
  }
  // yards and the strip under the megastructure
  const near = { x0: XR + 10, x1: XB + 470, z0: 1800, z1: -4200 };
  for (let i = 0; i < 6500; i++) {
    const cx = near.x0 + rng.next() * (near.x1 - near.x0);
    const cz = near.z1 + rng.next() * (near.z0 - near.z1);
    if (Math.abs(cx - XB) < BLVD.walk + 2) continue;
    const n = 1 + Math.floor(rng.next() * 5);
    for (let k = 0; k < n; k++) {
      const x = cx + rng.gauss() * 6;
      const z = cz + rng.gauss() * 6;
      if (Math.abs(x - XB) < BLVD.walk + 2 || grid.hit(x, z, 4)) continue;
      add(x, z, 2.8 + rng.next() * 2.4);
    }
  }
  // the far side beyond the megastructure's end, and the forest belts beyond the districts
  for (let i = 0; i < 7000; i++) {
    const right = rng.chance(0.62);
    const x = right ? XB + 470 + rng.next() * 2600 : XB - 520 - rng.next() * 2600;
    const z = 1500 - rng.next() * 9500;
    if (grid.hit(x, z, 4)) continue;
    add(x, z, 4 + rng.next() * 4);
  }
  for (let i = 0; i < 2500; i++) {
    const x = XB - 520 + rng.next() * 380;
    const z = megaZ1() - 40 - rng.next() * 3000;
    if (Math.abs(x - XB) < BLVD.walk + 2 || grid.hit(x, z, 4)) continue;
    add(x, z, 3 + rng.next() * 2.5);
  }
  const mat = paintMaterial({ vertexColors: true });
  const im = new THREE.InstancedMesh(base, mat, mats.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  mats.forEach(([x, y, z, s], i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.next() * 6.28);
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s * (0.85 + rng.next() * 0.4), s));
    im.setMatrixAt(i, m);
    im.setColorAt(i, c.setHSL(0.3 + rng.next() * 0.08, 0.45, 0.32 + rng.next() * 0.2));
  });
  im.frustumCulled = false;
  return im;
}

/** Street lamps: glowing heads along the boulevard and the yard walks. */
function buildLamps(blocks: Block[], rng: Rng): THREE.InstancedMesh {
  const g = new THREE.OctahedronGeometry(0.55, 0);
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff1dc').multiplyScalar(5) });
  patchMaterial(mat);
  const pts: Array<[number, number, number]> = [];
  for (let z = CITY_Z0; z > CITY_Z1; z -= 32) {
    for (const o of [-BLVD.lanes - 1.5, BLVD.lanes + 1.5, -BLVD.service - 1, BLVD.service + 1]) pts.push([XB + o, groundY(z) + 9, z + (o > 0 ? 16 : 0)]);
    pts.push([XB, groundY(z) + 10, z + 8]);
  }
  for (const b of blocks) {
    if (b.kind !== 'slab' || rng.chance(0.3)) continue;
    for (let x = b.x0; x < b.x1; x += 26 + rng.next() * 14) pts.push([x, groundY(b.z1) + 5, b.z1 + 9]);
  }
  const im = new THREE.InstancedMesh(g, mat, pts.length);
  const m = new THREE.Matrix4();
  pts.forEach(([x, y, z], i) => im.setMatrixAt(i, m.makeTranslation(x, y, z)));
  im.frustumCulled = false;
  return im;
}

export function buildTown(root: THREE.Group): { blocks: Block[] } {
  const rng = new Rng(2207);
  const blocks = layoutBlocks(rng);
  const atlas = paintBlockAtlas(31);
  const blockMat = new THREE.MeshLambertMaterial({ map: atlas.map, emissiveMap: atlas.emissive, emissive: 0xffffff, emissiveIntensity: 1.9, vertexColors: true });
  // far away the lit windows average into an orange wash; keep the distant facades lavender like the video.
  // Lit windows also mark themselves in the scene alpha (the engine's subject mask): the paint pass then uses a
  // finer brush on them, so they stay crisp dots like the video instead of melting into the wall.
  patchMaterial(blockMat, {
    key: 'cityBlocks',
    extend: (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float cityWin = smoothstep(0.08, 0.35, max(totalEmissiveRadiance.r, totalEmissiveRadiance.g) / max(emissive.r, 1e-3));
        totalEmissiveRadiance *= mix(1.0, 0.7, smoothstep(300.0, 2500.0, length(vAtmoWorldPos - cameraPosition)));
        // the bright dusk sky fills the shaded walls with a cool lavender-blue light
        totalEmissiveRadiance += diffuseColor.rgb * vec3(0.05, 0.06, 0.16);`,
      );
      const i = shader.fragmentShader.lastIndexOf('}');
      shader.fragmentShader = shader.fragmentShader.slice(0, i) + '\n gl_FragColor.a = 1.0 - 0.9 * cityWin;\n}';
    },
  });
  const mesh = new THREE.Mesh(buildBlockGeometry(blocks, rng), blockMat);
  mesh.frustumCulled = false;
  root.add(mesh);
  const floorMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: 0 });
  patchMaterial(floorMat);
  const floor = new THREE.Mesh(buildFloor(blocks, rng), floorMat);
  floor.frustumCulled = false;
  root.add(floor);
  root.add(buildTrees(blocks, rng));
  root.add(buildLamps(blocks, rng));
  return { blocks };
}
