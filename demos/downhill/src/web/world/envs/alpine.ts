import * as THREE from 'three';
import { Noise } from '../../core/noise';
import { clamp, smoothstep } from '../../core/math';
import type { EnvironmentDef, GroundSample, RGB } from '../types';
import { buildAlpineSetPieces } from '../props/alpine';

/*
 * Alpine Peaks — a Lauterbrunnen-style glacial valley.
 *  - The run descends a broad emerald alp (meadow shoulder) on the west flank of the main valley, heading -Z
 *    toward a milky-turquoise glacier lake.
 *  - East: the deep valley floor, then a sheer granite cliff wall with waterfalls, topped by a pasture terrace
 *    and a glaciated massif with a hanging glacier.
 *  - West: dark pine forest climbing to jagged granite spires.
 *  - South (straight ahead): the lake, ringed by peaks, with the Horn — a huge pyramidal peak — behind it.
 *  - A gondola climbs alongside the run from the lakeside village to the top station behind the start.
 */

const SEED = 4410;
const n = new Noise(SEED);
const lin = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** Lake surface level (m). */
export const LAKE = 800;
const TOP = 1300;
const GRADE = 0.165;

/** Alp spine x (centre of the meadow shoulder). */
export const spineX = (z: number) => -40 + 0.012 * z;
/** Alp spine elevation along the descent (never climbs toward -Z). */
export function spineY(z: number) {
  const s = -z;
  if (s < 0) return TOP + Math.min(-GRADE * s + 0.00005 * s * s, 650);
  return (
    TOP -
    GRADE * s +
    7 * (Math.sin((s / 850) * Math.PI * 2 + 0.6) - Math.sin(0.6)) +
    1.8 * (Math.sin((s / 330) * Math.PI * 2 + 2) - Math.sin(2))
  );
}
/** Floor of the deep valley east of the alp (falls toward the lake). */
export const eastFloor = (z: number) => LAKE + 4 + 0.072 * Math.max(0, z + 3220);
/** Foot line of the sheer east cliff wall. */
export const wallX = (z: number) => 1180 + 70 * Math.sin(z / 820 + 1.1) + 30 * Math.sin(z / 290 + 0.3);
/** Top of the east cliff (pasture terrace). */
export const terraceY = (z: number) => eastFloor(z) + 440 + 35 * Math.sin(z / 600);

/** Lake basin (ellipse in xz, < 1 inside). */
export const LAKE_C = { x: -250, z: -4250, ax: 2300, az: 1200 };
export function lakeE(x: number, z: number) {
  // gently bent basin: the far half swings west under the Horn
  const v = (z - LAKE_C.z) / LAKE_C.az;
  const u = (x - LAKE_C.x + 380 * Math.min(0, v) * Math.min(0, v)) / LAKE_C.ax;
  return Math.sqrt(u * u + v * v) + 0.06 * n.fbm(x / 640 + 7, z / 640, 2) + 0.03 * n.noise2(x / 190, z / 190 - 3);
}

interface Peak {
  x: number;
  z: number;
  h: number;
  r: number;
  c: number;
  s: number;
  sharp: number;
  pow: number;
}
const peak = (x: number, z: number, h: number, r: number, rot: number, sharp: number, pow: number): Peak => ({ x, z, h, r, c: Math.cos(rot), s: Math.sin(rot), sharp, pow });
/** Hero peaks. The first is the Horn, seen straight down the run beyond the lake. */
export const PEAKS: Peak[] = [
  peak(-650, -7900, 4300, 4700, 0.35, 0.85, 1.4),
  peak(3700, -1900, 2600, 2800, 0.9, 0.35, 1.4),
  peak(4500, 700, 2400, 2500, 0.2, 0.4, 1.4),
  peak(-3100, -1300, 2100, 2000, 0.5, 0.65, 1.45),
  peak(-3700, -3800, 2400, 2400, 1.1, 0.55, 1.45),
  peak(2700, -6600, 2500, 2600, 0.6, 0.5, 1.4),
  peak(-3300, -6900, 2300, 2600, 0.15, 0.5, 1.4),
  peak(-600, 4300, 2200, 2600, 0.0, 0.4, 1.4),
];
const HORN = PEAKS[0];

