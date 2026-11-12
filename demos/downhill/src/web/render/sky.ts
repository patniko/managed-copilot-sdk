import * as THREE from 'three';
import { Rng } from '../core/rng';
import { ATMOSPHERE_GLSL, G, atmoUniforms } from './globals';
import type { SkySpec } from '../world/types';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = pow(clamp(h, 0.0, 1.0), 0.5);
  vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 1.0, t));
  col = mix(col, uHaze, 1.0 - smoothstep(-0.03, 0.09, h));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 1500.0) * 8.0 + pow(s, 40.0) * 0.25 + pow(s, 5.0) * 0.08);
  gl_FragColor = vec4(col, 1.0);
}
`;

const CLOUD_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute float iVariant;
attribute float iTint;
varying vec2 vUv;
varying vec3 vWorld;
varying float vTint;
void main() {
  vec3 toCam = cameraPosition - iPos;
  toCam.y = 0.0;
  vec3 fwd = normalize(toCam);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 wp = iPos + right * position.x * iSize.x + vec3(0.0, 1.0, 0.0) * position.y * iSize.y;
  float v = iVariant;
  vec2 cell = vec2(mod(v, 2.0), floor(v / 2.0));
  vUv = (cell + vec2(position.x + 0.5, position.y)) * 0.5;
  vWorld = wp;
  vTint = iTint;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uLight;
uniform vec3 uShade;
${ATMOSPHERE_GLSL}
varying vec2 vUv;
varying vec3 vWorld;
varying float vTint;
void main() {
  vec4 t = texture2D(uAtlas, vUv);
  if (t.a < 0.02) discard;
  // r = lighting (1 lit / 0 shade), g = rim
  vec3 col = mix(uShade, uLight, t.r);
  col *= 0.94 + 0.12 * vTint;
  col = mix(col, applyAtmosphere(col, vWorld), 0.55);
  gl_FragColor = vec4(col, t.a);
}
`;

