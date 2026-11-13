import * as THREE from 'three';
import { paintMaterial } from '../../render/globals';
import { defaultRiderPose, type RiderColors, type RiderRig } from '../rider/types';
import { createBike } from './bike';
import { RIDER_BIKE } from './bikeStyles';
import { Cloth, ringGridConstraints, ringGridTriangles, type ClothBuild, type ClothCollider } from './cloth';
import { HumanoidRig, type HumanoidBody, type HumanoidSpec } from './humanoid';
import {
  adjacency,
  meshSdf,
  sdCapsule,
  sdEllipsoid,
  sdfOcclusion,
  sdRoundBox,
  sdRoundCone,
  sdSphere,
  SdfModel,
  SdfPart,
  smax,
  smin,
  transformed,
  type LocalSdf,
} from './sdf';
import { ellipsoid, enableShadows, merge, outfit, v3 } from './util';

/**
 * The human rider from the reference video, built for close-up chase shots:
 * - one continuous body sculpted from smooth SDF primitives (muscles, shoulder blades, glutes, calves)
 *   in the riding pose, meshed with surface nets and skinned to the IK skeleton,
 * - a loose T-shirt whose lower half and sleeves are a cloth simulation (wind, inertia, flutter),
 * - curly hair, ears, gloves, socks and shoes.
 */

/** Palette sampled from the reference video. */
export const RIDER_COLORS = {
  skin: '#c88456',
  skinWarm: '#c46d48',
  shirt: '#b3b1b8',
  shorts: '#141419',
  sock: '#121214',
  glove: '#141417',
  gloveTrim: '#2e2e34',
  shoe: '#d0532a',
  shoeDark: '#9c3a1c',
  sole: '#2a201c',
  strap: '#2b2427',
  hair: '#5d2c11',
  hairLight: '#9b5a2a',
  hairDark: '#3c1c0b',
  brow: '#552a12',
  eye: '#21150e',
  lip: '#a65846',
} as const;
const C = RIDER_COLORS;

export const RIDER_SPEC: HumanoidSpec = {
  hipHalf: 0.085,
  thigh: 0.44,
  shin: 0.435,
  ankleHeight: 0.075,
  ballForward: 0.1,
  torso: 0.5,
  shoulderHalf: 0.176,
  shoulderDrop: 0.035,
  upperArm: 0.29,
  forearm: 0.33,
  seatUp: 0.075,
  seatBack: 0.015,
  standUp: 0.15,
  standBack: 0.07,
  seatedPitch: 0.86,
  attackPitch: 1.1,
  reachMax: 0.95,
  reachMin: 0.7,
  attackReach: 0.84,
  emote: { splay: 0.05, headCenter: new THREE.Vector3(0, 0.15, -0.01), headRadius: 0.1 },
};

/* ------------------------------------------------------------------ skeleton */

const BONES = [
  'pelvis',
  'torso',
  'head',
  'upperArmL',
  'upperArmR',
  'forearmL',
  'forearmR',
  'handL',
  'handR',
  'thighL',
  'thighR',
  'shinL',
  'shinR',
  'footL',
  'footR',
] as const;
const B = Object.fromEntries(BONES.map((n, i) => [n, i])) as Record<(typeof BONES)[number], number>;

function bodyOf(o: THREE.Object3D[]): HumanoidBody {
  return {
    pelvis: o[B.pelvis],
    torso: o[B.torso],
    head: o[B.head],
    upperArm: [o[B.upperArmL], o[B.upperArmR]],
    forearm: [o[B.forearmL], o[B.forearmR]],
    hand: [o[B.handL], o[B.handR]],
    thigh: [o[B.thighL], o[B.thighR]],
    shin: [o[B.shinL], o[B.shinR]],
    foot: [o[B.footL], o[B.footR]],
  };
}

/** Bind pose = the standing "attack" position on the bike with level cranks (the most common pose at speed). */
function computeBindPose(): THREE.Matrix4[] {
  const objs = BONES.map(() => new THREE.Object3D());
  const rig = new HumanoidRig(RIDER_SPEC, bodyOf(objs));
  const bike = createBike(RIDER_BIKE);
  bike.update({ rearSpin: 0, frontSpin: 0, crank: 0, steer: 0, barspin: 0, tailwhip: 0, suspension: 0.15 });
  const pose = defaultRiderPose();
  pose.seated = 0;
  pose.speed = 12;
  pose.compress = 0.08;
  rig.update(pose, bike.anchors, 1 / 60);
  const one = new THREE.Vector3(1, 1, 1);
  return objs.map((o) => new THREE.Matrix4().compose(o.position, o.quaternion, one));
}

/* ------------------------------------------------------------------ body sculpt */

interface Sculpt {
  model: SdfModel;
  /** Neck axis in bind space (for the torso -> head weight blend). */
  neckA: THREE.Vector3;
  neckB: THREE.Vector3;
}

