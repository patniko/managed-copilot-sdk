import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { patchMaterial, paintMaterial } from '../../render/globals';
import type { WorldContext } from '../types';
import { END_DEPTH, OPEN_END, ROOF_BEGIN, ROOF_END, TOWER_DEPTH, WIDE, XL, XL_NARROW, XR, groundY, roofY } from '../envs/city';
import { TOWER_TILE, paintTowerFacade, type FacadeTextures } from './cityTextures';

/** Indexed geometry accumulator with explicit normals, UVs and colours. */
export class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0, r = 1, g = 1, b = 1): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    return this.pos.length / 3 - 1;
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }
  /** Axis-aligned box (min/max corners) with a flat colour; UV from `uvOf(face, x, y, z)`. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, g: number, b: number, faces = 0b111111, uvOf?: (f: number, x: number, y: number, z: number) => [number, number]) {
    const F: Array<[number, number, number, number[][]]> = [
      [1, 0, 0, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
      [-1, 0, 0, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
      [0, 1, 0, [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
      [0, -1, 0, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
      [0, 0, 1, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
      [0, 0, -1, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
    ];
    F.forEach(([nx, ny, nz, q], f) => {
      if (!(faces & (1 << f))) return;
      const ids = q.map(([x, y, z]) => {
        const [u, v] = uvOf ? uvOf(f, x, y, z) : [0, 0];
        return this.vert(x, y, z, nx, ny, nz, u, v, r, g, b);
      });
      this.quad(ids[0], ids[1], ids[2], ids[3]);
    });
  }
  get empty() {
    return this.idx.length === 0;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Facade material: painted window texture with glowing windows. The map's alpha is "sun visibility": recessed
 * loggias and glass get only the violet sky light, so they read as the vivid blue shadow blocks of the video.
 */
export function facadeMaterial(t: FacadeTextures, emissiveIntensity: number, vertexColors = false): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ map: t.map, emissiveMap: t.emissive, emissive: 0xffffff, emissiveIntensity, vertexColors });
  return patchMaterial(m, {
    key: 'citySunVis',
    extend: (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_fragment>', '#include <map_fragment>\nfloat sunVis = diffuseColor.a;\ndiffuseColor.a = opacity;')
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= sunVis;');
    },
  });
}

interface Tower {
  s0: number;
  s1: number;
  /** Facade x (right face) and back face x. */
  x1: number;
  x0: number;
  top: number;
  uo: number;
}

/** Gigantic panel towers along the left of the roof (+ the head and end blocks that close it). */
function towerList(rng: Rng): Tower[] {
  const spans: Array<[number, number, number]> = [
    [ROOF_BEGIN, OPEN_END, 300],
    [OPEN_END, 232, 236],
    [232, 560, 200],
    [560, 910, 262],
    [910, 1152, 300],
    [1152, 1410, 236],
    [1410, 1670, 192],
    [1670, 1848, 320],
    [1848, 2050, 228],
    [2050, 2242, 176],
    [2242, 2480, 282],
    [2480, ROOF_END, 220],
  ];
  const out: Tower[] = spans.map(([s0, s1, h]) => {
    const xl = XL((s0 + s1) / 2);
    return { s0, s1, x1: xl, x0: xl - TOWER_DEPTH, top: roofY(s0) + h, uo: rng.next() };
  });
  // head and end blocks span the whole roof width
  out.push({ s0: ROOF_BEGIN - END_DEPTH, s1: ROOF_BEGIN, x1: XR + 0.6, x0: XL_NARROW - TOWER_DEPTH, top: roofY(ROOF_BEGIN) + 300, uo: rng.next() });
  out.push({ s0: ROOF_END, s1: ROOF_END + END_DEPTH, x1: XR + 0.6, x0: XL_NARROW - TOWER_DEPTH, top: roofY(ROOF_END) + 150, uo: rng.next() });
  return out;
}

