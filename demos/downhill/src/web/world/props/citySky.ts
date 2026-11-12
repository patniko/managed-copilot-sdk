import * as THREE from 'three';
import { G } from '../../render/globals';
import type { SkySpec } from '../types';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uCam;
uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunCol;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 3.7);
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  vec3 sd = normalize(uSunDir);
  float h = d.y;
  vec2 dh = normalize(d.xz + 1e-5);
  vec2 sh = normalize(sd.xz + 1e-5);
  float az = dot(dh, sh) * 0.5 + 0.5;
  float s = max(dot(d, sd), 0.0);

  // sky: same gradient as the engine's dome, but deep violet-blue away from the sun (the video's top-left)
  vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 1.0, sqrt(clamp(h, 0.0, 1.0))));
  sky = mix(sky, uZenith * 0.8, (1.0 - az) * smoothstep(0.0, 0.35, h) * 0.75);
  sky = mix(sky, vec3(1.0, 0.38, 0.22), pow(s, 10.0) * smoothstep(0.2, 0.0, h) * 0.55);
  sky = mix(sky, uHaze, 1.0 - smoothstep(-0.03, 0.09, h));
  sky += uSunCol * (pow(s, 60.0) * 0.25 + pow(s, 8.0) * 0.06);

  // a layer of altocumulus ~2.4 km up, seen in perspective (bands crowd into streaks toward the horizon)
  float dens = 0.0;
  if (h > 0.004) {
    vec2 p = d.xz * (2400.0 / h) + uCam.xz * 0.6;
    vec2 q = p * vec2(1.0 / 5200.0, 1.0 / 1250.0) + vec2(uTime * 0.0006, 0.0);
    vec2 w = vec2(fbm(q * 1.3 + 3.1), fbm(q * 1.3 - 7.4));
    float base = fbm(q + 0.85 * w);
    // fine wavy ripples (the "mackerel" texture of the painted sky)
    float rip = 0.65 * vnoise(p * vec2(1.0 / 380.0, 1.0 / 85.0) + 5.0 * w) + 0.35 * vnoise(p * vec2(1.0 / 150.0, 1.0 / 40.0) - 3.0 * w);
    float cover = 0.43 - 0.06 * smoothstep(0.5, 0.95, h);
    dens = smoothstep(cover - 0.1, cover + 0.16, base + 0.36 * (rip - 0.5));
    dens *= smoothstep(0.004, 0.05, h);
  }
  // cloud light by angular distance from the sun: gold within ~10°, orange to ~25°, coral / hot pink to ~45°,
  // magenta beyond, violet on the far side
  float ang = acos(clamp(dot(d, sd), -1.0, 1.0));
  vec3 violet = vec3(0.42, 0.22, 0.8);
  vec3 magenta = vec3(1.0, 0.2, 0.62);
  vec3 coral = vec3(1.0, 0.3, 0.46);
  vec3 orange = vec3(1.0, 0.46, 0.1);
  vec3 gold = vec3(1.0, 0.7, 0.22);
  vec3 lit = mix(magenta, violet, smoothstep(1.2, 2.2, ang));
  lit = mix(coral, lit, smoothstep(0.38, 0.75, ang));
  lit = mix(orange, lit, smoothstep(0.1, 0.32, ang));
  lit = mix(gold, lit, smoothstep(0.03, 0.1, ang));
  // high overhead the deck is already in the earth's shadow
  lit = mix(lit, vec3(0.3, 0.2, 0.66), smoothstep(0.35, 0.9, h) * 0.8);
  float core = smoothstep(0.55, 1.0, dens);
  // the sunlit undersides glow (the video's clouds are the brightest thing in the frame after the sun)
  vec3 cloud = mix(lit * 1.5, lit * 0.55 + vec3(0.04, 0.02, 0.14), core * 0.6);
  cloud *= 1.0 + 0.5 * pow(s, 60.0);
  vec3 col = mix(sky, cloud, dens * 0.97);

  // a small crisp sun disc sitting just above the haze (replaces the dome's wide disc)
  float disc = smoothstep(0.999925, 0.999945, dot(d, sd));
  col = mix(col, vec3(1.0, 0.62, 0.14) * 2.2, disc);
  col += vec3(1.0, 0.45, 0.12) * pow(s, 900.0) * 0.6;
  // opaque above the horizon (hides the dome and its wide sun), fading out just below it
  gl_FragColor = vec4(col, smoothstep(-0.04, -0.005, h));
}
`;

/** The streaky, sunset-lit sky of the video (camera-centred shell; the scene occludes it). */
export function buildCloudDeck(sky: SkySpec): { mesh: THREE.Mesh; update(camera: THREE.Camera): void } {
  const uCam = { value: new THREE.Vector3() };
  const c = (hex: string) => ({ value: new THREE.Color(hex) });
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uSunDir: G.uSunDir, uCam, uTime: G.uTime, uZenith: c(sky.zenith), uHorizon: c(sky.horizon), uHaze: c(sky.haze), uSunCol: c(sky.sunColor) },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    // keep the scene alpha (rider mask)
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const geo = new THREE.SphereGeometry(18000, 64, 32, 0, Math.PI * 2, 0, Math.PI * 0.54);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -4;
  return {
    mesh,
    update(camera) {
      mesh.position.copy(camera.position);
      uCam.value.copy(camera.position);
    },
  };
}
