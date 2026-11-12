import * as THREE from 'three';
import { BIKE, type BikeAnchors, type RiderPose, type RiderRig } from '../rider/types';
import { RideDynamics } from './dynamics';
import { orientBone, solveTwoBone } from './ik';
import { clamp, clamp01, damp, enableShadows, lerp, smooth01, wobble } from './util';

/** Skeleton proportions (metres) and riding-style tuning for a humanoid rider. */
export interface HumanoidSpec {
  /** Lateral offset of each hip joint from the pelvis centre. */
  hipHalf: number;
  thigh: number;
  shin: number;
  /** Ankle joint height above the shoe sole. */
  ankleHeight: number;
  /** Ball of the foot (pedal contact) ahead of the ankle. */
  ballForward: number;
  /** Pelvis centre -> neck base along the spine. */
  torso: number;
  shoulderHalf: number;
  /** Shoulder joints sit this far below the neck base (along the spine). */
  shoulderDrop: number;
  upperArm: number;
  /** Elbow -> palm centre (the hand is rigidly attached to the forearm). */
  forearm: number;
  /** Pelvis centre above / behind (+z) the saddle top when seated. */
  seatUp: number;
  seatBack: number;
  /** Extra pelvis lift / push-back in the standing attack position. */
  standUp: number;
  standBack: number;
  /** Desired torso pitch from vertical (rad) seated / attack. Clamped by arm reach. */
  seatedPitch: number;
  attackPitch: number;
  /** Arm extension limits as a fraction of arm length when hands are on the grips. */
  reachMax: number;
  reachMin: number;
  /** Max arm extension in the attack position (lower = more bent elbows, lower torso). */
  attackReach: number;
  /** Fist-pump hand target relative to the right shoulder (keep it clear of big heads). */
  celebrateHand: THREE.Vector3;
}

/** Rigid body-part objects. Each part's local frame is described next to the field. */
export interface HumanoidBody {
  /** Origin: pelvis centre (between hip joints). +Y up the spine, -Z forward. */
  pelvis: THREE.Object3D;
  /** Origin: pelvis centre. +Y along the spine to the neck base at (0, spec.torso, 0). */
  torso: THREE.Object3D;
  /** Origin: neck base. +Y up, -Z = face direction. */
  head: THREE.Object3D;
  /** [left, right]. Origin at the proximal joint, +Y towards the distal joint, +Z towards the bend pole. */
  upperArm: [THREE.Object3D, THREE.Object3D];
  forearm: [THREE.Object3D, THREE.Object3D];
  /** Origin: palm centre (grip point). Oriented like the forearm. */
  hand: [THREE.Object3D, THREE.Object3D];
  thigh: [THREE.Object3D, THREE.Object3D];
  shin: [THREE.Object3D, THREE.Object3D];
  /** Origin: ankle. -Z toe direction, -Y down; sole at y = -ankleHeight. */
  foot: [THREE.Object3D, THREE.Object3D];
  /** Optional per-frame hook, called after every part is posed (cloth, blinking, glow...). */
  tick?: (time: number, dt: number, pose: RiderPose) => void;
}

const PEDAL_TOP = 0.012;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _qf = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Body orientation: pitch forward (rad from vertical), yaw (+ = left), roll (+ = lean right). */
function bodyQuat(out: THREE.Quaternion, pitch: number, yaw: number, roll: number): THREE.Quaternion {
  _e.set(-pitch, yaw, -roll, 'YXZ');
  return out.setFromEuler(_e);
}

interface Weights {
  seated: number;
  compress: number;
  lean: number;
  steer: number;
  air: number;
  crash: number;
  celebrate: number;
  superman: number;
  noHander: number;
  canCan: number;
  tailwhip: number;
  barspin: number;
  tabletop: number;
}

const TRICK_KEYS = ['superman', 'noHander', 'canCan', 'tailwhip', 'barspin', 'tabletop'] as const;

