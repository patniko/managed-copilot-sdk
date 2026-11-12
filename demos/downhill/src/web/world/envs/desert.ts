import * as THREE from 'three';
import { Noise } from '../../core/noise';
import { smoothstep, TAU } from '../../core/math';
import type { CourseSpec, EnvironmentDef, GroundSample, RGB, TerrainSpec } from '../types';
import { TrailGuide } from '../props/desertGuide';
import { buildDesertSetPieces } from '../props/desert';

/**
 * Sunset Mesa — red-rock canyon country at golden hour.
 *
 * Layout (run heads toward -Z):
 *  - The course bombs a broad terracotta bajada (alluvial fan) spilling out of a horseshoe amphitheatre of strata
 *    cliffs behind the start; a giant natural arch spans the trail at s ≈ 1040 m, a smaller arch on a slickrock fin
 *    stands off to the left, and banded hoodoo clusters line the run. A golden dune sheet gathers on the lower fan.
 *  - Past the finish the fan breaks over a wavy canyon rim, revealing the turquoise river ~130 m below, winding across
 *    a green-fringed floodplain at the foot of the 680 m South Rim wall.
 *  - Left (-X): the Sunset Mesa massif with benches, promontories, detached buttes and hoodoo badlands.
 *  - Right (+X): Monument-Valley buttes and totem spires; a steam train emerges from a tunnel in the big East butte,
 *    rolls down the East Valley, crosses the river on a timber trestle and vanishes into the South Rim.
 *  - Hot-air balloons drift above the run; violet ranges stand far beyond.
 */

const SEED = 5150;
const n = new Noise(SEED);
const lin = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

export const REGION = { minX: -512, maxX: 448, minZ: -2752, maxZ: 128 };

const COURSE: CourseSpec = {
  start: { x: 0, z: 0 },
  length: 2500,
  meander: 70,
  wavelengths: [640, 340, 200],
  jumps: 14,
  sideLines: [
    { from: 260, to: 860, offset: 66, kind: 'flow' },
    { from: 1150, to: 1760, offset: -76, kind: 'pro' },
    { from: 1880, to: 2380, offset: 62, kind: 'flow' },
  ],
  freerideKickers: 22,
  trailColor: lin('#efc08e'),
  trailEdgeColor: lin('#d39462'),
  marginX: 120,
};

let guide: TrailGuide | null = null;
/** Exact trail polylines + distance fields (see TrailGuide). */
export function desertGuide(): TrailGuide {
  return (guide ??= new TrailGuide(COURSE, REGION, SEED));
}

/** Approximate distance to the nearest trail centreline (large outside the region). */
export const trailDistance = (x: number, z: number) => desertGuide().dist(x, z);

// ---------------------------------------------------------------------------------------------
// Landscape
// ---------------------------------------------------------------------------------------------

export const RIVER_LEVEL = -40;
export const riverZ = (x: number) => -3260 + 150 * Math.sin(x / 820 + 0.4) + 60 * Math.sin(x / 330 + 2.1);
/** Broad, braided reach in the open valley; narrows where it enters the gorges east and west. */
export const riverHalfW = (x: number) => 70 + 110 * (1 - smoothstep(900, 2400, Math.abs(x - 150))) + 12 * Math.sin(x / 600 + 1);
/** Perpendicular-ish distance to the river centreline. */
export function riverDist(x: number, z: number) {
  const dzdx = (150 / 820) * Math.cos(x / 820 + 0.4) + (60 / 330) * Math.cos(x / 330 + 2.1);
  return Math.abs(z - riverZ(x)) / Math.sqrt(1 + dzdx * dzdx);
}
/** South Rim cliff face line (north face of the great wall beyond the river). */
export const southRimZ = (x: number) => riverZ(x) - riverHalfW(x) - 430 - 70 * Math.sin(x / 430 + 0.7);

/**
 * Elevation of the fan's spine (x = 0) along the run: a concave alluvial fan down to the finish, then a steep
 * escarpment (the canyon rim) plunging ~130 m to the river floodplain, so the river opens up far below at the end.
 */