function sculptBody(bind: THREE.Matrix4[]): Sculpt {
  const part = (name: string, bone: number, k: number) => new SdfPart(name, bone, bind[bone], k);
  const parts: SdfPart[] = [];

  const pelvis = part('pelvis', B.pelvis, 0.045)
    .add(sdEllipsoid(0, 0.035, 0.0, 0.14, 0.104, 0.102))
    .add(sdEllipsoid(-0.05, -0.036, 0.04, 0.074, 0.084, 0.062)) // glutes (one smooth seat, no ball shapes)
    .add(sdEllipsoid(0.05, -0.036, 0.04, 0.074, 0.084, 0.062))
    .add(sdEllipsoid(0, 0.05, -0.07, 0.128, 0.08, 0.055)) // lower belly
    .add(sdEllipsoid(-0.115, -0.015, 0.0, 0.048, 0.072, 0.062)) // hips
    .add(sdEllipsoid(0.115, -0.015, 0.0, 0.048, 0.072, 0.062));
  pelvis.computeBounds(v3(-0.26, -0.2, -0.18), v3(0.26, 0.2, 0.2));
  parts.push(pelvis);

  // The torso is the shirt-covered upper body: broad, rounded back, stocky belly.
  const torso = part('torso', B.torso, 0.045)
    .add(sdEllipsoid(0, 0.13, 0.0, 0.148, 0.13, 0.118)) // waist
    .add(sdEllipsoid(0, 0.185, -0.045, 0.138, 0.12, 0.102)) // belly
    .add(sdEllipsoid(0, 0.315, 0.0, 0.17, 0.15, 0.127)) // ribcage
    .add(sdEllipsoid(0, 0.375, 0.045, 0.16, 0.12, 0.1)) // rounded upper back
    .add(sdEllipsoid(-0.087, 0.36, 0.076, 0.076, 0.095, 0.046)) // shoulder blades
    .add(sdEllipsoid(0.087, 0.36, 0.076, 0.076, 0.095, 0.046))
    .add(sdRoundCone(-0.045, 0.488, 0.024, -0.158, 0.458, 0.008, 0.056, 0.048)) // trapezius
    .add(sdRoundCone(0.045, 0.488, 0.024, 0.158, 0.458, 0.008, 0.056, 0.048))
    .add(sdRoundCone(-0.07, 0.442, 0.0, -0.152, 0.455, 0.0, 0.07, 0.06)) // shoulder girdle
    .add(sdRoundCone(0.07, 0.442, 0.0, 0.152, 0.455, 0.0, 0.07, 0.06))
    .add(sdEllipsoid(0, 0.1, 0.05, 0.136, 0.1, 0.076)); // lumbar
  torso.computeBounds(v3(-0.26, -0.04, -0.2), v3(0.26, 0.58, 0.2));
  parts.push(torso);

  // neck: from the torso's neck base up under the skull (head frame), authored in the torso frame
  const toTorso = bind[B.torso].clone().invert();
  const top = v3(0, 0.075, 0.016).applyMatrix4(bind[B.head]).applyMatrix4(toTorso);
  const neck = part('neck', B.torso, 0.02).add(sdRoundCone(0, 0.43, 0.012, top.x, top.y, top.z, 0.062, 0.05));
  neck.computeBounds(
    v3(Math.min(0, top.x) - 0.08, Math.min(0.43, top.y) - 0.08, Math.min(0.012, top.z) - 0.08),
    v3(Math.max(0, top.x) + 0.08, Math.max(0.43, top.y) + 0.08, Math.max(0.012, top.z) + 0.08),
  );
  parts.push(neck);

  for (const [side, s] of [
    ['L', -1],
    ['R', 1],
  ] as const) {
    const upper = part(`upperArm${side}`, B[`upperArm${side}`], 0.025)
      .add(sdRoundCone(0, 0, 0, 0, 0.29, 0, 0.05, 0.036))
      .add(sdEllipsoid(0, 0.04, 0, 0.061, 0.085, 0.061)) // deltoid
      .add(sdEllipsoid(0, 0.15, -0.016, 0.041, 0.085, 0.042)) // biceps
      .add(sdEllipsoid(0, 0.13, 0.017, 0.043, 0.1, 0.041)); // triceps
    upper.computeBounds(v3(-0.09, -0.1, -0.09), v3(0.09, 0.34, 0.09));
    parts.push(upper);

    const fore = part(`forearm${side}`, B[`forearm${side}`], 0.02)
      .add(sdRoundCone(0, 0, 0, 0, 0.25, 0, 0.037, 0.024))
      .add(sdEllipsoid(0, 0.075, 0, 0.046, 0.095, 0.039))
      .add(sdSphere(0, -0.004, 0.012, 0.032));
    fore.computeBounds(v3(-0.07, -0.06, -0.07), v3(0.07, 0.3, 0.07));
    parts.push(fore);

    // gloved fist wrapped round the brake hood
    const hand = part(`hand${side}`, B[`hand${side}`], 0.014)
      .add(sdRoundBox(0, 0.0, 0.0, 0.04, 0.044, 0.02, 0.016))
      .add(sdCapsule(-0.032, 0.04, -0.019, 0.032, 0.04, -0.019, 0.019)) // curled fingers
      .add(sdRoundCone(0, -0.088, 0, 0, -0.035, 0, 0.025, 0.03)) // wrist cuff
      .add(sdCapsule(0, -0.012, -0.024, 0, 0.026, -0.036, 0.012)); // thumb
    hand.computeBounds(v3(-0.08, -0.13, -0.08), v3(0.08, 0.09, 0.07));
    parts.push(hand);

    const thigh = part(`thigh${side}`, B[`thigh${side}`], 0.03)
      .add(sdRoundCone(0, 0, 0, 0, 0.43, 0.006, 0.088, 0.051))
      .add(sdEllipsoid(0, 0.2, 0.028, 0.066, 0.17, 0.056)) // quads
      .add(sdEllipsoid(0, 0.18, -0.03, 0.062, 0.16, 0.05)) // hamstrings
      .add(sdEllipsoid(s * 0.034, 0.21, 0.004, 0.05, 0.15, 0.054)) // vastus lateralis
      .add(sdSphere(0, 0.44, 0.012, 0.047)); // knee
    thigh.computeBounds(v3(-0.13, -0.11, -0.12), v3(0.13, 0.51, 0.12));
    parts.push(thigh);

    const shin = part(`shin${side}`, B[`shin${side}`], 0.025)
      .add(sdRoundCone(0, 0, 0, 0, 0.43, 0, 0.047, 0.03))
      .add(sdEllipsoid(0, 0.125, -0.033, 0.054, 0.11, 0.05)) // calf
      .add(sdEllipsoid(0, 0.21, 0.016, 0.031, 0.18, 0.026)) // tibia ridge
      .add(sdSphere(0, 0.435, 0, 0.034)); // ankle
    shin.computeBounds(v3(-0.09, -0.07, -0.1), v3(0.09, 0.48, 0.09));
    parts.push(shin);
  }

  const model = new SdfModel(parts, [
    ['pelvis', 'torso', 0.06],
    ['torso', 'neck', 0.035],
    ['torso', 'upperArmL', 0.035],
    ['torso', 'upperArmR', 0.035],
    ['upperArmL', 'forearmL', 0.02],
    ['upperArmR', 'forearmR', 0.02],
    ['forearmL', 'handL', 0.012],
    ['forearmR', 'handR', 0.012],
    ['pelvis', 'thighL', 0.045],
    ['pelvis', 'thighR', 0.045],
    ['thighL', 'shinL', 0.022],
    ['thighR', 'shinR', 0.022],
  ]);
  const torsoBind = bind[B.torso];
  return { model, neckA: v3(0, 0.43, 0.012).applyMatrix4(torsoBind), neckB: top.clone().applyMatrix4(torsoBind) };
}

/* ------------------------------------------------------------------ body mesh */

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();
const _l = new THREE.Vector3();
const _l2 = new THREE.Vector3();
/** Part indices in `sculptBody` order. */
const TORSO = 1;
const NECK = 2;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** How much of the last `bodyColor` result is the shirt's colour (0..1), before occlusion: what a jersey repaints. */
let _shirtShare = 0;

/** Albedo + sheen of a body vertex. Region edges are blended over ~1 cm so they never stair-step. */
function bodyColor(model: SdfModel, dist: Float64Array, best: number, x: number, y: number, z: number, out: THREE.Color): number {
  const parts = model.parts;
  const name = parts[best].name;
  const l = parts[best].local(x, y, z, _l);
  const skin = _c3.set(C.skin);
  _shirtShare = 0;
  if (name === 'pelvis' || name === 'torso' || name === 'neck') {
    const torso = parts[TORSO];
    const yT = torso.local(x, y, z, _l2).y;
    const s = smoothstep(0.05, 0.085, yT);
    out.set(C.shorts).lerp(_c2.set(C.shirt), s);
    let sheen = 0.6 + (0.05 - 0.6) * s;
    // crew neck: skin wherever the neck wins over the torso
    const nk = smoothstep(-0.005, 0.006, dist[TORSO] - dist[NECK]);
    _shirtShare = s * (1 - nk);
    if (nk > 0) {
      out.lerp(skin.lerp(_c2.set(C.skinWarm), 0.35), nk);
      sheen += (0.25 - sheen) * nk;
    }
    return sheen;
  }
  if (name.startsWith('upperArm')) {
    const s = 1 - smoothstep(0.035, 0.07, l.y);
    out.copy(skin).lerp(_c2.set(C.shirt), s);
    _shirtShare = s;
    return 0.25 + (0.05 - 0.25) * s;
  }
  if (name.startsWith('forearm')) {
    const g = smoothstep(0.224, 0.242, l.y);
    out.copy(skin).lerp(_c2.set(C.glove), g);
    return 0.25 + 0.35 * g;
  }
  if (name.startsWith('hand')) {
    out.set(l.z > 0.012 && l.y > -0.01 ? C.gloveTrim : C.glove);
    return 0.6;
  }
  if (name.startsWith('thigh')) {
    const sh = 1 - smoothstep(0.245, 0.26, l.y);
    out.copy(skin);
    if (l.y > 0.39) out.lerp(_c2.set(C.skinWarm), 0.45 * smoothstep(0.39, 0.43, l.y)); // knee
    // leg gripper band just above the hem
    _c2.set(C.shorts).multiplyScalar(1 - 0.28 * smoothstep(0.226, 0.24, l.y));
    out.lerp(_c2, sh);
    return 0.25 + 0.35 * sh;
  }
  if (name.startsWith('shin')) {
    const so = smoothstep(0.255, 0.27, l.y);
    out.copy(skin).lerp(_c2.set(C.sock), so);
    return 0.25;
  }
  out.copy(skin);
  return 0.25;
}

