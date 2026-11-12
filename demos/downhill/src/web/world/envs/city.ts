import * as THREE from 'three';
import { Noise } from '../../core/noise';
import { clamp, smoothstep } from '../../core/math';
import { SHAPES } from '../features';
import type { CourseSpec, EnvironmentDef, GroundSample, RGB, TerrainSpec } from '../types';
import { buildCitySetPieces } from '../props/city';

/**
 * Sunset Blocks — the second painted video: bombing the steep bitumen roof of a colossal Soviet panel
 * megastructure at blue hour, a glowing window wall on the left, a railing and a 140 m drop on the right,
 * and below it a dead-straight boulevard of light trails running between combs of slab blocks into the sun.
 *
 * Layout (the run heads toward -Z, s ≈ -z):
 *  - The megastructure runs dead straight along the course. Its roof (the rideable heightfield) ends at the
 *    right edge x = XR (curb + thin railing, then a sheer facade down to the city ~130-150 m below).
 *  - On the left, a chain of giant towers rises out of the roof at x = XL(s): the opening pitch (the video's shot)
 *    has the window wall ~8.5 m beside the line, the other narrow sections ~17 m; wide sections set the towers
 *    back for side lines and a kicker plaza. Inside the towers the heightfield climbs away (riders and kickers
 *    stay out).
 *  - The roof alternates steep pitches (up to 22°, hugging the railing like the video) with gentler decks that
 *    carry the main-line jumps. The city ground slopes with the course so the drop stays roughly constant.
 *  - The boulevard runs parallel to the course XB metres right of the edge, toward the low sun.
 */

const SEED = 6160;
const n = new Noise(SEED);
const lin = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** Right roof edge (railing line). Grid samples beyond XR + 0.5 are city ground. */
export const XR = 6;
/** Boulevard centreline: a comb of slab blocks fits between it and the cliff, like the video's near side. */
export const XB = XR + 96;
/**
 * Rideable region, aligned so that coarse geometry never smears the cliff into a ramp outside the facade:
 *  - minX ≡ 7 (mod 8): every terrain LOD has a vertex at x = 7, just past the edge (XR + 0.5), so coarse LODs
 *    drop within the facade line;
 *  - (minX + maxX) / 2 ≡ 9 (mod 40): the backdrop's 40 m cell holding the cliff (x -31…9) lies fully inside the
 *    region and is skipped.
 * Its width (> 240 m) makes the engine sample freeride kickers in x ∈ [minX + 120, maxX - 120] = [-81, -61]: open
 * roof only in the set-back kicker plaza (everywhere else that band is tower interior).
 * In z it covers the whole megastructure (head block from s = -270, end block to s = 2842) plus 140 m of city.
 */
export const REGION = { minX: -201, maxX: 59, minZ: -2984, maxZ: 412 };
const LENGTH = 2500;
const MAIN_JUMPS = 14;

// ---------------------------------------------------------------------------------------------
// Main-line jump zones (the engine places main-line jumps at fixed spacing when the line is straight there)
// ---------------------------------------------------------------------------------------------

const ORDER = ['small', 'small', 'medium', 'step', 'medium', 'drop', 'medium', 'large', 'medium', 'step', 'large', 'medium', 'large', 'drop'];
/** [start, end] of each planned main-line jump (arc length). */
export const JUMP_SPANS: Array<[number, number]> = [];
{
  const usable = LENGTH - 260;
  for (let k = 0; k < MAIN_JUMPS; k++) {
    const sh = SHAPES[ORDER[k % ORDER.length]];
    const s0 = 120 + (usable * (k + 0.5)) / MAIN_JUMPS;
    JUMP_SPANS.push([s0, s0 + sh.lk + sh.table + sh.gap + sh.ll]);
  }
}
/** Decks (gentle roof) around every jump: a long run-in to scrub speed off the pitch, and the run-out. */
const DECKS = JUMP_SPANS.map(([a, b]) => [a - 44, b + 22] as [number, number]);