interface Glacier {
  pts: Array<[number, number]>;
  w: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  len: number;
}
function glacier(w: number, pts: Array<[number, number]>): Glacier {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity,
    len = 0;
  pts.forEach(([x, z], i) => {
    minX = Math.min(minX, x - w);
    maxX = Math.max(maxX, x + w);
    minZ = Math.min(minZ, z - w);
    maxZ = Math.max(maxZ, z + w);
    if (i > 0) len += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
  });
  return { pts, w, minX, maxX, minZ, maxZ, len };
}
/** Glacier tongues (smooth ice rivers): hanging glacier over the falls, the Horn glacier calving into the lake... */
export const GLACIERS: Glacier[] = [
  glacier(380, [
    [3500, -1850],
    [2800, -1600],
    [2100, -1450],
    [1420, -1400],
  ]),
  glacier(430, [
    [900, -7500],
    [620, -6900],
    [380, -6300],
  ]),
  glacier(330, [
    [-3700, -2700],
    [-3000, -2450],
    [-2300, -2300],
  ]),
  glacier(330, [
    [4300, 600],
    [3400, 450],
    [2400, 250],
  ]),
  glacier(340, [
    [2600, -6300],
    [2000, -5700],
    [1500, -5300],
  ]),
];

const gl = { k: 0, t: 0, d: 0 };
/** Glacier mask k (1 on the ice), position t along the flow (0 top..1 snout) and distance from the centre line. */
function glacierAt(x: number, z: number) {
  gl.k = 0;
  for (const g of GLACIERS) {
    if (x < g.minX || x > g.maxX || z < g.minZ || z > g.maxZ) continue;
    let best = 1e9,
      bestT = 0,
      acc = 0;
    for (let i = 0; i < g.pts.length - 1; i++) {
      const [ax, az] = g.pts[i];
      const [bx, bz] = g.pts[i + 1];
      const sx = bx - ax,
        sz = bz - az;
      const l2 = sx * sx + sz * sz;
      let u = ((x - ax) * sx + (z - az) * sz) / l2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const d = Math.hypot(x - ax - sx * u, z - az - sz * u);
      const sl = Math.sqrt(l2);
      if (d < best) {
        best = d;
        bestT = (acc + u * sl) / g.len;
      }
      acc += sl;
    }
    // tongue narrows toward the snout
    const w = g.w * (1 - 0.35 * bestT);
    const k = 1 - smoothstep(w * 0.55, w, best + 40 * n.noise2(x / 160, z / 160));
    if (k > gl.k) {
      gl.k = k;
      gl.t = bestT;
      gl.d = best / w;
    }
  }
  return gl;
}

function peaksAt(x: number, z: number) {
  let y = 0;
  for (const p of PEAKS) {
    const dx = x - p.x,
      dz = z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= p.r * p.r) continue;
    const u = dx * p.c + dz * p.s;
    const v = -dx * p.s + dz * p.c;
    const l2 = Math.sqrt(d2);
    const nrm = l2 + (Math.abs(u) + Math.abs(v) - l2) * p.sharp;
    const t = 1 - nrm / p.r;
    if (t <= 0) continue;
    y += p.h * Math.pow(t, p.pow) * (0.86 + 0.28 * n.noise2(x / 800 + p.x * 0.01, z / 800));
  }
  return y;
}