/** Plain typed arrays of one mesh (transferable from a worker). */
export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  sheen: Float32Array;
  indices: Uint32Array;
  skinIndex?: Uint16Array;
  skinWeight?: Float32Array;
  /** Body only: how much of each vertex's colour is the shirt's, occlusion included (repaints a jersey). */
  shirt?: Float32Array;
}

interface BodyAsset {
  mesh: MeshData & { skinIndex: Uint16Array; skinWeight: Float32Array; shirt: Float32Array };
  /** Dominant part per vertex (index into model.parts). */
  dominant: Uint8Array;
}

function buildBody(sc: Sculpt): BodyAsset {
  const model = sc.model;
  const sdf = (x: number, y: number, z: number) => model.eval(x, y, z);
  const mesh = meshSdf(sdf, model.bounds(0.03), 0.0095);
  const { positions, normals, indices } = mesh;
  const nv = positions.length / 3;
  const parts = model.parts;
  const np = parts.length;
  const dist = new Float64Array(np);
  const colors = new Float32Array(nv * 3);
  const sheen = new Float32Array(nv);
  const shirt = new Float32Array(nv);
  const dominant = new Uint8Array(nv);
  const NB = BONES.length;
  const W = new Float32Array(nv * NB);
  const neckIdx = parts.findIndex((p) => p.name === 'neck');
  const nA = sc.neckA;
  const nAB = new THREE.Vector3().subVectors(sc.neckB, sc.neckA);
  const nL2 = nAB.lengthSq();
  for (let v = 0; v < nv; v++) {
    const x = positions[v * 3],
      y = positions[v * 3 + 1],
      z = positions[v * 3 + 2];
    model.evalParts(x, y, z, dist);
    let best = 0;
    for (let p = 1; p < np; p++) if (dist[p] < dist[best]) best = p;
    dominant[v] = best;
    // skin weights from proximity to each part's surface
    for (let p = 0; p < np; p++) {
      const d = dist[p];
      if (d > 0.05) continue;
      const w = Math.exp(-Math.max(d, 0) / 0.011);
      if (p === neckIdx) {
        const t = ((x - nA.x) * nAB.x + (y - nA.y) * nAB.y + (z - nA.z) * nAB.z) / nL2;
        const hs = smoothstep(0.3, 0.92, t);
        W[v * NB + B.torso] += w * (1 - hs);
        W[v * NB + B.head] += w * hs;
      } else W[v * NB + parts[p].bone] += w;
    }
    // colour
    sheen[v] = bodyColor(model, dist, best, x, y, z, _c);
    const ao = sdfOcclusion(sdf, x, y, z, normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2], 0.013);
    _c.multiplyScalar(0.45 + 0.55 * ao);
    shirt[v] = _shirtShare * (0.45 + 0.55 * ao);
    colors[v * 3] = _c.r;
    colors[v * 3 + 1] = _c.g;
    colors[v * 3 + 2] = _c.b;
  }
  // smooth the weights over the surface so joints bend softly
  const adj = adjacency(nv, indices);
  const tmp = new Float32Array(NB);
  for (let it = 0; it < 4; it++) {
    for (let v = 0; v < nv; v++) {
      const nb = adj[v];
      if (!nb.length) continue;
      tmp.fill(0);
      for (const u of nb) for (let k = 0; k < NB; k++) tmp[k] += W[u * NB + k];
      const s = 0.5 / nb.length;
      for (let k = 0; k < NB; k++) W[v * NB + k] = W[v * NB + k] * 0.5 + tmp[k] * s;
    }
  }
  const skinIndex = new Uint16Array(nv * 4);
  const skinWeight = new Float32Array(nv * 4);
  for (let v = 0; v < nv; v++) {
    const top: Array<[number, number]> = [];
    for (let k = 0; k < NB; k++) {
      const w = W[v * NB + k];
      if (w > 1e-4) top.push([k, w]);
    }
    top.sort((a, b) => b[1] - a[1]);
    const sel = top.slice(0, 4);
    let sum = sel.reduce((a, b) => a + b[1], 0);
    if (sum <= 0) {
      sel.length = 0;
      sel.push([parts[dominant[v]].bone, 1]);
      sum = 1;
    }
    sel.forEach(([k, w], i) => {
      skinIndex[v * 4 + i] = k;
      skinWeight[v * 4 + i] = w / sum;
    });
  }
  return { mesh: { positions, normals, colors, sheen, indices, skinIndex, skinWeight, shirt }, dominant };
}

/* ------------------------------------------------------------------ head & hair */