/** Sections where the towers step back: [s0, s1, facade x]. The first one is the kicker plaza. */
export const WIDE: Array<[number, number, number]> = [
  [232, 560, -96],
  [560, 910, -44],
  [1152, 1670, -44],
  [1848, 2242, -44],
];
export const XL_NARROW = -14;
/**
 * The opening pitch (start platform, brink and the video's 20° drop-in) has the tower close beside the line, like
 * the video. It ends before the first deck, where the line moves inward for the jumps.
 */
export const XL_OPEN = -6;
export const OPEN_END = 140;
/** Tower facade line (left roof boundary) at arc length s. */
export function XL(s: number): number {
  if (s < OPEN_END) return XL_OPEN;
  for (const [a, b, x] of WIDE) if (s >= a && s < b) return x;
  return XL_NARROW;
}
/** Towers are this deep (their back faces stand at XL - TOWER_DEPTH). */
export const TOWER_DEPTH = 150;

// ---------------------------------------------------------------------------------------------
// Roof profile: piecewise slopes (steep pitches between decks), smoothed, integrated into a table
// ---------------------------------------------------------------------------------------------

const S0 = -900;
const S1 = 3600;
const deg = (d: number) => Math.tan((d * Math.PI) / 180);
/**
 * Slope of each pitch (bay k lies between deck k and deck k+1, so it feeds jump k+1), in degrees. The hero
 * pitches feed forgiving tabletops; drops and step-downs get gentler run-ins.
 * Jumps: 0 small, 1 small, 2 medium, 3 step, 4 medium, 5 drop, 6 medium, 7 large, 8 medium, 9 step, 10 large,
 * 11 medium, 12 large, 13 drop.
 */
const BAY_DEG = [15, 16, 12, 16, 11, 20, 21, 15, 12, 22, 16, 19, 11];
const DECK_DEG = 2.6;
const START_H = 452;
/** The start platform ends at the brink of the opening drop-in (the video's pitch). */
export const BRINK_S = 36;

function rawSlope(s: number): number {
  if (s < -40) return deg(6);
  if (s < BRINK_S) return deg(3.5);
  if (s < 124) return deg(20); // the opening pitch (the video)
  if (s < DECKS[0][0]) return deg(10);
  for (let k = 0; k < DECKS.length; k++) {
    const [a, b] = DECKS[k];
    if (s >= a && s <= b) return deg(DECK_DEG);
    if (k + 1 < DECKS.length && s > b && s < DECKS[k + 1][0]) {
      // the steep part sits in the middle of the bay; its ends ease into the decks
      const c0 = b + 10;
      const c1 = DECKS[k + 1][0] - 10;
      return s > c0 && s < c1 ? deg(BAY_DEG[k]) : deg((BAY_DEG[k] + DECK_DEG) * 0.5);
    }
  }
  const last = DECKS[DECKS.length - 1][1];
  if (s < last + 150) return deg(13); // the final pitch to the finish
  return deg(2.2); // run-out
}

const PROF_N = S1 - S0 + 1;
const PROFILE = new Float32Array(PROF_N);
{
  const raw = new Float32Array(PROF_N);
  for (let i = 0; i < PROF_N; i++) raw[i] = rawSlope(S0 + i);
  // two box blurs (≈ triangular, 2×13 m) make every transition a smooth concave / convex curve
  const blur = (src: Float32Array, r: number) => {
    const out = new Float32Array(src.length);
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[clamp(i, 0, src.length - 1)];
    for (let i = 0; i < src.length; i++) {
      out[i] = acc / (2 * r + 1);
      acc += src[clamp(i + r + 1, 0, src.length - 1)] - src[clamp(i - r, 0, src.length - 1)];
    }
    return out;
  };
  const sl = blur(blur(raw, 7), 6);
  const i0 = -S0;
  PROFILE[i0] = START_H;
  for (let i = i0 + 1; i < PROF_N; i++) PROFILE[i] = PROFILE[i - 1] - 0.5 * (sl[i] + sl[i - 1]);
  for (let i = i0 - 1; i >= 0; i--) PROFILE[i] = PROFILE[i + 1] + 0.5 * (sl[i] + sl[i + 1]);
}