/** Large-scale landscape (no fine detail). */
function farHeight(x: number, z: number): number {
  const dx = x - spineX(z);
  const cdx = dx < -300 ? -300 : dx > 300 ? 300 : dx;
  let y = Math.max(spineY(z), LAKE + 12) - 0.045 * cdx;
  if (dx > 300) {
    const ev = eastFloor(z) + 5 * n.noise2(x / 300, z / 300);
    y += (Math.min(y, ev) - y) * smoothstep(300, 580, dx);
  } else if (dx < -280) {
    // forested valley side, levelling off into the high cirques under the west spires
    y += 430 * smoothstep(0, 2000, -dx - 280);
  }
  // spurs and gullies on the valley sides
  const side = smoothstep(280, 620, Math.abs(dx));
  if (side > 0) y += side * 45 * n.fbm(x / 430, z / 430, 2);
  // east cliff wall: pasture terrace on top (only where the painted cliff stands)
  const w = x - wallX(z);
  const wallSpan = smoothstep(-5500, -5150, z) * (1 - smoothstep(1450, 1750, z));
  if (w > -40 && wallSpan > 0) {
    const ty = terraceY(z) + 0.09 * Math.min(Math.max(0, w), 3500) + 25 * n.noise2(x / 380, z / 380);
    y += (Math.max(y, ty) - y) * smoothstep(-15, 40, w) * wallSpan;
  }
  // mountain ranges (jagged ridged noise) and hero peaks, whichever is higher
  const e = lakeE(x, z);
  let m = smoothstep(950, 2900, -dx);
  if (w > 150) m = Math.max(m, smoothstep(150, 1700, w));
  if (z > 900) m = Math.max(m, smoothstep(900, 3200, z));
  if (z < LAKE_C.z + 500) m = Math.max(m, smoothstep(1.03, 1.5, e));
  m *= smoothstep(1.0, 1.5, e);
  const g = glacierAt(x, z);
  const gk = g.k;
  const r = n.ridged(x / 2800 + 3.7, z / 2800 - 1.3, 5);
  let mtn = 0;
  if (m > 0.001) {
    // keep the Horn's silhouette clean
    const hd = Math.hypot(x - HORN.x, z - HORN.z);
    const calm = hd < HORN.r * 1.2 ? 1 - 0.85 * smoothstep(HORN.r * 1.2, HORN.r * 0.45, hd) : 1;
    // broad snowy massifs carrying jagged ridges
    const massif = 950 * smoothstep(-0.35, 0.55, n.fbm(x / 5200 - 2, z / 5200 + 1, 2));
    const amp = 1950 * m * calm;
    mtn = m * calm * massif + amp * Math.pow(r, 1.35);
    // glaciers fill their valleys with a smooth, lower ice surface
    if (gk > 0) mtn += (m * calm * massif + amp * 0.72 * Math.pow(n.ridged(x / 2800 + 3.7, z / 2800 - 1.3, 2), 1.35) - mtn) * gk;
  }
  const pk = peaksAt(x, z) * (0.84 + 0.26 * (r + (0.6 - r) * gk)) * smoothstep(1.0, 1.45, e);
  y += Math.max(mtn, pk) + Math.min(mtn, pk) * 0.15;
  // lake basin (west of the cliff wall)
  if (e < 1.12 && w < -10) {
    const bed = LAKE - 4 - 80 * smoothstep(0.98, 0.5, e);
    const t = smoothstep(1.1, 0.985, e) * (1 - smoothstep(-80, -10, w));
    y += (Math.min(y, bed) - y) * t;
  }
  return y;
}

function height(x: number, z: number): number {
  const base = farHeight(x, z);
  const big = 7 * n.fbm(x / 280 + 11, z / 280, 4);
  const mid = 2.2 * n.fbm(x / 60 - 3, z / 60 + 7, 3);
  const small = 0.35 * n.noise2(x / 11, z / 11);
  return base + big + mid + small;
}

// ---------- colour ----------

const MEADOW_A = lin('#3a9a46');
const MEADOW_B = lin('#7cc24a');
const MEADOW_BLUE = lin('#23885e');
const MEADOW_DARK = lin('#22683a');
const WORN = lin('#93a463');
const ROCK = lin('#b3a38a');
const ROCK_COOL = lin('#7e84a8');
const SCREE = lin('#b3ada2');
const SNOW = lin('#f6f8fc');
const SNOW_SHADE = lin('#d4def0');
const ICE = lin('#eef8fc');
const ICE_BLUE = lin('#b4d8ee');
const MORAINE = lin('#6e6a66');
const FOREST = lin('#173f2a');
const FOREST_B = lin('#24563a');
const GRAVEL = lin('#d8d2c2');
const FLOWER_P = lin('#d45ab8');
const FLOWER_Y = lin('#f4d636');
const FLOWER_W = lin('#f6f4ee');

function mixInto(out: RGB, a: RGB, b: RGB, t: number) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

/** Elevation of the tree line (with noise). */
const treeLine = (x: number, z: number) => 1950 + 160 * n.noise2(x / 900, z / 900);