function buildTowers(towers: Tower[]): THREE.BufferGeometry {
  const geo = new Geo();
  for (const t of towers) {
    const z0 = -t.s1;
    const z1 = -t.s0;
    const y0 = Math.min(groundY(z0), groundY(z1)) - 6;
    // world-anchored UVs: 3 m storeys and window bays line up across every face
    const uvOf = (f: number, x: number, y: number, z: number): [number, number] => {
      const v = y / TOWER_TILE;
      if (f === 0) return [-z / TOWER_TILE + t.uo, v];
      if (f === 1) return [z / TOWER_TILE + t.uo, v];
      if (f === 4) return [x / TOWER_TILE + t.uo, v];
      if (f === 5) return [-x / TOWER_TILE + t.uo, v];
      return [0.31, 0.31];
    };
    // the top is never seen from below; skip it and the bottom
    geo.box(t.x0, y0, z0, t.x1, t.top, z1, 1, 1, 1, 0b110011, uvOf);
  }
  return geo.build();
}

/**
 * The building's face below the roof edge. The heightfield's cliff isn't perfectly vertical (B-spline + trail
 * carving lean it out a few metres), so the facade is built by tracing the actual terrain and hugging it.
 */
function buildCliffFacade(ctx: WorldContext): THREE.BufferGeometry {
  const t = ctx.terrain;
  const geo = new Geo();
  const drops = [0.5, 1.1, 1.9, 2.9, 4.2, 6, 8.5, 12, 17, 24, 33, 45, 60, 80, 105, 135, 170];
  const sA = Math.max(ROOF_BEGIN, -t.maxZ + 2);
  const sB = Math.min(ROOF_END, -t.minZ - 2);
  const step = 2;
  const cols = Math.floor((sB - sA) / step) + 1;
  let prevRow: number[] | null = null;
  const prof = new Float32Array(141);
  for (let c = 0; c < cols; c++) {
    const s = sA + c * step;
    const z = -s;
    const xa = XR - 0.4;
    for (let k = 0; k < prof.length; k++) prof[k] = t.heightAt(xa + k * 0.1, z);
    const top = prof[0];
    const g = groundY(z);
    const bottom = g - 3;
    // where the cliff reaches the city: below that the facade simply drops straight down
    let kBase = prof.length - 1;
    for (let k2 = 0; k2 < prof.length; k2++)
      if (prof[k2] < g + 1.5) {
        kBase = k2;
        break;
      }
    const row: number[] = [];
    let k = 0;
    for (const d of drops) {
      let y = top - d;
      if (y < bottom) y = bottom;
      let x: number;
      if (y <= prof[kBase]) x = xa + kBase * 0.1 + 0.3;
      else {
        while (k < kBase - 1 && prof[k + 1] > y) k++;
        // interpolate where the profile crosses y, then stand 0.3 m proud of it
        const a = prof[k];
        const b = prof[k + 1];
        const f = a - b > 1e-4 ? Math.min(1, Math.max(0, (a - y) / (a - b))) : 0;
        x = xa + (k + f) * 0.1 + 0.3;
      }
      row.push(geo.vert(x, y, z, 1, 0, 0, -z / TOWER_TILE + 0.17, y / TOWER_TILE));
      if (y <= bottom) break;
    }
    while (row.length < drops.length) row.push(row[row.length - 1]);
    if (prevRow) for (let j = 0; j < row.length - 1; j++) if (row[j] !== row[j + 1] || prevRow[j] !== prevRow[j + 1]) geo.quad(prevRow[j], prevRow[j + 1], row[j + 1], row[j]);
    prevRow = row;
  }
  // beyond the detailed region the cliff is a plain vertical wall
  for (const [s0, s1] of [
    [ROOF_BEGIN, sA],
    [sB, ROOF_END],
  ]) {
    if (s1 - s0 < 1) continue;
    const yTop = (s: number) => roofY(s) - 0.4;
    const n = Math.ceil((s1 - s0) / 8);
    let prev: [number, number] | null = null;
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      const z = -s;
      const a = geo.vert(XR + 0.6, yTop(s), z, 1, 0, 0, -z / TOWER_TILE + 0.17, yTop(s) / TOWER_TILE);
      const b = geo.vert(XR + 0.6, groundY(z) - 3, z, 1, 0, 0, -z / TOWER_TILE + 0.17, (groundY(z) - 3) / TOWER_TILE);
      if (prev) geo.quad(prev[1], b, a, prev[0]);
      prev = [a, b];
    }
  }
  const g = geo.build();
  g.computeVertexNormals();
  return g;
}