/** Roof surface height at arc length s (≈ -z). */
export function roofY(s: number): number {
  const f = clamp(s - S0, 0, PROF_N - 1.001);
  const i = Math.floor(f);
  return PROFILE[i] + (PROFILE[i + 1] - PROFILE[i]) * (f - i);
}

const END_H = roofY(LENGTH);
/** The run's last tower closes the roof here (well past the finish). */
export const ROOF_END = 2722;
/** The megastructure starts (the head block, the select screen's backdrop) here, behind the start. */
export const ROOF_BEGIN = -150;
/** The head and end blocks are this deep. */
export const END_DEPTH = 120;

/** City ground: follows the course (~150 m below the start, ~100 m below the finish), flattening beyond. */
const G_START = START_H - 98;
const G_END = END_H - 92;
const G_SLOPE = (G_START - G_END) / LENGTH;
export function groundY(z: number): number {
  const s = -z;
  if (s < -600) return G_START + G_SLOPE * 600 + G_SLOPE * 700 * (1 - Math.exp((s + 600) / 700));
  if (s <= LENGTH) return G_START - G_SLOPE * s;
  return G_END - G_SLOPE * 900 * (1 - Math.exp(-(s - LENGTH) / 900));
}
const f = (v: number) => v.toFixed(5);
/** groundY() for shaders (GPU-animated traffic). */
export const cityGroundGLSL = /* glsl */ `
float cityGround(float z) {
  float s = -z;
  if (s < -600.0) return ${f(G_START + G_SLOPE * 600)} + ${f(G_SLOPE * 700)} * (1.0 - exp((s + 600.0) / 700.0));
  if (s <= ${f(LENGTH)}) return ${f(G_START)} - ${f(G_SLOPE)} * s;
  return ${f(G_END)} - ${f(G_SLOPE * 900)} * (1.0 - exp(-(s - ${f(LENGTH)}) / 900.0));
}`;

// ---------------------------------------------------------------------------------------------
// Main line: hugs the railing on the pitches (the video framing), steps inward for the jumps
// ---------------------------------------------------------------------------------------------

const E_TABLE = new Float32Array(LENGTH + 400);
{
  for (let i = 0; i < E_TABLE.length; i++) {
    const s = i - 100;
    let w = 0;
    // 60 m transitions keep the line's curvature under the engine's banking threshold (1/70 m⁻¹): the roof stays
    // a plane, no berms
    for (const [a, b] of DECKS) w = Math.max(w, smoothstep(a - 50, a + 10, s) * (1 - smoothstep(b - 10, b + 50, s)));
    // a few gentle drifts so the long pitches aren't ruler-straight
    const drift = 0.4 * Math.sin(s / 61 + 0.7) * (1 - w);
    E_TABLE[i] = 3.5 + 3.8 * w + drift;
  }
}
/** Distance from the railing to the main line at arc length s. */
export function edgeGap(s: number): number {
  const f = clamp(s + 100, 0, E_TABLE.length - 1.001);
  const i = Math.floor(f);
  return E_TABLE[i] + (E_TABLE[i + 1] - E_TABLE[i]) * (f - i);
}
export const centerline = (z: number) => XR - edgeGap(-z);

// ---------------------------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------------------------

function insideRoofSpan(s: number) {
  return s > ROOF_BEGIN && s < ROOF_END;
}

/**
 * Megastructure roof, tower interiors and the sloping city plain. The whole megastructure lies ≥ 140 m inside the
 * detailed region's z borders, so the backdrop's coarse cells never have to span the cliff (they would turn it
 * into a stretched slope poking out of the facade).
 */
