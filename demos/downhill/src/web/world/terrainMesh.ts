import * as THREE from 'three';
import { patchMaterial } from '../render/globals';
import { sharedDetailTexture } from '../render/textures';
import type { TerrainData } from './terrain';
import type { GroundSample, RGB, TerrainSpec } from './types';

const CHUNK = 64;
const SUPER = 4; // chunks per super-chunk side
const LOD_SPACING = [1, 2, 4, 8];
const LOD_DIST = [100, 240, 560];
const SUPER_DIST = 700;

interface Chunk {
  x0: number;
  z0: number;
  mesh: THREE.Mesh;
  geos: (THREE.BufferGeometry | null)[];
  lod: number;
  wantLod: number;
}

interface SuperChunk {
  x0: number;
  z0: number;
  size: number;
  chunks: Chunk[];
  mesh: THREE.Mesh;
  geos: (THREE.BufferGeometry | null)[]; // [8m, 16m]
}

const indexCache = new Map<number, THREE.BufferAttribute>();

function gridIndex(n: number): THREE.BufferAttribute {
  let idx = indexCache.get(n);
  if (idx) return idx;
  const tris: number[] = [];
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      tris.push(a, c, b, b, c, d);
    }
  // skirt ring
  const ring = perimeter(n);
  const base = n * n;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const sa = base + k;
    const sb = base + ((k + 1) % ring.length);
    tris.push(a, sa, b, b, sa, sb);
  }
  idx = new THREE.BufferAttribute(n * n + ring.length > 65535 ? new Uint32Array(tris) : new Uint16Array(tris), 1);
  indexCache.set(n, idx);
  return idx;
}

function perimeter(n: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < n; i++) r.push(i);
  for (let j = 1; j < n; j++) r.push(j * n + n - 1);
  for (let i = n - 2; i >= 0; i--) r.push((n - 1) * n + i);
  for (let j = n - 2; j >= 1; j--) r.push(j * n);
  return r;
}