/** Curb along the edge: inner face, top, and an outer face that reaches down to meet the facade. */
function buildCurb(ctx: WorldContext): THREE.BufferGeometry {
  const t = ctx.terrain;
  const geo = new Geo();
  const xi = XR - 1.0;
  const xo = XR - 0.4;
  let prev: number[] | null = null;
  const sA = Math.max(ROOF_BEGIN, -t.maxZ + 1);
  const sB = Math.min(ROOF_END, -t.minZ - 1);
  const c = new THREE.Color('#a9acd0');
  for (let s = sA; s <= sB; s += 1) {
    const z = -s;
    const h = t.heightAt(xi - 0.3, z);
    const hOut = t.heightAt(xo, z);
    const top = h + 0.16;
    const k = 0.94 + 0.06 * Math.sin(s * 0.37);
    const v = [
      geo.vert(xi, h - 0.3, z, -1, 0, 0, 0, 0, c.r * k * 0.86, c.g * k * 0.86, c.b * k * 0.9),
      geo.vert(xi, top, z, -1, 0, 0, 0, 0, c.r * k * 0.86, c.g * k * 0.86, c.b * k * 0.9),
      geo.vert(xi, top, z, 0, 1, 0, 0, 0, c.r * k * 1.15, c.g * k * 1.15, c.b * k * 1.12),
      geo.vert(xo, top, z, 0, 1, 0, 0, 0, c.r * k * 1.15, c.g * k * 1.15, c.b * k * 1.12),
      geo.vert(xo, top, z, 1, 0, 0, 0, 0, c.r * k, c.g * k * 0.95, c.b * k * 0.95),
      geo.vert(xo, Math.min(hOut, h) - 1.6, z, 1, 0, 0, 0, 0, c.r * k, c.g * k * 0.95, c.b * k * 0.95),
    ];
    if (prev) {
      geo.quad(prev[0], prev[1], v[1], v[0]);
      geo.quad(prev[2], prev[3], v[3], v[2]);
      geo.quad(prev[4], prev[5], v[5], v[4]);
    }
    prev = v;
  }
  return geo.build();
}

