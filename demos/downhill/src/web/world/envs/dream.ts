import * as THREE from 'three';
import { Noise } from '../../core/noise';
import { clamp, smoothstep } from '../../core/math';
import type { EnvironmentDef, GroundSample, RGB } from '../types';
import { buildDreamSetPieces } from '../props/dream';

/*
 * Dreamscape — a pastel sky-island adrift on a sea of clouds.
 *  - The run follows the rolling pink spine of a vast floating massif, heading -Z, with the island's edge
 *    falling away into the cloud sea a few hundred metres either side.
 *  - Mesas and candy mountains rise out of the clouds all around; floating islands with waterfalls drift
 *    overhead, crystal spires glow on the slopes, rainbows arch out of the clouds and a colossal ringed
 *    planet with a second moon hangs over the end of the run.
 */

const SEED = 7702;
const n = new Noise(SEED);
const lin = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** Height of the cloud-sea surface (m). */
export const CLOUD = 150;
/** Terrain floor hidden below the cloud sea. */
const FLOOR = CLOUD - 320;
const TOP = 760;
const GRADE = 0.152;

/** Island spine x (centre of the rideable ridge). */
export const spineX = (z: number) => -60 + 30 * (Math.sin(z / 900 + 0.5) - Math.sin(0.5));
/** Ridge elevation along the descent (never climbs toward -Z). */
export function spineY(z: number) {
  const s = -z;
  if (s < 0) return TOP + Math.min(-s * 0.2 + 0.00012 * s * s, 520);
  return (
    TOP -
    GRADE * s +
    8 * (Math.sin((s / 780) * Math.PI * 2 + 1) - Math.sin(1)) +
    2 * (Math.sin((s / 290) * Math.PI * 2 + 2) - Math.sin(2))
  );
}
/** Half width of the island top (edge of the world) at z. */
const halfWidth = (z: number, side: number) => (side > 0 ? 505 : 525) + 45 * Math.sin(z / 520 + side) + 30 * n.noise2(z / 300, side * 7);

interface Mesa {
  x: number;
  z: number;
  r: number;
  h: number;
  /** 0 = flat-topped mesa, 1 = rounded candy cone. */
  cone: number;
}
/** Islands and candy mountains rising out of the cloud sea (heights above the cloud sea). */
export const MESAS: Mesa[] = [
  { x: 1500, z: -900, r: 520, h: 330, cone: 0 },
  { x: 1900, z: -2600, r: 650, h: 420, cone: 0 },
  { x: -1700, z: -2000, r: 600, h: 300, cone: 0 },
  { x: -1500, z: 300, r: 450, h: 380, cone: 0.6 },
  { x: 600, z: -4300, r: 700, h: 520, cone: 0.15 },
  { x: -1300, z: -4800, r: 800, h: 640, cone: 0.7 },
  { x: 3300, z: -4200, r: 1100, h: 950, cone: 0.85 },
  { x: -3600, z: -3000, r: 1200, h: 1050, cone: 0.9 },
  { x: 3600, z: 600, r: 1000, h: 800, cone: 0.8 },
  { x: -3200, z: 1900, r: 900, h: 700, cone: 0.75 },
  { x: 900, z: 2600, r: 800, h: 900, cone: 0.8 },
  { x: -500, z: -7600, r: 1600, h: 1500, cone: 0.95 },
  { x: 4800, z: -7600, r: 1500, h: 1300, cone: 0.9 },
  { x: -5600, z: -7000, r: 1500, h: 1250, cone: 0.9 },
  { x: 2300, z: -6000, r: 600, h: 380, cone: 0 },
];