/** 0..1 forest cover shared by the ground tint and the pine scatter so forests read as dark masses from afar. */
export function forestMask(x: number, z: number, h: number, ny: number): number {
  if (h < LAKE + 3 || ny < 0.55) return 0;
  const dx = x - spineX(z);
  const tl = treeLine(x, z);
  if (h > tl) return 0;
  const alt = 1 - smoothstep(tl - 220, tl, h);
  const nn = n.fbm(x / 210, z / 210, 3);
  // slopes beside the alp are thickly wooded; the alp itself has scattered groves
  const belt = Math.max(smoothstep(-250, -420, dx), smoothstep(310, 400, dx) * (1 - smoothstep(560, 640, dx)) * 1.0);
  const valley = dx > 600 ? smoothstep(-0.15, 0.25, nn) * 0.8 : 0;
  const groves = smoothstep(0.2, 0.4, nn) * 0.92;
  const f = Math.max(belt * smoothstep(-0.55, -0.2, nn), groves, valley);
  return clamp(f * alt * smoothstep(0.55, 0.7, ny), 0, 1);
}

const tmpC: RGB = [0, 0, 0];

/** Mountain/far tint: rock, snow, glaciers, forest, lake shore. */
function mountainTint(x: number, z: number, h: number, ny: number, out: RGB, region: boolean) {
  // forest
  const f = forestMask(x, z, h, ny);
  if (f > 0) mixInto(out, out, n.noise2(x / 60, z / 60) > 0 ? FOREST : FOREST_B, f * (region ? 0.85 : 0.95));
  // lake shore gravel
  if (h < LAKE + 4) mixInto(out, out, GRAVEL, 1 - smoothstep(LAKE + 1, LAKE + 4, h));
  // rock on steep ground and above the alpine meadows
  const tl = treeLine(x, z);
  const steep = smoothstep(0.8, 0.6, ny);
  const high = smoothstep(tl + 250, tl + 550, h);
  const rock = clamp(Math.max(steep, high * 0.85), 0, 1);
  if (rock > 0) {
    mixInto(tmpC, ROCK, ROCK_COOL, clamp(0.5 + 0.6 * n.noise2(x / 240, z / 240) + smoothstep(0.55, 0.3, ny) * 0.4, 0, 1));
    if (ny > 0.62 && h > tl) mixInto(tmpC, tmpC, SCREE, 0.4);
    mixInto(out, out, tmpC, rock);
  }
  // snow: solid on gentle ground above the snow line, streaked and banded on steep faces
  const sl = 2300 + 240 * n.noise2(x / 1300 + 5, z / 1300);
  const alt = smoothstep(sl - 180, sl + 180, h);
  if (alt > 0) {
    const stick = 0.38 + 0.62 * smoothstep(0.3, 0.62, ny) + smoothstep(3300, 3900, h) * 0.3;
    const streak = (n.noise2(x / 60, z / 200) * 0.6 + n.noise2(x / 300 + 3, h / 90) * 0.4) * smoothstep(0.3, 0.6, ny);
    const snow = smoothstep(0.3, 0.55, alt * stick + 0.22 * streak);
    mixInto(tmpC, SNOW, SNOW_SHADE, smoothstep(0.7, 0.35, ny) * 0.55);
    mixInto(out, out, tmpC, snow);
  }
  // glaciers: pale ice with crevasse bands and a dark medial moraine
  if (!region) {
    const g = glacierAt(x, z);
    if (g.k > 0) {
      const crev = 0.5 + 0.5 * Math.sin(g.t * 42 + n.noise2(x / 90, z / 90) * 2.5);
      mixInto(tmpC, ICE, ICE_BLUE, crev * 0.35 * smoothstep(0.3, 0.8, g.t) + smoothstep(0.6, 1, g.d) * 0.25);
      if (g.d < 0.09) mixInto(tmpC, tmpC, MORAINE, 0.55 * smoothstep(0.3, 0.7, g.t));
      mixInto(out, out, tmpC, g.k);
    }
  }
}

