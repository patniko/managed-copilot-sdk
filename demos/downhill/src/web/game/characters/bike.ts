import * as THREE from 'three';
import { BIKE, type BikeAnchors, type BikeVisual, type BikeVisualState } from '../rider/types';
import { glossMaterial, paintMaterial } from '../../render/globals';
import { box, capsule, clamp01, ellipsoid, enableShadows, merge, place, tint, tintBy, tube, v3 } from './util';

/** Colour scheme + build options of a bike. */
export interface BikeStyle {
  frame: THREE.ColorRepresentation;
  /** Rear triangle (defaults to frame colour). */
  swingarm?: THREE.ColorRepresentation;
  /** Decal bands on the down tube / top tube. */
  downTubeBand?: THREE.ColorRepresentation;
  topTubeBand?: THREE.ColorRepresentation;
  /** Small accent parts: seat collar, headset, axle caps, pivot caps. */
  accent: THREE.ColorRepresentation;
  forkLower: THREE.ColorRepresentation;
  forkCrown: THREE.ColorRepresentation;
  stanchion: THREE.ColorRepresentation;
  rim: THREE.ColorRepresentation;
  rimStripe?: THREE.ColorRepresentation;
  hub: THREE.ColorRepresentation;
  spoke: THREE.ColorRepresentation;
  tyre: THREE.ColorRepresentation;
  saddle: THREE.ColorRepresentation;
  saddleAccent?: THREE.ColorRepresentation;
  cockpit: THREE.ColorRepresentation;
  grip: THREE.ColorRepresentation;
  crank: THREE.ColorRepresentation;
  chainring: THREE.ColorRepresentation;
  pedal: THREE.ColorRepresentation;
  shockBody: THREE.ColorRepresentation;
  spring: THREE.ColorRepresentation;
  /** Rigid rear triangle, no shock: fork sag pitches the frame about the rear axle. */
  hardtail?: boolean;
  /** Slim, almost slick tyres instead of knobby downhill rubber. */
  slimTyres?: boolean;
  /** Frame / fork tube thickness multiplier (default 1). */
  tubeScale?: number;
  /** Road / gravel drop handlebar with brake hoods (the rider holds the hoods). */
  dropBars?: boolean;
}

/* ---------------------------------------------------------------- frame layout */

/** Steering axis direction (pointing up, tilted back by the head angle). */
export const STEER_AXIS = new THREE.Vector3(0, Math.cos(BIKE.headAngle), Math.sin(BIKE.headAngle));
const FA = BIKE.frontAxle;
const RA = BIKE.rearAxle;
const BB = BIKE.bottomBracket;
const SADDLE = BIKE.saddle;
const SEAT_DIR = new THREE.Vector3().subVectors(SADDLE, BB).normalize();
/** Maximum visual sag along the steering axis for suspension = 1. */
const SAG_MAX = 0.085;

const axisPt = (d: number, x = 0): THREE.Vector3 => FA.clone().addScaledVector(STEER_AXIS, d).setX(x);
const seatPt = (d: number): THREE.Vector3 => BB.clone().addScaledVector(SEAT_DIR, d);
/** Forward direction perpendicular to the steering axis (in the bike plane). */
const AXIS_FWD = new THREE.Vector3(0, STEER_AXIS.z, -STEER_AXIS.y);

const HT_BOT = axisPt(0.585);
const HT_TOP = axisPt(0.705);
const DT_FRONT = axisPt(0.6).add(v3(0, -0.004, 0.012));
const DT_REAR = v3(0, 0.338, 0.098);
const TT_FRONT = axisPt(0.68).add(v3(0, 0, 0.01));
const TT_REAR = seatPt(0.52);
const ST_TOP = seatPt(0.585);
/** Main swingarm pivot (frame side). */
const PIVOT = v3(0, 0.425, 0.128);
/** Upper swingarm / shock eyelet. */
const Q_MOUNT = v3(0, 0.655, 0.198);
/** Shock frame mount on top of the down tube. */
const F_MOUNT = DT_REAR.clone().lerp(DT_FRONT, 0.44).add(v3(0, 0.036, 0.012));
const SHOCK_LEN = F_MOUNT.distanceTo(Q_MOUNT);
const BAR = BIKE.bar;
const GRIP = BIKE.gripOffset;
/** Drop bar: tops sit lower and a touch further back than the riser bar (road stem). */
const DROP_TOP = v3(0, BAR.y - 0.05, BAR.z + 0.012);
/** Where the palm rests on top of each brake hood (x = +/- this.x). */
const HOOD_GRIP = v3(0.205, DROP_TOP.y + 0.034, DROP_TOP.z - 0.082);

/** Rest-pose grip anchor (palm centre) of the right hand for a style. */
export function gripRest(st: Pick<BikeStyle, 'dropBars'>): THREE.Vector3 {
  return st.dropBars ? HOOD_GRIP.clone() : v3(GRIP, BAR.y, BAR.z);
}
/** Hardtail: horizontal distance rear axle -> head tube, used to turn fork sag into frame pitch. */
const HT_LEVER = RA.z - HT_BOT.z;