function farHeight(x: number, z: number): number {
  const s = -z;
  const g = groundY(z);
  if (x > XR + 0.5) return g;
  // the roof runs 12 m into the head / end blocks, so even coarse terrain LODs stay flat up to their faces
  if (s < ROOF_BEGIN - 12 || s > ROOF_END + 12) {
    // hidden floors inside the blocks are flat (2 m inset), so the engine never puts a freeride kicker there
    const head = s > ROOF_BEGIN - END_DEPTH + 2 && s < ROOF_BEGIN;
    const end = s > ROOF_END && s < ROOF_END + END_DEPTH - 2;
    if ((head || end) && x > XL_NARROW - TOWER_DEPTH + 2 && x < XR - 1.5) return groundY(-(head ? ROOF_BEGIN : ROOF_END + END_DEPTH)) - 1;
    return g;
  }
  const ry = roofY(clamp(s, ROOF_BEGIN, ROOF_END));
  // the roof band reaches 1.5 m behind every facade, so the walls stand on clean roof (no B-spline fillet)
  const xl = Math.min(XL(s - 1.5), XL(s), XL(s + 1.5));
  if (x >= xl - 1.5) return ry;
  // inside the towers the ground climbs away from the walls (too steep for a kicker) and falls back to the city
  // well inside them
  if (x < xl - TOWER_DEPTH + 45) return g;
  return ry + 0.6 * (xl - 1.5 - x);
}

function height(x: number, z: number): number {
  return farHeight(x, z);
}

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

const ROOF = lin('#757fb4');
const ROOF_B = lin('#808abc');
const ROOF_DARK = lin('#545c8c');
const ROOF_PATCH = lin('#6c74a6');
const WORN = lin('#8790c0');
const LAWN = lin('#2a5232');
const LAWN_B = lin('#386038');
const FOREST = lin('#16302a');
const FOREST_B = lin('#1c3a30');
const CONCRETE = lin('#9d9cc4');

function mixInto(out: RGB, a: RGB, b: RGB, t: number) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

function cityColor(x: number, z: number, out: RGB) {
  const d = Math.abs(x - XB);
  // forest beyond the micro-districts, lawns and tree yards between the blocks
  const urban = 1 - smoothstep(520, 900, x - XR) * (x > XR ? 1 : 0) - (x < XR - 160 ? smoothstep(160, 420, XR - x) : 0);
  const p = n.fbm(x / 140, z / 140, 2) * 0.5 + 0.5;
  mixInto(out, FOREST, FOREST_B, p);
  mixInto(out, out, n.noise2(x / 60, z / 60) > 0 ? LAWN : LAWN_B, clamp(urban, 0, 1) * 0.85);
  // the boulevard corridor reads as grey-blue asphalt from afar
  if (d < 46) mixInto(out, out, CONCRETE, (1 - smoothstep(30, 46, d)) * 0.5);
}

function groundColor(s: GroundSample, out: RGB) {
  const roofLevel = Math.abs(s.h - roofY(-s.z)) < 1.5 && s.x <= XR + 0.5 && s.x > XL(-s.z) - 1;
  if (!roofLevel) {
    if (s.x > XR + 0.5 || s.h < groundY(s.z) + 6) cityColor(s.x, s.z, out);
    else mixInto(out, CONCRETE, ROOF_DARK, 0.4);
    return;
  }
  // bitumen membrane: big calm sheets of periwinkle with slightly different patches and dark weathering
  const p = n.fbm(s.x / 26, s.z / 34, 3) * 0.5 + 0.5;
  mixInto(out, ROOF, ROOF_B, smoothstep(0.3, 0.75, p));
  const patch = n.noise2(Math.floor(s.x / 7) * 1.31 + 0.5, Math.floor((s.z + 3) / 11) * 0.73);
  if (patch > 0.45) mixInto(out, out, ROOF_PATCH, 0.55);
  const wet = n.fbm(s.x / 9 + 7, s.z / 9 - 2, 2);
  mixInto(out, out, ROOF_DARK, clamp(-wet * 0.9, 0, 0.45));
  // grime gathers along the curb
  mixInto(out, out, ROOF_DARK, (1 - smoothstep(0.6, 2.4, XR - s.x)) * 0.5);
  // the line riders take is polished lighter
  mixInto(out, out, WORN, (1 - smoothstep(-0.2, 1.6, s.trailDist)) * 0.35);
}