/** Thin see-through railing on the curb (posts, balusters, two rails) + the cable along the tower facades. */
function buildRailing(ctx: WorldContext, root: THREE.Group) {
  const t = ctx.terrain;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // thin metal reads in the video; mark it in the subject mask so the paint pass uses its finest brush on it
  // instead of melting the balusters into the bright city behind
  patchMaterial(mat, {
    key: 'cityRail',
    extend: (shader) => {
      const i = shader.fragmentShader.lastIndexOf('}');
      shader.fragmentShader = shader.fragmentShader.slice(0, i) + '\n gl_FragColor.a = 0.1;\n}';
    },
  });
  const x = XR - 0.7;
  const CH = 120;
  const sA = Math.max(ROOF_BEGIN, -t.maxZ + 1);
  const sB = Math.min(ROOF_END, -t.minZ - 1);
  const dark = [0.035, 0.035, 0.06] as const;
  for (let c0 = sA; c0 < sB; c0 += CH) {
    const c1 = Math.min(sB, c0 + CH);
    const geo = new Geo();
    const hAt = (s: number) => t.heightAt(XR - 1.3, -s) + 0.16;
    // posts and balusters
    for (let s = c0; s < c1; s += 0.36) {
      const post = Math.abs((s / 1.44) % 1) < 0.25 || s === c0;
      const w = post ? 0.05 : 0.018;
      const h = hAt(s);
      geo.box(x - w, h, -s - w, x + w, h + 0.66, -s + w, dark[0], dark[1], dark[2], 0b110011);
    }
    // rails: top (handrail), middle, bottom
    for (const [dy, hw] of [
      [0.66, 0.03],
      [0.36, 0.012],
      [0.08, 0.016],
    ] as const) {
      let prev: number[] | null = null;
      for (let s = c0; s <= c1 + 0.01; s += 2) {
        const z = -s;
        const y = hAt(s) + dy;
        const v = [
          geo.vert(x - hw, y + hw, z, -0.7, 0.7, 0, 0, 0, ...dark),
          geo.vert(x + hw, y + hw, z, 0.7, 0.7, 0, 0, 0, ...dark),
          geo.vert(x + hw, y - hw, z, 0.7, -0.7, 0, 0, 0, ...dark),
          geo.vert(x - hw, y - hw, z, -0.7, -0.7, 0, 0, 0, ...dark),
        ];
        if (prev) for (let k = 0; k < 4; k++) geo.quad(prev[k], prev[(k + 1) % 4], v[(k + 1) % 4], v[k]);
        prev = v;
      }
    }
    // the cable along the facade where the towers stand close (the video's diagonal handrail)
    {
      let prev: number[] | null = null;
      for (let s = c0; s <= c1 + 0.01; s += 3) {
        const xl = XL(s);
        if (xl < XL_NARROW || XL(s - 1.5) !== xl || XL(s + 1.5) !== xl) {
          prev = null;
          continue;
        }
        const cx = xl + 0.2;
        const y = t.heightAt(cx + 0.5, -s) + 1.25;
        const v = [geo.vert(cx, y + 0.03, -s, 1, 0.3, 0, 0, 0, 0.05, 0.05, 0.08), geo.vert(cx + 0.06, y - 0.03, -s, 1, -0.3, 0, 0, 0, 0.05, 0.05, 0.08)];
        if (prev) geo.quad(prev[0], prev[1], v[1], v[0]);
        prev = v;
      }
    }
    const mesh = new THREE.Mesh(geo.build(), mat);
    // the low sun would rake long railing shadows over the whole roof; the video's light is soft
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    root.add(mesh);
  }
}

function nearFeature(ctx: WorldContext, x: number, z: number, pad: number) {
  for (const f of ctx.features) {
    const b = f.bbox;
    if (x > b.min.x - pad && x < b.max.x + pad && z > b.min.y - pad && z < b.max.y + pad) return true;
  }
  return false;
}

/** Roof clutter: mushroom vents, hatches and boxes, always well clear of the lines (camera room). */
function buildRoofProps(ctx: WorldContext, rng: Rng): THREE.Object3D[] {
  const t = ctx.terrain;
  // unit geometries
  const vent = new Geo();
  {
    const segs = 10;
    const ring = (y: number, r: number, ny: number, k: number) => {
      const ids: number[] = [];
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        ids.push(vent.vert(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(a) * (1 - Math.abs(ny)), ny, Math.sin(a) * (1 - Math.abs(ny)), 0, 0, 0.86 * k, 0.86 * k, 0.94 * k));
      }
      return ids;
    };
    const pipeB = ring(-0.1, 0.16, 0, 0.8);
    const pipeT = ring(0.55, 0.16, 0, 0.9);
    const capB = ring(0.5, 0.42, -0.6, 0.75);
    const capT = ring(0.72, 0.05, 0.95, 1.05);
    for (let i = 0; i < segs; i++) {
      vent.quad(pipeB[i], pipeT[i], pipeT[i + 1], pipeB[i + 1]);
      vent.quad(capB[i], capT[i], capT[i + 1], capB[i + 1]);
    }
  }
  const hatch = new Geo();
  hatch.box(-0.6, -0.1, -0.6, 0.6, 0.45, 0.6, 0.8, 0.79, 0.9, 0b110111);
  hatch.box(-0.5, 0.45, -0.5, 0.5, 0.5, 0.5, 0.55, 0.56, 0.72, 0b000100);
  const vents: THREE.Matrix4[] = [];
  const hatches: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let s = ROOF_BEGIN + 8; s < ROOF_END - 20; s += 7 + rng.next() * 16) {
    const xl = XL(s);
    const x = xl + 2.5 + rng.next() * (XR - 2 - xl - 2.5);
    const z = -s;
    // ≥ 4.5 m from any line's centre (≥ 3.9 m from its edge) and off the jumps
    if (t.trailDistAt(x, z) < 3.9 || nearFeature(ctx, x, z, 2.5)) continue;
    const h = t.heightAt(x, z);
    const isVent = rng.chance(0.62);
    const sc = isVent ? 0.9 + rng.next() * 0.5 : 0.8 + rng.next() * 0.9;
    q.setFromAxisAngle(up, rng.next() * Math.PI);
    m.compose(new THREE.Vector3(x, h, z), q, new THREE.Vector3(sc, sc, sc));
    (isVent ? vents : hatches).push(m.clone());
    ctx.addCollider(x, z, isVent ? 0.4 * sc : 0.75 * sc, h + 0.75 * sc, 'solid');
  }
  const mat = paintMaterial({ vertexColors: true });
  const out: THREE.Object3D[] = [];
  for (const [g, list] of [
    [vent, vents],
    [hatch, hatches],
  ] as const) {
    const im = new THREE.InstancedMesh(g.build(), mat, Math.max(1, list.length));
    list.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.count = list.length;
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    out.push(im);
  }
  return out;
}