export function makeTerrainMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const detail = sharedDetailTexture();
  return patchMaterial(mat, {
    key: 'terrain',
    extend: (shader) => {
      shader.uniforms.uDetail = { value: detail };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec2 wp = vAtmoWorldPos.xz;
            float camD = length(vAtmoWorldPos - cameraPosition);
            float d1 = texture2D(uDetail, wp * 0.0071).r;
            float d2 = texture2D(uDetail, wp * 0.043 + 0.37).g;
            float d3 = texture2D(uDetail, wp * vec2(0.21, 0.035)).b;
            float d4 = texture2D(uDetail, wp * 0.19).a;
            float nearF = 1.0 - smoothstep(60.0, 260.0, camD);
            float m = (d1 - 0.5) * 0.34 + (d2 - 0.5) * 0.22 * (0.4 + 0.6 * nearF) + (d3 - 0.5) * 0.12 * nearF + (d4 - 0.5) * 0.14 * nearF;
            diffuseColor.rgb *= 1.0 + m;
            // warm/cool hue drift for painterly richness
            diffuseColor.rgb += vec3(0.03, 0.015, -0.02) * (d1 - 0.5);
          }`,
        );
    },
  });
}

/** Chunked, distance-LOD terrain renderer for the rideable region. */
export class TerrainRenderer {
  readonly group = new THREE.Group();
  readonly material = makeTerrainMaterial();
  private supers: SuperChunk[] = [];
  private sample: GroundSample = { x: 0, z: 0, h: 0, ny: 1, trailDist: 0 };
  private color: RGB = [0, 0, 0];
  private n = { x: 0, y: 1, z: 0 };
  private queue: Chunk[] = [];

  constructor(
    private terrain: TerrainData,
    private spec: TerrainSpec,
  ) {
    this.group.name = 'terrain';
    const ncx = Math.ceil((terrain.maxX - terrain.minX) / CHUNK);
    const ncz = Math.ceil((terrain.maxZ - terrain.minZ) / CHUNK);
    for (let sz = 0; sz < ncz; sz += SUPER)
      for (let sx = 0; sx < ncx; sx += SUPER) {
        const sc: SuperChunk = {
          x0: terrain.minX + sx * CHUNK,
          z0: terrain.minZ + sz * CHUNK,
          size: CHUNK * SUPER,
          chunks: [],
          mesh: new THREE.Mesh(undefined, this.material),
          geos: [null, null],
        };
        sc.mesh.receiveShadow = true;
        sc.mesh.visible = false;
        this.group.add(sc.mesh);
        for (let cz = sz; cz < Math.min(ncz, sz + SUPER); cz++)
          for (let cx = sx; cx < Math.min(ncx, sx + SUPER); cx++) {
            const ch: Chunk = {
              x0: terrain.minX + cx * CHUNK,
              z0: terrain.minZ + cz * CHUNK,
              mesh: new THREE.Mesh(undefined, this.material),
              geos: [null, null, null, null],
              lod: -1,
              wantLod: 3,
            };
            ch.mesh.receiveShadow = true;
            ch.mesh.visible = false;
            this.group.add(ch.mesh);
            sc.chunks.push(ch);
          }
        this.supers.push(sc);
      }
  }

  /** Build a grid mesh covering [x0, x0+size]² at the given spacing. */
  private buildGeometry(x0: number, z0: number, size: number, spacing: number): THREE.BufferGeometry {
    const t = this.terrain;
    const n = Math.round(size / spacing) + 1;
    const ring = perimeter(n);
    const total = n * n + ring.length;
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const s = this.sample;
    const c = this.color;
    const nn = this.n;
    const maxX = t.maxX;
    const maxZ = t.maxZ;
    for (let j = 0; j < n; j++) {
      const z = Math.min(z0 + j * spacing, maxZ);
      for (let i = 0; i < n; i++) {
        const x = Math.min(x0 + i * spacing, maxX);
        const h = t.heightAt(x, z);
        t.normalAt(x, z, nn, Math.max(0.75, spacing * 0.75));
        const o = (j * n + i) * 3;
        pos[o] = x;
        pos[o + 1] = h;
        pos[o + 2] = z;
        nor[o] = nn.x;
        nor[o + 1] = nn.y;
        nor[o + 2] = nn.z;
        s.x = x;
        s.z = z;
        s.h = h;
        s.ny = nn.y;
        s.trailDist = t.trailDistAt(x, z);
        this.spec.groundColor(s, c);
        col[o] = c[0];
        col[o + 1] = c[1];
        col[o + 2] = c[2];
      }
    }
    const skirt = spacing * 1.5 + 0.5;
    for (let k = 0; k < ring.length; k++) {
      const src = ring[k] * 3;
      const dst = (n * n + k) * 3;
      pos[dst] = pos[src];
      pos[dst + 1] = pos[src + 1] - skirt;
      pos[dst + 2] = pos[src + 2];
      nor[dst] = nor[src];
      nor[dst + 1] = nor[src + 1];
      nor[dst + 2] = nor[src + 2];
      col[dst] = col[src];
      col[dst + 1] = col[src + 1];
      col[dst + 2] = col[src + 2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(gridIndex(n));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** Synchronous initial build: coarse everything + fine around `focus`. */
  buildInitial(focus: THREE.Vector3) {
    for (const sc of this.supers) {
      sc.geos[1] = this.buildGeometry(sc.x0, sc.z0, sc.size, 16);
      for (const ch of sc.chunks) ch.geos[3] = this.buildGeometry(ch.x0, ch.z0, CHUNK, LOD_SPACING[3]);
    }
    this.update(focus, 1e9);
  }

  private dist(x0: number, z0: number, size: number, p: THREE.Vector3) {
    const dx = Math.max(x0 - p.x, 0, p.x - (x0 + size));
    const dz = Math.max(z0 - p.z, 0, p.z - (z0 + size));
    return Math.hypot(dx, dz);
  }

  /** Select LODs around the camera; spend at most `budgetMs` building new meshes. */
  update(cam: THREE.Vector3, budgetMs = 4) {
    this.queue.length = 0;
    for (const sc of this.supers) {
      const d = this.dist(sc.x0, sc.z0, sc.size, cam);
      if (d > SUPER_DIST) {
        const li = d > 1500 ? 1 : 0;
        if (!sc.geos[li]) sc.geos[li] = this.buildGeometry(sc.x0, sc.z0, sc.size, li === 0 ? 8 : 16);
        sc.mesh.geometry = sc.geos[li]!;
        sc.mesh.visible = true;
        for (const ch of sc.chunks) ch.mesh.visible = false;
        continue;
      }
      sc.mesh.visible = false;
      for (const ch of sc.chunks) {
        const dc = this.dist(ch.x0, ch.z0, CHUNK, cam);
        const want = dc < LOD_DIST[0] ? 0 : dc < LOD_DIST[1] ? 1 : dc < LOD_DIST[2] ? 2 : 3;
        ch.wantLod = want;
        if (!ch.geos[want]) this.queue.push(ch);
        // show best available lod (closest to wanted, prefer finer)
        let show = -1;
        for (let l = want; l < 4; l++)
          if (ch.geos[l]) {
            show = l;
            break;
          }
        if (show < 0) for (let l = want - 1; l >= 0; l--) if (ch.geos[l]) show = l;
        if (show >= 0 && show !== ch.lod) {
          ch.mesh.geometry = ch.geos[show]!;
          ch.lod = show;
        }
        ch.mesh.visible = show >= 0;
        // evict fine lods far away
        if (dc > 700) {
          for (let l = 0; l < 2; l++)
            if (ch.geos[l]) {
              ch.geos[l]!.dispose();
              ch.geos[l] = null;
            }
        }
      }
    }
    if (!this.queue.length) return;
    this.queue.sort((a, b) => a.wantLod - b.wantLod || this.dist(a.x0, a.z0, CHUNK, cam) - this.dist(b.x0, b.z0, CHUNK, cam));
    const t0 = performance.now();
    for (const ch of this.queue) {
      if (performance.now() - t0 > budgetMs) break;
      ch.geos[ch.wantLod] = this.buildGeometry(ch.x0, ch.z0, CHUNK, LOD_SPACING[ch.wantLod]);
      ch.mesh.geometry = ch.geos[ch.wantLod]!;
      ch.lod = ch.wantLod;
      ch.mesh.visible = true;
    }
  }

  /** True when every chunk near `cam` already shows its wanted LOD. */
  isSettled(cam: THREE.Vector3) {
    this.update(cam, 0);
    return this.queue.length === 0;
  }

  dispose() {
    for (const sc of this.supers) {
      sc.geos.forEach((g) => g?.dispose());
      for (const ch of sc.chunks) ch.geos.forEach((g) => g?.dispose());
    }
    this.material.dispose();
  }
}