/** Paint a cumulus cloud atlas (2x2 variants). Red = light amount, alpha = coverage. */
function paintCloudAtlas(seed: number): THREE.CanvasTexture {
  const W = 2048,
    H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  const rng = new Rng(seed);
  const cw = W / 2,
    ch = H / 2;
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * cw;
    const oy = Math.floor(v / 2) * ch;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, cw, ch);
    ctx.clip();
    // canvas y grows downward; atlas row 0 is the bottom in UV space so flip each cell
    ctx.translate(ox, oy + ch);
    ctx.scale(1, -1);
    const base = ch * 0.1;
    const puffs: Array<[number, number, number]> = [];
    const towering = v === 1 || v === 3;
    const count = towering ? 95 : 75;
    // a few big anchor masses then many smaller billows
    for (let i = 0; i < count; i++) {
      const gx = rng.gauss() * (towering ? 0.17 : 0.25);
      const x = cw * (0.5 + Math.max(-0.42, Math.min(0.42, gx)));
      const env = Math.exp(-Math.pow((x - cw * 0.5) / (cw * (towering ? 0.17 : 0.27)), 2));
      const big = i < 8;
      const y = base + rng.next() * env * ch * (towering ? 0.74 : 0.46) * (big ? 0.5 : 1);
      const r = ch * (big ? 0.14 + 0.06 * rng.next() : 0.045 + 0.085 * rng.next()) * (0.55 + 0.65 * env);
      puffs.push([x, y + r * 0.55, r]);
    }
    puffs.sort((a, b) => a[1] - b[1]);
    // pass 1: shadowed body (r channel low)
    ctx.filter = 'blur(7px)';
    for (const [x, y, r] of puffs) {
      ctx.fillStyle = 'rgba(40,0,0,1)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // pass 2: sunlit tops (offset toward the sun, up-left)
    for (const [x, y, r] of puffs) {
      const g = ctx.createRadialGradient(x - r * 0.25, y + r * 0.35, r * 0.1, x - r * 0.15, y + r * 0.2, r * 0.95);
      g.addColorStop(0, 'rgba(255,0,0,1)');
      g.addColorStop(0.6, 'rgba(235,0,0,0.85)');
      g.addColorStop(1, 'rgba(150,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x - r * 0.15, y + r * 0.2, r * 0.95, 0, Math.PI * 2);
      ctx.fill();
    }
    // flatten the base
    ctx.filter = 'blur(6px)';
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fillRect(0, -40, cw, base + 30);
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

function col(hex: string, mul = 1) {
  return new THREE.Color(hex).multiplyScalar(mul);
}

export class Sky {
  readonly group = new THREE.Group();
  private dome: THREE.Mesh;
  private clouds: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;

  constructor(spec: SkySpec, seed: number) {
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uZenith: { value: col(spec.zenith) },
        uHorizon: { value: col(spec.horizon) },
        uHaze: { value: col(spec.haze) },
        uSunDir: G.uSunDir,
        uSunColor: { value: col(spec.sunColor) },
      },
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(24000, 48, 24), this.skyMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    this.group.add(this.dome);

    // clouds
    const rng = new Rng(seed ^ 0xc10d);
    const n = spec.cloudCount;
    const iPos = new Float32Array(n * 3);
    const iSize = new Float32Array(n * 2);
    const iVar = new Float32Array(n);
    const iTint = new Float32Array(n);
    const totalW = spec.cloudBanks.reduce((a, b) => a + b.weight, 0);
    for (let i = 0; i < n; i++) {
      let r = rng.next() * totalW;
      let bank = spec.cloudBanks[0];
      for (const b of spec.cloudBanks) {
        r -= b.weight;
        if (r <= 0) {
          bank = b;
          break;
        }
      }
      const az = bank.azimuth + rng.gauss() * bank.spread;
      const dist = rng.range(spec.cloudDistance[0], spec.cloudDistance[1]);
      const x = Math.sin(az) * dist;
      const z = -Math.cos(az) * dist;
      const scale = rng.range(spec.cloudScale[0], spec.cloudScale[1]) * (dist / spec.cloudDistance[1]);
      const y = rng.range(spec.cloudHeight[0], spec.cloudHeight[1]);
      iPos.set([x, y, z], i * 3);
      iSize.set([scale, scale * rng.range(0.45, 0.62)], i * 2);
      iVar[i] = rng.int(0, 3);
      iTint[i] = rng.next();
    }
    // sort far-to-near for nicer overlap (relative to origin)
    const order = [...Array(n).keys()].sort((a, b) => Math.hypot(iPos[b * 3], iPos[b * 3 + 2]) - Math.hypot(iPos[a * 3], iPos[a * 3 + 2]));
    const reorder = (src: Float32Array, k: number) => {
      const o = new Float32Array(src.length);
      order.forEach((from, to) => {
        for (let c = 0; c < k; c++) o[to * k + c] = src[from * k + c];
      });
      return o;
    };
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(reorder(iPos, 3), 3));
    g.setAttribute('iSize', new THREE.InstancedBufferAttribute(reorder(iSize, 2), 2));
    g.setAttribute('iVariant', new THREE.InstancedBufferAttribute(reorder(iVar, 1), 1));
    g.setAttribute('iTint', new THREE.InstancedBufferAttribute(reorder(iTint, 1), 1));
    g.instanceCount = n;
    const cmat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uAtlas: { value: paintCloudAtlas(seed) },
        uLight: { value: col(spec.cloudLight) },
        uShade: { value: col(spec.cloudShade) },
        ...atmoUniforms(),
      },
    });
    this.clouds = new THREE.Mesh(g, cmat);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -5;
    this.group.add(this.clouds);
  }

  update(camera: THREE.Camera) {
    this.dome.position.copy(camera.position);
  }

  dispose() {
    this.dome.geometry.dispose();
    this.skyMat.dispose();
    this.clouds.geometry.dispose();
    (this.clouds.material as THREE.ShaderMaterial).dispose();
  }
}
