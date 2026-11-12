import * as THREE from 'three';
import { Noise } from '../../core/noise';
import { clamp, smoothstep, TAU } from '../../core/math';
import type { CourseSpec, EnvironmentDef, GroundSample, RGB, TerrainSpec } from '../types';
import { TrailGuide } from '../props/desertGuide';
import { buildDuneSetPieces } from '../props/dunes';

/**
 * Dune Coast — a golden erg pouring into a turquoise lagoon under tropical midday light.
 *
 * Layout (run heads toward -Z):
 *  - The course drops ~335 m down the flank of a sand sea: sharp-crested transverse ridges with deep-orange slip
 *    faces rise on both sides of the sand streets the trails follow (dunes fade out near every trail), with
 *    weathered sand fences half buried along the main line.
 *  - Ahead: palm groves, a white beach with an old shipwreck, the shallow turquoise lagoon dotted with sailboats,
 *    a palm-studded barrier island and the sapphire ocean with green islands on the horizon.
 *  - Right (+X): a red granite headland with a grassy top curls in front of the finish, crowned by the
 *    red-and-white lighthouse (sweeping beam); sea stacks off its tip.
 *  - Behind/sides: mega-dunes climb inland to hazy violet ranges.
 */

const SEED = 7311;
const n = new Noise(SEED);
const lin = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

export const REGION = { minX: -512, maxX: 448, minZ: -2752, maxZ: 128 };

const COURSE: CourseSpec = {
  start: { x: 0, z: 0 },
  length: 2500,
  meander: 62,
  wavelengths: [640, 340, 200],
  jumps: 14,
  sideLines: [
    { from: 280, to: 860, offset: -64, kind: 'flow' },
    { from: 1100, to: 1700, offset: 74, kind: 'pro' },
    { from: 1840, to: 2340, offset: -60, kind: 'flow' },
  ],
  freerideKickers: 22,
  trailColor: lin('#c58f55'),
  trailEdgeColor: lin('#dca872'),
  marginX: 120,
};

let guide: TrailGuide | null = null;
/** Exact trail polylines + distance fields. */
export function dunesGuide(): TrailGuide {
  return (guide ??= new TrailGuide(COURSE, REGION, SEED));
}

// ---------------------------------------------------------------------------------------------
// Coast
// ---------------------------------------------------------------------------------------------

/** Lagoon waterline z as a function of x (the mainland beach). */
export function shoreZ(x: number): number {
  return -2510 + 46 * Math.sin(x / 520 + 0.6) + 20 * Math.sin(x / 190 + 1.7) - 0.32 * Math.max(0, -x - 1800) + 0.18 * Math.max(0, x - 1300);
}
/** Barrier island centreline z. */
export const barZ = (x: number) => -3540 + 70 * Math.sin(x / 1100 + 1);

/** Headland spine (granite point curling in front of the finish, right of the run) and its half width. */
export const HEADLAND = { ax: 470, az: -2250, bx: 240, bz: -3020, r: 120, top: 70 };
/** Distance from the headland spine segment. */
export function headlandDist(x: number, z: number): number {
  const { ax, az, bx, bz } = HEADLAND;
  const sx = bx - ax;
  const sz = bz - az;
  let t = ((x - ax) * sx + (z - az) * sz) / (sx * sx + sz * sz);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + sx * t), z - (az + sz * t));
}
/** Headland plateau elevation (rises inland). */
export function headlandTop(x: number, z: number): number {
  const { az, bz, top } = HEADLAND;
  const t = clamp((z - bz) / (az - bz), 0, 1);
  return top + 22 * t + 4 * n.noise2(x / 120, z / 120);
}

const ISLANDS: Array<[number, number, number, number]> = [
  [4300, -9400, 1500, 300],
  [6100, -10600, 900, 170],
  [-3900, -11200, 1900, 420],
];

const CX = (REGION.minX + REGION.maxX) / 2;
const CZ = (REGION.minZ + REGION.maxZ) / 2;

/** Elevation of the coastal ramp as a function of the distance inland from the waterline. */
export function ramp(dz: number): number {
  if (dz < 0) return 0;
  if (dz < 150) return 0.0175 * dz;
  const L = 2340;
  if (dz < 150 + L) {
    const t = (dz - 150) / L;
    let y = 2.6 + 339.4 * Math.pow(t, 1.1);
    y += (5 * Math.sin(t * 3.4 * TAU + 0.4) + 2 * Math.sin(t * 8.1 * TAU + 1.3)) * smoothstep(0.04, 0.2, t) * (1 - smoothstep(0.85, 0.98, t));
    return y;
  }
  const b = Math.min(dz - 150 - L, 4000);
  return 342 + 0.11 * b - 0.000011 * b * b;
}

