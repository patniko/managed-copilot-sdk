import * as THREE from 'three';
import { clamp, smoothstep } from '../core/math';
import type { Surface } from '../core/audioTypes';
import type { BikePhysics } from './bike';
import type { Collider, Ground } from '../world/ground';
import type { EnvironmentDef, RGB } from '../world/types';

/**
 * Speed effects that sell how fast the bike is going:
 *  - wind streaks: world-anchored motes of dust and pollen around the camera, drawn as short motion streaks along
 *    the rider's velocity (they stream out of the vanishing point and whip past the lens);
 *  - wheel spray: dust, sand, snow or grass clippings kicked up by the rear wheel, more when skidding, plus a burst
 *    on every landing;
 *  - flybys: a whoosh when the rider blasts past a bush, rock or tree.
 * Blending leaves the scene buffer's alpha (the motion-blur subject mask) untouched.
 */

const STREAKS = 150;
const PUFFS = 220;
const BOX = new THREE.Vector3(22, 7, 22);

const STREAK_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCenter;
uniform vec3 uBox;
uniform vec3 uVel;
uniform float uLen;
uniform float uWidth;
varying float vAlong;
varying float vAcross;
varying float vFade;
void main() {
  // a world-anchored mote, wrapped into a box that travels with the camera
  vec3 anchor = aSeed.xyz * uBox;
  vec3 rel = mod(anchor - uCenter + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec3 head = uCenter + rel;
  vec4 hv = modelViewMatrix * vec4(head, 1.0);
  vec3 e = abs(rel) / uBox;
  vFade = (1.0 - smoothstep(0.3, 0.5, max(max(e.x, e.y), e.z))) * smoothstep(1.0, 3.2, length(hv.xyz));
  vAlong = position.x;
  vAcross = position.y;
  // invisible motes (box edge, or right at the lens) are collapsed so they never rasterize
  if (vFade < 0.002 || hv.z > -0.3) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // seen from the moving camera, a still mote smears back along the direction of travel
  vec3 tail = head + uVel * uLen * (0.55 + 0.9 * aSeed.w);
  vec4 tv = modelViewMatrix * vec4(tail, 1.0);
  vec3 p = mix(hv.xyz, tv.xyz, position.x);
  vec3 side = cross(tv.xyz - hv.xyz, p);
  float sl = length(side);
  side = sl > 1e-6 ? side / sl : vec3(1.0, 0.0, 0.0);
  p += side * uWidth * (0.6 + 0.8 * fract(aSeed.w * 7.13)) * (1.0 - 0.55 * position.x) * position.y;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const STREAK_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying float vAlong;
varying float vAcross;
varying float vFade;
void main() {
  float a = uAlpha * vFade * (1.0 - vAlong) * (1.0 - vAcross * vAcross);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}`;

const PUFF_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aCol;
attribute vec3 aShape;
varying vec2 vUv;
varying vec4 vCol;
varying float vSeed;
void main() {
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  vUv = position.xy;
  vCol = aCol;
  vSeed = aShape.z;
  // faded-out puffs and puffs right at the lens are collapsed so they never rasterize
  if (aCol.a < 0.004 || mv.z > -0.35) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float c = cos(aShape.y);
  float s = sin(aShape.y);
  mv.xy += mat2(c, s, -s, c) * position.xy * aShape.x;
  gl_Position = projectionMatrix * mv;
}`;

const PUFF_FRAG = /* glsl */ `
uniform float uLight;
varying vec2 vUv;
varying vec4 vCol;
varying float vSeed;
void main() {
  float r = length(vUv);
  // lumpy outline so a puff reads as a painted dab rather than a disc
  float ang = atan(vUv.y, vUv.x);
  float edge = 0.8 + 0.12 * sin(ang * 3.0 + vSeed * 6.283) + 0.06 * sin(ang * 5.0 - vSeed * 11.0);
  float a = vCol.a * (1.0 - smoothstep(edge * 0.45, edge, r));
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol.rgb * uLight * (0.85 + 0.22 * vUv.y), a);
}`;

/** Normal colour blending that keeps the destination alpha (the motion-blur subject mask). */
function keepAlpha(m: THREE.ShaderMaterial) {
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  return m;
}

interface DustSpec {
  /** Puffs per second per m/s above 5 m/s. */
  rate: number;
  size: [number, number];
  life: [number, number];
  alpha: number;
  /** Fraction of gravity (dust floats, clods and clippings fall). */
  grav: number;
  /** Air drag (1/s). */
  drag: number;
  color: 'trail' | 'grass' | 'snow';
}

const DUST: Record<Surface, DustSpec | null> = {
  dirt: { rate: 1.15, size: [0.22, 0.85], life: [0.6, 1.0], alpha: 0.42, grav: 0.12, drag: 2.2, color: 'trail' },
  sand: { rate: 1.6, size: [0.26, 1.0], life: [0.7, 1.2], alpha: 0.45, grav: 0.1, drag: 2.0, color: 'trail' },
  rock: { rate: 0.45, size: [0.18, 0.6], life: [0.45, 0.8], alpha: 0.3, grav: 0.2, drag: 2.4, color: 'trail' },
  grass: { rate: 0.75, size: [0.06, 0.13], life: [0.35, 0.6], alpha: 0.95, grav: 0.9, drag: 1.0, color: 'grass' },
  snow: { rate: 1.7, size: [0.22, 0.9], life: [0.6, 1.1], alpha: 0.6, grav: 0.1, drag: 2.0, color: 'snow' },
  wood: null,
};

function lin(hex: string): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

export interface WhooshSink {
  playWhoosh(intensity: number, pan: number): void;
}

export class SpeedFx {
  readonly group = new THREE.Group();
  private readonly streakMat: THREE.ShaderMaterial;
  private readonly puffMat: THREE.ShaderMaterial;
  private readonly streakGeo: THREE.InstancedBufferGeometry;
  private readonly puffGeo: THREE.InstancedBufferGeometry;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  private readonly aShape: THREE.InstancedBufferAttribute;
  // particle pool (structure of arrays)
  private readonly p = new Float32Array(PUFFS * 3);
  private readonly v = new Float32Array(PUFFS * 3);
  private readonly col = new Float32Array(PUFFS * 3);
  /** age, life, size0, size1, alpha, grav, drag, rot, spin, seed */
  private readonly st = new Float32Array(PUFFS * 10);
  private alive = 0;
  private emitAcc = 0;
  private readonly colors: Record<'trail' | 'grass' | 'snow', RGB>;
  private streakK = 0;
  private boostK = 0;
  private time = 0;
  private lastNear: Collider | null = null;
  private whooshAt = -10;
  private rng = mulberry(91731);
  private readonly fwd = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    env: EnvironmentDef,
    private readonly ground: Ground,
  ) {
    this.group.name = 'speedfx';
    const sky = env.sky;
    const sun = sky.sunIntensity * Math.max(0.3, sky.sunDir[1] / Math.hypot(...sky.sunDir)) + sky.hemiIntensity;
    const light = clamp(sun * 0.55, 0.9, 2.4);
    const t = env.course.trailColor;
    const tc: RGB = [t[0] * 0.75 + 0.25 * 0.9, t[1] * 0.75 + 0.25 * 0.85, t[2] * 0.75 + 0.25 * 0.8];
    this.colors = { trail: tc, grass: lin(env.grass.tip), snow: [0.92, 0.95, 1.0] };

    // wind streaks
    const sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    sg.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(STREAKS * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = this.rng();
    sg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    sg.instanceCount = STREAKS;
    this.streakGeo = sg;
    const cl = lin(sky.cloudLight);
    this.streakMat = keepAlpha(
      new THREE.ShaderMaterial({
        vertexShader: STREAK_VERT,
        fragmentShader: STREAK_FRAG,
        uniforms: {
          uCenter: { value: new THREE.Vector3() },
          uBox: { value: BOX.clone() },
          uVel: { value: new THREE.Vector3() },
          uLen: { value: 0.055 },
          uWidth: { value: 0.02 },
          uColor: { value: new THREE.Color(cl[0] * light * 1.1, cl[1] * light * 1.1, cl[2] * light * 1.1) },
          uAlpha: { value: 0 },
        },
      }),
    );
    const streaks = new THREE.Mesh(sg, this.streakMat);
    streaks.frustumCulled = false;
    streaks.renderOrder = 5;
    this.group.add(streaks);

    // wheel spray
    const pg = new THREE.InstancedBufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    pg.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 4), 4);
    this.aShape = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 3), 3);
    for (const a of [this.aPos, this.aCol, this.aShape]) a.setUsage(THREE.DynamicDrawUsage);
    pg.setAttribute('aPos', this.aPos);
    pg.setAttribute('aCol', this.aCol);
    pg.setAttribute('aShape', this.aShape);
    pg.instanceCount = 0;
    this.puffGeo = pg;
    this.puffMat = keepAlpha(new THREE.ShaderMaterial({ vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, uniforms: { uLight: { value: light } } }));
    const puffs = new THREE.Mesh(pg, this.puffMat);
    puffs.frustumCulled = false;
    puffs.renderOrder = 4;
    this.group.add(puffs);
    scene.add(this.group);
  }

  /** A short surge of extra wind (speed boosts). */
  boost(k: number) {
    this.boostK = Math.max(this.boostK, clamp(k, 0, 1));
  }

  /** Dust burst where the wheels touch down. */
  landing(bike: BikePhysics, intensity: number) {
    const spec = DUST[bike.surface];
    if (!spec) return;
    const n = Math.round((spec.color === 'grass' ? 14 : 9) + 16 * intensity);
    const h = bike.heading;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const r = this.rng;
    for (let i = 0; i < n; i++) {
      const back = i % 2 ? 0.55 : -0.5;
      const a = r() * Math.PI * 2;
      const out = (1.2 + 2.6 * r()) * (0.6 + 0.6 * intensity);
      this.spawn(
        spec,
        bike.pos.x - fx * back,
        bike.pos.y + 0.05,
        bike.pos.z - fz * back,
        bike.vel.x * 0.3 + Math.cos(a) * out,
        0.4 + r() * (1.2 + 1.6 * intensity),
        bike.vel.z * 0.3 + Math.sin(a) * out,
        1.25,
      );
    }
  }

  update(dt: number, bike: BikePhysics, camera: THREE.PerspectiveCamera, audio: WhooshSink | null) {
    this.time += dt;
    const speed = bike.crashed ? 0 : bike.speed;

    /* wind streaks */
    this.boostK = Math.max(0, this.boostK - dt * 1.6);
    const want = smoothstep(8, 19, speed) * (1 + 0.8 * this.boostK);
    this.streakK += (want - this.streakK) * (1 - Math.exp(-dt * 4));
    const u = this.streakMat.uniforms;
    camera.getWorldDirection(this.fwd);
    u.uCenter.value.copy(camera.position).addScaledVector(this.fwd, 6.5);
    u.uCenter.value.y = camera.position.y - 0.4;
    u.uVel.value.copy(bike.vel);
    u.uLen.value = 0.05 + 0.03 * this.boostK;
    u.uAlpha.value = 0.42 * this.streakK;
    this.group.children[0].visible = this.streakK > 0.01;

    /* wheel spray */
    const spec = DUST[bike.surface];
    if (spec && bike.grounded && !bike.crashed && speed > 5 && Number.isFinite(speed)) {
      // (bounded per frame: a physics hiccup can never turn the emitter into a long loop)
      this.emitAcc = Math.min(24, this.emitAcc + dt * spec.rate * (speed - 5) * 1.3 * (1 + 2.5 * bike.skid));
      const h = bike.heading;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      const r = this.rng;
      while (this.emitAcc >= 1) {
        this.emitAcc -= 1;
        const side = (r() - 0.5) * 2 * (0.6 + 2.5 * bike.skid);
        const kick = 0.8 + 0.08 * speed;
        const up = spec.color === 'grass' ? 1 + 2 * r() : 0.4 + 1.2 * r();
        this.spawn(
          spec,
          bike.pos.x - fx * 0.55 + (r() - 0.5) * 0.2,
          bike.pos.y + 0.05,
          bike.pos.z - fz * 0.55 + (r() - 0.5) * 0.2,
          bike.vel.x * 0.35 - fx * kick + fz * -side,
          up,
          bike.vel.z * 0.35 - fz * kick + fx * side,
          1,
        );
      }
    } else this.emitAcc = 0;
    this.simulate(dt);

    /* flybys */
    if (audio && !bike.crashed && speed > 9) {
      const near = this.ground.nearest(bike.pos.x, bike.pos.z, bike.pos.y + 1.0, 2.6);
      const c = near?.c ?? null;
      if (near && c !== this.lastNear && this.time - this.whooshAt > 0.18) {
        const rx = Math.cos(bike.heading);
        const rz = Math.sin(bike.heading);
        const side = (near.c.x - bike.pos.x) * rx + (near.c.z - bike.pos.z) * rz;
        audio.playWhoosh(clamp((speed - 8) / 14, 0.15, 1) * clamp(1.15 - near.gap / 2.6, 0.35, 1), clamp(side / 2.5, -0.8, 0.8));
        this.whooshAt = this.time;
      }
      this.lastNear = c;
    } else this.lastNear = null;
  }

  private spawn(spec: DustSpec, x: number, y: number, z: number, vx: number, vy: number, vz: number, scale: number) {
    if (this.alive >= PUFFS) return;
    const r = this.rng;
    const i = this.alive++;
    this.p[i * 3] = x;
    this.p[i * 3 + 1] = y;
    this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx;
    this.v[i * 3 + 1] = vy;
    this.v[i * 3 + 2] = vz;
    const c = this.colors[spec.color];
    const tint = 0.88 + 0.24 * r();
    this.col[i * 3] = c[0] * tint;
    this.col[i * 3 + 1] = c[1] * tint;
    this.col[i * 3 + 2] = c[2] * tint;
    const s = this.st;
    const k = i * 10;
    s[k] = 0;
    s[k + 1] = spec.life[0] + (spec.life[1] - spec.life[0]) * r();
    s[k + 2] = spec.size[0] * scale * (0.7 + 0.6 * r());
    s[k + 3] = spec.size[1] * scale * (0.7 + 0.6 * r());
    s[k + 4] = spec.alpha * (0.7 + 0.3 * r());
    s[k + 5] = spec.grav;
    s[k + 6] = spec.drag;
    s[k + 7] = r() * 6.283;
    s[k + 8] = (r() - 0.5) * 3;
    s[k + 9] = r();
  }

  private simulate(dt: number) {
    const { p, v, st, col } = this;
    let n = 0;
    const pos = this.aPos.array as Float32Array;
    const cols = this.aCol.array as Float32Array;
    const shape = this.aShape.array as Float32Array;
    for (let i = 0; i < this.alive; i++) {
      const k = i * 10;
      const age = st[k] + dt;
      const life = st[k + 1];
      if (age >= life) continue;
      const drag = Math.exp(-st[k + 6] * dt);
      v[i * 3] *= drag;
      v[i * 3 + 1] = v[i * 3 + 1] * drag - 9.81 * st[k + 5] * dt;
      v[i * 3 + 2] *= drag;
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      // compact the pool in place
      if (n !== i) {
        for (let c = 0; c < 3; c++) {
          p[n * 3 + c] = p[i * 3 + c];
          v[n * 3 + c] = v[i * 3 + c];
          col[n * 3 + c] = col[i * 3 + c];
        }
        for (let c = 0; c < 10; c++) st[n * 10 + c] = st[k + c];
      }
      const m = n * 10;
      st[m] = age;
      const f = age / life;
      pos[n * 3] = p[n * 3];
      pos[n * 3 + 1] = p[n * 3 + 1];
      pos[n * 3 + 2] = p[n * 3 + 2];
      cols[n * 4] = col[n * 3];
      cols[n * 4 + 1] = col[n * 3 + 1];
      cols[n * 4 + 2] = col[n * 3 + 2];
      cols[n * 4 + 3] = st[m + 4] * smoothstep(0, 0.08, age) * Math.pow(1 - f, 1.5);
      shape[n * 3] = st[m + 2] + (st[m + 3] - st[m + 2]) * Math.sqrt(f);
      shape[n * 3 + 1] = st[m + 7] + st[m + 8] * age;
      shape[n * 3 + 2] = st[m + 9];
      n++;
    }
    this.alive = n;
    this.puffGeo.instanceCount = n;
    if (n > 0) {
      this.aPos.needsUpdate = true;
      this.aCol.needsUpdate = true;
      this.aShape.needsUpdate = true;
    }
  }

  /** Live particle count (diagnostics). */
  get particles() {
    return this.alive;
  }

  get streakIntensity() {
    return this.streakK;
  }

  dispose() {
    this.group.removeFromParent();
    this.streakGeo.dispose();
    this.puffGeo.dispose();
    this.streakMat.dispose();
    this.puffMat.dispose();
  }
}

/** Small deterministic PRNG (captures stay reproducible). */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