function mesaAt(x: number, z: number) {
  let y = -1e9;
  for (const m of MESAS) {
    const dx = x - m.x,
      dz = z - m.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > m.r * m.r * 1.6) continue;
    const ang = Math.atan2(dz, dx);
    const rr = m.r * (1 + 0.14 * n.noise2(Math.cos(ang) * 1.3 + m.x * 0.001, Math.sin(ang) * 1.3 + m.z * 0.001));
    const t = Math.sqrt(d2) / rr;
    if (t >= 1.25) continue;
    // plateau with rounded shoulders, or a soft cone
    const plateau = 1 - smoothstep(0.62, 1.05, t);
    const coneP = Math.pow(Math.max(0, 1 - t / 1.2), 1.35);
    const prof = plateau + (coneP - plateau) * m.cone;
    const top = CLOUD + m.h * prof * (0.92 + 0.12 * n.noise2(x / 260, z / 260));
    const yy = FLOOR + (top - FLOOR) * Math.min(1, prof * 3);
    if (yy > y) y = yy;
  }
  return y;
}

/** Large-scale landscape (no fine detail). */
function farHeight(x: number, z: number): number {
  const s = -z;
  const dx = x - spineX(z);
  // the island top: gently crowned, falling away at the edge
  const ridge = spineY(z);
  let y = ridge - 0.018 * Math.abs(dx);
  // rolling pink hills flanking the run
  const hills = smoothstep(130, 330, Math.abs(dx));
  if (hills > 0) y += hills * 26 * smoothstep(-0.3, 0.7, n.fbm(x / 420 + 4, z / 420, 2));
  // the edge of the world: rounded lip, sheer pastel cliffs, down into the clouds
  const side = dx > 0 ? 1 : -1;
  const w = halfWidth(z, side);
  const over = Math.abs(dx) - w;
  if (over > -30) {
    const t = smoothstep(-30, 520, over);
    y += (FLOOR - y) * Math.pow(t, 0.85);
  }
  // south tip of the island and the summit behind the start
  if (s > 2950) y += (FLOOR - y) * smoothstep(2950, 3500, s);
  if (s < -1250) y += (FLOOR - y) * smoothstep(-1250, -1900, s);
  // mesas and candy mountains out in the clouds
  const m = mesaAt(x, z);
  if (m > y) y = m;
  // the far horizon: soft mountains of cloud-tinted rock
  const r = Math.hypot(x + 60, z + 1300);
  if (r > 8000) {
    const k = smoothstep(8000, 12500, r);
    const b = 1 - Math.abs(n.noise2(x / 3400 + 9, z / 3400 - 4));
    const hz = FLOOR + k * (900 + 1700 * b * b * (0.6 + 0.4 * n.noise2(x / 1500, z / 1500)));
    if (hz > y) y = hz;
  }
  return y;
}

function height(x: number, z: number): number {
  const base = farHeight(x, z);
  const big = 5 * n.fbm(x / 240 + 11, z / 240, 4);
  const mid = 1.6 * n.fbm(x / 55 - 3, z / 55 + 7, 3);
  const small = 0.3 * n.noise2(x / 11, z / 11);
  return base + big + mid + small;
}

// ---------- colour ----------

const PINK = lin('#f86fb2');
const PINK_L = lin('#ff9fcc');
const LAVENDER = lin('#a47cf0');
const PEACH = lin('#ffa47c');
const MINT = lin('#6fe0bc');
const ROSE_DEEP = lin('#b8438e');
const WORN = lin('#f6c8a8');
const STRATA = [lin('#fff0dc'), lin('#ffc2a4'), lin('#d8b8f4'), lin('#f4a6c4'), lin('#fde0f0'), lin('#c4a8ec')];
const CLOUD_TINT = lin('#f6d6f2');

function mixInto(out: RGB, a: RGB, b: RGB, t: number) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

const tmp: RGB = [0, 0, 0];

/** 0..1 mask of the lavender / mint clover patches (short grass, so the ground colour shows). */
function cloverMask(x: number, z: number) {
  const q = n.fbm(x / 260 + 9, z / 260 - 3, 2);
  const m = n.noise2(x / 420 - 7, z / 420 + 2);
  return Math.max(smoothstep(0.22, 0.42, q), smoothstep(0.5, 0.7, m));
}