// ---------------------------------------------------------------------------------------------
// Dunes
// ---------------------------------------------------------------------------------------------

/** Phase axis of the main ridges: crests run ~20° off the fall line (leading lines toward the sea); slip faces face +X (away from the sun). */
const AX = 0.94;
const AZ = 0.34;
const LA = 270;
const KA = 0.8;
const KB = 0.8;

/** Last dune sample (avoids allocations in hot paths). */
export const dune = { u: 0, amp: 0, h: 0 };

/** Gentle stoss slope steepening to a sharp brink, then an angle-of-repose slip face with a concave foot. */
function profile(u: number, k: number) {
  return u < k ? Math.pow(u / k, 1.25) : Math.pow(1 - (u - k) / (1 - k), 1.25);
}

/** Dune relief (≥ 0) on top of the coastal ramp, with its phase and amplitude written into `dune`. */
export function dunes(x: number, z: number, dz: number): number {
  dune.u = 0;
  dune.amp = 0;
  dune.h = 0;
  let env = smoothstep(130, 420, dz);
  if (env <= 0) return 0;
  const hd = headlandDist(x, z);
  env *= smoothstep(HEADLAND.r + 30, HEADLAND.r + 220, hd);
  const r = Math.hypot(x - CX, z - CZ);
  env *= 1 - smoothstep(5200, 6600, r);
  if (env <= 0) return 0;
  // main ridges: sinuous crests, linked along their length
  const w = 0.42 * n.fbm(x / 820 + 3.3, z / 820 - 7.1, 2);
  const p = (x * AX + z * AZ) / LA + w;
  const u = p - Math.floor(p);
  const along = (x * -AZ + z * AX) / 520 + 1.5 * w;
  const link = 0.66 + 0.34 * Math.sin(along * TAU);
  const wide = smoothstep(380, 1500, Math.abs(x - 20)) + smoothstep(2700, 3600, dz);
  const amp = (20 + 16 * (n.noise2(x / 900 - 1.3, z / 900 + 2.7) * 0.5 + 0.5) + 30 * Math.min(1, wide)) * link * env;
  let h = profile(u, KA) * amp;
  // small oblique dunes riding on the flanks
  const pb = (x * 0.5 + z * 0.866) / 78 + 0.4 * w;
  const ub = pb - Math.floor(pb);
  h += profile(ub, KB) * 2.2 * env * (0.4 + 0.6 * smoothstep(-0.2, 0.5, n.noise2(x / 260, z / 260)));
  dune.u = u;
  dune.amp = amp;
  dune.h = h;
  return h;
}

/** Mega-dunes (draa) of the inland erg — backdrop only. */
function megaDunes(x: number, z: number, dz: number): number {
  const r = Math.hypot(x - CX, z - CZ);
  const m = Math.max(smoothstep(1100, 2600, Math.abs(x - 20)), smoothstep(3000, 4200, dz)) * smoothstep(400, 900, dz) * (1 - smoothstep(9000, 12000, r));
  if (m <= 0) return 0;
  const w = 0.4 * n.fbm(x / 3000 - 2, z / 3000 + 4, 2);
  const p = (x * 0.42 + z * 0.91) / 1500 + w;
  const u = p - Math.floor(p);
  const amp = 70 + 70 * (n.noise2(x / 4000, z / 4000) * 0.5 + 0.5);
  return profile(u, 0.72) * amp * m;
}

// ---------------------------------------------------------------------------------------------
// Height
// ---------------------------------------------------------------------------------------------