/** Dark tar cracks and membrane seams draped over the roof (chunked for culling). */
function buildCracks(ctx: WorldContext, rng: Rng, root: THREE.Group) {
  const t = ctx.terrain;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: 0 });
  patchMaterial(mat);
  const CH = 160;
  const sA = Math.max(ROOF_BEGIN + 4, -t.maxZ + 4);
  const sB = Math.min(ROOF_END - 4, -t.minZ - 4);
  const crack = [0.13, 0.12, 0.26] as const;
  const seam = [0.36, 0.36, 0.62] as const;
  for (let c0 = sA - 20; c0 < sB; c0 += CH) {
    const geo = new Geo();
    const strip = (pts: Array<[number, number, number]>, col: readonly [number, number, number]) => {
      // pts: x, z, half width
      let prev: number[] | null = null;
      for (let i = 0; i < pts.length; i++) {
        const [x, z, w] = pts[i];
        const nx = i < pts.length - 1 ? pts[i + 1][0] - x : x - pts[i - 1][0];
        const nz = i < pts.length - 1 ? pts[i + 1][1] - z : z - pts[i - 1][1];
        const l = Math.hypot(nx, nz) || 1;
        const rx = -nz / l;
        const rz = nx / l;
        const xa = x + rx * w;
        const za = z + rz * w;
        const xb = x - rx * w;
        const zb = z - rz * w;
        const v = [geo.vert(xa, t.heightAt(xa, za) + 0.025, za, 0, 1, 0, 0, 0, ...col), geo.vert(xb, t.heightAt(xb, zb) + 0.025, zb, 0, 1, 0, 0, 0, ...col)];
        if (prev) geo.quad(prev[0], v[0], v[1], prev[1]);
        prev = v;
      }
    };
    const onRoof = (x: number, s: number) => s > sA && s < sB && x < XR - 1.1 && x > XL(s) + 0.4;
    // long wandering cracks, mostly following the fall line (like the big crack in the video)
    for (let k = 0; k < 9; k++) {
      let s = c0 + rng.next() * CH;
      let x = XL(s) + 1 + rng.next() * (XR - 2 - XL(s) - 1);
      if (rng.chance(0.35)) x = XR - 2.2 - rng.next() * 3;
      let a = (rng.next() - 0.5) * 0.5;
      const len = 8 + rng.next() * 30;
      const pts: Array<[number, number, number]> = [];
      for (let d = 0; d < len && onRoof(x, s); d += 0.45) {
        const w = 0.035 + 0.05 * Math.abs(Math.sin(d * 1.7 + k)) + (rng.chance(0.06) ? 0.12 : 0);
        pts.push([x, -s, w]);
        a += (rng.next() - 0.5) * 0.9;
        a *= 0.9;
        x += Math.sin(a) * 0.45;
        s += Math.cos(a) * 0.45;
        // branches
        if (rng.chance(0.03)) {
          const bp: Array<[number, number, number]> = [];
          let bx = x;
          let bs = s;
          let ba = a + (rng.chance(0.5) ? 1 : -1) * (0.8 + rng.next() * 0.6);
          for (let e = 0; e < 3 + rng.next() * 5 && onRoof(bx, bs); e += 0.4) {
            bp.push([bx, -bs, 0.025]);
            ba += (rng.next() - 0.5) * 0.8;
            bx += Math.sin(ba) * 0.4;
            bs += Math.cos(ba) * 0.4;
          }
          if (bp.length > 1) strip(bp, crack);
        }
      }
      if (pts.length > 1) strip(pts, crack);
    }
    // membrane seams across the roof
    for (let s = Math.ceil(c0 / 9.5) * 9.5; s < c0 + CH; s += 9.5) {
      if (s < sA || s > sB) continue;
      const pts: Array<[number, number, number]> = [];
      for (let x = XL(s) + 0.5; x < XR - 1.1; x += 1.5) pts.push([x, -s + 0.15 * Math.sin(x * 0.7), 0.03]);
      if (pts.length > 1 && rng.chance(0.75)) strip(pts, seam);
    }
    if (geo.empty) continue;
    const mesh = new THREE.Mesh(geo.build(), mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    root.add(mesh);
  }
}