/* ---------------------------------------------------------------- materials */

let _gloss: THREE.MeshStandardMaterial | null = null;
let _matte: THREE.MeshLambertMaterial | null = null;
function bikeGloss(): THREE.MeshStandardMaterial {
  return (_gloss ??= glossMaterial(0xffffff, 0.34, 0.12, { vertexColors: true }));
}
function bikeMatte(): THREE.MeshLambertMaterial {
  return (_matte ??= paintMaterial({ vertexColors: true }));
}

/* ---------------------------------------------------------------- geometry builders */

class HelixCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private radius: number,
    private y0: number,
    private y1: number,
    private turns: number,
  ) {
    super();
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.radius, this.y0 + (this.y1 - this.y0) * t, Math.sin(a) * this.radius);
  }
}

interface WheelGeometries {
  /** Tyre, rim, hub and rotor (opaque). */
  wheel: THREE.BufferGeometry;
  /** Spokes (fade out at speed). */
  spokes: THREE.BufferGeometry;
  /** Translucent disc standing in for motion-blurred spokes (fades in at speed). */
  blur: THREE.BufferGeometry;
}

function wheelGeometry(st: BikeStyle): WheelGeometries {
  const parts: THREE.BufferGeometry[] = [];
  const spokeParts: THREE.BufferGeometry[] = [];
  const toX = new THREE.Euler(0, Math.PI / 2, 0);
  const R = BIKE.wheelRadius;
  const slim = st.slimTyres === true;
  // tyre carcass: outer edge at the contract wheel radius
  const tr = slim ? 0.021 : 0.031;
  const tyreR = slim ? R - tr : 0.326;
  parts.push(place(tint(new THREE.TorusGeometry(tyreR, tr, 7, 44), st.tyre), v3(), toX, v3(1, 1, slim ? 1.12 : 1.08)));
  if (!slim) {
    // knobs: alternating shoulder pair / centre knob
    const knobs = 28;
    for (let i = 0; i < knobs; i++) {
      const a = (i / knobs) * Math.PI * 2;
      const rows = i % 2 === 0 ? [-0.019, 0.019] : [0];
      for (const x of rows) {
        const r = 0.352;
        parts.push(box(0.017, 0.015, 0.026, v3(x, Math.cos(a) * r, Math.sin(a) * r), st.tyre, new THREE.Euler(a, 0, 0)));
      }
    }
  }
  // rim (side walls optionally striped)
  const rimR = tyreR - tr * 0.95;
  {
    const rim = place(new THREE.TorusGeometry(rimR, 0.012, 5, 40), v3(), toX, v3(1, 1, slim ? 1.3 : 1.6));
    const base = new THREE.Color(st.rim);
    const stripe = new THREE.Color(st.rimStripe ?? st.rim);
    parts.push(
      tintBy(rim, (x, y, z, out) => {
        out.copy(Math.abs(x) > 0.011 && Math.hypot(y, z) > rimR - 0.005 ? stripe : base);
      }),
    );
  }
  // hub + flanges
  parts.push(tube(v3(-0.058, 0, 0), v3(0.058, 0, 0), 0.02, 0.02, st.hub, 10));
  for (const x of [-0.032, 0.032]) parts.push(tube(v3(x - 0.004, 0, 0), v3(x + 0.004, 0, 0), 0.033, 0.033, st.hub, 12));
  // spokes (crossed lacing)
  const spokes = 20;
  const spokeR = rimR - 0.009;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const side = i % 2 === 0 ? 1 : -1;
    const ha = a + (i % 4 < 2 ? 0.32 : -0.32);
    const hub = v3(side * 0.031, Math.cos(ha) * 0.03, Math.sin(ha) * 0.03);
    const rim = v3(side * 0.004, Math.cos(a) * spokeR, Math.sin(a) * spokeR);
    spokeParts.push(tube(hub, rim, 0.0028, 0.0028, st.spoke, 3, true));
  }
  // disc rotor (left side) + spider
  parts.push(tube(v3(-0.051, 0, 0), v3(-0.048, 0, 0), 0.09, 0.09, '#b9bec6', 24));
  parts.push(tube(v3(-0.053, 0, 0), v3(-0.046, 0, 0), 0.045, 0.045, '#3a3d42', 8));
  // blurred spokes: denser towards the hub where the spokes converge
  const disc = new THREE.RingGeometry(0.034, spokeR, 48, 3);
  disc.rotateY(Math.PI / 2);
  const sc = new THREE.Color(st.spoke);
  tintBy(disc, (_x, y, z, out) => {
    out.copy(sc).multiplyScalar(0.8 + 0.4 * (Math.hypot(y, z) / spokeR));
  });
  return { wheel: merge(parts), spokes: merge(spokeParts), blur: disc };
}