/** Curly hair: a scalp shell covered in small blended curls, trimmed at the hairline. */
function hairSdf(): LocalSdf {
  const cx = 0,
    cy = 0.173,
    cz = 0.008;
  const shell = sdEllipsoid(cx, cy, cz, 0.083, 0.1, 0.099);
  const hairline = (x: number, z: number) => {
    const az = Math.atan2(x, -(z - cz));
    const c = Math.cos(az),
      s = Math.sin(az);
    return 0.1 + 0.105 * Math.pow((1 + c) / 2, 1.2) + 0.035 * s * s;
  };
  // Fibonacci-distributed curls, fuller on top
  const curls: number[] = [];
  let seed = 11;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const N = 640;
  for (let i = 0; i < N; i++) {
    const yy = 1 - (2 * (i + 0.5)) / N;
    const rr = Math.sqrt(1 - yy * yy);
    const th = i * 2.399963 + rnd() * 0.4;
    const dx = Math.cos(th) * rr,
      dy = yy,
      dz = Math.sin(th) * rr;
    const px = cx + dx * 0.083,
      py = cy + dy * 0.1,
      pz = cz + dz * 0.099;
    if (py < hairline(px, pz) - 0.006) continue;
    const r = 0.0105 + rnd() * 0.0075;
    // uneven volume: clumps sit at different heights so the silhouette is tousled, not a cap
    const lift = 0.002 + 0.012 * Math.max(0, dy) * (0.5 + rnd()) + 0.006 * rnd() + (dz > 0.3 ? 0.004 : 0);
    curls.push(px + dx * lift, py + dy * lift, pz + dz * lift, r);
  }
  // a few bigger tufts break up the outline
  for (let i = 0; i < 26; i++) {
    const th = rnd() * Math.PI * 2;
    const dy = 0.2 + rnd() * 0.75;
    const rr = Math.sqrt(1 - dy * dy);
    const dx = Math.cos(th) * rr,
      dz = Math.sin(th) * rr;
    if (dz < -0.55 && dy < 0.75) continue; // keep the forehead clear
    const lift = 0.006 + rnd() * 0.01;
    curls.push(cx + dx * (0.083 + lift), cy + dy * (0.1 + lift), cz + dz * (0.099 + lift), 0.014 + rnd() * 0.008);
  }
  // bucket the curls in a flat grid (numeric keys: this lookup runs ~10^6 times)
  const cell = 0.03;
  const gx0 = -0.16,
    gy0 = 0.0,
    gz0 = -0.16;
  const GN = 12;
  const buckets: number[][] = Array.from({ length: GN * GN * GN }, () => []);
  const cellOf = (v: number, o: number) => Math.floor((v - o) / cell);
  for (let c = 0; c < curls.length; c += 4) {
    // reach covers the meshing band (~1.7 cm) so no coarse corner overestimates its distance
    const reach = curls[c + 3] + 0.022;
    for (let i = cellOf(curls[c] - reach, gx0); i <= cellOf(curls[c] + reach, gx0); i++)
      for (let j = cellOf(curls[c + 1] - reach, gy0); j <= cellOf(curls[c + 1] + reach, gy0); j++)
        for (let k = cellOf(curls[c + 2] - reach, gz0); k <= cellOf(curls[c + 2] + reach, gz0); k++)
          if (i >= 0 && j >= 0 && k >= 0 && i < GN && j < GN && k < GN) buckets[i + j * GN + k * GN * GN].push(c);
  }
  const grid = buckets.map((b) => Int32Array.from(b));
  return (x, y, z) => {
    let d = shell(x, y, z) + 0.003;
    const i = cellOf(x, gx0),
      j = cellOf(y, gy0),
      k = cellOf(z, gz0);
    if (i >= 0 && j >= 0 && k >= 0 && i < GN && j < GN && k < GN) {
      const list = grid[i + j * GN + k * GN * GN];
      for (let n = 0; n < list.length; n++) {
        const c = list[n];
        const dx = x - curls[c],
          dy = y - curls[c + 1],
          dz = z - curls[c + 2];
        d = smin(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - curls[c + 3], 0.0085);
      }
    }
    return smax(d, hairline(x, z) - y, 0.012);
  };
}

function buildHead(): MeshData {
  const I = new THREE.Matrix4();
  const face = new SdfPart('face', 0, I, 0.02)
    .add(sdEllipsoid(0, 0.165, 0.004, 0.077, 0.095, 0.093)) // cranium
    .add(sdEllipsoid(0, 0.112, -0.033, 0.062, 0.062, 0.066)) // jaw / lower face
    .add(sdEllipsoid(0, 0.086, -0.073, 0.03, 0.024, 0.025)) // chin
    .add(sdEllipsoid(-0.045, 0.138, -0.061, 0.03, 0.024, 0.03)) // cheeks
    .add(sdEllipsoid(0.045, 0.138, -0.061, 0.03, 0.024, 0.03))
    .add(sdRoundCone(0, 0.158, -0.09, 0, 0.13, -0.103, 0.008, 0.013), { k: 0.012 }) // nose
    .add(sdCapsule(-0.04, 0.186, -0.083, 0.04, 0.186, -0.083, 0.011), { k: 0.012 }) // brow ridge
    .add(sdRoundCone(0, -0.035, 0.016, 0, 0.11, 0.012, 0.053, 0.047)) // neck stub
    .add(sdSphere(-0.031, 0.164, -0.094, 0.0155), { sub: true, k: 0.01 }) // eye sockets
    .add(sdSphere(0.031, 0.164, -0.094, 0.0155), { sub: true, k: 0.01 });
  face.computeBounds(v3(-0.1, -0.06, -0.13), v3(0.1, 0.28, 0.12));
  const ears = new SdfPart('ears', 0, I, 0.006)
    .add(transformed(sdEllipsoid(0, 0, 0, 0.011, 0.031, 0.021), v3(-0.079, 0.15, 0.01), new THREE.Euler(0, 0.3, 0.12)))
    .add(transformed(sdEllipsoid(0, 0, 0, 0.011, 0.031, 0.021), v3(0.079, 0.15, 0.01), new THREE.Euler(0, -0.3, -0.12)))
    .add(sdSphere(-0.09, 0.152, 0.007, 0.0105), { sub: true, k: 0.005 })
    .add(sdSphere(0.09, 0.152, 0.007, 0.0105), { sub: true, k: 0.005 });
  ears.computeBounds(v3(-0.11, 0.1, -0.03), v3(0.11, 0.2, 0.05));
  const eyes = new SdfPart('eyes', 0, I, 0.001).add(sdSphere(-0.031, 0.164, -0.088, 0.0092)).add(sdSphere(0.031, 0.164, -0.088, 0.0092));
  eyes.computeBounds(v3(-0.05, 0.14, -0.11), v3(0.05, 0.19, -0.07));
  const brows = new SdfPart('brows', 0, I, 0.004)
    .add(sdCapsule(-0.046, 0.19, -0.088, -0.018, 0.194, -0.093, 0.0055))
    .add(sdCapsule(0.046, 0.19, -0.088, 0.018, 0.194, -0.093, 0.0055));
  brows.computeBounds(v3(-0.06, 0.18, -0.11), v3(0.06, 0.21, -0.075));
  const hairFn = hairSdf();
  const hair = new SdfPart('hair', 0, I, 0.01).add(hairFn);
  hair.computeBounds(v3(-0.13, 0.06, -0.13), v3(0.13, 0.31, 0.14));
  const model = new SdfModel(
    [face, ears, eyes, brows, hair],
    [
      ['face', 'ears', 0.006],
      ['face', 'hair', 0.008],
      ['face', 'brows', 0.003],
    ],
  );
  model.cull = 0.03;
  const sdf = (x: number, y: number, z: number) => model.eval(x, y, z);
  const { positions, normals, indices } = meshSdf(sdf, model.bounds(0.015), 0.0042);
  const nv = positions.length / 3;
  const dist = new Float64Array(5);
  const colors = new Float32Array(nv * 3);
  const sheen = new Float32Array(nv);
  const shell = sdEllipsoid(0, 0.173, 0.008, 0.083, 0.1, 0.099);
  for (let v = 0; v < nv; v++) {
    const x = positions[v * 3],
      y = positions[v * 3 + 1],
      z = positions[v * 3 + 2];
    model.evalParts(x, y, z, dist);
    let best = 0;
    for (let p = 1; p < 5; p++) if (dist[p] < dist[best]) best = p;
    let sh = 0.3;
    switch (best) {
      case 1:
        _c.set(C.skinWarm).lerp(_c2.set(C.skin), 0.35);
        break;
      case 2:
        _c.set(C.eye);
        sh = 0.15;
        break;
      case 3:
        _c.set(C.brow);
        break;
      case 4: {
        // curl tops catch the light, the gaps between curls stay deep; the trimmed edge stays mid-tone
        const h = shell(x, y, z);
        _c.set(C.hair).multiplyScalar(0.72).lerp(_c2.set(C.hair), smoothstep(-0.004, 0.006, h));
        _c.lerp(_c2.set(C.hairDark), smoothstep(0.002, -0.006, h) * smoothstep(0.012, 0.03, y - 0.1) * 0.6);
        _c.lerp(_c2.set(C.hairLight), smoothstep(0.006, 0.02, h) * 0.75);
        sh = 0.45;
        break;
      }
      default: {
        _c.set(C.skin);
        // warmer nose / cheeks, lips
        const cheek = Math.max(0, 1 - Math.hypot(Math.abs(x) - 0.045, y - 0.135, z + 0.07) / 0.03);
        const nose = Math.max(0, 1 - Math.hypot(x, y - 0.135, z + 0.1) / 0.02);
        _c.lerp(_c2.set(C.skinWarm), Math.min(1, cheek * 0.6 + nose * 0.5));
        const lip = Math.max(0, 1 - Math.hypot(x * 0.55, (y - 0.108) * 2.2, (z + 0.094) * 1.2) / 0.012);
        _c.lerp(_c2.set(C.lip), Math.min(1, lip * 1.4));
      }
    }
    const ao = sdfOcclusion(sdf, x, y, z, normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2], 0.006);
    _c.multiplyScalar(best === 4 ? 0.55 + 0.45 * ao : 0.4 + 0.6 * ao);
    colors.set([_c.r, _c.g, _c.b], v * 3);
    sheen[v] = sh;
  }
  return { positions, normals, colors, sheen, indices };
}