/** Pastel quilt of meadow colours. */
function meadow(x: number, z: number, out: RGB) {
  const p = n.fbm(x / 120, z / 120, 3) * 0.5 + 0.5;
  mixInto(out, PINK, PINK_L, smoothstep(0.35, 0.75, p));
  const q = n.fbm(x / 260 + 9, z / 260 - 3, 2);
  mixInto(out, out, LAVENDER, smoothstep(0.1, 0.4, q) * 0.85);
  mixInto(out, out, PEACH, smoothstep(0.15, 0.55, -q) * 0.6);
  const m = n.noise2(x / 420 - 7, z / 420 + 2);
  mixInto(out, out, MINT, smoothstep(0.45, 0.75, m) * 0.75);
}

/** Banded pastel strata on cliffs, cloud tint low down. */
function cliffTint(x: number, z: number, h: number, ny: number, out: RGB) {
  const steep = smoothstep(0.78, 0.55, ny);
  if (steep > 0) {
    const band = h / 16 + 1.8 * n.noise2(x / 140, z / 140);
    const i = Math.floor(band);
    const f = band - i;
    const a = STRATA[((i % STRATA.length) + STRATA.length) % STRATA.length];
    const b = STRATA[(((i + 1) % STRATA.length) + STRATA.length) % STRATA.length];
    mixInto(tmp, a, b, smoothstep(0.75, 1, f));
    mixInto(out, out, tmp, steep);
  }
  // shade of deep rose in hollows of the steep faces
  if (ny < 0.4) mixInto(out, out, ROSE_DEEP, 0.15 * smoothstep(0.4, 0.15, ny));
  // the cloud sea soaks into the land near its surface
  const c = 1 - smoothstep(CLOUD - 10, CLOUD + 70, h);
  if (c > 0) mixInto(out, out, CLOUD_TINT, c);
}

function groundColor(s: GroundSample, out: RGB) {
  meadow(s.x, s.z, out);
  const hollow = n.fbm(s.x / 40 + 4, s.z / 40, 2);
  mixInto(out, out, ROSE_DEEP, clamp(-hollow * 0.5, 0, 0.22));
  mixInto(out, out, WORN, (1 - smoothstep(0, 2.4, s.trailDist)) * 0.55);
  cliffTint(s.x, s.z, s.h, s.ny, out);
}

function farColor(x: number, z: number, h: number, ny: number, out: RGB) {
  meadow(x, z, out);
  cliffTint(x, z, h, ny, out);
}