function saddleGeometry(st: BikeStyle): THREE.BufferGeometry[] {
  const s = new THREE.Shape();
  s.moveTo(0, 0.15);
  s.bezierCurveTo(0.024, 0.15, 0.024, 0.06, 0.034, 0.0);
  s.bezierCurveTo(0.048, -0.05, 0.074, -0.068, 0.072, -0.1);
  s.bezierCurveTo(0.07, -0.128, 0.03, -0.126, 0, -0.12);
  s.bezierCurveTo(-0.03, -0.126, -0.07, -0.128, -0.072, -0.1);
  s.bezierCurveTo(-0.074, -0.068, -0.048, -0.05, -0.034, 0.0);
  s.bezierCurveTo(-0.024, 0.06, -0.024, 0.15, 0, 0.15);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.022,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.01,
    bevelSegments: 2,
    curveSegments: 5,
  });
  g.rotateX(-Math.PI / 2);
  // top of the extrusion is at y = 0.034
  g.translate(0, SADDLE.y - 0.034, SADDLE.z);
  tint(g, st.saddle);
  const parts: THREE.BufferGeometry[] = [g];
  if (st.saddleAccent !== undefined) {
    parts.push(box(0.15, 0.012, 0.03, v3(0, SADDLE.y - 0.03, SADDLE.z + 0.1), st.saddleAccent));
  }
  // rails
  for (const x of [-0.022, 0.022]) {
    parts.push(tube(v3(x, SADDLE.y - 0.045, SADDLE.z - 0.08), v3(x, SADDLE.y - 0.045, SADDLE.z + 0.08), 0.004, 0.004, '#2a2b2f', 5));
  }
  return parts;
}

/** Cassette, derailleur, chain and rear caliper (lives on the swingarm, or the frame for hardtails). */
function drivetrainRear(matte: THREE.BufferGeometry[]): void {
  matte.push(tube(RA.clone().setX(0.034), RA.clone().setX(0.064), 0.052, 0.022, '#9ea4ad', 18));
  matte.push(box(0.016, 0.075, 0.03, v3(0.078, RA.y - 0.07, RA.z + 0.02), '#25272b', new THREE.Euler(0.25, 0, 0)));
  matte.push(tube(v3(0.07, RA.y - 0.105, RA.z + 0.03), v3(0.086, RA.y - 0.105, RA.z + 0.03), 0.014, 0.014, '#3a3c41', 8));
  const ringR = 0.074;
  matte.push(tube(v3(0.05, BB.y + ringR, BB.z), v3(0.05, RA.y + 0.045, RA.z), 0.0055, 0.0055, '#2b2c30', 4));
  matte.push(tube(v3(0.05, BB.y - ringR, BB.z), v3(0.075, RA.y - 0.105, RA.z + 0.03), 0.0055, 0.0055, '#2b2c30', 4));
  matte.push(box(0.022, 0.05, 0.035, RA.clone().add(v3(-0.062, 0.07, -0.045)), '#2c2e33', new THREE.Euler(-0.5, 0, 0)));
}

/** Static (merged) geometry of one bike style; shared by every bike built with that style object. */
interface BikeGeometries {
  wheel: WheelGeometries;
  forkLower: THREE.BufferGeometry;
  forkUpperGloss: THREE.BufferGeometry;
  forkUpperMatte: THREE.BufferGeometry;
  frameGloss: THREE.BufferGeometry;
  frameMatte: THREE.BufferGeometry;
  cranks: THREE.BufferGeometry;
  pedal: THREE.BufferGeometry;
  swingGloss: THREE.BufferGeometry | null;
  swingMatte: THREE.BufferGeometry | null;
  shock: THREE.BufferGeometry | null;
}

const geometryCache = new WeakMap<BikeStyle, BikeGeometries>();
function bikeGeometries(st: BikeStyle): BikeGeometries {
  let g = geometryCache.get(st);
  if (!g) {
    g = buildBikeGeometries(st);
    geometryCache.set(st, g);
  }
  return g;
}

/** Road / gravel drop bar: taped tops, forward ramps into the brake hoods, deep drops curling back. */
function dropBarCockpit(st: BikeStyle, out: THREE.BufferGeometry[]): void {
  const T = DROP_TOP;
  out.push(capsule(axisPt(0.753), v3(0, T.y, T.z + 0.004), 0.018, st.cockpit, 8, 2)); // stem
  out.push(tube(v3(-0.034, T.y, T.z), v3(0.034, T.y, T.z), 0.0195, 0.0195, st.cockpit, 12)); // clamp
  const side = (s: number) => [
    v3(s * 0.06, T.y, T.z),
    v3(s * 0.15, T.y, T.z + 0.002),
    v3(s * 0.194, T.y + 0.002, T.z - 0.02),
    v3(s * 0.206, T.y + 0.001, T.z - 0.062),
    v3(s * 0.21, T.y - 0.032, T.z - 0.09),
    v3(s * 0.213, T.y - 0.084, T.z - 0.074),
    v3(s * 0.214, T.y - 0.118, T.z - 0.02),
    v3(s * 0.215, T.y - 0.126, T.z + 0.045),
  ];
  const pts = [...side(-1).reverse(), ...side(1)];
  out.push(tint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), 110, 0.0125, 8, false), st.grip));
  for (const s of [-1, 1]) {
    // lever housing ("hood") on the ramp, rising to a horn at the front
    out.push(capsule(v3(s * 0.206, T.y + 0.006, T.z - 0.05), v3(s * 0.208, T.y + 0.018, T.z - 0.11), 0.0165, '#1e1f22', 8, 3));
    out.push(ellipsoid(0.0135, 0.017, 0.015, v3(s * 0.208, T.y + 0.028, T.z - 0.117), '#1e1f22', 8, 6));
    // brake lever blade following the drop
    out.push(capsule(v3(s * 0.208, T.y + 0.004, T.z - 0.121), v3(s * 0.211, T.y - 0.056, T.z - 0.113), 0.0065, '#2b2d31', 5, 2));
    out.push(capsule(v3(s * 0.211, T.y - 0.056, T.z - 0.113), v3(s * 0.213, T.y - 0.1, T.z - 0.083), 0.006, '#2b2d31', 5, 2));
    out.push(tube(v3(s * 0.215, T.y - 0.126, T.z + 0.04), v3(s * 0.215, T.y - 0.126, T.z + 0.053), 0.0135, 0.0135, '#2a2c30', 8));
  }
}