/* ------------------------------------------------------------------ shoes */

function buildShoe(): MeshData {
  const I = new THREE.Matrix4();
  const sole = new SdfPart('sole', 0, I, 0.004).add(sdRoundBox(0, -0.066, -0.05, 0.045, 0.0095, 0.135, 0.009));
  sole.computeBounds(v3(-0.07, -0.09, -0.21), v3(0.07, -0.04, 0.11));
  const upper = new SdfPart('upper', 0, I, 0.016)
    .add(sdEllipsoid(0, -0.03, -0.07, 0.046, 0.04, 0.115))
    .add(sdEllipsoid(0, -0.044, -0.148, 0.041, 0.028, 0.056)) // toe box
    .add(sdEllipsoid(0, -0.034, 0.034, 0.041, 0.042, 0.048)); // heel
  upper.computeBounds(v3(-0.07, -0.09, -0.22), v3(0.07, 0.03, 0.1));
  const sock = new SdfPart('sock', 0, I, 0.01).add(sdRoundCone(0, -0.03, 0.004, 0, 0.075, 0.004, 0.039, 0.036));
  sock.computeBounds(v3(-0.06, -0.08, -0.06), v3(0.06, 0.13, 0.06));
  const model = new SdfModel(
    [sole, upper, sock],
    [
      ['sole', 'upper', 0.006],
      ['upper', 'sock', 0.012],
    ],
  );
  const sdf = (x: number, y: number, z: number) => model.eval(x, y, z);
  const { positions, normals, indices } = meshSdf(sdf, model.bounds(0.012), 0.0055);
  const nv = positions.length / 3;
  const dist = new Float64Array(3);
  const colors = new Float32Array(nv * 3);
  const sheen = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = positions[v * 3],
      y = positions[v * 3 + 1],
      z = positions[v * 3 + 2];
    model.evalParts(x, y, z, dist);
    const best = dist[0] < dist[1] ? (dist[0] < dist[2] ? 0 : 2) : dist[1] < dist[2] ? 1 : 2;
    if (best === 0) _c.set(C.sole);
    else if (best === 2) _c.set(C.sock);
    else {
      _c.set(C.shoe);
      if (z < -0.15 || z > 0.03) _c.lerp(_c2.set(C.shoeDark), 0.6); // toe cap + heel counter
      // two straps across the instep
      if (y > -0.018 && (Math.abs(z + 0.06) < 0.009 || Math.abs(z + 0.105) < 0.009)) _c.set(C.strap);
    }
    const ao = sdfOcclusion(sdf, x, y, z, normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2], 0.006);
    _c.multiplyScalar(0.45 + 0.55 * ao);
    colors.set([_c.r, _c.g, _c.b], v * 3);
    sheen[v] = best === 1 ? 0.35 : 0.2;
  }
  return { positions, normals, colors, sheen, indices };
}

/* ------------------------------------------------------------------ shirt cloth */

/** Walk in from `maxR` along a ray towards `o` until the surface of `f` (outermost hit). */
function traceIn(f: (x: number, y: number, z: number) => number, o: THREE.Vector3, d: THREE.Vector3, maxR: number): number {
  let r = maxR;
  for (let k = 0; k < 160; k++) {
    const dd = f(o.x + d.x * r, o.y + d.y * r, o.z + d.z * r);
    if (dd < 0.0003) return r;
    r -= Math.max(dd, 0.0006);
    if (r <= 0) return 0;
  }
  return r;
}

function gradient(f: (x: number, y: number, z: number) => number, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const e = 0.002;
  out.set(
    f(p.x + e, p.y, p.z) - f(p.x - e, p.y, p.z),
    f(p.x, p.y + e, p.z) - f(p.x, p.y - e, p.z),
    f(p.x, p.y, p.z + e) - f(p.x, p.y, p.z - e),
  );
  return out.normalize();
}

