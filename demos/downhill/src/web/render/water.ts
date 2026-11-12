import * as THREE from 'three';
import { ATMOSPHERE_GLSL, G, atmoUniforms } from './globals';
import type { TerrainSpec, WaterSpec } from '../world/types';

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uHeight;
uniform vec4 uRect;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uSky;
uniform vec3 uSunColor;
uniform float uLevel;
uniform float uDepthScale;
uniform float uTime;
${ATMOSPHERE_GLSL}
varying vec3 vWorld;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 huv = (vWorld.xz - uRect.xy) / uRect.zw;
  float ground = texture2D(uHeight, huv).r;
  float depth = uLevel - ground;
  vec3 V = normalize(cameraPosition - vWorld);
  float dist = length(cameraPosition - vWorld);
  // wave normal from scrolling noise
  vec2 p = vWorld.xz;
  float n1 = vnoise(p * 0.035 + vec2(uTime * 0.05, uTime * 0.02));
  float n2 = vnoise(p * 0.11 - vec2(uTime * 0.07, -uTime * 0.03));
  float n3 = vnoise(p * vec2(0.02, 0.32) + vec2(0.0, uTime * 0.12));
  vec3 N = normalize(vec3((n1 - 0.5) * 0.35 + (n2 - 0.5) * 0.25, 1.0, (n3 - 0.5) * 0.3 + (n2 - 0.5) * 0.2));
  float t = 1.0 - exp(-max(depth, 0.0) / uDepthScale);
  vec3 col = mix(uShallow, uDeep, t);
  // painterly wave streaks (lighter crests)
  float streak = smoothstep(0.62, 0.9, vnoise(p * vec2(0.012, 0.09) + vec2(uTime * 0.03, n1 * 1.5)));
  col = mix(col, uShallow * 1.25, streak * 0.35 * (1.0 - smoothstep(800.0, 4000.0, dist)));
  float fres = pow(1.0 - max(dot(V, N), 0.0), 5.0);
  col = mix(col, uSky, clamp(fres * 0.18, 0.0, 0.18));
  // sun glitter
  vec3 R = reflect(-V, N);
  float sp = pow(max(dot(R, uSunDir), 0.0), 220.0);
  col += uSunColor * sp * 2.5;
  // shoreline foam
  float shore = 1.0 - smoothstep(0.0, 3.5, depth);
  float wave = 0.5 + 0.5 * sin(depth * 3.0 - uTime * 1.3 + n1 * 6.0);
  float foam = shore * smoothstep(0.35, 0.75, wave * 0.6 + n2 * 0.6) + (1.0 - smoothstep(0.0, 0.7, depth));
  col = mix(col, uFoam, clamp(foam, 0.0, 1.0) * 0.9);
  col = mix(col, applyAtmosphere(col, vWorld), 0.45);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Water {
  readonly mesh: THREE.Mesh;
  private heightTex: THREE.DataTexture;

  constructor(spec: WaterSpec, terrain: TerrainSpec, centre: THREE.Vector2, extent = 16000, res = 512) {
    const data = new Float32Array(res * res);
    const minX = centre.x - extent;
    const minZ = centre.y - extent;
    const size = extent * 2;
    const r = terrain.region;
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++) {
        const x = minX + ((i + 0.5) / res) * size;
        const z = minZ + ((j + 0.5) / res) * size;
        const inside = x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ;
        data[j * res + i] = inside ? terrain.height(x, z) : terrain.farHeight(x, z);
      }
    this.heightTex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.FloatType);
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.needsUpdate = true;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHeight: { value: this.heightTex },
        uRect: { value: new THREE.Vector4(minX, minZ, size, size) },
        uDeep: { value: new THREE.Color(spec.deep) },
        uShallow: { value: new THREE.Color(spec.shallow) },
        uFoam: { value: new THREE.Color(spec.foam) },
        uSky: { value: G.uFogColor.value },
        uSunColor: G.uSunColor,
        uLevel: { value: spec.level },
        uDepthScale: { value: spec.depthScale },
        uTime: G.uTime,
        ...atmoUniforms(),
      },
    });
    const geo = new THREE.PlaneGeometry(size * 1.6, size * 1.6, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(centre.x, spec.level, centre.y);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  dispose() {
    this.heightTex.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