function buildBikeGeometries(st: BikeStyle): BikeGeometries {
  const swing = st.swingarm ?? st.frame;
  const ts = st.tubeScale ?? 1;
  const hardtail = st.hardtail === true;

  /* ---------- wheels */
  const wheel = wheelGeometry(st);

  /* ---------- front lower (fork lowers, stays with the wheel) */
  const lowers: THREE.BufferGeometry[] = [];
  const legX = 0.075;
  for (const x of [-legX, legX]) {
    lowers.push(capsule(axisPt(-0.025, x), axisPt(0.395, x), 0.024 * ts, st.forkLower, 12, 2));
    lowers.push(tube(axisPt(0.37, x), axisPt(0.405, x), 0.0265 * ts, 0.0265 * ts, st.forkCrown, 12)); // seal
    lowers.push(tube(v3(x - 0.02 * Math.sign(x), FA.y, FA.z), v3(x + 0.016 * Math.sign(x), FA.y, FA.z), 0.017, 0.017, st.accent, 10));
  }
  // arch over the tyre, in front of the steering axis
  {
    const arch = new THREE.TorusGeometry(legX, 0.013 * ts, 6, 12, Math.PI);
    arch.scale(1, 0.5, 1);
    tint(arch, st.forkLower);
    place(arch, axisPt(0.37).addScaledVector(AXIS_FWD, 0.03), new THREE.Quaternion().setFromUnitVectors(_Y, STEER_AXIS));
    lowers.push(arch);
  }
  // front brake caliper on the left leg
  lowers.push(box(0.022, 0.05, 0.035, FA.clone().add(v3(-0.062, 0.06, 0.06)), '#2c2e33', new THREE.Euler(0.6, 0, 0)));

  /* ---------- front upper (crown, stanchions, stem, bars) */
  const upperGloss: THREE.BufferGeometry[] = [];
  const upperMatte: THREE.BufferGeometry[] = [];
  for (const x of [-legX, legX]) {
    upperGloss.push(tube(axisPt(0.29, x), axisPt(0.56, x), 0.0182 * ts, 0.0182 * ts, st.stanchion, 12));
  }
  {
    const crown = new THREE.BoxGeometry(0.205, 0.038, 0.062);
    tint(crown, st.forkCrown);
    place(crown, axisPt(0.555), new THREE.Quaternion().setFromUnitVectors(_Y, STEER_AXIS));
    upperGloss.push(crown);
    upperGloss.push(ellipsoid(0.03, 0.022, 0.034, axisPt(0.555, -0.103), st.forkCrown, 10, 8));
    upperGloss.push(ellipsoid(0.03, 0.022, 0.034, axisPt(0.555, 0.103), st.forkCrown, 10, 8));
  }
  upperMatte.push(tube(axisPt(0.54), axisPt(0.79), 0.0165, 0.0165, '#2a2c30', 10)); // steerer
  upperMatte.push(tube(axisPt(0.705), axisPt(0.722), 0.03, 0.03, st.cockpit, 14)); // spacer
  upperMatte.push(tube(axisPt(0.722), axisPt(0.785), 0.024, 0.024, st.cockpit, 14)); // stem clamp
  if (st.dropBars) {
    dropBarCockpit(st, upperMatte);
  } else {
    upperMatte.push(capsule(axisPt(0.753), v3(0, BAR.y, BAR.z + 0.004), 0.019, st.cockpit, 8, 2));
    // handlebar: slight rise & sweep
    const pts = [
      v3(-0.43, BAR.y + 0.004, BAR.z + 0.008),
      v3(-0.27, BAR.y + 0.004, BAR.z + 0.006),
      v3(-0.12, BAR.y - 0.012, BAR.z - 0.004),
      v3(0, BAR.y - 0.016, BAR.z - 0.006),
      v3(0.12, BAR.y - 0.012, BAR.z - 0.004),
      v3(0.27, BAR.y + 0.004, BAR.z + 0.006),
      v3(0.43, BAR.y + 0.004, BAR.z + 0.008),
    ];
    upperMatte.push(tint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.0115, 7, false), st.cockpit));
    upperMatte.push(tube(v3(-0.03, BAR.y - 0.016, BAR.z - 0.006), v3(0.03, BAR.y - 0.016, BAR.z - 0.006), 0.018, 0.018, st.cockpit, 12));
    for (const s of [-1, 1]) {
      const g0 = v3(s * 0.292, BAR.y + 0.004, BAR.z + 0.006);
      const g1 = v3(s * 0.428, BAR.y + 0.004, BAR.z + 0.008);
      upperMatte.push(capsule(g0, g1, 0.0175, st.grip, 8, 2));
      upperMatte.push(tube(g0.clone().setX(s * 0.283), g0.clone().setX(s * 0.295), 0.0195, 0.0195, st.accent, 10));
      // brake lever + master cylinder
      upperMatte.push(box(0.03, 0.024, 0.026, v3(s * 0.235, BAR.y + 0.018, BAR.z + 0.004), '#232428'));
      upperMatte.push(capsule(v3(s * 0.245, BAR.y + 0.01, BAR.z - 0.02), v3(s * 0.33, BAR.y - 0.012, BAR.z - 0.045), 0.0055, '#3a3c41', 5, 2));
    }
  }

  /* ---------- main frame (front triangle, + rear triangle for hardtails) */
  const frameGloss: THREE.BufferGeometry[] = [];
  const frameMatte: THREE.BufferGeometry[] = [];
  frameGloss.push(tube(HT_BOT, HT_TOP, 0.034 * ts, 0.031 * ts, st.frame, 16));
  frameGloss.push(capsule(DT_REAR, DT_FRONT, 0.032 * ts, st.frame, 12, 2));
  frameGloss.push(capsule(TT_REAR, TT_FRONT, 0.023 * ts, st.frame, 10, 2));
  frameGloss.push(capsule(BB, ST_TOP, 0.022 * ts, st.frame, 10, 2));
  // gussets near the head tube
  frameGloss.push(capsule(axisPt(0.62).add(v3(0, -0.005, 0.03)), TT_FRONT.clone().lerp(TT_REAR, 0.16), 0.02 * ts, st.frame, 8, 2));
  frameGloss.push(capsule(axisPt(0.6).add(v3(0, 0, 0.03)), DT_FRONT.clone().lerp(DT_REAR, 0.18), 0.028 * ts, st.frame, 8, 2));
  if (st.downTubeBand !== undefined) {
    const r = 0.0335 * ts;
    frameGloss.push(tube(DT_REAR.clone().lerp(DT_FRONT, 0.52), DT_REAR.clone().lerp(DT_FRONT, 0.86), r, r, st.downTubeBand, 14));
  }
  if (st.topTubeBand !== undefined) {
    const r = 0.0245 * ts;
    frameGloss.push(tube(TT_REAR.clone().lerp(TT_FRONT, 0.12), TT_REAR.clone().lerp(TT_FRONT, 0.4), r, r, st.topTubeBand, 12));
  }
  frameMatte.push(tube(HT_TOP, axisPt(0.715), 0.033 * ts, 0.033 * ts, st.accent, 14)); // headset cup
  frameMatte.push(tube(axisPt(0.57), HT_BOT, 0.034 * ts, 0.034 * ts, st.accent, 14));
  frameMatte.push(tube(BB.clone().setX(-0.048), BB.clone().setX(0.048), 0.026, 0.026, '#26282c', 14)); // BB shell
  frameMatte.push(tube(seatPt(0.575), seatPt(0.6), 0.025 * ts, 0.025 * ts, st.accent, 12)); // seat collar
  frameMatte.push(tube(seatPt(0.5), seatPt(0.655), 0.0155, 0.0155, '#202124', 10)); // seatpost
  frameMatte.push(box(0.03, 0.02, 0.05, seatPt(0.655).add(v3(0, 0.004, 0)), '#202124'));
  frameMatte.push(...saddleGeometry(st));

  if (hardtail) {
    // rigid rear triangle: chain stays + seat stays meeting at the dropouts
    for (const s of [-1, 1]) {
      const drop = v3(s * 0.068, RA.y, RA.z);
      frameGloss.push(capsule(BB.clone().add(v3(s * 0.04, 0.0, 0.03)), drop.clone().add(v3(0, 0.0, -0.012)), 0.0135 * ts, swing, 8, 2));
      frameGloss.push(capsule(seatPt(0.5).add(v3(s * 0.016, 0, 0.012)), drop.clone().add(v3(0, 0.016, -0.006)), 0.0115 * ts, swing, 8, 2));
      frameGloss.push(box(0.012, 0.05, 0.05, drop, swing));
      frameMatte.push(tube(drop.clone().setX(s * 0.074), drop.clone().setX(s * 0.084), 0.013, 0.013, st.accent, 10));
    }
    frameGloss.push(tube(seatPt(0.36).add(v3(-0.05, 0, 0.11)), seatPt(0.36).add(v3(0.05, 0, 0.11)), 0.007, 0.007, swing, 6)); // brake bridge
    drivetrainRear(frameMatte);
  } else {
    // shock mount tab + swingarm pivot boss
    frameGloss.push(box(0.03, 0.05, 0.05, F_MOUNT.clone().add(v3(0, -0.018, 0)), st.frame, new THREE.Euler(-0.5, 0, 0)));
    frameGloss.push(tube(PIVOT.clone().setX(-0.05), PIVOT.clone().setX(0.05), 0.026, 0.026, st.frame, 14));
    for (const s of [-1, 1]) frameMatte.push(tube(PIVOT.clone().setX(s * 0.05), PIVOT.clone().setX(s * 0.062), 0.017, 0.017, st.accent, 10));
  }

  /* ---------- cranks (rotate about BB) */
  const crankParts: THREE.BufferGeometry[] = [];
  crankParts.push(tube(v3(-0.078, 0, 0), v3(0.078, 0, 0), 0.012, 0.012, st.crank, 8));
  crankParts.push(capsule(v3(0.071, 0, 0), v3(0.073, 0, -BIKE.crankLength), 0.0115, st.crank, 8, 2));
  crankParts.push(capsule(v3(-0.071, 0, 0), v3(-0.073, 0, BIKE.crankLength), 0.0115, st.crank, 8, 2));
  crankParts.push(tube(v3(0.074, 0, -BIKE.crankLength), v3(0.095, 0, -BIKE.crankLength), 0.007, 0.007, '#9aa0a8', 6));
  crankParts.push(tube(v3(-0.095, 0, BIKE.crankLength), v3(-0.074, 0, BIKE.crankLength), 0.007, 0.007, '#9aa0a8', 6));
  {
    const ring = new THREE.TorusGeometry(0.074, 0.0085, 4, 32);
    tint(ring, st.chainring);
    place(ring, v3(0.05, 0, 0), new THREE.Euler(0, Math.PI / 2, 0), v3(1, 1, 0.55));
    crankParts.push(ring);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      crankParts.push(tube(v3(0.055, 0, 0), v3(0.05, Math.cos(a) * 0.07, Math.sin(a) * 0.07), 0.0065, 0.0065, st.crank, 5));
    }
  }

  /* ---------- pedals (instanced: 2 instances, stay level) */
  const p: THREE.BufferGeometry[] = [];
  p.push(box(0.092, 0.013, 0.07, v3(0, 0, 0), st.pedal));
  for (const z of [-0.04, 0.04]) p.push(tube(v3(-0.046, 0, z), v3(0.046, 0, z), 0.009, 0.009, st.pedal, 8));
  for (const x of [-0.046, 0.046]) p.push(box(0.008, 0.018, 0.086, v3(x, 0, 0), st.pedal));
  p.push(tube(v3(-0.05, 0, 0), v3(0.05, 0, 0), 0.0075, 0.0075, '#3a3c41', 6));

  const out: BikeGeometries = {
    wheel,
    forkLower: merge(lowers),
    forkUpperGloss: merge(upperGloss),
    forkUpperMatte: merge(upperMatte),
    frameGloss: merge(frameGloss),
    frameMatte: merge(frameMatte),
    cranks: merge(crankParts),
    pedal: merge(p),
    swingGloss: null,
    swingMatte: null,
    shock: null,
  };
  if (!hardtail) {
    /* ---------- swingarm (rotates about the rear axle so the hub stays put) */
    const swingGloss: THREE.BufferGeometry[] = [];
    const swingMatte: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      const drop = v3(s * 0.071, RA.y, RA.z);
      swingGloss.push(capsule(PIVOT.clone().setX(s * 0.05), drop.clone().add(v3(0, 0.0, -0.012)), 0.0165, swing, 8, 2));
      swingGloss.push(capsule(drop.clone().add(v3(0, 0.018, -0.008)), Q_MOUNT.clone().setX(s * 0.034), 0.0135, swing, 8, 2));
      swingGloss.push(capsule(PIVOT.clone().setX(s * 0.036), Q_MOUNT.clone().setX(s * 0.034), 0.017, swing, 8, 2));
      swingGloss.push(box(0.012, 0.06, 0.06, drop, swing));
      swingMatte.push(tube(drop.clone().setX(s * 0.077), drop.clone().setX(s * 0.088), 0.014, 0.014, st.accent, 10));
    }
    swingGloss.push(tube(Q_MOUNT.clone().setX(-0.04), Q_MOUNT.clone().setX(0.04), 0.011, 0.011, st.accent, 8));
    drivetrainRear(swingMatte);
    out.swingGloss = merge(swingGloss);
    out.swingMatte = merge(swingMatte);

    /* ---------- shock (built along +Y, stretched between the mounts) */
    const sp: THREE.BufferGeometry[] = [];
    const L = SHOCK_LEN;
    sp.push(tube(v3(-0.022, 0, 0), v3(0.022, 0, 0), 0.013, 0.013, st.shockBody, 10));
    sp.push(tube(v3(-0.022, L, 0), v3(0.022, L, 0), 0.013, 0.013, st.shockBody, 10));
    sp.push(capsule(v3(0, 0.012, 0), v3(0, 0.16, 0), 0.021, st.shockBody, 10, 2));
    sp.push(tube(v3(0, 0.15, 0), v3(0, L - 0.012, 0), 0.0095, 0.0095, '#c9ced6', 8));
    sp.push(tube(v3(0, 0.055, 0), v3(0, 0.07, 0), 0.034, 0.034, st.shockBody, 14));
    sp.push(tube(v3(0, L - 0.05, 0), v3(0, L - 0.036, 0), 0.034, 0.034, st.shockBody, 14));
    sp.push(capsule(v3(0, 0.03, 0.035), v3(0, 0.1, 0.035), 0.014, st.shockBody, 10, 2)); // reservoir
    sp.push(tint(new THREE.TubeGeometry(new HelixCurve(0.029, 0.07, L - 0.05, 6.5), 64, 0.006, 4, false), st.spring));
    out.shock = merge(sp);
  }
  return out;
}