/** Smoothed weight (snaps on the first update so a new rig starts in pose). */
export function blend(snap: boolean, cur: number, target: number, rate: number, dt: number): number {
  return snap ? target : damp(cur, target, rate, dt);
}

/**
 * Generic IK rider: pelvis placement from saddle + pose blends, torso pitch solved so hands reach the grips,
 * analytic 2-bone IK for arms and legs, procedural trick / crash / celebrate poses.
 */
export class HumanoidRig implements RiderRig {
  readonly root = new THREE.Group();
  /** Arms-and-legs suspension between the body and the bike (secondary motion). */
  readonly dynamics = new RideDynamics();

  private readonly w: Weights = {
    seated: 1,
    compress: 0,
    lean: 0,
    steer: 0,
    air: 0,
    crash: 0,
    celebrate: 0,
    superman: 0,
    noHander: 0,
    canCan: 0,
    tailwhip: 0,
    barspin: 0,
    tabletop: 0,
  };
  private primed = false;

  // scratch state
  private readonly pelvis = new THREE.Vector3();
  private readonly saddleRef = new THREE.Vector3();
  private readonly torsoQ = new THREE.Quaternion();
  private readonly pelvisQ = new THREE.Quaternion();
  private readonly neck = new THREE.Vector3();
  private readonly shoulder = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly hip = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly ankleT = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly handT = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly mid = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly free = new THREE.Vector3();
  private readonly footPhi = [0, 0];
  private readonly footOff = [0, 0];
  private readonly reachOut = { max: 0, min: 0 };
  private readonly qa = new THREE.Quaternion();

  constructor(
    readonly spec: HumanoidSpec,
    readonly body: HumanoidBody,
  ) {
    this.root.name = 'rider';
    const b = body;
    this.root.add(b.pelvis, b.torso, b.head, ...b.upperArm, ...b.forearm, ...b.hand, ...b.thigh, ...b.shin, ...b.foot);
    enableShadows(this.root);
  }

  private shoulderAt(out: THREE.Vector3, side: number, pitch: number, yaw: number, roll: number): THREE.Vector3 {
    const S = this.spec;
    bodyQuat(_q, pitch, yaw, roll);
    return out
      .set(side === 0 ? -S.shoulderHalf : S.shoulderHalf, S.torso - S.shoulderDrop, 0)
      .applyQuaternion(_q)
      .add(this.pelvis);
  }

  /** Max/min shoulder->hand-target distance for a torso pitch. */
  private reach(pitch: number, yaw: number, roll: number, out: { max: number; min: number }): void {
    let mx = 0;
    let mn = Infinity;
    for (let s = 0; s < 2; s++) {
      const d = this.shoulderAt(_v, s, pitch, yaw, roll).distanceTo(this.handT[s]);
      if (d > mx) mx = d;
      if (d < mn) mn = d;
    }
    out.max = mx;
    out.min = mn;
  }

