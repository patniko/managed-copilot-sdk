import * as THREE from 'three';
import { patchMaterial } from '../render/globals';
import { Rng } from '../core/rng';
import type { JumpFeature } from './features';
import type { TerrainData } from './terrain';
import type { GrassSpec, GroundSample } from './types';

/** Textures describing the region for GPU-side placement: smoothed heights + mask (coverage, trail distance, tint). */
export class GroundTextures {
  readonly height: THREE.DataTexture;
  readonly mask: THREE.DataTexture;
  readonly rect: THREE.Vector4;
  readonly size: THREE.Vector2;

  constructor(terrain: TerrainData, grass: GrassSpec, features: JumpFeature[], noise: (x: number, z: number) => number) {
    const { nx, nz, cell, minX, minZ } = terrain;
    const hd = new Float32Array(nx * nz);
    const md = new Uint8Array(nx * nz * 4);
    const s: GroundSample = { x: 0, z: 0, h: 0, ny: 1, trailDist: 0 };
    const n = { x: 0, y: 1, z: 0 };
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const x = minX + i * cell;
        const z = minZ + j * cell;
        const h = terrain.heightAt(x, z);
        hd[j * nx + i] = h;
        terrain.normalAt(x, z, n, 1);
        s.x = x;
        s.z = z;
        s.h = h;
        s.ny = n.y;
        s.trailDist = terrain.trailDist[j * nx + i];
        const o = (j * nx + i) * 4;
        md[o] = Math.round(Math.max(0, Math.min(1, grass.coverage(s))) * 255);
        md[o + 1] = Math.round(Math.max(0, Math.min(1, s.trailDist / 12)) * 255);
        md[o + 2] = Math.round(Math.max(0, Math.min(1, 0.5 + 0.5 * noise(x, z))) * 255);
        md[o + 3] = 255;
      }
    // clear grass under jumps
    for (const f of features) {
      const b = f.bbox;
      for (let z = b.min.y; z <= b.max.y; z += cell)
        for (let x = b.min.x; x <= b.max.x; x += cell) {
          if (f.heightAt(x, z) === -Infinity) continue;
          const i = Math.round((x - minX) / cell);
          const j = Math.round((z - minZ) / cell);
          if (i >= 0 && j >= 0 && i < nx && j < nz) md[(j * nx + i) * 4] = 0;
        }
    }
    this.height = new THREE.DataTexture(hd, nx, nz, THREE.RedFormat, THREE.FloatType);
    this.height.needsUpdate = true;
    this.mask = new THREE.DataTexture(md, nx, nz, THREE.RGBAFormat);
    this.mask.magFilter = THREE.LinearFilter;
    this.mask.minFilter = THREE.LinearFilter;
    this.mask.needsUpdate = true;
    this.rect = new THREE.Vector4(minX, minZ, cell, 0);
    this.size = new THREE.Vector2(nx, nz);
  }

  dispose() {
    this.height.dispose();
    this.mask.dispose();
  }
}

function bladeGeometry(segments: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const w = (1 - t) * 0.5 + 0.02;
    if (i < segments) {
      pos.push(-w, t, 0, w, t, 0);
      uv.push(0, t, 1, t);
    } else {
      pos.push(0, 1, 0);
      uv.push(0.5, 1);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < segments - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const last = (segments - 1) * 2;
  idx.push(last, last + 1, last + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // r186 forces FLAT_SHADED for Lambert when a geometry has no normals; the shader computes its own.
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0), 3));
  g.setIndex(idx);
  return g;
}

interface LayerOpts {
  tile: number;
  count: number;
  segments: number;
  width: number;
  height: [number, number];
  flowers: number;
}