/* ---------------------------------------------------------------- bike */

const _tmp = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _qh = new THREE.Quaternion();
const _mat = new THREE.Matrix4();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _f = new THREE.Vector3();
const _g = new THREE.Vector3();

function rotateAboutAxisPoint(group: THREE.Object3D, q: THREE.Quaternion, p: THREE.Vector3): void {
  group.quaternion.copy(q);
  group.position.copy(p).sub(_tmp.copy(p).applyQuaternion(q));
}

class BikeModel implements BikeVisual {
  readonly root = new THREE.Group();
  readonly anchors: BikeAnchors = {
    gripL: new THREE.Vector3(),
    gripR: new THREE.Vector3(),
    pedalL: new THREE.Vector3(),
    pedalR: new THREE.Vector3(),
    saddle: new THREE.Vector3(),
  };

  private readonly hardtail: boolean;
  /** Rest-pose right-hand grip (palm centre); the left one is mirrored. */
  private readonly grip: THREE.Vector3;
  private readonly front = new THREE.Group();
  private readonly frontUpper = new THREE.Group();
  private readonly frontWheel = new THREE.Group();
  private readonly frame = new THREE.Group();
  private readonly mainFrame = new THREE.Group();
  private readonly swingarm = new THREE.Group();
  private readonly rearWheel = new THREE.Group();
  private readonly cranks = new THREE.Group();
  private readonly shock = new THREE.Group();
  private readonly pedals: THREE.InstancedMesh;
  /** Fork-upper (bars) displacement from suspension sag, bike-local. */
  private readonly upperDisp = new THREE.Vector3();
  private readonly spokeMat: THREE.MeshLambertMaterial;
  private readonly blurMat: THREE.MeshLambertMaterial;
  private lastSpin = 0;
  private spinBlur = 0;