/** Nearest body vertex whose dominant part is allowed (uniform grid lookup). */
class VertexFinder {
  private readonly cell = 0.03;
  private readonly grid = new Map<string, number[]>();
  constructor(
    private readonly pos: Float32Array,
    dominant: Uint8Array,
    allowed: Set<number>,
  ) {
    for (let v = 0; v < dominant.length; v++) {
      if (!allowed.has(dominant[v])) continue;
      const k = this.key(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      const l = this.grid.get(k);
      if (l) l.push(v);
      else this.grid.set(k, [v]);
    }
  }
  private key(x: number, y: number, z: number, di = 0, dj = 0, dk = 0): string {
    return `${Math.floor(x / this.cell) + di},${Math.floor(y / this.cell) + dj},${Math.floor(z / this.cell) + dk}`;
  }
  nearest(x: number, y: number, z: number): number {
    let best = -1;
    let bd = Infinity;
    for (let ring = 1; ring <= 4 && best < 0; ring++)
      for (let i = -ring; i <= ring; i++)
        for (let j = -ring; j <= ring; j++)
          for (let k = -ring; k <= ring; k++) {
            const l = this.grid.get(this.key(x, y, z, i, j, k));
            if (!l) continue;
            for (const v of l) {
              const d = (this.pos[v * 3] - x) ** 2 + (this.pos[v * 3 + 1] - y) ** 2 + (this.pos[v * 3 + 2] - z) ** 2;
              if (d < bd) {
                bd = d;
                best = v;
              }
            }
          }
    return Math.max(0, best);
  }
}

interface TubeSpec {
  cols: number;
  rows: number;
  /** Spare fabric around / along (fraction of the fitted length). */
  slackU: number;
  slackV: number;
  /** Ring centre + ray direction in bind space for (column, row). */
  ray(i: number, j: number, o: THREE.Vector3, d: THREE.Vector3): void;
  /** Surface the ring hugs. */
  surface: (x: number, y: number, z: number) => number;
  gap(i: number, j: number): number;
  maxDist(i: number, j: number): number;
  flutter(i: number, j: number): number;
  /** Wave coordinates [around, along] in metres. */
  wave(i: number, j: number): [number, number];
  finder: VertexFinder;
}

function buildClothPieces(body: BodyAsset, sc: Sculpt, bind: THREE.Matrix4[]): ClothBuild {
  const model = sc.model;
  const P = (n: string) => model.parts.findIndex((p) => p.name === n);
  const torso = model.parts[P('torso')];
  const pelvis = model.parts[P('pelvis')];
  const trunk = (x: number, y: number, z: number) => smin(torso.eval(x, y, z), pelvis.eval(x, y, z), 0.06);
  const tubes: TubeSpec[] = [];

  // lower shirt: from just under the shoulder blades to the hem, all the way round
  {
    const cols = 56,
      rows = 16;
    const yTop = 0.3;
    // the hem lies across the shorts' waistband (like the painting), just above the seat so it drapes flat
    const hem = (th: number) => 0.034 + 0.008 * ((1 - Math.cos(th)) / 2);
    const finder = new VertexFinder(body.mesh.positions, body.dominant, new Set([P('torso'), P('pelvis')]));
    const m = bind[B.torso];
    tubes.push({
      cols,
      rows,
      slackU: 0.14,
      slackV: 0.07,
      ray(i, j, o, d) {
        const th = (i / cols) * Math.PI * 2;
        const y = yTop + (hem(th) - yTop) * (j / (rows - 1));
        o.set(0, y, -0.012).applyMatrix4(m);
        d.set(Math.sin(th), 0, Math.cos(th)).transformDirection(m);
      },
      surface: trunk,
      gap(i, j) {
        // emerge gradually out of the (shirt-coloured) body so there is no visible ledge, then hang looser towards the hem
        if (j === 0) return -0.006;
        if (j === 1) return 0.0015;
        const f = j / (rows - 1);
        const front = (1 - Math.cos((i / cols) * Math.PI * 2)) / 2;
        return 0.004 + 0.012 * Math.pow(f, 0.8) + 0.008 * front * f;
      },
      maxDist(i, j) {
        if (j === 0) return 0;
        if (j === 1) return 0.004;
        const f = j / (rows - 1);
        const front = (1 - Math.cos((i / cols) * Math.PI * 2)) / 2;
        return 0.003 + 0.068 * Math.pow(f, 1.5) * (1 - 0.35 * front);
      },
      flutter(i, j) {
        const front = (1 - Math.cos((i / cols) * Math.PI * 2)) / 2;
        return Math.pow(j / (rows - 1), 1.1) * (1 - 0.6 * front);
      },
      wave(i, j) {
        return [(i / cols) * 0.95, (j / (rows - 1)) * 0.27];
      },
      finder,
    });
  }
  // short, loose sleeves
  for (const side of ['L', 'R'] as const) {
    const bone = B[`upperArm${side}`];
    const arm = model.parts[P(`upperArm${side}`)];
    const finder = new VertexFinder(body.mesh.positions, body.dominant, new Set([P(`upperArm${side}`), P('torso')]));
    const m = bind[bone];
    const cols = 24,
      rows = 6;
    const y0 = -0.03,
      y1 = 0.142;
    tubes.push({
      cols,
      rows,
      slackU: 0.08,
      slackV: 0.03,
      ray(i, j, o, d) {
        const th = (i / cols) * Math.PI * 2;
        o.set(0, y0 + (y1 - y0) * (j / (rows - 1)), 0).applyMatrix4(m);
        d.set(Math.cos(th), 0, Math.sin(th)).transformDirection(m);
      },
      surface: (x, y, z) => arm.eval(x, y, z),
      gap(_i, j) {
        return j === 0 ? -0.008 : 0.004 + 0.015 * Math.pow(j / (rows - 1), 0.8);
      },
      maxDist(_i, j) {
        return j === 0 ? 0 : 0.004 + 0.028 * Math.pow(j / (rows - 1), 1.3);
      },
      flutter(_i, j) {
        return 0.55 * (j / (rows - 1));
      },
      wave(i, j) {
        return [(i / cols) * 0.36, (j / (rows - 1)) * 0.17];
      },
      finder,
    });
  }

  let n = 0;
  for (const t of tubes) n += t.cols * t.rows;
  const rest = new Float32Array(n * 3);
  const restNormal = new Float32Array(n * 3);
  const backstop = new Float32Array(n);
  const normalBlend = new Float32Array(n);
  const bones = new Uint8Array(n * 4);
  const weights = new Float32Array(n * 4);
  const maxDist = new Float32Array(n);
  const wave = new Float32Array(n * 2);
  const flutter = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  const con = { edges: [] as number[], len: [] as number[], stretch: [] as number[], compress: [] as number[] };
  const tris: number[] = [];
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const shirt = new THREE.Color(C.shirt);
  const full = (x: number, y: number, z: number) => model.eval(x, y, z);
  let base = 0;
  for (const t of tubes) {
    const centres: THREE.Vector3[] = [];
    for (let j = 0; j < t.rows; j++) {
      const cj = new THREE.Vector3();
      for (let i = 0; i < t.cols; i++) {
        t.ray(i, j, o, d);
        const r = traceIn(t.surface, o, d, 0.4);
        p.copy(o).addScaledVector(d, r);
        gradient(t.surface, p, nrm);
        if (nrm.dot(d) < 0.2) nrm.copy(d);
        // same occlusion term the body's vertex colours use, so the seam where the shirt leaves the body is invisible
        const ao = sdfOcclusion(full, p.x, p.y, p.z, nrm.x, nrm.y, nrm.z, 0.013);
        const gap = t.gap(i, j);
        p.addScaledVector(nrm, gap);
        const id = base + j * t.cols + i;
        rest.set([p.x, p.y, p.z], id * 3);
        restNormal.set([nrm.x, nrm.y, nrm.z], id * 3);
        maxDist[id] = t.maxDist(i, j);
        // free particles never sink behind the skin (keep at least a few mm of air under the fabric)
        backstop[id] = maxDist[id] > 0 ? -(gap - 0.6 * Math.min(Math.max(gap, 0), 0.005)) : NaN;
        normalBlend[id] = j <= 1 ? 1 : j === 2 ? 0.5 : 0;
        cj.add(o);
        const v = t.finder.nearest(p.x, p.y, p.z);
        for (let k = 0; k < 4; k++) {
          bones[id * 4 + k] = body.mesh.skinIndex[v * 4 + k];
          weights[id * 4 + k] = body.mesh.skinWeight[v * 4 + k];
        }
        flutter[id] = t.flutter(i, j);
        wave.set(t.wave(i, j), id * 2);
        // fabric tone: body-matched occlusion at the seam, faint mottling lower down, darker turned hem
        const seam = smoothstep(4, 1, j);
        const aoK = THREE.MathUtils.lerp(0.62 + 0.38 * ao, 0.45 + 0.55 * ao, seam);
        const hemK = j === t.rows - 1 ? 0.8 : j === t.rows - 2 ? 0.93 : 1;
        const mott = 1 - (1 - seam) * (0.02 - 0.02 * Math.sin(i * 1.7 + j * 2.3));
        _c.copy(shirt).multiplyScalar(aoK * hemK * mott);
        colors.set([_c.r, _c.g, _c.b], id * 3);
      }
      centres.push(cj.multiplyScalar(1 / t.cols));
    }
    ringGridConstraints(rest, t.cols, t.rows, base, con, t.slackU, t.slackV);
    ringGridTriangles(rest, t.cols, t.rows, base, (j) => centres[j], tris);
    base += t.cols * t.rows;
  }

  // collision capsules (bind space) sized to the inscribed radius of the body there
  const colliders: ClothCollider[] = [];
  const addCol = (bone: number, frame: THREE.Matrix4, a: THREE.Vector3, b: THREE.Vector3, f: (x: number, y: number, z: number) => number) => {
    const A = a.clone().applyMatrix4(frame);
    const Bp = b.clone().applyMatrix4(frame);
    let r = Infinity;
    for (let k = 0; k <= 8; k++) {
      const q = A.clone().lerp(Bp, k / 8);
      r = Math.min(r, -f(q.x, q.y, q.z));
    }
    colliders.push({ bone, a: A, b: Bp, r: Math.max(0.02, r) + 0.005 });
  };
  const mT = bind[B.torso];
  const mP = bind[B.pelvis];
  // the backstop keeps every particle off its own patch of skin; capsules stop the hem sinking into the
  // seat / hips below it and other limbs poking through
  addCol(B.torso, mT, v3(-0.066, 0.1, 0.012), v3(-0.066, 0.37, 0.02), trunk);
  addCol(B.torso, mT, v3(0.066, 0.1, 0.012), v3(0.066, 0.37, 0.02), trunk);
  addCol(B.pelvis, mP, v3(-0.05, -0.035, 0.04), v3(0.05, -0.035, 0.04), trunk);
  addCol(B.pelvis, mP, v3(-0.085, 0.03, 0.0), v3(0.085, 0.03, 0.0), trunk);
  for (const side of ['L', 'R'] as const) {
    const th = model.parts[P(`thigh${side}`)];
    addCol(B[`thigh${side}`], bind[B[`thigh${side}`]], v3(0, 0.06, 0), v3(0, 0.36, 0), (x, y, z) => th.eval(x, y, z));
    const ua = model.parts[P(`upperArm${side}`)];
    addCol(B[`upperArm${side}`], bind[B[`upperArm${side}`]], v3(0, 0.02, 0), v3(0, 0.22, 0), (x, y, z) => ua.eval(x, y, z));
  }

  return {
    rest,
    bones,
    weights,
    maxDist,
    restNormal,
    backstop,
    normalBlend,
    wave,
    flutter,
    edges: Uint32Array.from(con.edges),
    restLen: Float32Array.from(con.len),
    stretch: Float32Array.from(con.stretch),
    compress: Float32Array.from(con.compress),
    index: Uint32Array.from(tris),
    colors,
    colliders,
  };
}

/* ------------------------------------------------------------------ materials */

const SHEEN_KEY = '|riderSheen';

/** Matte painterly Lambert plus a sky-tinted grazing sheen (satin shorts, gloves, hair). */
function sheenMaterial(doubleSided: boolean): THREE.MeshLambertMaterial {
  const m = paintMaterial({ vertexColors: true, side: doubleSided ? THREE.DoubleSide : THREE.FrontSide });
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    prev.call(m, shader, r);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSheen;\nvarying float vSheen;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSheen = aSheen;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSheen;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\n${doubleSided ? 'if (!gl_FrontFacing) diffuseColor.rgb *= 0.55;' : ''}`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          vec3 Vd = normalize(vViewPosition);
          float ndv = clamp(dot(normal, Vd), 0.0, 1.0);
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float sky = 0.35 + 0.65 * clamp(dot(normal, upV) * 0.5 + 0.5, 0.0, 1.0);
          outgoingLight += vSheen * pow(1.0 - ndv, 3.0) * sky * vec3(0.3, 0.36, 0.56) * 0.5;
        }
        #include <opaque_fragment>`,
      );
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + SHEEN_KEY + (doubleSided ? '2' : '1');
  return m;
}