/** Large-scale landscape (no fine detail, includes the dunes). */
function farHeight(x: number, z: number): number {
  const dz = z - shoreZ(x);
  let land: number;
  dune.h = 0;
  if (dz >= 0) {
    land = ramp(dz) + dunes(x, z, dz) + megaDunes(x, z, dz);
  } else {
    // lagoon floor, shoreface, sandbars, barrier island, reef drop-off to the ocean
    const bz = barZ(x);
    const deep = Math.max(smoothstep(bz - 70, bz - 420, z), smoothstep(1150, 1700, x) * smoothstep(-60, -520, dz));
    land = -5 - 1.2 * n.noise2(x / 300, z / 300) - 33 * deep;
    land = Math.max(land, -2.6 + 1.4 * n.noise2(x / 140 + 9, z / 90 - 4) - 6 * smoothstep(-0.2, 0.4, n.noise2(x / 600, z / 600)));
    land += (0 - land) * smoothstep(-70, 0, dz);
    const island = smoothstep(62, 18, Math.abs(z - bz)) * smoothstep(260, 120, x) * (1 - smoothstep(150, 70, Math.abs(x + 1700)));
    land = Math.max(land, -6 + 9 * island);
  }
  // granite headland base, kept inside the cliff walls (the cliffs themselves are set-piece geometry)
  const hd = headlandDist(x, z);
  if (hd < HEADLAND.r) {
    const k = smoothstep(HEADLAND.r - 30, HEADLAND.r - 75, hd);
    land = Math.max(land, land + (headlandTop(x, z) - 12 - land) * k);
  }
  // distant volcanic islands
  for (const [ix, iz, ir, ih] of ISLANDS) {
    const d = Math.hypot(x - ix, z - iz);
    if (d < ir) {
      const t = 1 - d / ir;
      land = Math.max(land, -40 + (ih + 40) * Math.pow(t, 1.4) * (0.85 + 0.15 * n.noise2(x / 500, z / 500)));
    }
  }
  // violet ranges far inland
  const r = Math.hypot(x - CX, z - CZ);
  if (dz > 4500 && r > 6500) {
    const k = smoothstep(4500, 9000, dz) * smoothstep(6500, 10000, r);
    land += k * (300 + 1500 * n.ridged(x / 5200 + 3.1, z / 5200 - 1.7, 4));
  }
  return land;
}

function height(x: number, z: number): number {
  const base = farHeight(x, z);
  const dz = z - shoreZ(x);
  if (dz < -80) return base;
  // sand streets: dunes fade out near every trail
  const keep = smoothstep(7, 30, dunesGuide().dist(x, z));
  let h = base;
  if (dune.h > 0) h -= dune.h * (1 - keep);
  // gentle sand waves on the erg (subdued in the streets so the lines never climb)
  h += 0.5 * Math.sin((x * 0.42 + z * 0.9) / 8.5) * smoothstep(300, 600, dz) * (0.25 + 0.75 * keep);
  const big = 2.4 * n.fbm(x / 210 + 11, z / 210, 3);
  const small = 0.3 * n.noise2(x / 13, z / 13);
  return h + big * smoothstep(40, 200, dz) + small * smoothstep(-10, 120, dz);
}

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

const SAND = lin('#f0b45a');
const SAND_LIGHT = lin('#f7cc76');
const SAND_PALE = lin('#fde4ac');
const SAND_WARM = lin('#eea04e');
const SAND_DEEP = lin('#df7e40');
const SAND_SLIP = lin('#e6783c');
const RIPPLE = lin('#d99248');
const BEACH = lin('#f7ecd2');
const WET = lin('#d6c294');
const VEG = lin('#9ab84a');
const VEG_DEEP = lin('#6d963a');
const GRASS = lin('#7cb84a');
const ROCK = lin('#b07a66');
const ISLAND = lin('#4f9a48');
const VIOLET = lin('#9a8fd6');
const VIOLET_DEEP = lin('#7a72c0');
const SEABED = lin('#e8dcb8');

function mixInto(out: RGB, a: RGB, b: RGB, t: number) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

