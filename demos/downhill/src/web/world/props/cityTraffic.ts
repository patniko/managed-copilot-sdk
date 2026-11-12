import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { ATMOSPHERE_GLSL, G, atmoUniforms, patchMaterial } from '../../render/globals';
import { XB, groundY, cityGroundGLSL } from '../envs/city';
import { BLVD, CITY_Z0, CITY_Z1 } from './cityTown';
import { Geo } from './cityMega';

/** Lane centre offsets from XB (+ = the carriageway heading toward the sun, i.e. -Z). */
const LANES = [4.6, 7.9, 11.1, 14.4];
/** Moving window (relative to the camera z) inside which every car loops. */
const WIN_AHEAD = 3400;
const WIN_BEHIND = 1100;

export interface TrafficHandle {
  objects: THREE.Object3D[];
  update(camera: THREE.Camera): void;
}

/** A small car facing -Z with glowing head/tail lights (per-vertex `glow`). */
function carGeometry(): THREE.BufferGeometry {
  const geo = new Geo();
  const glow: number[] = [];
  const push = (n: number, r: number, g: number, b: number) => {
    for (let i = 0; i < n; i++) glow.push(r, g, b);
  };
  let before = 0;
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: [number, number, number], gl: [number, number, number]) => {
    before = geo.pos.length / 3;
    geo.box(x0, y0, z0, x1, y1, z1, c[0], c[1], c[2], 0b110111);
    push(geo.pos.length / 3 - before, gl[0], gl[1], gl[2]);
  };
  box(-0.92, 0.3, -2.2, 0.92, 1.05, 2.2, [1, 1, 1], [0, 0, 0]);
  box(-0.8, 1.05, -0.9, 0.8, 1.55, 1.3, [0.25, 0.27, 0.42], [0, 0, 0]);
  // headlights (front = -Z) and tail lights
  box(-0.85, 0.55, -2.26, -0.45, 0.8, -2.18, [1, 1, 1], [9, 8.2, 6.5]);
  box(0.45, 0.55, -2.26, 0.85, 0.8, -2.18, [1, 1, 1], [9, 8.2, 6.5]);
  box(-0.88, 0.62, 2.18, -0.42, 0.85, 2.26, [1, 0.2, 0.15], [7, 0.6, 0.3]);
  box(0.42, 0.62, 2.18, 0.88, 0.85, 2.26, [1, 0.2, 0.15], [7, 0.6, 0.3]);
  const g = geo.build();
  g.setAttribute('glow', new THREE.Float32BufferAttribute(glow, 3));
  return g;
}