  constructor(style: BikeStyle) {
    const gloss = bikeGloss();
    const matte = bikeMatte();
    const G = bikeGeometries(style);
    this.hardtail = style.hardtail === true;
    this.grip = gripRest(style);
    this.root.name = 'bike';

    // per-bike materials so each bike's spoke blur follows its own wheel speed
    this.spokeMat = paintMaterial({ vertexColors: true, transparent: true, opacity: 1 });
    this.blurMat = paintMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    for (const wheel of [this.frontWheel, this.rearWheel]) {
      const blur = new THREE.Mesh(G.wheel.blur, this.blurMat);
      blur.castShadow = false;
      blur.renderOrder = 1;
      wheel.add(new THREE.Mesh(G.wheel.wheel, matte), new THREE.Mesh(G.wheel.spokes, this.spokeMat), blur);
    }
    this.frontWheel.position.copy(FA);
    this.rearWheel.position.copy(RA);

    const frontLower = new THREE.Group();
    frontLower.add(new THREE.Mesh(G.forkLower, gloss), this.frontWheel);
    this.frontUpper.add(new THREE.Mesh(G.forkUpperGloss, gloss), new THREE.Mesh(G.forkUpperMatte, matte));
    this.front.add(frontLower, this.frontUpper);

    this.mainFrame.add(new THREE.Mesh(G.frameGloss, gloss), new THREE.Mesh(G.frameMatte, matte));
    this.cranks.add(new THREE.Mesh(G.cranks, matte));
    this.cranks.position.copy(BB);
    this.pedals = new THREE.InstancedMesh(G.pedal, matte, 2);
    this.pedals.frustumCulled = false;
    this.mainFrame.add(this.cranks, this.pedals);

    if (G.swingGloss && G.swingMatte && G.shock) {
      this.swingarm.add(new THREE.Mesh(G.swingGloss, gloss), new THREE.Mesh(G.swingMatte, matte));
      this.shock.add(new THREE.Mesh(G.shock, gloss));
      this.frame.add(this.swingarm, this.shock);
    }
    this.frame.add(this.mainFrame, this.rearWheel);
    this.root.add(this.front, this.frame);
    enableShadows(this.root);
    for (const wheel of [this.frontWheel, this.rearWheel]) wheel.children[2].castShadow = false;

    this.update({ rearSpin: 0, frontSpin: 0, crank: 0, steer: 0, barspin: 0, tailwhip: 0, suspension: 0 });
  }

