import * as THREE from 'three';

/**
 * Shared, live-updating uniforms used by every stylized material (fog, sun, wind...).
 * Materials reference these objects directly so a single write updates all shaders.
 */
export const G = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.96, 0.86) },
  uFogColor: { value: new THREE.Color(0.74, 0.83, 0.95) },
  uFogSunColor: { value: new THREE.Color(1.0, 0.93, 0.8) },
  uFogDensity: { value: 0.00018 },
  uFogHeightFalloff: { value: 0.0022 },
  uFogBase: { value: 0 },
  uFogMax: { value: 0.92 },
  uMistColor: { value: new THREE.Color(0.62, 0.58, 0.95) },
  uMistTop: { value: 180 },
  uMistBottom: { value: 40 },
  uMistStrength: { value: 0 },
  uMistNear: { value: 120 },
  uMistCenter: { value: new THREE.Vector2(0, 0) },
  uMistRadius: { value: 1e6 },
  uMistSlope: { value: 0 },
  uWind: { value: new THREE.Vector2(0.6, 0.3) },
  uPlayerPos: { value: new THREE.Vector3() },
};

export type GlobalUniforms = typeof G;

/** All uniforms referenced by ATMOSPHERE_GLSL (shared references). */
export function atmoUniforms() {
  return {
    uFogColor: G.uFogColor,
    uFogSunColor: G.uFogSunColor,
    uSunDir: G.uSunDir,
    uFogDensity: G.uFogDensity,
    uFogHeightFalloff: G.uFogHeightFalloff,
    uFogBase: G.uFogBase,
    uFogMax: G.uFogMax,
    uMistColor: G.uMistColor,
    uMistTop: G.uMistTop,
    uMistBottom: G.uMistBottom,
    uMistStrength: G.uMistStrength,
    uMistNear: G.uMistNear,
    uMistCenter: G.uMistCenter,
    uMistRadius: G.uMistRadius,
    uMistSlope: G.uMistSlope,
  };
}

/** GLSL for the stylized atmospheric perspective: exponential height fog + sun in-scatter + low valley mist. */
export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform vec3 uFogSunColor;
uniform vec3 uSunDir;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uFogBase;
uniform float uFogMax;
uniform vec3 uMistColor;
uniform float uMistTop;
uniform float uMistBottom;
uniform float uMistStrength;
uniform float uMistNear;
uniform vec2 uMistCenter;
uniform float uMistRadius;
uniform float uMistSlope;

vec3 applyAtmosphere(vec3 col, vec3 wpos) {
  vec3 rd = wpos - cameraPosition;
  float dist = length(rd);
  rd /= max(dist, 1e-3);
  float b = uFogHeightFalloff;
  float h = cameraPosition.y - uFogBase;
  float rdy = abs(rd.y) < 1e-4 ? 1e-4 : rd.y;
  float e = clamp(-dist * rdy * b, -60.0, 60.0);
  float amount = uFogDensity * exp(clamp(-b * h, -60.0, 60.0)) * (1.0 - exp(e)) / (b * rdy);
  float fog = min(1.0 - exp(-max(amount, 0.0)), uFogMax);
  float sunAmt = pow(max(dot(rd, uSunDir), 0.0), 5.0);
  vec3 fcol = mix(uFogColor, uFogSunColor, sunAmt * 0.6);
  col = mix(col, fcol, fog);
  float mist = uMistStrength * (1.0 - smoothstep(uMistBottom, uMistTop, wpos.y - uMistSlope * wpos.z)) * smoothstep(uMistNear, uMistNear * 4.0, dist);
  mist *= 1.0 - smoothstep(uMistRadius, uMistRadius * 1.7, distance(wpos.xz, uMistCenter));
  col = mix(col, uMistColor, clamp(mist, 0.0, 0.85));
  return col;
}
`;

const FOG_VERTEX = /* glsl */ `
vAtmoWorldPos = transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz);
`;

export interface PatchOptions {
  /** Skip atmospheric fog (e.g. for UI previews). */
  noFog?: boolean;
  /** Multiplies lit color saturation for this material. */
  saturation?: number;
  /** Custom hook to modify the shader further. */
  extend?: (shader: THREE.WebGLProgramParametersWithUniforms) => void;
  /** Unique key when `extend` changes shader code. */
  key?: string;
}

/**
 * Patch a built-in material (Lambert/Standard/Phong/Basic/Toon) so it uses the shared stylized atmosphere.
 * Must be called before the material is first rendered.
 */
export function patchMaterial<T extends THREE.Material>(mat: T, opts: PatchOptions = {}): T {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    Object.assign(shader.uniforms, atmoUniforms(), {
      uTime: G.uTime,
      uWind: G.uWind,
      uPlayerPos: G.uPlayerPos,
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vAtmoWorldPos;\nuniform float uTime;\nuniform vec2 uWind;\nuniform vec3 uPlayerPos;`,
      )
      .replace('#include <project_vertex>', `#include <project_vertex>\n${FOG_VERTEX}`);
    const sat = opts.saturation ?? 1;
    const satCode =
      sat !== 1
        ? `{ float l = dot(gl_FragColor.rgb, vec3(0.299,0.587,0.114)); gl_FragColor.rgb = max(mix(vec3(l), gl_FragColor.rgb, ${sat.toFixed(3)}), 0.0); }`
        : '';
    const fogCode = opts.noFog ? '' : `gl_FragColor.rgb = applyAtmosphere(gl_FragColor.rgb, vAtmoWorldPos);`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vAtmoWorldPos;\nuniform float uTime;\n${ATMOSPHERE_GLSL}`)
      .replace('#include <fog_fragment>', `${satCode}\n${fogCode}`);
    opts.extend?.(shader);
  };
  const baseKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () =>
    `${baseKey ? baseKey() : ''}|atmo:${opts.noFog ? 0 : 1}:${opts.saturation ?? 1}:${opts.key ?? ''}`;
  return mat;
}

export interface PaintMaterialParams {
  color?: THREE.ColorRepresentation;
  map?: THREE.Texture | null;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  emissiveMap?: THREE.Texture | null;
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  flatShading?: boolean;
  alphaTest?: number;
  depthWrite?: boolean;
  saturation?: number;
  noFog?: boolean;
}

/** Standard stylized material for scenery / characters (Lambert = soft, matte painterly shading). */
export function paintMaterial(p: PaintMaterialParams = {}): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    color: p.color ?? 0xffffff,
    map: p.map ?? null,
    emissive: p.emissive ?? 0x000000,
    emissiveIntensity: p.emissiveIntensity ?? 1,
    emissiveMap: p.emissiveMap ?? null,
    vertexColors: p.vertexColors ?? false,
    transparent: p.transparent ?? false,
    opacity: p.opacity ?? 1,
    side: p.side ?? THREE.FrontSide,
    flatShading: p.flatShading ?? false,
    alphaTest: p.alphaTest ?? 0,
    depthWrite: p.depthWrite ?? true,
  });
  return patchMaterial(m, { saturation: p.saturation, noFog: p.noFog });
}

/** Slightly glossy material for bikes / characters (helmet shells, frame paint). */
export function glossMaterial(
  color: THREE.ColorRepresentation,
  roughness = 0.45,
  metalness = 0.1,
  extra: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  return patchMaterial(m);
}