/* ------------------------------------------------------------------ assets (built once) */

/** Everything the rider needs, as plain transferable data (generated on a worker when possible). */
export interface HumanData {
  /** Bind matrices of the 15 bones, column-major. */
  bind: Float32Array;
  body: MeshData;
  head: MeshData;
  shoe: MeshData;
  cloth: ClothBuild;
}

/** Sculpt, mesh, skin and dress the rider. Pure computation: safe to run in a worker. */
export function generateHumanData(): HumanData {
  const t0 = performance.now();
  const bind = computeBindPose();
  const sc = sculptBody(bind);
  const body = buildBody(sc);
  const t1 = performance.now();
  const head = buildHead();
  const shoe = buildShoe();
  const t2 = performance.now();
  const cloth = buildClothPieces(body, sc, bind);
  const t3 = performance.now();
  console.debug(
    `[rider] body ${body.mesh.positions.length / 3} verts ${(t1 - t0).toFixed(0)} ms, head+shoes ${(t2 - t1).toFixed(0)} ms, cloth ${cloth.rest.length / 3} particles ${(t3 - t2).toFixed(0)} ms`,
  );
  const bindArr = new Float32Array(bind.length * 16);
  bind.forEach((m, i) => bindArr.set(m.elements, i * 16));
  return { bind: bindArr, body: body.mesh, head, shoe, cloth };
}

/** Buffers to transfer when posting `HumanData` from a worker. */
export function humanDataTransferables(d: HumanData): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (o: object) => {
    for (const v of Object.values(o)) if (ArrayBuffer.isView(v)) out.add(v.buffer as ArrayBuffer);
  };
  add(d);
  add(d.body);
  add(d.head);
  add(d.shoe);
  add(d.cloth);
  return [...out];
}

interface HumanAssets {
  bind: THREE.Matrix4[];
  body: THREE.BufferGeometry;
  /** Shirt share of each body vertex's colour (see `MeshData.shirt`). */
  bodyShirt: Float32Array | null;
  head: THREE.BufferGeometry;
  shoe: THREE.BufferGeometry;
  cloth: ClothBuild;
  skinMat: THREE.MeshLambertMaterial;
  clothMat: THREE.MeshLambertMaterial;
}

function toGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
  g.setAttribute('aSheen', new THREE.BufferAttribute(m.sheen, 1));
  if (m.skinIndex && m.skinWeight) {
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(m.skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(m.skinWeight, 4));
  }
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  return g;
}