function groundColor(s: GroundSample, out: RGB) {
  const p = n.fbm(s.x / 95, s.z / 95, 3) * 0.5 + 0.5;
  mixInto(out, MEADOW_A, MEADOW_B, smoothstep(0.38, 0.78, p));
  // cool blue-green swales
  const q = n.fbm(s.x / 160 + 9, s.z / 160, 2);
  mixInto(out, out, MEADOW_BLUE, clamp(q * 0.9, 0, 0.45));
  const hollow = n.fbm(s.x / 38 + 4, s.z / 38, 2);
  mixInto(out, out, MEADOW_DARK, clamp(-hollow * 0.7, 0, 0.35));
  // wildflower drifts: magenta-purple, yellow and white patches
  const fl = n.noise2(s.x / 42 - 13, s.z / 42 + 5);
  if (fl > 0.4) {
    const kind = n.noise2(s.x / 160 + 40, s.z / 160);
    const col = kind > 0.2 ? FLOWER_P : kind < -0.3 ? FLOWER_W : FLOWER_Y;
    mixInto(out, out, col, smoothstep(0.4, 0.8, fl) * (col === FLOWER_W ? 0.24 : 0.36));
  }
  // worn grass near trails
  mixInto(out, out, WORN, (1 - smoothstep(0, 2.4, s.trailDist)) * 0.55);
  // rocky patches matching the granite scatter
  const rocky = smoothstep(0.55, 0.78, n.fbm(s.x / 70 + 30, s.z / 70, 2)) * 0.2;
  if (rocky > 0) mixInto(out, out, ROCK, rocky * smoothstep(3, 6, s.trailDist));
  mountainTint(s.x, s.z, s.h, s.ny, out, true);
}

function farColor(x: number, z: number, h: number, ny: number, out: RGB) {
  mixInto(out, MEADOW_A, MEADOW_B, 0.35 + 0.35 * (n.noise2(x / 300, z / 300) * 0.5 + 0.5));
  mixInto(out, out, MEADOW_BLUE, clamp(n.noise2(x / 500 + 9, z / 500) * 0.6, 0, 0.4));
  mountainTint(x, z, h, ny, out, false);
}