function farColor(x: number, z: number, h: number, _ny: number, out: RGB) {
  if (insideRoofSpan(-z) && x <= XR + 0.5 && h > groundY(z) + 20) {
    mixInto(out, ROOF, ROOF_DARK, 0.3);
    return;
  }
  cityColor(x, z, out);
}

export const cityTerrainSpec: TerrainSpec = {
  region: REGION,
  cell: 1,
  height,
  farHeight,
  groundColor,
  farColor,
  surface: () => 'rock',
};

const COURSE: CourseSpec = {
  start: { x: centerline(0), z: 0 },
  length: LENGTH,
  meander: 0,
  wavelengths: [400, 200, 100],
  centerline,
  jumps: MAIN_JUMPS,
  sideLines: [
    { from: 566, to: 904, offset: -22, kind: 'flow' },
    { from: 1184, to: 1664, offset: -23, kind: 'pro' },
    { from: 1880, to: 2236, offset: -22, kind: 'flow' },
  ],
  freerideKickers: 6,
  trailColor: lin('#7d86ba'),
  trailEdgeColor: lin('#737cae'),
  marginX: 8,
};

export const sunsetBlocks: EnvironmentDef = {
  id: 'city',
  name: 'Sunset Blocks',
  subtitle: 'Rooftop run above the boulevard',
  description: 'Drop the steep roof of a colossal panel tower at blue hour — a glowing window wall on your left, a sheer drop on your right and a boulevard of light trails running into the sun.',
  cardColors: ['#7f86e8', '#ff5aa0', '#ffb43c'],
  // (layout noise uses SEED; this one only drives jump/kicker placement: all kickers land fully inside the plaza)
  seed: 6151,
  ambience: 'city',
  terrain: cityTerrainSpec,
  course: COURSE,
  sky: {
    zenith: '#26268a',
    horizon: '#8e4a9c',
    haze: '#4c3f9a',
    sunColor: '#ffb470',
    sunIntensity: 2.6,
    sunDir: [0.4837, 0.0454, -0.8737],
    hemiSky: '#7a8aff',
    hemiGround: '#3c3466',
    hemiIntensity: 1.7,
    cloudCount: 0,
    cloudLight: '#ffd2a8',
    cloudShade: '#8a5aa0',
    cloudBanks: [{ azimuth: 0.4, spread: 0.6, weight: 1 }],
    cloudHeight: [600, 1200],
    cloudDistance: [6000, 9000],
    cloudScale: [2000, 3000],
  },
  fog: {
    // blue-violet even toward the sun: the video's far plain is a saturated navy haze, never magenta
    color: '#3036a8',
    sunColor: '#4a42c6',
    density: 0.0001,
    heightFalloff: 0.0013,
    base: 0,
    max: 0.8,
    mistColor: '#3438a6',
    // a violet haze over the far plain (the planes descend with the city)
    mistTop: G_START + 40,
    mistBottom: G_START - 70,
    mistSlope: G_SLOPE,
    mistStrength: 0.32,
    mistNear: 900,
    mistCenter: [XB, -3000],
    mistRadius: 9000,
  },
  grass: {
    enabled: false,
    base: '#3a5a34',
    tip: '#5a7a44',
    tipAlt: '#6a8a4a',
    height: [0.1, 0.2],
    density: 0,
    coverage: () => 0,
  },
  scatter: [],
  post: {
    saturation: 1.5,
    vibrance: 0.35,
    contrast: 0.42,
    exposure: 1.0,
    bloom: 0.9,
    shadowTint: [0.02, 0.0, 0.12],
    highlightTint: [0.05, 0.02, -0.03],
  },
  introShot: { from: [26, 26, 70], to: [40, -150, -900] },
  // like the video's operator: ride on the tower side of the rider (rear-left), a little high, aiming across the
  // rider toward the edge so the view falls over the railing onto the boulevard instead of along the roof
  camera: { lift: 0.9, lookLift: 0.2, orbit: 0.4, orbitScale: 0.7, pan: 1.8 },
  buildSetPieces: buildCitySetPieces,
};
