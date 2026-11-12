import * as THREE from 'three';
import type { RGB, TerrainSpec } from './types';
import { makeTerrainMaterial } from './terrainMesh';

/**
 * Distant terrain surrounding the rideable region: an inner ring (fine) and an outer ring (coarse),
 * both with the region cut out. Vertices that fall inside the region are pushed below the detailed terrain.
 */
export function buildBackdrop(spec: TerrainSpec): THREE.Group {
  const group = new THREE.Group();
  group.name = 'backdrop';
  const r = spec.region;
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const mat = makeTerrainMaterial();
  const rings = [
    { half: 7000, cell: 40, hole: r, pad: 0 },
    { half: 26000, cell: 320, hole: { minX: cx - 6800, maxX: cx + 6800, minZ: cz - 6800, maxZ: cz + 6800 }, pad: 0 },
  ];
  const col: RGB = [0, 0, 0];
  for (const ring of rings) {
    const n = Math.ceil((ring.half * 2) / ring.cell) + 1;
    const x0 = cx - ring.half;
    const z0 = cz - ring.half;
    const pos = new Float32Array(n * n * 3);
    const colors = new Float32Array(n * n * 3);
    const hole = ring.hole;
    const inHole = (x: number, z: number, m: number) => x > hole.minX + m && x < hole.maxX - m && z > hole.minZ + m && z < hole.maxZ - m;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = x0 + i * ring.cell;
        const z = z0 + j * ring.cell;
        let h = spec.farHeight(x, z);
        if (inHole(x, z, 0)) h -= ring === rings[0] ? 6 : 60;
        const o = (j * n + i) * 3;
        pos[o] = x;
        pos[o + 1] = h;
        pos[o + 2] = z;
      }
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const xa = x0 + i * ring.cell;
        const za = z0 + j * ring.cell;
        const xb = xa + ring.cell;
        const zb = za + ring.cell;
        const m = ring.cell * 1.01;
        if (inHole(xa, za, m) && inHole(xb, zb, m) && inHole(xa, zb, m) && inHole(xb, za, m)) continue;
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(n * n > 65535 ? new THREE.BufferAttribute(new Uint32Array(idx), 1) : new THREE.BufferAttribute(new Uint16Array(idx), 1));
    g.computeVertexNormals();
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let k = 0; k < n * n; k++) {
      spec.farColor(pos[k * 3], pos[k * 3 + 2], pos[k * 3 + 1], nor.getY(k), col);
      colors[k * 3] = col[0];
      colors[k * 3 + 1] = col[1];
      colors[k * 3 + 2] = col[2];
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}