export const alpinePeaks: EnvironmentDef = {
  id: 'alpine',
  name: 'Alpine Peaks',
  subtitle: 'Snowcaps & glacier lakes',
  description: 'Rip a wildflower alp beneath glaciers and waterfall cliffs, racing the gondola down to a turquoise lake.',
  cardColors: ['#3a9a46', '#2fb8c8', '#f4f7fb'],
  seed: SEED,
  ambience: 'alpine',
  terrain: {
    region: { minX: -512, maxX: 320, minZ: -2752, maxZ: 128 },
    cell: 2,
    height,
    farHeight,
    groundColor,
    farColor,
    surface: (s) => (s.ny < 0.72 ? 'rock' : s.h > 2600 ? 'snow' : 'grass'),
    seaLevel: LAKE,
  },
  course: {
    start: { x: -30, z: 0 },
    length: 2500,
    meander: 60,
    wavelengths: [620, 340, 190],
    jumps: 14,
    sideLines: [
      { from: 260, to: 820, offset: 72, kind: 'flow' },
      { from: 1000, to: 1700, offset: -80, kind: 'pro' },
      { from: 1850, to: 2350, offset: 75, kind: 'flow' },
    ],
    freerideKickers: 22,
    trailColor: lin('#c8a676'),
    trailEdgeColor: lin('#8f9a5c'),
    marginX: 120,
    xRange: [-330, 165],
  },
  sky: {
    zenith: '#1a48c8',
    horizon: '#86b4ee',
    haze: '#d0e2f6',
    sunColor: '#fff5e4',
    sunIntensity: 3.4,
    sunDir: [-0.5, 0.72, 0.48],
    hemiSky: '#98c0ff',
    hemiGround: '#4d8a4c',
    hemiIntensity: 1.5,
    cloudCount: 40,
    cloudLight: '#ffffff',
    cloudShade: '#a3b2d8',
    cloudBanks: [
      { azimuth: 0.25, spread: 0.35, weight: 3 },
      { azimuth: -0.65, spread: 0.4, weight: 2 },
      { azimuth: 1.35, spread: 0.45, weight: 2 },
      { azimuth: -1.9, spread: 0.5, weight: 1 },
      { azimuth: 3.0, spread: 0.7, weight: 1 },
    ],
    cloudHeight: [3900, 5400],
    cloudDistance: [11500, 18000],
    cloudScale: [3600, 6400],
  },
  fog: {
    color: '#a8c4ec',
    sunColor: '#fff3de',
    density: 0.0001,
    heightFalloff: 0.0009,
    base: LAKE,
    max: 0.78,
    mistColor: '#c4e8f2',
    mistTop: LAKE + 70,
    mistBottom: LAKE - 20,
    mistStrength: 0.3,
    mistNear: 400,
    mistCenter: [LAKE_C.x, LAKE_C.z],
    mistRadius: 2300,
  },
  water: { level: LAKE, deep: '#0b86a4', shallow: '#3fd6c4', foam: '#effcff', depthScale: 16 },
  grass: {
    enabled: true,
    base: '#2a8a48',
    tip: '#6fcf72',
    tipAlt: '#b4e46a',
    height: [0.14, 0.42],
    density: 1,
    coverage: (s) => (s.ny < 0.74 ? 0 : s.h < LAKE + 3 ? 0 : 1 - 0.6 * forestMask(s.x, s.z, s.h, s.ny)),
    flowers: { colors: ['#d88cff', '#fff6d0'], density: 0.11 },
  },
  scatter: [
    {
      // dense pine forest on the slopes beside the alp
      kind: 'pine',
      perHectare: 34,
      scale: [1.5, 3.4],
      colorA: '#143a28',
      colorB: '#2a5e3a',
      trailClearance: 6,
      collide: 'solid',
      density: (s) => forestMask(s.x, s.z, s.h, s.ny) * 0.9,
    },
    {
      // the same forests across the valleys (larger, cheap far LOD); only a few of these big ones mix into the region
      kind: 'pine',
      perHectare: 4,
      scale: [2.6, 4.4],
      colorA: '#163f2b',
      colorB: '#2c623c',
      trailClearance: 8,
      collide: 'solid',
      far: true,
      density: (s) => forestMask(s.x, s.z, s.h, s.ny) * (s.x > -512 && s.x < 320 && s.z > -2752 && s.z < 128 ? 0.4 : 1),
    },
    {
      kind: 'pine',
      perHectare: 0.7,
      scale: [1.1, 2.4],
      colorA: '#24543a',
      colorB: '#3f7a3c',
      trailClearance: 7,
      collide: 'solid',
      density: (s) => (s.ny > 0.85 && s.h < 1900 ? 0.6 : 0),
    },
    {
      kind: 'granite',
      perHectare: 3.2,
      scale: [0.6, 2.6],
      colorA: '#b9b7b0',
      colorB: '#8f929c',
      trailClearance: 2,
      collide: 'solid',
      density: (s, nn) => 0.25 + 0.75 * smoothstep(0.4, 0.7, nn.fbm(s.x / 70 + 30, s.z / 70, 2)) + (s.ny < 0.85 ? 0.3 : 0),
    },
    {
      kind: 'round',
      perHectare: 3,
      scale: [0.45, 1.1],
      colorA: '#2c6a3a',
      colorB: '#4a8a3c',
      trailClearance: 2.5,
      collide: 'soft',
      density: (s, nn) => smoothstep(-0.1, 0.4, nn.fbm(s.x / 120 + 3, s.z / 120, 2)) * (s.ny > 0.8 ? 1 : 0.3),
    },
    {
      // lupine spires in the purple flower drifts
      kind: 'marram',
      perHectare: 26,
      scale: [0.4, 0.75],
      colorA: '#9a4ee6',
      colorB: '#dc6ad8',
      trailClearance: 1.2,
      collide: 'none',
      density: (s, nn) => smoothstep(0.35, 0.75, nn.noise2(s.x / 42 - 13, s.z / 42 + 5)) * (nn.noise2(s.x / 160 + 40, s.z / 160) > 0.2 ? 1 : 0.12),
    },
    {
      // arnica / globeflower tufts in the yellow drifts
      kind: 'marram',
      perHectare: 22,
      scale: [0.35, 0.6],
      colorA: '#f0b81e',
      colorB: '#ffe45a',
      trailClearance: 1.2,
      collide: 'none',
      density: (s, nn) => {
        const k = nn.noise2(s.x / 160 + 40, s.z / 160);
        return smoothstep(0.35, 0.75, nn.noise2(s.x / 42 - 13, s.z / 42 + 5)) * (k <= 0.2 && k >= -0.3 ? 1 : 0.1);
      },
    },
  ],
  post: {
    saturation: 1.3,
    vibrance: 0.32,
    contrast: 0.3,
    exposure: 1.02,
    shadowTint: [0.0, 0.012, 0.09],
    highlightTint: [0.03, 0.025, -0.012],
  },
  introShot: { from: [-30, 13, 34], to: [30, 30, -320] },
  buildSetPieces: buildAlpineSetPieces,
};