function landColor(x: number, z: number, h: number, ny: number, out: RGB, keep: number, trailDist = 1e4) {
  const dz = z - shoreZ(x);
  if (dz < -2) {
    mixInto(out, SEABED, BEACH, smoothstep(-0.5, 1.5, h));
  } else {
    const p = n.noise2(x / 420 + 7, z / 420 - 3) * 0.5 + 0.5;
    mixInto(out, SAND, SAND_LIGHT, smoothstep(0.3, 0.75, p));
    mixInto(out, out, SAND_WARM, smoothstep(0.2, 0.7, n.noise2(x / 640 - 5, z / 640 + 8)) * 0.6);
    // broad wind-ripple bands across the whole erg (painterly strokes)
    const rip0 = Math.sin(((x * 0.42 + z * 0.9) / 8.5) * 1.0 + 1.8 * n.noise2(x / 60, z / 60));
    mixInto(out, out, rip0 > 0 ? SAND_PALE : RIPPLE, Math.abs(rip0) * 0.12 * smoothstep(160, 400, dz));
    dunes(x, z, dz);
    const a = clamp((dune.amp * keep) / 14, 0, 1);
    if (a > 0.02) {
      const u = dune.u;
      if (u < KA) {
        // stoss: crisp wind-ripple bands, brightening toward the sharp crest
        const t = u / KA;
        const rip = Math.sin(((x * AX + z * AZ) / LA) * TAU * 24 + 2.4 * n.noise2(x / 40, z / 40));
        mixInto(out, out, RIPPLE, smoothstep(0.35, 0.75, rip) * 0.55 * a * (1 - t * 0.7));
        mixInto(out, out, SAND_PALE, smoothstep(0.62, 1.0, t) * 0.85 * a);
      } else {
        // slip face: rich, deep orange, darkest just below the brink
        const t = (u - KA) / (1 - KA);
        mixInto(out, out, t < 0.4 ? SAND_DEEP : SAND_SLIP, (0.95 - 0.35 * t) * a);
      }
    }
    // beach: bright white sand, wet band at the waterline
    mixInto(out, out, BEACH, smoothstep(170, 70, dz));
    mixInto(out, out, WET, smoothstep(14, 2, dz) * 0.9);
    // vegetated slacks behind the beach (kept off the trails)
    if (dz > 90 && dz < 1000) {
      const v = smoothstep(0.36, 0.64, n.noise2(x / 150 + 4, z / 150 - 9)) * (1 - a * 0.9) * smoothstep(90, 180, dz) * (1 - smoothstep(600, 1000, dz)) * smoothstep(3, 12, trailDist);
      if (v > 0) mixInto(out, out, n.noise2(x / 30, z / 30) > 0 ? VEG : VEG_DEEP, v * 0.7);
    }
  }
  // headland: grassy top, rock on steep ground
  const hd = headlandDist(x, z);
  if (hd < HEADLAND.r + 40 && h > 6) {
    const k = smoothstep(HEADLAND.r + 30, HEADLAND.r - 10, hd);
    mixInto(out, out, ny > 0.82 ? GRASS : ROCK, k);
  }
  // islands + far ranges
  if (h > 30) {
    const far = Math.hypot(x - CX, z - CZ);
    if (far > 6000) {
      const isl = dz < 0 ? 1 : 0;
      if (isl) mixInto(out, out, ny > 0.8 ? ISLAND : ROCK, smoothstep(30, 60, h));
      else mixInto(out, out, n.noise2(x / 900, z / 900) > 0 ? VIOLET : VIOLET_DEEP, smoothstep(380, 900, h));
    }
  }
}

function groundColor(s: GroundSample, out: RGB) {
  const td = dunesGuide().dist(s.x, s.z);
  landColor(s.x, s.z, s.h, s.ny, out, smoothstep(7, 30, td), s.trailDist);
  // compacted, slightly darker sand along the trails
  mixInto(out, out, SAND_DEEP, (1 - smoothstep(0, 2.6, s.trailDist)) * 0.28);
}

function farColor(x: number, z: number, h: number, ny: number, out: RGB) {
  landColor(x, z, h, ny, out, 1);
}

function surface(s: GroundSample) {
  if (s.trailDist < 1.2) return 'dirt' as const;
  if (headlandDist(s.x, s.z) < HEADLAND.r) return 'rock' as const;
  return 'sand' as const;
}

export const dunesTerrainSpec: TerrainSpec = {
  region: REGION,
  cell: 2,
  height,
  farHeight,
  groundColor,
  farColor,
  surface,
  seaLevel: 0,
};

