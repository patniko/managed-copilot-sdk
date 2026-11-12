import * as THREE from 'three';
import { Noise } from '../../core/noise';
import { clamp, smoothstep } from '../../core/math';
import type { EnvironmentDef, GroundSample, RGB } from '../types';
import { buildCitadelSetPieces } from '../props/citadel';

const SEED = 1207;
const n = new Noise(SEED);
const lin = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** Low-frequency spine of the ridge (smooth; the wall and viaduct follow it). */
export const ridgeLow = (z: number) => -40 + 16 * Math.sin(z / 560 + 0.4) - 16 * Math.sin(0.4);
const wiggleAmp = (z: number) => 2 + 20 * smoothstep(-260, -680, z);
/** Trail centreline: the ledge, brink and bank are all laid out relative to it. */
export const ridgeX = (z: number) => ridgeLow(z) + wiggleAmp(z) * (0.62 * Math.sin(z / 84 + 1.1) + 0.38 * Math.sin(z / 41 + 2.3));
/** 0 at the start (tight, video-like composition) → 1 after ~700 m (wider, more open riding). */
export const ledgeOpen = (z: number) => smoothstep(-380, -720, z);
/** Left brink and right bank of the meadow ledge, relative to the trail centreline. */
export const brinkDx = (z: number) => -7 - 35 * ledgeOpen(z);
export const bankDx = (z: number) => 17 + 77 * ledgeOpen(z);
/** Ridge crest elevation along the descent. */
export function ridgeY(z: number) {
  const s = -z;
  if (s < 0) return 432 + Math.min(-s, 2500) * 0.2;
  const y = 430 - 0.148 * s + 10 * Math.sin((s / 900) * Math.PI * 2 + 0.4) - 10 * Math.sin(0.4);
  return Math.max(34, y);
}
/** West coastline x as a function of z. */
const coastX = (z: number) => -1250 - 140 * Math.sin(z / 650) - 0.12 * Math.max(0, -z - 1500);
/** North shore line (chalk cliffs) z as a function of x (only meaningful west of the citadel). */
const northShoreZ = (x: number) => -3480 + 0.32 * Math.min(0, x + 900) + 60 * Math.sin(x / 300);
/** Citadel wall face: east section x(z) (just beyond the ravine, receding as you descend) and north section z(x). */
export const wallEastX = (z: number) => ridgeLow(z) + 104 + 0.12 * Math.max(0, -z - 200) + 8 * Math.sin(z / 700);
export const wallNorthZ = (x: number) => -3330 + 30 * Math.sin(x / 500);
/** Viaduct: hugs the ravine right beside the trail at the start, then curves away into the wall. */
export const viaductX = (z: number) => ridgeLow(z) + 30;

function valleyFloor(x: number, z: number) {
  return 30 + 10 * n.fbm(x / 600, z / 600, 3);
}