export const RIM_S = 2350;
export function spineY(z: number): number {
  if (z > 0) {
    const b = Math.min(z, 2400);
    return 430 + 0.13 * b - 0.000012 * b * b;
  }
  const s = -z;
  let y: number;
  if (s < RIM_S) y = 95 + 335 * Math.pow(1 - s / RIM_S, 1.06);
  else if (s < RIM_S + 420) y = RIVER_LEVEL + 5 + (95 - RIVER_LEVEL - 5) * Math.pow(1 - (s - RIM_S) / 420, 2);
  else y = RIVER_LEVEL + 5 - (s - RIM_S - 420) * 0.01;
  const roll = 5 * (Math.sin((s / 780) * TAU + 0.5) - Math.sin(0.5)) + 1.4 * (Math.sin((s / 310) * TAU + 2.0) - Math.sin(2.0));
  y += roll * (1 - smoothstep(2000, 2300, s));
  return y;
}

/** The East Valley floor, descending south to the river. */
export const valleyEastY = (z: number) => RIVER_LEVEL + 5 + 0.08 * Math.max(0, z + 2800);

function bajada(x: number, z: number): number {
  // wavy canyon rim beyond the finish
  const zr = z - (45 * Math.sin(x / 260 + 1.3) + 22 * Math.sin(x / 97)) * smoothstep(-2050, -2350, z);
  let y = spineY(zr) - 0.018 * x;
  if (x < -280) {
    const d = Math.min(-280 - x, 1700);
    y += 0.00008 * d * d;
  }
  if (x > 260) {
    const d = x - 260;
    y -= 0.00022 * d * d;
  }
  return y;
}

/** 0..1 envelope of the dune field gathering on the lower fan and the floodplain (low in the central view lane). */
export function duneMask(x: number, z: number): number {
  const m = smoothstep(-1450, -2000, z) * (1 - smoothstep(-3300, -3800, z));
  if (m <= 0) return 0;
  const river = riverDist(x, z) - riverHalfW(x);
  return m * smoothstep(40, 220, river) * (1 - smoothstep(850, 1150, x)) * smoothstep(-0.55, -0.1, n.noise2(x / 520 + 4, z / 520 - 2));
}

/** Transverse dunes (height above the fan). */
export function duneField(x: number, z: number): number {
  const m = duneMask(x, z);
  if (m <= 0) return 0;
  const warp = 50 * n.fbm(x / 280 + 3.1, z / 280 - 1.7, 2);
  const ph = ((x * 0.62 + z * 0.78 + warp) / 120) * TAU;
  const ridge = Math.pow(0.5 + 0.5 * Math.sin(ph + 0.6 * Math.sin(ph)), 2.0);
  const amp = 6 + 10 * (n.noise2(x / 460 - 2, z / 460 + 5) * 0.5 + 0.5);
  const lane = 0.3 + 0.7 * smoothstep(100, 300, Math.abs(x - 20));
  return m * ridge * amp * lane;
}

const CX = (REGION.minX + REGION.maxX) / 2;
const CZ = (REGION.minZ + REGION.maxZ) / 2;

/** Dune height of the last farHeight() sample (lets height() reuse it). */
let lastDune = 0;

/** Large-scale landscape (no fine detail). */
function farHeight(x: number, z: number): number {
  let land = Math.max(bajada(x, z), valleyEastY(z));
  // east plateau beyond the valley
  land += 210 * smoothstep(2500, 3500, x) * (1 - smoothstep(-2800, -3200, z));
  // floodplain floor + river channel
  const rd = riverDist(x, z);
  const hw = riverHalfW(x);
  const plain = RIVER_LEVEL + 4.5;
  if (rd < hw + 440) {
    const fp = plain + 2.0 * n.noise2(x / 300, z / 300);
    let l = Math.max(land, fp);
    l = fp + (l - fp) * smoothstep(hw + 50, hw + 440, rd);
    land = Math.min(l, RIVER_LEVEL - 2.6 + 0.12 * Math.max(0, rd - hw));
  } else if (z < -2900) {
    land = Math.max(land, plain);
  }
  // distant violet ranges
  const r = Math.hypot(x - CX, z - CZ);
  if (r > 5500) {
    const k = smoothstep(5500, 12000, r);
    const mtn = 320 + k * (450 + 2300 * n.ridged(x / 5600 + 7.3, z / 5600 - 2.1, 4));
    land += Math.max(0, mtn - land) * smoothstep(5500, 8000, r);
  }
  lastDune = duneField(x, z);
  return land + lastDune;
}