/** Physics: railing, facade bases, end wall, and invisible "fall" colliders just past the edge. */
function addColliders(ctx: WorldContext) {
  const t = ctx.terrain;
  const sA = Math.max(ROOF_BEGIN, -t.maxZ + 1);
  const sB = Math.min(ROOF_END, -t.minZ - 1);
  for (let s = sA; s <= sB; s += 0.6) {
    const h = t.heightAt(XR - 1.3, -s);
    ctx.addCollider(XR - 0.7, -s, 0.3, h + 0.82, 'solid');
  }
  for (let s = sA; s <= sB; s += 2) {
    const h = roofY(s);
    // past the railing a rider is falling: crash within ~3 m of drop instead of a long fall to the city
    ctx.addCollider(XR + 2.4, -s, 1.7, h - 2.5, 'solid');
    ctx.addCollider(XR + 6.2, -s, 2.0, h - 6, 'solid');
    ctx.addCollider(XR + 10.4, -s, 2.2, h - 11, 'solid');
  }
  for (let s = sA; s <= sB; s += 1.2) {
    const xl = XL(s);
    ctx.addCollider(xl - 0.55, -s, 0.7, roofY(s) + 40, 'solid');
  }
  // tower side walls where the facade steps in or out
  const steps: number[] = [OPEN_END];
  for (const [a, b] of WIDE) steps.push(a, b);
  for (const s of steps) {
    const xa = Math.min(XL(s - 2), XL(s + 2));
    const xb = Math.max(XL(s - 2), XL(s + 2));
    for (let x = xa; x <= xb; x += 1.2) ctx.addCollider(x, -s, 0.7, roofY(s) + 40, 'solid');
  }
  for (let x = XL_NARROW; x <= XR; x += 1.2) ctx.addCollider(x, -ROOF_END - 0.5, 0.7, roofY(ROOF_END) + 40, 'solid');
}

export function buildMegastructure(ctx: WorldContext, root: THREE.Group) {
  const rng = new Rng(9187);
  const tex = paintTowerFacade(77);
  const facadeMat = facadeMaterial(tex, 1.7);
  const towers = new THREE.Mesh(buildTowers(towerList(rng)), facadeMat);
  towers.frustumCulled = false;
  towers.receiveShadow = true;
  root.add(towers);
  const cliff = new THREE.Mesh(buildCliffFacade(ctx), facadeMat);
  cliff.frustumCulled = false;
  root.add(cliff);
  const curb = new THREE.Mesh(buildCurb(ctx), paintMaterial({ vertexColors: true }));
  curb.receiveShadow = true;
  curb.castShadow = true;
  root.add(curb);
  buildRailing(ctx, root);
  for (const o of buildRoofProps(ctx, rng)) root.add(o);
  buildCracks(ctx, rng, root);
  addColliders(ctx);
}