/** Large-scale landscape (no fine detail). */
function farHeight(x: number, z: number): number {
  const s = -z;
  // sea / land distance (positive on land)
  const landE = x - coastX(z);
  const landN = northShoreZ(x) - z;
  const dShore = Math.max(landE, landN);
  const vf = valleyFloor(x, z);
  let land: number;
  const nearNorthShore = landN > -400 && x < -700;
  if (nearNorthShore && landN > 0) {
    // chalk plateau beyond the bay
    land = 150 + 40 * n.fbm(x / 900, z / 900, 3) + Math.min(landN, 600) * 0.08;
  } else {
    const ry = s > 2780 ? vf : Math.max(vf, ridgeY(z));
    const dx = x - ridgeX(z);
    const brink = brinkDx(z);
    const bank = bankDx(z);
    if (dx > bank) {
      // over the right bank: keep rolling off, then plunge into the forested ravine at the foot of the citadel wall
      const open = ledgeOpen(z);
      const tilt = 0.36 * (1 - open) + 0.05 * open;
      const r = Math.max(0, bank - 3);
      const atBank = ry + 0.015 * (bank - brink) - (tilt * r * r) / (r + 6);
      const slope = (tilt * (r * r + 12 * r)) / ((r + 6) * (r + 6));
      const t = Math.min(1, (dx - bank) / 30);
      land = atBank - slope * Math.min(dx - bank, 12) - 58 * (t * t * (3 - 2 * t));
    } else if (dx >= brink) {
      // the meadow ledge: near the start it rolls off convexly toward the ravine so the viaduct's arches
      // show over the bank (like the painting); further down it opens into a broad, gentler meadow
      const open = ledgeOpen(z);
      const tilt = 0.36 * (1 - open) + 0.05 * open;
      const r = Math.max(0, dx - 3);
      land = ry + 0.015 * (dx - brink) - (tilt * r * r) / (r + 6);
    } else {
      // left of the brink the hillside falls away steeply to a misty terrace (spire town + flower fields),
      // then drops again to the coastal valley — like the painting
      const terrace = -150 + 9 * n.fbm(x / 300, z / 300, 2);
      const t1 = Math.min(1, (brink - dx) / 230);
      // convex roll-off at the brink, then a steep wooded slope down to the terrace
      land = ry + terrace * smoothstep(0, 1, Math.pow(t1, 0.6));
      const w2 = smoothstep(brink - 560, brink - 1000, dx);
      land = land + (vf - land) * w2;
      // forested foothills in the west valley
      land += 45 * Math.max(0, n.fbm(x / 420, z / 420, 3)) * smoothstep(-800, -1000, dx) * (1 - smoothstep(-1150, -1300, x));
    }
    // north: city basin floor
    land = Math.max(land, vf);
    // coastal downs with white chalk cliffs along the west shore (Seven Sisters look)
    const downs = smoothstep(520, 140, landE) * smoothstep(-200, 200, z + 3000);
    if (downs > 0) land = Math.max(land, land + (105 + 30 * n.fbm(x / 380, z / 380, 3) - land) * downs);
  }
  // behind the citadel walls: high plateau
  const behindEast = x - wallEastX(z);
  const behindNorth = wallNorthZ(x) - z;
  let walled = land;
  if (behindEast > 10 && z > -3500) walled = Math.max(walled, land + (820 - land) * smoothstep(10, 70, behindEast));
  if (behindNorth > 10 && x > -1100) {
    // the cliff-city wall ends mid-way across the north; westward it becomes a natural chalk escarpment
    const top = x > -250 ? 820 : 820 + (175 + 35 * n.fbm(x / 400, z / 400, 2) - 820) * smoothstep(-250, -480, x);
    walled = Math.max(walled, land + (top - land) * smoothstep(10, 70, behindNorth));
  }
  land = walled;
  // coastline: chalk cliffs on the north shore, gentler beaches on the west
  const cliffW = nearNorthShore ? 26 : z > -3100 ? 34 : 110;
  const seaFloor = -28 + 8 * n.noise2(x / 700, z / 700);
  return seaFloor + (land - seaFloor) * smoothstep(-cliffW * 0.15, cliffW, dShore);
}

function height(x: number, z: number): number {
  const base = farHeight(x, z);
  const big = 4.5 * n.fbm(x / 260 + 11, z / 260, 4);
  const mid = 1.8 * n.fbm(x / 55 - 3, z / 55 + 7, 3);
  const small = 0.35 * n.noise2(x / 11, z / 11);
  return base + big + mid + small;
}

const GRASS_A = lin('#b2c64a');
const GRASS_B = lin('#d0d35e');
const GRASS_DARK = lin('#5d8a2e');
const GRASS_WORN = lin('#a9b85c');
const ROCK = lin('#9e9378');
const CHALK = lin('#ece9e0');
const CHALK_SHADE = lin('#b8bfd2');
const SAND = lin('#eadcb4');
const FOREST = lin('#2f6a2c');
const FOREST_B = lin('#447f35');
const FIELD_ORANGE = lin('#d9824a');
const FIELD_RED = lin('#c4553a');
const LAVENDER = lin('#9d8fe6');

function mixInto(out: RGB, a: RGB, b: RGB, t: number) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

function groundColor(s: GroundSample, out: RGB) {
  const p = n.fbm(s.x / 90, s.z / 90, 3) * 0.5 + 0.5;
  mixInto(out, GRASS_A, GRASS_B, smoothstep(0.35, 0.75, p));
  const hollow = n.fbm(s.x / 35 + 4, s.z / 35, 2);
  const tmp: RGB = [0, 0, 0];
  mixInto(tmp, out, GRASS_DARK, clamp(-hollow * 0.9 + 0.08, 0, 0.55));
  out[0] = tmp[0];
  out[1] = tmp[1];
  out[2] = tmp[2];
  // worn grass near trails
  const worn = 1 - smoothstep(0, 2.2, s.trailDist);
  mixInto(tmp, out, GRASS_WORN, worn * 0.55);
  out[0] = tmp[0];
  out[1] = tmp[1];
  out[2] = tmp[2];
  // steep: rock (the brink and ravine sides stay mostly green, like the painting)
  const steep = smoothstep(0.62, 0.42, s.ny);
  mixInto(tmp, out, ROCK, steep * 0.8);
  out[0] = tmp[0];
  out[1] = tmp[1];
  out[2] = tmp[2];
  farTint(s.x, s.z, s.h, s.ny, out, true);
}