function height(x: number, z: number): number {
  const base = farHeight(x, z);
  const td = trailDistance(x, z);
  // keep a clean, gently rolling corridor around every trail through the dunes
  const clear = lastDune > 0 ? lastDune * (1 - smoothstep(16, 64, td)) : 0;
  // terrain undulation, calmer inside the trail corridors so every line keeps descending
  const calm = 0.5 + 0.5 * smoothstep(10, 50, td);
  const big = 3.2 * calm * n.fbm(x / 230 + 11, z / 230, 3);
  const mid = 1.0 * calm * n.fbm(x / 52 - 3, z / 52 + 7, 2);
  const small = 0.28 * n.noise2(x / 11, z / 11);
  // shallow sandy washes running down the fan (kept out of the trail corridors so lines never climb)
  const w = n.noise2(x / 120 + 0.4 * Math.sin(z / 300), z / 420);
  const wash = -1.3 * Math.max(0, 1 - Math.abs(w) * 5) * smoothstep(10, 34, td);
  return base - clear + big + mid + small + wash;
}

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

const OCHRE = lin('#e2a05c');
const TERRA = lin('#d4784a');
const RED_SOIL = lin('#bd5634');
const SAND = lin('#f0c88e');
const PALE = lin('#f6dcae');
const SAGE = lin('#a3ab78');
const DUNE = lin('#f8c45c');
const DUNE_LIGHT = lin('#ffe096');
const DUNE_SHADE = lin('#e8984a');
const WORN = lin('#efc092');
const GREEN = lin('#86a63c');
const GREEN_DEEP = lin('#557a2c');
const SANDBAR = lin('#f2e2bc');
const VIOLET = lin('#8c70b4');
const VIOLET_DEEP = lin('#6a5598');
const PEACH = lin('#e9a888');
const STRATA_LIN = ['#b8502f', '#d8703a', '#eaa468', '#a8442e', '#f2c690', '#cf6436', '#9a3e2c', '#e2905a', '#f6dcb2'].map(lin);

/** Layered rock colour for steep ground (bands follow world height, wobbling slightly). */
function strataBand(h: number, x: number, z: number): RGB {
  const k = Math.floor((h + 2000) / 7.5 + 0.7 * Math.sin(x / 60 + z / 80));
  return STRATA_LIN[(Math.imul(k, 2654435761) >>> 0) % STRATA_LIN.length];
}

function mixInto(out: RGB, a: RGB, b: RGB, t: number) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