export const dreamscape: EnvironmentDef = {
  id: 'dream',
  name: 'Dreamscape',
  subtitle: 'A surreal pastel sky-world',
  description: 'Float down a candy-pink sky island above a sea of clouds, past crystal spires, drifting islands and a ringed planet.',
  cardColors: ['#f08cc0', '#8ee8d8', '#b994f2'],
  seed: SEED,
  ambience: 'fantasy',
  terrain: {
    region: { minX: -512, maxX: 320, minZ: -2752, maxZ: 128 },
    cell: 2,
    height,
    farHeight,
    groundColor,
    farColor,
    surface: (s) => (s.ny < 0.7 ? 'rock' : 'grass'),
  },
  course: {
    start: { x: -60, z: 0 },
    length: 2500,
    meander: 55,
    wavelengths: [600, 320, 170],
    jumps: 14,
    sideLines: [
      { from: 280, to: 860, offset: -70, kind: 'flow' },
      { from: 1050, to: 1720, offset: 75, kind: 'pro' },
      { from: 1860, to: 2360, offset: -70, kind: 'flow' },
    ],
    freerideKickers: 22,
    trailColor: lin('#f7cf8c'),
    trailEdgeColor: lin('#f0a0b8'),
    marginX: 120,
    xRange: [-190, 70],
  },
  sky: {
    zenith: '#5660de',
    horizon: '#f8b8d4',
    haze: '#ffdcd6',
    sunColor: '#ffd49a',
    sunIntensity: 3.2,
    sunDir: [-0.66, 0.5, 0.42],
    hemiSky: '#b4a2ff',
    hemiGround: '#f2a2c8',
    hemiIntensity: 1.45,
    cloudCount: 56,
    cloudLight: '#fff6fb',
    cloudShade: '#b8a0e8',
    cloudBanks: [
      { azimuth: 0.0, spread: 0.6, weight: 3 },
      { azimuth: 1.2, spread: 0.5, weight: 2 },
      { azimuth: -1.3, spread: 0.5, weight: 2 },
      { azimuth: -1.9, spread: 0.4, weight: 1.5 },
      { azimuth: 1.9, spread: 0.4, weight: 1.5 },
      { azimuth: 2.6, spread: 0.6, weight: 1 },
    ],
    cloudHeight: [350, 1400],
    cloudDistance: [4500, 10500],
    cloudScale: [1800, 3800],
  },
  fog: {
    color: '#e2b8f0',
    sunColor: '#ffe2bc',
    density: 0.00007,
    heightFalloff: 0.0012,
    base: CLOUD,
    max: 0.72,
    mistColor: '#f4cdee',
    mistTop: CLOUD + 110,
    mistBottom: CLOUD - 30,
    mistStrength: 0.5,
    mistNear: 300,
  },
  grass: {
    enabled: true,
    base: '#d4529c',
    tip: '#ff96c6',
    tipAlt: '#ffb49c',
    height: [0.14, 0.4],
    density: 1,
    coverage: (s) => (s.ny < 0.74 ? 0 : s.h < CLOUD + 40 ? 0 : 1 - 0.75 * cloverMask(s.x, s.z)),
    flowers: { colors: ['#ffffff', '#fff27a'], density: 0.06 },
  },
  scatter: [
    {
      kind: 'broadleaf',
      perHectare: 2.4,
      scale: [2.4, 4.4],
      colorA: '#3cc8c0',
      colorB: '#9cf0cc',
      trailClearance: 6,
      collide: 'solid',
      far: true,
      density: (s, nn) => (s.h < CLOUD + 40 || s.ny < 0.8 ? 0 : 0.08 + 0.92 * smoothstep(0.15, 0.5, nn.fbm(s.x / 180 + 2, s.z / 180, 2))),
    },
    {
      kind: 'round',
      perHectare: 4,
      scale: [1.1, 2.6],
      colorA: '#5edcd0',
      colorB: '#b49cff',
      trailClearance: 2.5,
      collide: 'soft',
      far: true,
      density: (s, nn) => (s.h < CLOUD + 40 || s.ny < 0.78 ? 0 : 0.15 + 0.85 * smoothstep(0.0, 0.45, nn.fbm(s.x / 130 - 5, s.z / 130, 2))),
    },
    {
      kind: 'mushroom',
      perHectare: 1.4,
      scale: [1.4, 4.2],
      colorA: '#ff5f9e',
      colorB: '#9a6cff',
      trailClearance: 5,
      collide: 'solid',
      density: (s, nn) => (s.ny < 0.85 ? 0 : 0.15 + 0.85 * smoothstep(0.15, 0.5, nn.fbm(s.x / 150 + 20, s.z / 150, 2))),
    },
    {
      kind: 'crystal',
      perHectare: 1.3,
      scale: [1.1, 3.2],
      colorA: '#7ff4ff',
      colorB: '#e49cff',
      trailClearance: 4,
      collide: 'solid',
      density: (s, nn) => (s.ny < 0.75 ? 0 : 0.05 + 0.95 * smoothstep(0.3, 0.6, nn.noise2(s.x / 110 - 9, s.z / 110 + 3))),
    },
    {
      kind: 'crystalRock',
      perHectare: 1.4,
      scale: [0.7, 1.9],
      colorA: '#e2d0f4',
      colorB: '#f6cadc',
      trailClearance: 2,
      collide: 'solid',
      density: (s, nn) => 0.3 + 0.7 * smoothstep(0.2, 0.6, nn.noise2(s.x / 90 + 4, s.z / 90)),
    },
  ],
  post: {
    saturation: 1.3,
    vibrance: 0.3,
    contrast: 0.27,
    exposure: 1.0,
    lift: 0.02,
    bloom: 0.65,
    shadowTint: [0.04, 0.0, 0.1],
    highlightTint: [0.05, 0.03, -0.025],
  },
  introShot: { from: [-30, 20, 30], to: [40, 45, -360] },
  buildSetPieces: buildDreamSetPieces,
};