function assetsFrom(d: HumanData): HumanAssets {
  const bind: THREE.Matrix4[] = [];
  for (let i = 0; i < d.bind.length / 16; i++) bind.push(new THREE.Matrix4().fromArray(d.bind, i * 16));
  // colliders arrive as plain objects from a worker
  const cloth: ClothBuild = {
    ...d.cloth,
    colliders: d.cloth.colliders.map((c) => ({ bone: c.bone, r: c.r, a: new THREE.Vector3(c.a.x, c.a.y, c.a.z), b: new THREE.Vector3(c.b.x, c.b.y, c.b.z) })),
  };
  return {
    bind,
    body: toGeometry(d.body),
    bodyShirt: d.body.shirt ?? null,
    head: toGeometry(d.head),
    shoe: toGeometry(d.shoe),
    cloth,
    skinMat: sheenMaterial(false),
    clothMat: sheenMaterial(true),
  };
}

let _assets: HumanAssets | null = null;
let _pending: Promise<void> | null = null;

function humanAssets(): HumanAssets {
  return (_assets ??= assetsFrom(generateHumanData()));
}

/**
 * Generate the rider's meshes on a worker so it overlaps with world building. Resolves when ready
 * (or when the worker is unavailable, in which case the first rider is generated synchronously).
 */
export function preloadHumanRider(): Promise<void> {
  if (_assets) return Promise.resolve();
  if (_pending) return _pending;
  _pending = new Promise<void>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./human.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve();
      return;
    }
    const t0 = performance.now();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve();
    };
    // never let a stuck worker block loading: the rider is then built on the main thread on first use
    const timer = setTimeout(() => {
      console.warn('[rider] worker timed out');
      done();
    }, 20000);
    worker.onmessage = (e: MessageEvent<HumanData>) => {
      try {
        _assets ??= assetsFrom(e.data);
        console.debug(`[rider] meshes ready from worker in ${(performance.now() - t0).toFixed(0)} ms`);
      } catch (err) {
        console.warn('[rider] worker data rejected', err);
      }
      done();
    };
    worker.onerror = (e) => {
      console.warn('[rider] worker failed, generating on the main thread', e.message);
      done();
    };
    worker.postMessage('generate');
  });
  return _pending;
}

/* ------------------------------------------------------------------ rider */

let _mouth: { geo: THREE.BufferGeometry; mat: THREE.MeshLambertMaterial } | null = null;

/** The open mouth (a dark opening under the top teeth), built around the upper lip so it opens by scaling down. */
function mouth(): NonNullable<typeof _mouth> {
  return (_mouth ??= {
    geo: merge([
      ellipsoid(0.017, 0.0105, 0.009, v3(0, -0.004, 0.002), '#3a1714', 14, 10),
      ellipsoid(0.012, 0.0032, 0.0055, v3(0, 0.0025, -0.002), '#e9e2d6', 12, 6),
    ]),
    mat: paintMaterial({ vertexColors: true }),
  });
}

const _jerseys = new Map<string, { body: THREE.BufferGeometry; cloth: ClothBuild }>();

/**
 * The body and shirt cloth in a jersey colour, built once per colour. Only the shirt's share of each colour changes,
 * so occlusion, seams and the hem stay exactly as sculpted.
 */
function jersey(A: HumanAssets, color: string): { body: THREE.BufferGeometry; cloth: ClothBuild } {
  const made = _jerseys.get(color);
  if (made) return made;
  const from = new THREE.Color(C.shirt);
  const to = new THREE.Color(color);
  const base = A.body.getAttribute('color');
  const share = A.bodyShirt;
  const bodyColors = new Float32Array(base.count * 3);
  for (let i = 0; i < base.count; i++) {
    const k = share ? share[i] : 0;
    bodyColors[i * 3] = base.getX(i) + k * (to.r - from.r);
    bodyColors[i * 3 + 1] = base.getY(i) + k * (to.g - from.g);
    bodyColors[i * 3 + 2] = base.getZ(i) + k * (to.b - from.b);
  }
  const body = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(A.body.attributes)) body.setAttribute(name, attr);
  body.setIndex(A.body.index);
  body.setAttribute('color', new THREE.BufferAttribute(bodyColors, 3));
  body.boundingSphere = A.body.boundingSphere?.clone() ?? null;
  // the cloth is all shirt: each particle's colour is the shirt colour times its shading
  const sum = from.r + from.g + from.b;
  const clothColors = new Float32Array(A.cloth.colors.length);
  for (let i = 0; i < clothColors.length; i += 3) {
    const k = (A.cloth.colors[i] + A.cloth.colors[i + 1] + A.cloth.colors[i + 2]) / sum;
    clothColors[i] = to.r * k;
    clothColors[i + 1] = to.g * k;
    clothColors[i + 2] = to.b * k;
  }
  const dressed = { body, cloth: { ...A.cloth, colors: clothColors } };
  _jerseys.set(color, dressed);
  return dressed;
}

/** The human rider from the reference video, in the painting's grey T-shirt or a shop jersey (`colors.shirt`). */
export function createHumanRider(colors?: RiderColors): RiderRig {
  const A = humanAssets();
  const shirt = outfit(RIDER_COLORS, colors).palette.shirt;
  const look = shirt === C.shirt ? { body: A.body, cloth: A.cloth } : jersey(A, shirt);
  const bones = BONES.map((name) => {
    const b = new THREE.Bone();
    b.name = name;
    return b;
  });
  const body = bodyOf(bones);
  const rig = new HumanoidRig(RIDER_SPEC, body);
  // bind: bones at the bind pose while the rig root is still at the origin
  const one = new THREE.Vector3();
  bones.forEach((b, i) => A.bind[i].decompose(b.position, b.quaternion, one));
  bones.forEach((b) => b.scale.set(1, 1, 1));
  rig.root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  const skin = new THREE.SkinnedMesh(look.body, A.skinMat);
  skin.name = 'body';
  skin.frustumCulled = false;
  rig.root.add(skin);
  skin.bind(skeleton, new THREE.Matrix4());

  const head = new THREE.Mesh(A.head, A.skinMat);
  head.name = 'head';
  bones[B.head].add(head);
  // a whoop, a shout, a gasp: the mouth opens from the upper lip
  const M = mouth();
  const shout = new THREE.Mesh(M.geo, M.mat);
  shout.name = 'mouth';
  shout.position.set(0, 0.11, -0.095);
  shout.visible = false;
  bones[B.head].add(shout);
  for (const f of [B.footL, B.footR]) {
    const shoe = new THREE.Mesh(A.shoe, A.skinMat);
    shoe.name = 'shoe';
    bones[f].add(shoe);
  }

  const cloth = new Cloth(look.cloth, A.bind, A.clothMat);
  rig.root.add(cloth.mesh);
  enableShadows(rig.root);

  const wind = new THREE.Vector3();
  body.tick = (time, dt, pose, face) => {
    shout.visible = face.mouth > 0.04;
    shout.scale.set(0.85 + 0.3 * face.joy, face.mouth, 1);
    for (const b of bones) b.updateMatrix();
    rig.root.updateWorldMatrix(true, false);
    const mw = rig.root.matrixWorld;
    if (pose.velocity) wind.copy(pose.velocity).negate();
    else wind.set(0, 0, -1).transformDirection(mw).multiplyScalar(-(pose.speed || 0));
    cloth.update(dt, mw, bones, wind, pose.speed || 0, time);
  };
  return rig;
}