/** Valley patchwork, forest, chalk and sand, applied for low / far terrain. */
function farTint(x: number, z: number, h: number, ny: number, out: RGB, _region: boolean) {
  const tmp: RGB = [0, 0, 0];
  const dx = x - ridgeX(z);
  const below = ridgeY(z) - h;
  const bank = bankDx(z);
  const brink = brinkDx(z);
  // forests: the ravine under the viaduct, the slope below the brink and the western foothills
  const ravine = smoothstep(bank + 4, bank + 22, dx);
  const underBrink = smoothstep(brink - 12, brink - 45, dx) * (1 - smoothstep(brink - 150, brink - 200, dx));
  const forest =
    (ravine * 0.95 + underBrink * 0.75 + smoothstep(-700, -900, dx) * (1 - smoothstep(60, 20, h))) *
    smoothstep(0.1, 0.4, n.fbm(x / 160, z / 160, 3) + 0.4);
  if (forest > 0) {
    mixInto(tmp, out, n.noise2(x / 40, z / 40) > 0 ? FOREST : FOREST_B, clamp(forest, 0, 1));
    out[0] = tmp[0];
    out[1] = tmp[1];
    out[2] = tmp[2];
  }
  // patchwork fields + lavender meadows far below the ridge on the valley side (the painterly orange/purple quilt)
  const valley = smoothstep(70, 115, below) * (dx < brink ? 1 : 0) * smoothstep(0.55, 0.8, ny);
  if (valley > 0) {
    const cellV = n.noise2(Math.floor(x / 45) * 1.7, Math.floor(z / 38) * 1.3);
    const col = cellV > 0.35 ? FIELD_ORANGE : cellV > 0.05 ? FIELD_RED : cellV < -0.4 ? LAVENDER : GRASS_A;
    mixInto(tmp, out, col, valley * 0.85);
    out[0] = tmp[0];
    out[1] = tmp[1];
    out[2] = tmp[2];
  }
  // beaches
  if (h < 5) {
    mixInto(tmp, out, SAND, 1 - smoothstep(1.5, 5, h));
    out[0] = tmp[0];
    out[1] = tmp[1];
    out[2] = tmp[2];
  }
  // white chalk cliffs along the coast
  const nearCoast = 1 - smoothstep(450, 750, Math.min(Math.abs(x - coastX(z)), Math.abs(z - northShoreZ(x))));
  const chalk = smoothstep(0.62, 0.38, ny) * nearCoast;
  if (chalk > 0) {
    mixInto(tmp, CHALK, CHALK_SHADE, smoothstep(0.3, 0.05, ny) * 0.5);
    mixInto(out, out, tmp, chalk);
  }
}

function farColor(x: number, z: number, h: number, ny: number, out: RGB) {
  mixInto(out, GRASS_A, GRASS_DARK, 0.25 + 0.3 * (n.noise2(x / 300, z / 300) * 0.5 + 0.5));
  farTint(x, z, h, ny, out, false);
}