  update(s: BikeVisualState): void {
    const sag = clamp01(Number.isFinite(s.suspension) ? s.suspension : 0) * SAG_MAX;
    const steer = (s.steer || 0) + (s.barspin || 0);
    const whip = s.tailwhip || 0;

    /* suspension: main frame sag transform (bike-local, before the tailwhip rotation) */
    if (this.hardtail) {
      // only the fork compresses: pitch the whole frame forward about the rear axle
      _qh.setFromAxisAngle(_X, -(sag * STEER_AXIS.y) / HT_LEVER);
      rotateAboutAxisPoint(this.mainFrame, _qh, RA);
      this.upperDisp.copy(HT_BOT).sub(RA).applyQuaternion(_qh).add(RA).sub(HT_BOT);
    } else {
      this.upperDisp.copy(STEER_AXIS).multiplyScalar(-sag);
      this.mainFrame.position.copy(this.upperDisp);
      this.mainFrame.quaternion.identity();
      // swingarm pivots about the rear axle so its front end follows the sagging frame
      const pivotNow = _f.copy(PIVOT).add(this.upperDisp);
      const a0 = Math.atan2(PIVOT.z - RA.z, PIVOT.y - RA.y);
      const a1 = Math.atan2(pivotNow.z - RA.z, pivotNow.y - RA.y);
      _qs.setFromAxisAngle(_X, a1 - a0);
      rotateAboutAxisPoint(this.swingarm, _qs, RA);
      // shock between the frame mount and the swingarm eyelet
      const f = _f.copy(F_MOUNT).add(this.upperDisp);
      const dir = _g.copy(Q_MOUNT).sub(RA).applyQuaternion(_qs).add(RA).sub(f);
      const len = dir.length();
      this.shock.position.copy(f);
      this.shock.quaternion.setFromUnitVectors(_Y, dir.multiplyScalar(1 / Math.max(len, 1e-5)));
      this.shock.scale.set(1, len / SHOCK_LEN, 1);
    }

    // front assembly: steer + barspin about the steering axis (through the front axle)
    _qa.setFromAxisAngle(STEER_AXIS, -steer);
    rotateAboutAxisPoint(this.front, _qa, FA);
    this.frontUpper.position.copy(this.upperDisp);
    this.frontWheel.rotation.x = -(s.frontSpin || 0);

    // spokes strobe once a wheel turns more than ~half a spoke gap per frame: fade them into a blurred disc
    const spin = s.rearSpin || 0;
    const step = Math.abs(spin - this.lastSpin);
    this.lastSpin = spin;
    const target = step > 2 ? this.spinBlur : clamp01((step - 0.07) / 0.16);
    this.spinBlur += (target - this.spinBlur) * 0.35;
    this.spokeMat.opacity = 1 - 0.8 * this.spinBlur;
    this.blurMat.opacity = 0.42 * this.spinBlur;
    this.blurMat.visible = this.spinBlur > 0.01;

    // frame assembly: tailwhip about the steering axis
    _qb.setFromAxisAngle(STEER_AXIS, -whip);
    rotateAboutAxisPoint(this.frame, _qb, FA);
    this.rearWheel.rotation.x = -(s.rearSpin || 0);
    const c = s.crank || 0;
    this.cranks.rotation.x = -c;

    // pedals (main-frame local, kept level)
    const L = BIKE.crankLength;
    const sc = Math.sin(c) * L;
    const cc = Math.cos(c) * L;
    _mat.makeTranslation(-BIKE.pedalOffset, BB.y + sc, BB.z + cc);
    this.pedals.setMatrixAt(0, _mat);
    _mat.makeTranslation(BIKE.pedalOffset, BB.y - sc, BB.z - cc);
    this.pedals.setMatrixAt(1, _mat);
    this.pedals.instanceMatrix.needsUpdate = true;

    // anchors (bike-local)
    const A = this.anchors;
    const g = this.grip;
    this.frontPoint(A.gripL.set(-g.x, g.y, g.z));
    this.frontPoint(A.gripR.set(g.x, g.y, g.z));
    this.framePoint(A.pedalL.set(-BIKE.pedalOffset, BB.y + sc, BB.z + cc));
    this.framePoint(A.pedalR.set(BIKE.pedalOffset, BB.y - sc, BB.z - cc));
    this.framePoint(A.saddle.copy(SADDLE));
  }

  /** Rest-pose point on the bars / fork upper -> current bike-local position. */
  private frontPoint(p: THREE.Vector3): THREE.Vector3 {
    return p.add(this.upperDisp).sub(FA).applyQuaternion(_qa).add(FA);
  }

  /** Rest-pose point on the main frame -> current bike-local position (sag, then tailwhip). */
  private framePoint(p: THREE.Vector3): THREE.Vector3 {
    p.applyQuaternion(this.mainFrame.quaternion).add(this.mainFrame.position);
    return p.sub(FA).applyQuaternion(_qb).add(FA);
  }
}

/** Build a bike in the bike-local frame defined by `BIKE`. */
export function createBike(style: BikeStyle): BikeVisual {
  return new BikeModel(style);
}