/** One wrapped field of grass blades around the camera. */
class GrassLayer {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(tex: GroundTextures, spec: GrassSpec, o: LayerOpts, seed: number) {
    const base = bladeGeometry(o.segments);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('uv', base.getAttribute('uv'));
    g.setAttribute('normal', base.getAttribute('normal'));
    const rng = new Rng(seed);
    const off = new Float32Array(o.count * 2);
    const rnd = new Float32Array(o.count * 4);
    for (let i = 0; i < o.count; i++) {
      off[i * 2] = rng.next() * o.tile;
      off[i * 2 + 1] = rng.next() * o.tile;
      rnd[i * 4] = rng.next();
      rnd[i * 4 + 1] = rng.next();
      rnd[i * 4 + 2] = rng.next();
      rnd[i * 4 + 3] = rng.next() < o.flowers ? 1 : 0;
    }
    g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 2));
    g.setAttribute('aRand', new THREE.InstancedBufferAttribute(rnd, 4));
    g.instanceCount = o.count;
    const flowerCols = spec.flowers?.colors ?? ['#ffffff'];
    this.uniforms = {
      uHeightTex: { value: tex.height },
      uMaskTex: { value: tex.mask },
      uRect: { value: tex.rect },
      uTexSize: { value: tex.size },
      uTile: { value: o.tile },
      uCam: { value: new THREE.Vector2() },
      uBladeW: { value: o.width },
      uBladeH: { value: new THREE.Vector2(o.height[0], o.height[1]) },
      uBase: { value: new THREE.Color(spec.base) },
      uTip: { value: new THREE.Color(spec.tip) },
      uTipAlt: { value: new THREE.Color(spec.tipAlt) },
      uFlowerA: { value: new THREE.Color(flowerCols[0]) },
      uFlowerB: { value: new THREE.Color(flowerCols[1 % flowerCols.length]) },
    };
    const mat = new THREE.MeshLambertMaterial({ side: THREE.FrontSide });
    const U = this.uniforms;
    patchMaterial(mat, {
      key: 'grass',
      extend: (shader) => {
        Object.assign(shader.uniforms, U);
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            `#include <common>
            attribute vec2 aOffset;
            attribute vec4 aRand;
            uniform sampler2D uHeightTex;
            uniform sampler2D uMaskTex;
            uniform vec4 uRect;
            uniform vec2 uTexSize;
            uniform float uTile;
            uniform vec2 uCam;
            uniform float uBladeW;
            uniform vec2 uBladeH;
            uniform vec3 uBase;
            uniform vec3 uTip;
            uniform vec3 uTipAlt;
            uniform vec3 uFlowerA;
            uniform vec3 uFlowerB;
            varying vec3 vGrassCol;
            float hAt(vec2 g) {
              vec2 c = clamp(g, vec2(0.0), uTexSize - 1.001);
              ivec2 i = ivec2(floor(c));
              vec2 f = fract(c);
              float a = texelFetch(uHeightTex, i, 0).r;
              float b = texelFetch(uHeightTex, i + ivec2(1, 0), 0).r;
              float cc = texelFetch(uHeightTex, i + ivec2(0, 1), 0).r;
              float d = texelFetch(uHeightTex, i + ivec2(1, 1), 0).r;
              return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y);
            }`,
          )
          .replace(
            '#include <beginnormal_vertex>',
            `
            vec2 wxz = uCam + mod(aOffset - uCam + uTile * 0.5, uTile) - uTile * 0.5;
            vec2 gg = (wxz - uRect.xy) / uRect.z;
            vec4 mk = texture2D(uMaskTex, (gg + 0.5) / uTexSize);
            bool outside = gg.x < 1.0 || gg.y < 1.0 || gg.x > uTexSize.x - 2.0 || gg.y > uTexSize.y - 2.0;
            float gy = hAt(gg);
            float camd = distance(wxz, cameraPosition.xz);
            float fade = 1.0 - smoothstep(uTile * 0.32, uTile * 0.49, camd);
            float cover = smoothstep(0.25, 0.6, mk.r + (aRand.x - 0.5) * 0.3);
            float trail = smoothstep(0.03, 0.12, mk.g + aRand.y * 0.02);
            float sc = outside ? 0.0 : fade * cover * trail;
            float hgt = mix(uBladeH.x, uBladeH.y, aRand.y * aRand.y) * (0.75 + 0.5 * mk.b) * sc;
            float ang = (aRand.z - 0.5) * 1.1;
            vec2 toCam = normalize(cameraPosition.xz - wxz + 1e-4);
            vec2 side0 = vec2(toCam.y, -toCam.x);
            vec2 dirv = vec2(side0.x * cos(ang) - side0.y * sin(ang), side0.x * sin(ang) + side0.y * cos(ang));
            float t = position.y;
            // wind + rider push
            float ph = dot(wxz, vec2(0.23, 0.17)) + aRand.x * 3.0;
            vec2 wind = uWind * (0.35 + 0.25 * sin(uTime * 1.7 + ph) + 0.15 * sin(uTime * 3.1 + ph * 1.7));
            vec2 away = wxz - uPlayerPos.xz;
            float pd = length(away);
            vec2 push = pd < 1.3 ? normalize(away + 1e-4) * (1.3 - pd) * 0.9 : vec2(0.0);
            vec2 bendDir = vec2(cos(aRand.w * 40.0 + aRand.x * 6.28), sin(aRand.w * 40.0 + aRand.x * 6.28));
            vec2 lean = (wind + bendDir * 0.35 + push) * t * t * hgt;
            vec3 p = vec3(wxz.x, gy, wxz.y);
            p.xz += dirv * position.x * uBladeW * (0.7 + 0.6 * aRand.x) * (aRand.w > 0.5 ? 1.8 : 1.0);
            p.y += t * hgt;
            p.xz += lean;
            vec3 objectNormal = normalize(vec3(lean.x * 0.4, 1.0, lean.y * 0.4));
            vec3 tipC = mix(uTip, uTipAlt, aRand.x * 0.7 + mk.b * 0.6);
            vGrassCol = mix(uBase, tipC, smoothstep(0.0, 1.0, t));
            if (aRand.w > 0.5 && t > 0.7) vGrassCol = mix(uFlowerA, uFlowerB, step(0.5, aRand.z));
            `,
          )
          .replace('#include <begin_vertex>', 'vec3 transformed = p;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol;')
          .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vGrassCol;');
      },
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  update(cam: THREE.Vector3) {
    (this.uniforms.uCam.value as THREE.Vector2).set(cam.x, cam.z);
  }
}

export interface GrassQuality {
  near: number;
  far: number;
}

export class GrassField {
  readonly group = new THREE.Group();
  private layers: GrassLayer[] = [];

  constructor(tex: GroundTextures, spec: GrassSpec, q: GrassQuality, seed: number) {
    this.group.name = 'grass';
    if (!spec.enabled) return;
    const flowers = spec.flowers?.density ?? 0;
    this.layers.push(
      new GrassLayer(tex, spec, { tile: 34, count: q.near, segments: 3, width: 0.036, height: spec.height, flowers }, seed),
      new GrassLayer(tex, spec, { tile: 110, count: q.far, segments: 2, width: 0.1, height: [spec.height[0] * 1.1, spec.height[1] * 1.25], flowers: flowers * 0.5 }, seed + 1),
    );
    for (const l of this.layers) this.group.add(l.mesh);
  }

  update(cam: THREE.Vector3) {
    for (const l of this.layers) l.update(cam);
  }

  dispose() {
    for (const l of this.layers) {
      l.mesh.geometry.dispose();
      (l.mesh.material as THREE.Material).dispose();
    }
  }
}