function baseColor(x: number, z: number, h: number, ny: number, out: RGB) {
  // broad, calm fields of colour (painterly): ochre sand ↔ terracotta, with red-soil and pale sand sheets
  const p = n.fbm(x / 260, z / 260, 2) * 0.5 + 0.5;
  mixInto(out, OCHRE, TERRA, smoothstep(0.38, 0.68, p));
  const red = n.noise2(x / 170 - 9, z / 170 + 4);
  mixInto(out, out, RED_SOIL, smoothstep(0.3, 0.7, red) * 0.55);
  const q = n.noise2(x / 120 + 13, z / 120 - 4);
  mixInto(out, out, SAND, smoothstep(0.2, 0.6, q) * 0.8);
  const g = n.noise2(x / 70 - 7, z / 70 + 2);
  mixInto(out, out, SAGE, smoothstep(0.3, 0.75, g) * 0.42);
  // pale sandy washes snaking down the fan
  const w = n.noise2(x / 120 + 0.4 * Math.sin(z / 300), z / 420);
  mixInto(out, out, PALE, (1 - smoothstep(0.04, 0.17, Math.abs(w))) * 0.5);
  // dunes: a golden sand sheet with crest highlights, shaded lee sides and wind-ripple bands
  const dm = duneMask(x, z);
  if (dm > 0.02) {
    const dn = duneField(x, z);
    mixInto(out, out, DUNE, smoothstep(0.05, 0.6, dm) * 0.85);
    const k = smoothstep(0.3, 4, dn);
    const rip = Math.sin((x * 0.8 - z * 0.6) * 0.9 + 3 * n.noise2(x / 18, z / 18));
    mixInto(out, out, rip > 0.35 ? DUNE_LIGHT : rip < -0.6 ? DUNE_SHADE : DUNE, k * 0.6);
    mixInto(out, out, DUNE_LIGHT, smoothstep(5, 12, dn) * 0.7);
  }
  // river: floodplain greenery + sandbars
  const rd = riverDist(x, z) - riverHalfW(x);
  if (rd < 300) {
    const veg = (1 - smoothstep(30, 260, rd)) * smoothstep(-0.35, 0.3, n.noise2(x / 90, z / 90));
    mixInto(out, out, n.noise2(x / 35, z / 35) > 0 ? GREEN : GREEN_DEEP, veg * 0.9);
    mixInto(out, out, SANDBAR, (1 - smoothstep(-10, 26, rd)) * 0.95);
  }
  // steep ground: bare layered rock
  const steep = smoothstep(0.84, 0.62, ny);
  if (steep > 0) mixInto(out, out, strataBand(h, x, z), steep);
  // high, far land: violet ranges with peach light on the tops
  if (h > 330) {
    const m = smoothstep(330, 700, h) * smoothstep(5000, 8000, Math.hypot(x - CX, z - CZ));
    if (m > 0) mixInto(out, out, ny > 0.82 ? PEACH : n.noise2(x / 900, z / 900) > 0 ? VIOLET : VIOLET_DEEP, m);
  }
}

function groundColor(s: GroundSample, out: RGB) {
  baseColor(s.x, s.z, s.h, s.ny, out);
  // compacted, paler sand alongside the trails
  const worn = 1 - smoothstep(0, 2.4, s.trailDist);
  mixInto(out, out, WORN, worn * 0.5);
}

function farColor(x: number, z: number, h: number, ny: number, out: RGB) {
  baseColor(x, z, h, ny, out);
  mixInto(out, out, PALE, 0.08);
}

function surface(s: GroundSample) {
  if (s.ny < 0.72) return 'rock' as const;
  if (duneMask(s.x, s.z) > 0.45) return 'sand' as const;
  return n.noise2(s.x / 120 + 13, s.z / 120 - 4) > 0.35 ? ('sand' as const) : ('dirt' as const);
}

export const desertTerrainSpec: TerrainSpec = {
  region: REGION,
  cell: 2,
  height,
  farHeight,
  groundColor,
  farColor,
  surface,
};