function buildCars(rng: Rng, uWin: { value: THREE.Vector2 }) {
  const base = carGeometry();
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const k of ['position', 'normal', 'color', 'glow', 'uv']) g.setAttribute(k, base.getAttribute(k));
  const cars: number[] = [];
  const tints: number[] = [];
  const palette = ['#e8e8f0', '#20222e', '#b8bcc8', '#8a1c22', '#2a3c7a', '#d8d2c0', '#3a3a44', '#f0f0f4'].map((h) => new THREE.Color(h));
  const span = WIN_AHEAD + WIN_BEHIND;
  for (const side of [1, -1])
    for (let li = 0; li < LANES.length; li++) {
      const speed = side * (13 + li * 2.4 + rng.next() * 2);
      for (let z = 0; z < span; z += 22 + rng.next() * 70) {
        cars.push(XB + side * LANES[li] + (rng.next() - 0.5) * 0.3, z, speed, 0);
        const c = rng.pick(palette);
        tints.push(c.r, c.g, c.b);
      }
    }
  g.setAttribute('aCar', new THREE.InstancedBufferAttribute(new Float32Array(cars), 4));
  g.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(tints), 3));
  g.instanceCount = cars.length / 4;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  patchMaterial(mat, {
    key: 'cityCars',
    extend: (shader) => {
      shader.uniforms.uWin = uWin;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec4 aCar;
          attribute vec3 aTint;
          attribute vec3 glow;
          uniform vec2 uWin;
          varying vec3 vGlow;
          varying vec3 vTint;
          ${cityGroundGLSL}`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `vec3 objectNormal = vec3( normal );
          if (aCar.z < 0.0) objectNormal.xz = -objectNormal.xz;`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3( position );
          if (aCar.z < 0.0) transformed.xz = -transformed.xz;
          float cz = uWin.x + mod(aCar.y - aCar.z * uTime - uWin.x, uWin.y);
          transformed.x += aCar.x;
          transformed.z += cz;
          transformed.y += cityGround(cz);
          vGlow = glow;
          vTint = aTint;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGlow;\nvarying vec3 vTint;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(vTint, vec3(1.0), step(0.01, vGlow.r + vGlow.g));')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;');
    },
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  return mesh;
}

const TRAIL_VERT = /* glsl */ `
attribute vec3 aLane;
varying vec3 vWorld;
varying vec3 vLane;
varying float vAcross;
void main() {
  vLane = aLane;
  vAcross = uv.x;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const TRAIL_FRAG = /* glsl */ `
uniform float uTime;
${ATMOSPHERE_GLSL}
varying vec3 vWorld;
varying vec3 vLane;
varying float vAcross;
void main() {
  // vLane: x = direction (+1 toward -Z; ±2 = the soft glow over a whole carriageway), y = speed, z = seed
  float across = 1.0 - abs(vAcross * 2.0 - 1.0);
  float vis = applyAtmosphere(vec3(1.0), vWorld).r - applyAtmosphere(vec3(0.0), vWorld).r;
  if (abs(vLane.x) > 1.5) {
    vec3 g = vLane.x > 0.0 ? vec3(1.0, 0.24, 0.08) * 0.3 : vec3(1.0, 0.45, 0.25) * 0.1;
    gl_FragColor = vec4(g * smoothstep(0.0, 0.7, across) * max(vis, 0.0), 0.0);
    return;
  }
  float z = vWorld.z + vLane.x * vLane.y * uTime;
  float a = 0.0;
  // overlapping long-exposure streaks of varying length
  float p1 = fract(z / 61.0 + vLane.z);
  float p2 = fract(z / 23.0 + vLane.z * 3.7);
  float p3 = fract(z / 137.0 + vLane.z * 1.3);
  a += smoothstep(0.0, 0.08, p1) * (1.0 - smoothstep(0.35, 0.75, p1));
  a += 0.6 * smoothstep(0.0, 0.1, p2) * (1.0 - smoothstep(0.4, 0.7, p2));
  a += 0.8 * smoothstep(0.0, 0.05, p3) * (1.0 - smoothstep(0.55, 0.95, p3));
  a = 0.45 + 0.55 * min(a, 1.4);
  across = across * across;
  // tail lights (driving away, into the sun) glow red-orange; oncoming headlights warm white
  vec3 col = vLane.x > 0.0 ? vec3(1.0, 0.22, 0.05) * 9.0 : vec3(1.0, 0.76, 0.48) * 5.0;
  gl_FragColor = vec4(col * a * across * max(vis, 0.0), 0.0);
}
`;

/** Long-exposure light trails: soft streak ribbons hovering over every lane, scrolling with the traffic. */
function buildTrails(rng: Rng) {
  const pos: number[] = [];
  const uv: number[] = [];
  const lane: number[] = [];
  const idx: number[] = [];
  const ribbon = (x: number, w: number, y0: number, dir: number, speed: number, seed: number) => {
    let prev = -1;
    for (let z = CITY_Z0; z >= CITY_Z1; z -= 40) {
      const y = groundY(z) + y0;
      const i = pos.length / 3;
      pos.push(x - w, y, z, x + w, y, z);
      uv.push(0, 0, 1, 0);
      lane.push(dir, speed, seed, dir, speed, seed);
      if (prev >= 0) idx.push(prev, prev + 1, i + 1, prev, i + 1, i);
      prev = i;
    }
  };
  for (const side of [1, -1]) {
    for (let li = 0; li < LANES.length; li++) ribbon(XB + side * LANES[li], 1.5, 0.85, side, 13 + li * 2.4 + 1, rng.next());
    // the light pooled over the whole carriageway
    ribbon(XB + side * 9.5, 7.5, 0.5, side * 2, 0, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aLane', new THREE.Float32BufferAttribute(lane, 3));
  g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    vertexShader: TRAIL_VERT,
    fragmentShader: TRAIL_FRAG,
    uniforms: { uTime: G.uTime, ...atmoUniforms() },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // add light, keep the scene alpha (it carries the rider mask for the paint pass)
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

export function buildTraffic(): TrafficHandle {
  const rng = new Rng(4411);
  const uWin = { value: new THREE.Vector2(-WIN_AHEAD, WIN_AHEAD + WIN_BEHIND) };
  const cars = buildCars(rng, uWin);
  const trails = buildTrails(rng);
  void BLVD;
  return {
    objects: [cars, trails],
    update(camera) {
      uWin.value.x = camera.position.z - WIN_AHEAD;
    },
  };
}