export const duneCoast: EnvironmentDef = {
  id: 'dunes',
  name: 'Dune Coast',
  subtitle: 'Golden dunes to a turquoise lagoon',
  description: 'Surf a sea of golden dunes down to a white beach and a turquoise lagoon, with a candy-striped lighthouse watching over the sails.',
  cardColors: ['#f2c066', '#22c7c0', '#e8463a'],
  seed: SEED,
  ambience: 'beach',
  terrain: dunesTerrainSpec,
  course: COURSE,
  sky: {
    zenith: '#1652d4',
    horizon: '#7ccff0',
    haze: '#d2f0fa',
    sunColor: '#fff0d2',
    sunIntensity: 3.7,
    sunDir: [-0.64, 0.7, 0.3],
    hemiSky: '#98c4ff',
    hemiGround: '#e0a868',
    hemiIntensity: 1.05,
    cloudCount: 54,
    cloudLight: '#ffffff',
    cloudShade: '#a6bcdc',
    cloudBanks: [
      { azimuth: 0.15, spread: 0.55, weight: 3 },
      { azimuth: -0.85, spread: 0.45, weight: 2 },
      { azimuth: 0.95, spread: 0.45, weight: 2 },
      { azimuth: 3.1, spread: 0.9, weight: 1 },
    ],
    cloudHeight: [600, 1500],
    cloudDistance: [4200, 9800],
    cloudScale: [1700, 3800],
  },
  fog: {
    color: '#c4e2f6',
    sunColor: '#fff2d8',
    density: 0.00008,
    heightFalloff: 0.0014,
    base: 0,
    max: 0.75,
  },
  water: { level: 0, deep: '#0b3aa8', shallow: '#20d0c8', foam: '#f6fbfa', depthScale: 16 },
  grass: {
    enabled: true,
    base: '#9aa04c',
    tip: '#d9d27c',
    tipAlt: '#b8c868',
    height: [0.2, 0.55],
    density: 1,
    coverage: (s) => {
      const dz = s.z - shoreZ(s.x);
      if (dz < 60 || dz > 1200) return 0;
      return smoothstep(0.25, 0.6, n.noise2(s.x / 150 + 4, s.z / 150 - 9)) * smoothstep(60, 150, dz) * (s.ny > 0.85 ? 0.9 : 0) * smoothstep(2, 8, s.trailDist);
    },
    flowers: { colors: ['#ff6fa8', '#ffe35a'], density: 0.03 },
  },
  scatter: [
    {
      kind: 'marram',
      perHectare: 70,
      scale: [0.9, 1.5],
      colorA: '#9cae52',
      colorB: '#d2cc78',
      trailClearance: 1.2,
      collide: 'none',
      density: (s) => {
        const dz = s.z - shoreZ(s.x);
        if (dz < 50) return 0;
        dunes(s.x, s.z, dz);
        const crest = dune.amp > 4 ? smoothstep(0.6, 0.78, dune.u) * (1 - smoothstep(0.8, 0.86, dune.u)) : 0;
        const back = smoothstep(60, 120, dz) * (1 - smoothstep(260, 600, dz));
        return Math.max(crest * 0.7, back * 0.8);
      },
    },
    {
      kind: 'palm',
      perHectare: 13,
      scale: [1.2, 2.0],
      colorA: '#2a8a3c',
      colorB: '#62b240',
      trailClearance: 5,
      collide: 'solid',
      far: true,
      density: (s) => {
        const dz = s.z - shoreZ(s.x);
        if (s.h < 1.2) return 0;
        const beach = smoothstep(18, 50, dz) * (1 - smoothstep(260, 460, dz));
        const grove = smoothstep(-0.15, 0.35, n.noise2(s.x / 170 - 6, s.z / 170 + 3));
        const island = dz < 0 && s.h > 1.2 && s.h < 6 ? 1 : 0;
        const slack = dz > 90 && dz < 900 ? smoothstep(0.38, 0.6, n.noise2(s.x / 150 + 4, s.z / 150 - 9)) * 0.35 : 0;
        const head = headlandDist(s.x, s.z) < HEADLAND.r + 60 && s.ny > 0.85 && s.h > 20 ? 0.5 : 0;
        return Math.max(beach * grove, island * 0.9, slack, head);
      },
    },
    {
      kind: 'round',
      perHectare: 6,
      scale: [0.7, 1.5],
      colorA: '#4f8f3a',
      colorB: '#8cb24a',
      trailClearance: 2,
      collide: 'soft',
      far: true,
      density: (s) => {
        const dz = s.z - shoreZ(s.x);
        if (dz < 40 || dz > 1100) return 0;
        return smoothstep(0.25, 0.55, n.noise2(s.x / 150 + 4, s.z / 150 - 9)) * 0.9 + smoothstep(60, 110, dz) * (1 - smoothstep(160, 260, dz)) * 0.4;
      },
    },
    {
      kind: 'driftwood',
      perHectare: 8,
      scale: [0.8, 1.7],
      colorA: '#c2ad90',
      colorB: '#efe4d0',
      trailClearance: 2,
      collide: 'none',
      density: (s) => {
        const dz = s.z - shoreZ(s.x);
        return dz > 4 && dz < 70 ? 0.7 : 0;
      },
    },
  ],
  post: {
    saturation: 1.3,
    vibrance: 0.32,
    contrast: 0.27,
    exposure: 1.02,
    shadowTint: [0.0, 0.015, 0.09],
    highlightTint: [0.04, 0.03, -0.02],
  },
  introShot: { from: [-34, 10, 30], to: [70, 10, -420] },
  buildSetPieces: buildDuneSetPieces,
};