export const desertMesa: EnvironmentDef = {
  id: 'desert',
  name: 'Sunset Mesa',
  subtitle: 'Red rock canyon country',
  description: 'Carve a golden-hour bajada beneath colossal strata mesas, thread a giant stone arch and race the steam train to the turquoise river.',
  cardColors: ['#e0773a', '#2d5fc8', '#ffc078'],
  seed: SEED,
  ambience: 'desert',
  terrain: desertTerrainSpec,
  course: COURSE,
  sky: {
    zenith: '#1f48b8',
    horizon: '#5cc2d6',
    haze: '#ffc79c',
    sunColor: '#ffbd78',
    sunIntensity: 4.2,
    sunDir: [0.56, 0.36, 0.72],
    hemiSky: '#8088ff',
    hemiGround: '#b8603a',
    hemiIntensity: 1.05,
    cloudCount: 44,
    cloudLight: '#fff0da',
    cloudShade: '#c49aa6',
    cloudBanks: [
      { azimuth: 0.15, spread: 0.5, weight: 3 },
      { azimuth: -0.9, spread: 0.5, weight: 2 },
      { azimuth: 1.1, spread: 0.45, weight: 2 },
      { azimuth: 3.0, spread: 0.8, weight: 1 },
    ],
    cloudHeight: [700, 1700],
    cloudDistance: [5200, 10500],
    cloudScale: [1900, 4200],
  },
  fog: {
    color: '#f0b993',
    sunColor: '#ffd7a0',
    density: 0.00012,
    heightFalloff: 0.0012,
    base: 0,
    max: 0.78,
    mistColor: '#f2b48c',
    mistTop: 60,
    mistBottom: -60,
    mistStrength: 0.2,
    mistNear: 900,
    mistCenter: [0, -3300],
    mistRadius: 4200,
  },
  grass: {
    enabled: true,
    base: '#8f7a44',
    tip: '#dcc47c',
    tipAlt: '#b2bf88',
    height: [0.12, 0.36],
    density: 1,
    coverage: (s) => {
      if (s.ny < 0.8) return 0;
      const k = n.noise2(s.x / 34 - 7, s.z / 34 + 2);
      return smoothstep(0.05, 0.6, k) * 0.8;
    },
    flowers: { colors: ['#ff7b2c', '#ffd83a'], density: 0.03 },
  },
  scatter: [
    {
      kind: 'round',
      perHectare: 26,
      scale: [0.55, 1.5],
      colorA: '#789a72',
      colorB: '#a9bb8c',
      trailClearance: 1.8,
      collide: 'soft',
      far: true,
      density: (s, nn) => (s.ny > 0.82 ? 1 : 0.2) * smoothstep(-0.3, 0.45, nn.noise2(s.x / 90, s.z / 90) + 0.2) * (duneField(s.x, s.z) > 1 ? 0.1 : 1),
    },
    {
      kind: 'round',
      perHectare: 2.2,
      scale: [1.3, 2.8],
      colorA: '#355f34',
      colorB: '#58873f',
      trailClearance: 3,
      collide: 'solid',
      far: true,
      density: (s, nn) => (s.ny > 0.82 ? 1 : 0.3) * smoothstep(0.0, 0.5, nn.noise2(s.x / 200 - 3, s.z / 200 + 8)) * (duneField(s.x, s.z) > 0.6 ? 0 : 1),
    },
    {
      kind: 'cactus',
      perHectare: 3,
      scale: [1.0, 2.0],
      colorA: '#3f7a3a',
      colorB: '#6f9e48',
      trailClearance: 3,
      collide: 'solid',
      far: true,
      density: (s, nn) => (s.ny > 0.85 ? 1 : 0) * (0.35 + 0.65 * smoothstep(-0.2, 0.4, nn.noise2(s.x / 160 + 4, s.z / 160))) * (duneField(s.x, s.z) > 0.6 ? 0 : 1) * (s.h > RIVER_LEVEL + 3 ? 1 : 0),
    },
    {
      kind: 'deadTree',
      perHectare: 0.8,
      scale: [1.2, 2.3],
      colorA: '#7d6150',
      colorB: '#c2a88c',
      trailClearance: 6,
      collide: 'solid',
      density: (s) => (s.ny > 0.85 ? 0.8 : 0),
    },
    {
      kind: 'sandstone',
      perHectare: 3.2,
      scale: [0.6, 2.6],
      colorA: '#bd5a34',
      colorB: '#e59a5c',
      trailClearance: 1.6,
      collide: 'solid',
      density: (s, nn) => (0.3 + 0.7 * smoothstep(0.0, 0.5, nn.noise2(s.x / 110, s.z / 110))) * (duneField(s.x, s.z) > 1 ? 0.15 : 1),
    },
  ],
  post: {
    saturation: 1.28,
    vibrance: 0.3,
    contrast: 0.32,
    exposure: 1.0,
    shadowTint: [0.02, 0.0, 0.11],
    highlightTint: [0.05, 0.02, -0.03],
  },
  introShot: { from: [-30, 9, 34], to: [60, 30, -320] },
  buildSetPieces: buildDesertSetPieces,
};