  update(pose: RiderPose, anchors: BikeAnchors, dt: number): void {
    const S = this.spec;
    const B = this.body;
    const w = this.w;
    const t = pose.time || 0;
    const tr = pose.tricks;

    /* ---------------- smoothed blend weights */
    const snap = !this.primed;
    w.seated = blend(snap, w.seated, clamp01(pose.seated), 7, dt);
    w.compress = blend(snap, w.compress, clamp01(pose.compress), 14, dt);
    w.lean = blend(snap, w.lean, clamp(pose.lean || 0, -1.2, 1.2), 10, dt);
    w.steer = blend(snap, w.steer, clamp(pose.steer || 0, -1, 1), 8, dt);
    w.air = blend(snap, w.air, pose.airborne ? 1 : 0, 6, dt);
    w.crash = blend(snap, w.crash, pose.crashed ? 1 : 0, 5, dt);
    w.celebrate = blend(snap, w.celebrate, clamp01(pose.celebrate || 0), 9, dt);
    for (const key of TRICK_KEYS) w[key] = blend(snap, w[key], clamp01(tr ? tr[key] : 0), 12, dt);
    this.primed = true;

    const seated = smooth01(w.seated);
    const att = 1 - seated;
    const comp = w.compress;
    const sup = smooth01(w.superman);
    const nh = smooth01(w.noHander);
    const cc = smooth01(w.canCan);
    const tw = smooth01(w.tailwhip);
    const bs = smooth01(w.barspin);
    const tt = smooth01(w.tabletop);
    const crash = smooth01(w.crash);
    const cel = smooth01(w.celebrate) * (1 - crash);
    const speedK = clamp01((pose.speed || 0) / 18);

    /* ---------------- crank phase from the pedals */
    const pL = anchors.pedalL;
    const pR = anchors.pedalR;
    const crank = Math.atan2(-(pR.y - pL.y) * 0.5, -(pR.z - pL.z) * 0.5);

    /* ---------------- pelvis */
    // during a tailwhip the frame whips around under the rider: ignore the saddle anchor
    this.saddleRef.copy(anchors.saddle).lerp(BIKE.saddle, tw);
    const P = this.pelvis;
    const sr = this.saddleRef;
    P.set(
      sr.x + Math.sin(crank) * 0.008 * seated,
      sr.y + S.seatUp + att * S.standUp + Math.abs(Math.cos(crank)) * 0.006 * seated,
      sr.z + S.seatBack + att * S.standBack,
    );
    P.y -= comp * (0.04 + 0.12 * att) + w.air * 0.03 * att;
    P.z += comp * 0.05 * att;
    P.x += w.lean * 0.06 - cc * 0.04;
    P.y += sup * 0.25 + nh * 0.05 + cc * 0.08 + tw * 0.13 + bs * 0.05 + tt * 0.05;
    P.z += sup * 0.2 + nh * 0.02 - tw * 0.03 + bs * 0.03;

    /* ---------------- secondary motion: the body floats on its arms and legs */
    const parent = this.root.parent;
    if (parent) parent.updateWorldMatrix(true, false);
    const dyn = this.dynamics;
    dyn.update(dt, parent ? parent.matrixWorld : null, pose.velocity, pose.roughness ?? 0, pose.speed || 0, !pose.airborne, pose.crashed ? 0 : 1);
    P.add(dyn.offset);

    /* ---------------- feet on pedals */
    const footOff = this.footOff;
    footOff[0] = Math.max(sup, tw, crash, cc);
    footOff[1] = Math.max(sup, tw, crash);
    const hA = S.ankleHeight + PEDAL_TOP;
    const bF = S.ballForward;
    for (let s = 0; s < 2; s++) {
      const pedal = s === 0 ? pL : pR;
      const c = s === 1 ? crank : crank + Math.PI;
      const phiSeated = 0.06 + 0.1 * Math.cos(c) - 0.14 * Math.sin(c);
      const phiAttack = 0.24 + 0.05 * Math.cos(c);
      const phi = lerp(phiAttack, phiSeated, seated);
      this.footPhi[s] = phi;
      const cs = Math.cos(phi);
      const sn = Math.sin(phi);
      this.ankleT[s].set(pedal.x, pedal.y + hA * cs - bF * sn, pedal.z + hA * sn + bF * cs);
    }

    /* ---------------- leg reach: lower the pelvis until attached feet reach their pedals */
    const legLen = S.thigh + S.shin;
    // standing: keep a visible knee bend; seated: nearly straight at the bottom of the stroke
    const maxD = legLen * lerp(0.925, 0.965, seated);
    let drop = 0;
    for (let s = 0; s < 2; s++) {
      const on = 1 - footOff[s];
      if (on <= 0.01) continue;
      const a = this.ankleT[s];
      const dx = P.x + (s === 0 ? -S.hipHalf : S.hipHalf) - a.x;
      const dy = P.y - a.y;
      const dz = P.z - a.z;
      const h2 = dx * dx + dz * dz;
      if (h2 + dy * dy > maxD * maxD) {
        const vy = Math.sqrt(Math.max(0, maxD * maxD - h2));
        drop = Math.max(drop, (dy - vy) * on);
      }
    }
    P.y -= Math.min(drop, 0.04 + att * 0.4);

    /* ---------------- torso orientation */
    let pitch = lerp(S.attackPitch, S.seatedPitch, seated);
    pitch += comp * 0.22 + speedK * 0.06 * att + w.air * 0.04 * att;
    pitch = lerp(pitch, 1.4, sup);
    pitch = lerp(pitch, 0.2, nh);
    pitch += tw * 0.06 - bs * 0.14 - cc * 0.04 - cel * 0.18;
    pitch += Math.sin(t * 2.3) * 0.012 + dyn.pitch;
    // tabletop: the game rolls the bike (assumed towards the rider's right); counter-roll + twist to stay upright
    let yaw = -w.steer * 0.1 + tt * 0.45 - cc * 0.25;
    let roll = w.lean * 0.75 - tt * 0.75 + cc * 0.1 + dyn.roll;

    // hand targets (grips by default)
    const armLen = S.upperArm + S.forearm;
    const handsOn = 1 - Math.max(nh, bs, crash);
    this.handT[0].copy(anchors.gripL);
    this.handT[1].copy(anchors.gripR);

    // solve pitch so the grips are within reach
    if (handsOn > 0.001) {
      const r = this.reachOut;
      const reachK = lerp(lerp(S.attackReach, S.reachMax, seated) * (1 - comp * 0.06), 0.97, sup);
      const maxR = armLen * reachK;
      const minR = armLen * S.reachMin;
      let solved = pitch;
      this.reach(pitch, yaw, roll, r);
      if (r.max > maxR) {
        let lo = pitch;
        let hi = 1.55;
        this.reach(hi, yaw, roll, r);
        if (r.max > maxR) solved = hi;
        else {
          for (let i = 0; i < 14; i++) {
            const m = (lo + hi) * 0.5;
            this.reach(m, yaw, roll, r);
            if (r.max > maxR) lo = m;
            else hi = m;
          }
          solved = hi;
        }
      } else if (r.min < minR) {
        let lo = -0.2;
        let hi = pitch;
        this.reach(lo, yaw, roll, r);
        if (r.min < minR) solved = lo;
        else {
          for (let i = 0; i < 14; i++) {
            const m = (lo + hi) * 0.5;
            this.reach(m, yaw, roll, r);
            if (r.min < minR) hi = m;
            else lo = m;
          }
          solved = lo;
        }
      }
      pitch = lerp(pitch, solved, handsOn);
      // still out of reach (superman stretch, tabletop twist): slide the pelvis towards the farthest grip
      for (let it = 0; it < 4; it++) {
        let far = -1;
        let farD = maxR;
        for (let s = 0; s < 2; s++) {
          const d = this.shoulderAt(_v, s, pitch, yaw, roll).distanceTo(this.handT[s]);
          if (d > farD) {
            farD = d;
            far = s;
          }
        }
        if (far < 0) break;
        _v2.copy(this.handT[far]).sub(this.shoulderAt(_v, far, pitch, yaw, roll)).normalize();
        P.addScaledVector(_v2, (farD - maxR) * handsOn + 1e-4);
      }
    }

    /* ---------------- crash: limp, slowly flailing (no IK to the bike) */
    if (crash > 0.001) {
      P.lerp(_v.set(0, 1.0, 0.32), crash);
      pitch = lerp(pitch, 0.45 + 0.55 * wobble(t * 0.9, 1), crash);
      yaw = lerp(yaw, 0.6 * wobble(t * 0.7, 2), crash);
      roll = lerp(roll, 0.7 * wobble(t * 0.8, 3), crash);
    }

    bodyQuat(this.torsoQ, pitch, yaw, roll);
    bodyQuat(this.pelvisQ, 0.2 + pitch * 0.45, yaw * 0.5 - cc * 0.25, roll * 0.35);
    B.pelvis.position.copy(P);
    B.pelvis.quaternion.copy(this.pelvisQ);
    B.torso.position.copy(P);
    B.torso.quaternion.copy(this.torsoQ);
    // breathing: tiny chest scale pulse
    const breath = 1 + Math.sin(t * 2.3 + 0.6) * 0.012;
    B.torso.scale.set(breath, 1, breath);

    this.neck.set(0, S.torso, 0).applyQuaternion(this.torsoQ).add(P);
    for (let s = 0; s < 2; s++) {
      this.shoulder[s]
        .set(s === 0 ? -S.shoulderHalf : S.shoulderHalf, S.torso - S.shoulderDrop, 0)
        .applyQuaternion(this.torsoQ)
        .add(P);
      this.hip[s].set(s === 0 ? -S.hipHalf : S.hipHalf, 0, 0).applyQuaternion(this.pelvisQ).add(P);
    }

    /* ---------------- arms */
    for (let s = 0; s < 2; s++) {
      const sg = s === 0 ? -1 : 1;
      const sh = this.shoulder[s];
      const T = this.handT[s];
      // bar-spin: hands hover just above / behind where the grips were, elbows bent
      if (bs > 0.001) {
        this.free.set(sg * BIKE.gripOffset * 0.85, BIKE.bar.y + 0.11 + Math.sin(t * 7 + s * 2) * 0.015, BIKE.bar.z + 0.13);
        T.lerp(this.free, bs);
      }
      // no-hander: arms spread wide and up
      if (nh > 0.001) {
        this.free.set(sg * 0.52, 0.3 + Math.sin(t * 4 + s * 2.1) * 0.05, 0.08 + Math.sin(t * 3.1 + s) * 0.04).add(sh);
        T.lerp(this.free, nh);
      }
      // celebrate: right fist pump
      if (s === 1 && cel > 0.001) {
        const ch = S.celebrateHand;
        this.free.set(ch.x, ch.y + Math.sin(t * 12) * 0.07, ch.z).add(sh);
        T.lerp(this.free, cel);
      }
      if (crash > 0.001) {
        _v.set(sg * 0.9, 0.3 + 0.6 * wobble(t * 1.3, 4 + s * 3), 0.35 * wobble(t * 1.1, 5 + s * 3)).normalize();
        this.free.copy(sh).addScaledVector(_v, armLen * (0.78 + 0.12 * wobble(t * 1.7, 8 + s)));
        T.lerp(this.free, crash);
      }
      // elbows: out & back, more out in attack
      this.pole.set(sg * lerp(0.95, 0.85, seated), lerp(-0.15, -0.45, seated), lerp(0.4, 0.55, seated));
      this.pole.lerp(_v.set(sg * 0.2, -0.7, 0.7), nh);
      if (s === 1) this.pole.lerp(_v.set(0.9, -0.5, -0.3), cel);
      this.pole.lerp(_v.set(sg * 0.3, -0.4 + wobble(t, 11 + s) * 0.5, 0.8), crash);
      this.pole.normalize();

      solveTwoBone(sh, T, S.upperArm, S.forearm, this.pole, this.mid, this.end, 0.999);
      orientBone(B.upperArm[s], sh, this.mid, this.pole);
      orientBone(B.forearm[s], this.mid, this.end, this.pole);
      B.hand[s].position.copy(this.end);
      B.hand[s].quaternion.copy(B.forearm[s].quaternion);
    }

    /* ---------------- legs */
    for (let s = 0; s < 2; s++) {
      const sg = s === 0 ? -1 : 1;
      const H = this.hip[s];
      const T = this.ankleT[s];
      if (sup > 0.001) {
        // legs straight back, slightly raised, toes pointed
        _v.set(sg * 0.05, 0.06, 1).normalize();
        this.free.copy(H).addScaledVector(_v, legLen * 0.97);
        T.lerp(this.free, sup);
      }
      if (tw > 0.001) {
        // feet kicked off the pedals: knees up and slightly out, feet tucked under the seat
        this.free.set(sg * 0.15, -0.46, 0.12).add(H);
        T.lerp(this.free, tw);
      }
      if (s === 0 && cc > 0.001) {
        // quadratic bezier from the pedal, over the top tube, out to the right side
        const u = cc;
        const a = (1 - u) * (1 - u);
        const b = 2 * u * (1 - u);
        const c = u * u;
        T.set(
          T.x * a + 0.05 * b + 0.58 * c,
          T.y * a + 1.25 * b + 0.8 * c,
          T.z * a + 0.02 * b - 0.1 * c,
        );
      }
      if (crash > 0.001) {
        _v.set(sg * (0.45 + 0.25 * wobble(t * 1.1, 20 + s)), -0.75, 0.45 * wobble(t * 0.9, 22 + s)).normalize();
        this.free.copy(H).addScaledVector(_v, legLen * (0.82 + 0.1 * wobble(t * 1.4, 24 + s)));
        T.lerp(this.free, crash);
      }
      // knees: forward, slightly up and out
      this.pole.set(sg * lerp(0.28, 0.16, seated), 0.25, -1);
      this.pole.lerp(_v.set(-sg * 0.55, 0.15, -1), nh);
      this.pole.lerp(_v.set(0, -1, 0.15), sup);
      this.pole.lerp(_v.set(sg * 0.4, 0.3, -1), tw);
      if (s === 0) this.pole.lerp(_v.set(0.3, 1, -0.4), cc);
      this.pole.lerp(_v.set(sg * 0.3, 0.2 + wobble(t, 30 + s) * 0.4, -1), crash);
      this.pole.normalize();

      solveTwoBone(H, T, S.thigh, S.shin, this.pole, this.mid, this.end, 0.999);
      orientBone(B.thigh[s], H, this.mid, this.pole);
      orientBone(B.shin[s], this.mid, this.end, this.pole);

      const foot = B.foot[s];
      foot.position.copy(this.end);
      // on the pedal: level with ankling
      this.qa.setFromAxisAngle(X_AXIS, this.footPhi[s]);
      // tucked (tailwhip / can-can swing leg): roughly level, toes slightly down
      const tucked = s === 0 ? Math.max(tw, cc) : tw;
      if (tucked > 0.001) this.qa.slerp(_qf.setFromAxisAngle(X_AXIS, -0.3), tucked);
      // stretched (superman, toes pointed back) / flailing: foot relative to the shin
      const stretched = Math.max(sup, crash);
      if (stretched > 0.001) {
        const point = lerp(0.65, 1.42, sup / Math.max(stretched, 1e-3));
        _qf.setFromAxisAngle(X_AXIS, Math.PI - point);
        _q.copy(B.shin[s].quaternion).multiply(_qf);
        this.qa.slerp(_q, stretched);
      }
      foot.quaternion.copy(this.qa);
    }

    /* ---------------- head: look ahead / into the turn, secondary motion */
    // the neck stabilises the gaze against the body's bounce
    let hp = pitch * 0.32 + 0.1 + comp * 0.08 - cel * 0.3 + tt * 0.75 + sup * 0.05 - nh * 0.05 - dyn.pitch * 0.75;
    let hy = -w.steer * 0.42 + tt * 0.2 + yaw * 0.4 + Math.sin(t * 0.37) * 0.04;
    let hr = w.lean * 0.35 - tt * 0.6 - dyn.roll * 0.6;
    if (crash > 0.001) {
      hp = lerp(hp, 0.4 * wobble(t * 1.2, 40), crash);
      hy = lerp(hy, 0.5 * wobble(t * 0.9, 41), crash);
      hr = lerp(hr, 0.5 * wobble(t * 1.0, 42), crash);
    }
    B.head.position.copy(this.neck);
    bodyQuat(B.head.quaternion, hp, hy, hr);

    B.tick?.(t, dt, pose);
  }
}