export const citadelCoast: EnvironmentDef = {
  id: 'citadel',
  name: 'Citadel Coast',
  subtitle: 'The painted original',
  description: 'Bomb the meadow ridge beneath a cliff-city of glowing windows, a train-crossed viaduct and a sapphire bay.',
  cardColors: ['#9ccf3d', '#2f5fc4', '#ff9a3c'],
  seed: SEED,
  ambience: 'coast',
  terrain: {
    region: { minX: -640, maxX: 192, minZ: -2752, maxZ: 128 },
    cell: 2,
    height,
    farHeight,
    groundColor,
    farColor,
    surface: (s) => (s.ny < 0.7 ? 'rock' : 'grass'),
    seaLevel: 0,
  },
  course: {
    start: { x: ridgeX(0), z: 0 },
    length: 2500,
    meander: 0,
    wavelengths: [460, 240, 130],
    centerline: ridgeX,
    jumps: 14,
    sideLines: [
      { from: 640, to: 1080, offset: 40, kind: 'flow' },
      { from: 1150, to: 1750, offset: 44, kind: 'pro' },
      { from: 1850, to: 2350, offset: 40, kind: 'flow' },
    ],
    freerideKickers: 22,
    trailColor: lin('#d9c79c'),
    trailEdgeColor: lin('#b9b07a'),
    marginX: 110,
  },
  sky: {
    zenith: '#2556c4',
    horizon: '#9ec2ee',
    haze: '#c9dcf2',
    sunColor: '#fff3dc',
    sunIntensity: 3.3,
    sunDir: [-0.42, 0.74, 0.52],
    hemiSky: '#a8cdfa',
    hemiGround: '#7c9a3c',
    hemiIntensity: 1.55,
    cloudCount: 28,
    cloudLight: '#ffffff',
    cloudShade: '#aab8d4',
    // distinct cumulus groups with clear deep-blue sky between them (not a continuous deck)
    cloudBanks: [
      { azimuth: 0.25, spread: 0.3, weight: 3 },
      { azimuth: -0.75, spread: 0.3, weight: 2 },
      { azimuth: 1.4, spread: 0.4, weight: 1.5 },
      { azimuth: 3.1, spread: 0.8, weight: 1 },
    ],
    cloudHeight: [500, 1700],
    cloudDistance: [3800, 9000],
    cloudScale: [1700, 3600],
  },
  fog: {
    color: '#b9d0f0',
    sunColor: '#fff0d8',
    density: 0.00014,
    heightFalloff: 0.0016,
    base: 0,
    max: 0.8,
    mistColor: '#a698f0',
    // lavender mist pools in the valley well below the ridge (the planes descend with the ridge)
    mistTop: 395,
    mistBottom: 300,
    mistSlope: 0.148,
    mistStrength: 0.68,
    mistNear: 40,
    mistCenter: [-450, -1700],
    mistRadius: 1700,
  },
  water: { level: 0, deep: '#0a2c9c', shallow: '#2277d6', foam: '#f4f7fb', depthScale: 6 },
  grass: {
    enabled: true,
    base: '#8fa93a',
    tip: '#cbd85a',
    tipAlt: '#ece08a',
    height: [0.12, 0.34],
    density: 1,
    coverage: (s) => (s.ny < 0.75 ? 0 : s.h < 4 ? 0 : 1),
    flowers: { colors: ['#ffffff', '#ffd83a'], density: 0.06 },
  },
  scatter: [
    {
      kind: 'round',
      perHectare: 90,
      scale: [0.9, 2.4],
      colorA: '#3f7f2c',
      colorB: '#6aa83a',
      trailClearance: 2.5,
      collide: 'soft',
      far: true,
      density: (s, nn) => {
        const dx = s.x - ridgeX(s.z);
        const bank = bankDx(s.z);
        // bushes crowd the right bank (they frame the viaduct like the painting)
        const atBank = smoothstep(bank - 14, bank - 4, dx) * (1 - smoothstep(bank + 6, bank + 16, dx));
        const base = smoothstep(0.0, 0.5, nn.fbm(s.x / 140, s.z / 140, 2) + 0.2) * (s.ny > 0.8 ? 1 : 0.3);
        return clamp(base * 0.12 + atBank * 0.85, 0, 1);
      },
    },
    {
      kind: 'boulder',
      perHectare: 2.2,
      scale: [0.5, 1.6],
      colorA: '#e4e2da',
      colorB: '#c9c6bb',
      trailClearance: 1.8,
      collide: 'solid',
      density: (s, nn) => 0.4 + 0.6 * smoothstep(0.1, 0.5, nn.noise2(s.x / 80, s.z / 80)),
    },
    {
      kind: 'broadleaf',
      perHectare: 40,
      scale: [1.0, 2.1],
      colorA: '#2d6629',
      colorB: '#4f8c37',
      trailClearance: 5,
      collide: 'solid',
      far: true,
      density: (s, nn) => {
        const dx = s.x - ridgeX(s.z);
        const bank = bankDx(s.z);
        const brink = brinkDx(s.z);
        // dense woods in the ravine and on the slope below the brink; a few lone trees on the ledge
        const edge =
          smoothstep(bank + 2, bank + 14, dx) * 0.95 +
          smoothstep(brink - 8, brink - 30, dx) * (1 - smoothstep(brink - 160, brink - 210, dx)) * 0.8 +
          smoothstep(-700, -900, dx) * 0.6;
        return clamp(edge * 0.85 + 0.015 * smoothstep(0.3, 0.6, nn.fbm(s.x / 200, s.z / 200, 2)), 0, 1) * (s.h > 6 ? 1 : 0);
      },
    },
  ],
  post: {
    saturation: 1.34,
    vibrance: 0.3,
    contrast: 0.4,
    exposure: 1.05,
    shadowTint: [0.0, 0.0, 0.07],
    highlightTint: [0.045, 0.03, -0.03],
  },
  introShot: { from: [-26, 30, 60], to: [60, -60, -700] },
  buildSetPieces: buildCitadelSetPieces,
};
