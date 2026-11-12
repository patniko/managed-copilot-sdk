import * as THREE from 'three';
import { clamp, clamp01, damp, dampAngle, lerp, smootherstep, wrapAngle } from '../core/math';
import type { BikePhysics } from './bike';
import { ROUGHNESS } from './player';
import type { Ground } from '../world/ground';
import type { CameraStyle } from '../world/types';

export type CameraMode = 'chase' | 'far' | 'low' | 'steady';
const MODES: CameraMode[] = ['chase', 'far', 'low', 'steady'];

interface Rig {
  dist: number;
  height: number;
  ahead: number;
  fov: number;
  /** Fixed sideways offset (m, + = right of the rider). */
  side: number;
  /** 0..1 how much cinematic motion (drift, orbit, pan, Dutch roll, handheld) the rig gets. */
  life: number;
}

const RIGS: Record<CameraMode, Rig> = {
  // the painted video's camera: close, low, constantly drifting around the rider with the ground rushing past. It
  // aims just past the rider, so its sweeps around the rider swing the whole scene through the frame
  chase: { dist: 2.0, height: 1.12, ahead: 1.5, fov: 60, side: 0, life: 1 },
  far: { dist: 6.8, height: 2.9, ahead: 6, fov: 56, side: 0, life: 0.45 },
  low: { dist: 2.4, height: 0.9, ahead: 5, fov: 58, side: 0, life: 0.45 },
  // the classic locked-off chase cam
  steady: { dist: 2.15, height: 1.42, ahead: 3.4, fov: 56, side: 0.32, life: 0 },
};
/** Widest the lens gets at full speed (vertical degrees). */
const MAX_FOV = 72;

/** Hashed lattice value in [-1, 1]. */
function lattice(i: number, seed: number): number {
  const h = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}

/**
 * Framings the "operator" moves between every few seconds (offsets from the rig): orbit (rad, + =
 * rear-left), distance / height (m), sideways pan of the look point (m, + = right) and Dutch roll (rad).
 */
const SHOTS = [
  { orbit: 0.42, dist: 0.1, height: 0.05, pan: -0.5, roll: 0.06 }, // rear-left three-quarter, scenery on the right
  { orbit: -0.8, dist: -0.2, height: -0.35, pan: -0.9, roll: -0.1 }, // low side-on tracking shot from the right
  { orbit: 0.04, dist: 0.6, height: 0.45, pan: 0.0, roll: 0.0 }, // higher and wider behind: the trail ahead
  { orbit: 0.12, dist: -0.15, height: -0.3, pan: 0.0, roll: 0.07 }, // low and close behind, looking up at the rider
  { orbit: -0.42, dist: 0.3, height: 0.1, pan: 0.6, roll: -0.06 }, // wide rear-right three-quarter
  { orbit: 0.8, dist: -0.2, height: -0.32, pan: 0.9, roll: 0.1 }, // low side-on tracking shot from the left
];

/** Orbit fallbacks (fractions of the wanted orbit) when props block the camera: swing back into the rider's wake. */
const ORBIT_FALLBACK = [1, 0.6, 0.3, 0, -0.4];

/** Smooth, non-repeating 1D noise in about [-1, 1] (quintic value noise, two octaves). */
export function noise1(t: number, seed: number): number {
  let v = 0;
  let amp = 0.72;
  let f = t;
  for (let o = 0; o < 2; o++) {
    const i = Math.floor(f);
    const u = f - i;
    const s = u * u * u * (u * (u * 6 - 15) + 10);
    v += amp * (lattice(i, seed + o * 31) * (1 - s) + lattice(i + 1, seed + o * 31) * s);
    f = f * 2.13 + 17.3;
    amp = 0.28;
  }
  return v;
}

/**
 * Third-person camera. The default "chase" rig behaves like the handheld / drone follow camera in the
 * painted video: it drifts between rear-left and rear-right three-quarter views, lets the rider pull
 * away on fast sections and catches up, pans the view into turns and across the scenery, banks with a
 * Dutch roll, and swings out to the side for big air. "steady" is the classic locked chase camera.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  /** The world's camera adjustments (see EnvironmentDef.camera). */
  style: CameraStyle = {};
  private pos = new THREE.Vector3();
  private offset = new THREE.Vector3();
  private lookOff = new THREE.Vector3();
  private camY = 0;
  private look = new THREE.Vector3();
  private yaw = 0;
  private shake = 0;
  private roll = 0;
  private fov = 52;
  private inited = false;
  /** Time base for the drift noise (fixed start so captures are reproducible). */
  private t = 37;
  private orbit = 0;
  private dist = 2.35;
  private height = 1.45;
  private accel = 0;
  private prevSpeed = 0;
  private airK = 0;
  /** Current framing (index into SHOTS), time in it, its duration, and the smoothed framing offsets. */
  private shot = 0;
  private prevShot = -1;
  private shotT = 0;
  private shotDur = 4.5;
  private shotN = 0;
  private sh = { orbit: 0, dist: 0, height: 0, pan: 0, roll: 0 };
  /** 1 while dodging props (the orbit swings faster), easing back to 0. */
  private dodge = 0;
  /** Landing punch: vertical dip spring (m, m/s). */
  private punchY = 0;
  private punchV = 0;
  /** Phase of the operator's continuous sweep around the rider. */
  private sweep = 0;
  /** Speed-boost lens kick, 0..1. */
  private kick = 0;
  /** Smallest vertical FOV (degrees) that fits the whole rider this frame. */
  private fitFov = 0;
  /** Velocity of the camera (for motion blur), m/s. */
  readonly velocity = new THREE.Vector3();
  private lastPos = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private right = new THREE.Vector3();
  private euler = new THREE.Euler();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(52, aspect, 0.2, 30000);
  }

  cycleMode() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
  }

  addShake(amount: number) {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** Landing impact: the camera dips with the hit (0..1) and springs back. */
  punch(amount: number) {
    this.punchV -= 2.6 * clamp01(amount) * RIGS[this.mode].life;
  }

  /** Speed boost: the lens flares wide for a moment (0..1). */
  boostKick(amount: number) {
    this.kick = Math.max(this.kick, clamp01(amount));
  }

  snap(bike: BikePhysics, ground: Ground) {
    this.inited = false;
    this.update(1 / 60, bike, ground);
  }

  update(dt: number, bike: BikePhysics, ground: Ground) {
    const p = RIGS[this.mode];
    const life = p.life;
    const first = !this.inited;
    this.t += dt;
    const t = this.t;
    const speed = bike.speed;
    const fs = bike.forwardSpeed;
    const pos = bike.pos;

    /* heading: the camera body follows the travel direction with some lag (it swings out in turns) */
    const targetYaw = bike.grounded ? bike.heading : bike.air.travelHeading;
    if (!this.inited) this.yaw = targetYaw;
    this.yaw = dampAngle(this.yaw, targetYaw, bike.grounded ? lerp(4.5, 2.8, life) : 1.5, dt);

    /* forward acceleration: on steep pitches the rider pulls away and the camera catches up */
    const acc = this.inited && dt > 0 ? (fs - this.prevSpeed) / dt : 0;
    this.prevSpeed = fs;
    this.accel = this.inited ? damp(this.accel, clamp(acc, -12, 12), 2.5, dt) : 0;

    /* big air: widen out and swing to the side to show the jump */
    const above = pos.y - ground.heightAt(pos.x, pos.z);
    const airTarget = bike.grounded ? 0 : clamp01((above - 0.8) / 3);
    this.airK = this.inited ? damp(this.airK, airTarget * life, bike.grounded ? 2.2 : 1.4, dt) : 0;

    /* the operator: hold a framing for a few seconds, then arc smoothly to the next (not while airborne) */
    this.shotT += dt;
    if (this.shotT > this.shotDur && bike.grounded) {
      this.shotN++;
      // a different framing from the last two
      const pick = Math.floor(((lattice(this.shotN, 41) + 1) / 2) * (SHOTS.length - 2) * 0.9999);
      let next = -1;
      for (let i = 0, c = 0; i < SHOTS.length && next < 0; i++) if (i !== this.shot && i !== this.prevShot && c++ === pick) next = i;
      this.prevShot = this.shot;
      this.shot = next < 0 ? (this.shot + 1) % SHOTS.length : next;
      this.shotT = 0;
      this.shotDur = 2.8 + (lattice(this.shotN, 43) + 1) * 1.2;
    }
    const S = SHOTS[this.shot];
    const sh = this.sh;
    if (!this.inited) Object.assign(sh, S);
    sh.orbit = damp(sh.orbit, S.orbit, 1.5, dt);
    sh.dist = damp(sh.dist, S.dist, 1.5, dt);
    sh.height = damp(sh.height, S.height, 1.5, dt);
    sh.pan = damp(sh.pan, S.pan, 1.3, dt);
    sh.roll = damp(sh.roll, S.roll, 1.3, dt);

    /* distance and height: framing + drift; the rider pulls away when accelerating, and the cinematic camera tucks
       in at speed (with the widening lens below, the ground rushes past the frame edges) */
    const st = this.style;
    let distT = p.dist + clamp(speed - 6, 0, 18) * (0.02 - 0.032 * life);
    distT += (sh.dist + noise1(t * 0.19, 3) * 0.3 + this.accel * 0.09) * life + this.airK * 1.6;
    distT = clamp(distT, p.dist * 0.85, p.dist + 2.6);
    const heightT = p.height + ((st.lift ?? 0) + sh.height + noise1(t * 0.42, 4) * 0.28) * life + this.airK * 0.85 + (distT - p.dist) * 0.12;

    /* orbit: the operator never stops moving. A continuous sweep between rear-left (+) and rear-right (-) whose
       pace and reach wander (the video's camera swings the scenery through the frame at ~15-20°/s), centred on
       the current framing */
    this.sweep += (dt * Math.PI * 2) / (4.4 + 1.5 * noise1(t * 0.07, 21));
    const reach = 0.56 + 0.18 * noise1(t * 0.09, 22);
    const swing = Math.sin(this.sweep) * reach + sh.orbit * 0.45 + noise1(t * 0.53, 2) * 0.06;
    let orbitT = (clamp(swing, -1.05, 1.05) * (st.orbitScale ?? 1) + (st.orbit ?? 0)) * life;
    orbitT += (this.orbit >= 0 ? 1 : -1) * 0.45 * this.airK;
    // don't orbit into a hillside (the camera would be shoved up into a steep top-down view): favour the open side
    const probe = this.yaw + orbitT;
    const blocked = ground.heightAt(pos.x - Math.sin(probe) * distT, pos.z + Math.cos(probe) * distT) + 0.75 - (pos.y + heightT);
    if (blocked > 0.2) orbitT = lerp(orbitT, -orbitT * 0.6, clamp01((blocked - 0.2) / 0.8));
    // ...or into bushes, rocks and trees beside the trail (checked half a second ahead)
    if (life > 0) {
      const clear = this.clearOrbit(orbitT, distT, heightT, bike, ground);
      this.dodge = clear !== orbitT ? 1 : damp(this.dodge, 0, 1.2, dt);
      orbitT = clear;
    }

    if (!this.inited) {
      this.orbit = orbitT;
      this.dist = distT;
      this.height = heightT;
    }
    this.orbit = damp(this.orbit, orbitT, 3 + 3 * this.dodge, dt);
    this.dist = damp(this.dist, distT, 2.0, dt);
    this.height = damp(this.height, heightT, 2.5, dt);

    /* position: offset-space smoothing (no lag at speed), orbit around the rider */
    const a = this.yaw + this.orbit;
    const ox = -Math.sin(a) * this.dist + Math.cos(this.yaw) * p.side;
    const oz = Math.cos(a) * this.dist + Math.sin(this.yaw) * p.side;
    const groundAtCam = ground.heightAt(pos.x + ox, pos.z + oz);
    let dy = Math.max(pos.y + this.height, groundAtCam + 0.75);
    if (!bike.grounded) dy = Math.max(dy, Math.min(bike.air.startY + this.height * 0.6, pos.y + this.height + 2.2));
    if (!this.inited) {
      this.offset.set(ox, 0, oz);
      this.camY = dy;
    }
    this.offset.x = damp(this.offset.x, ox, 12, dt);
    this.offset.z = damp(this.offset.z, oz, 12, dt);
    this.camY = damp(this.camY, dy, bike.grounded ? 9 : 4, dt);
    this.pos.set(pos.x + this.offset.x, this.camY, pos.z + this.offset.z);
    this.pos.y = Math.max(this.pos.y, ground.heightAt(this.pos.x, this.pos.z) + 0.6);
    if (!this.inited) this.lastPos.copy(this.pos);

    /* look: lead into turns (look along the bike's heading, not the lagging camera yaw) and pan across the scenery */
    const lookYaw = this.yaw + wrapAngle(targetYaw - this.yaw) * life;
    const ahead = p.ahead * (1 - 0.45 * this.airK);
    const pan = (sh.pan + (st.pan ?? 0) + noise1(t * 0.6, 5) * 0.7 + noise1(t * 1.3, 6) * 0.2) * life;
    const lookT = this.tmp2.set(pos.x + Math.sin(lookYaw) * ahead + Math.cos(lookYaw) * pan, 0, pos.z - Math.cos(lookYaw) * ahead + Math.sin(lookYaw) * pan);
    lookT.y = pos.y + 0.22 + (st.lookLift ?? 0) * life + (bike.grounded ? 0 : 0.4) - this.airK * 0.25;
    if (!this.inited) this.lookOff.copy(lookT).sub(pos);
    this.lookOff.x = damp(this.lookOff.x, lookT.x - pos.x, 12, dt);
    this.lookOff.z = damp(this.lookOff.z, lookT.z - pos.z, 12, dt);
    this.lookOff.y = damp(this.lookOff.y, lookT.y - pos.y, 8, dt);
    this.look.copy(pos).add(this.lookOff);
    if (life > 0) this.frameRider(bike);
    this.inited = true;

    /* handheld: organic jitter that grows with speed (wind buffet) and rough ground, plus impact shake */
    this.shake = damp(this.shake, 0, 3.5, dt);
    const sK = clamp(speed / 14, 0, 1.3);
    const rough = bike.grounded ? ROUGHNESS[bike.surface] * sK * (bike.trailDist < 1.5 ? 0.6 : 1) : 0.15 * sK;
    const amp = (0.005 + 0.02 * rough) * (0.35 + 0.65 * life) + 0.012 * sK * sK * life + this.shake * 0.05;
    // landing punch: a quick dip that springs back (≈3 Hz, lightly damped)
    const w = 19;
    this.punchV += (-w * w * this.punchY - 2 * 0.42 * w * this.punchV) * dt;
    this.punchY = clamp(this.punchY + this.punchV * dt, -0.35, 0.2);
    this.right.set(Math.cos(a), 0, Math.sin(a));
    this.camera.position.copy(this.pos).addScaledVector(this.right, noise1(t * 7.3, 11) * amp);
    this.camera.position.y += noise1(t * 8.9, 12) * amp * 1.25 + this.punchY;
    const cp = this.camera.position;
    cp.y = Math.max(cp.y, ground.heightAt(cp.x, cp.z) + 0.42);
    this.look.y += this.punchY * 0.6;
    this.camera.lookAt(this.look);

    /* Dutch roll: bank with the rider, plus a slow drift */
    const rollT = (bike.grounded ? -bike.lean * lerp(0.14, 0.32, life) : 0) + (sh.roll + noise1(t * 0.27, 7) * 0.05 - this.orbit * 0.06) * life;
    this.roll = damp(this.roll, clamp(rollT, -0.22, 0.22), 4, dt);
    this.camera.rotateZ(this.roll);
    const rot = amp * 0.3;
    this.camera.rotateX(noise1(t * 5.1, 13) * rot);
    this.camera.rotateY(noise1(t * 4.3, 14) * rot);

    /* lens: widen with speed, in the air and on boosts, and breathe a little */
    this.kick = damp(this.kick, 0, 1.3, dt);
    let fovT = p.fov + clamp(speed - 5, 0, 20) * lerp(0.65, 0.78, life) + noise1(t * 0.17, 8) * 1.6 * life + this.airK * 5;
    fovT = Math.min(MAX_FOV, fovT) + this.kick * 9 * life;
    this.fov = first ? fovT : damp(this.fov, fovT, this.kick > 0.05 ? 6 : 3, dt);
    // never narrower than what keeps the whole rider in frame
    if (life > 0) this.fov = Math.max(this.fov, this.fitFov);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    if (dt > 0) this.velocity.copy(this.camera.position).sub(this.lastPos).divideScalar(dt);
    this.lastPos.copy(this.camera.position);
  }

  /**
   * The orbit nearest `want` (scanning back toward straight behind) whose camera path over the next half
   * second stays clear of prop colliders. Straight behind is the rider's own wake, so it is normally clear.
   */
  private clearOrbit(want: number, dist: number, height: number, bike: BikePhysics, ground: Ground): number {
    const pos = bike.pos;
    const v = bike.vel;
    for (const k of ORBIT_FALLBACK) {
      const a = this.yaw + want * k;
      const ox = -Math.sin(a) * dist;
      const oz = Math.cos(a) * dist;
      let clear = true;
      for (let s = 0; s <= 0.5 && clear; s += 0.25) {
        const x = pos.x + v.x * s + ox;
        const z = pos.z + v.z * s + oz;
        const y = Math.max(pos.y + v.y * s + height, ground.heightAt(x, z) + 0.75);
        if (ground.collide(x, z, y, 0.85)) clear = false;
      }
      if (clear) return want * k;
    }
    return 0;
  }

  /** Re-aim the look point so the whole rider (wheels to head, flips included) stays comfortably inside the frame. */
  private frameRider(bike: BikePhysics) {
    const pos = bike.pos;
    const cam = this.pos;
    const look = this.look;
    // tricks rotate the rider about the wheel contact point, so take the body's extent along the bike's up axis
    const up = this.tmp.set(0, 1.8, 0).applyEuler(bike.orientation(this.euler));
    const lx = look.x - cam.x;
    const lz = look.z - cam.z;
    const lh = Math.max(0.5, Math.hypot(lx, lz));
    const rx = pos.x + up.x * 0.5 - cam.x;
    const rz = pos.z + up.z * 0.5 - cam.z;
    const rh = Math.max(0.3, Math.hypot(rx, rz));
    // vertical extent of the rider seen from the camera; widen the lens if it would not fit inside the margins
    // (the margin leaves room for the Dutch roll and handheld jitter applied after aiming)
    const MARGIN = 0.72;
    const lo = Math.atan2(pos.y + Math.min(0, up.y) - cam.y, rh);
    const hi = Math.atan2(pos.y + Math.max(0, up.y) - cam.y, rh);
    let vHalf = THREE.MathUtils.degToRad(this.fov * 0.5);
    const need = (hi - lo) / (2 * MARGIN);
    this.fitFov = Math.min(100, THREE.MathUtils.radToDeg(need * 2));
    vHalf = Math.max(vHalf, need);
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    // sideways: rider within the middle ~60% of the frame (leaves room for Dutch roll)
    const azRider = Math.atan2(rx, rz);
    const dAz = wrapAngle(Math.atan2(lx, lz) - azRider);
    const maxAz = hHalf * 0.6;
    const az = Math.abs(dAz) > maxAz ? azRider + Math.sign(dAz) * maxAz : azRider + dAz;
    // vertically: wheels above the bottom edge and head below the top
    const m = vHalf * MARGIN;
    let pitch = Math.atan2(look.y - cam.y, lh);
    pitch = Math.min(pitch, lo + m);
    pitch = Math.max(pitch, hi - m);
    look.set(cam.x + Math.sin(az) * lh, cam.y + Math.tan(pitch) * lh, cam.z + Math.cos(az) * lh);
  }

  /** Diagnostics for the capture scripts. */
  debug() {
    const r = (v: number) => Math.round(v * 100) / 100;
    return { mode: this.mode, shot: this.shot, want: SHOTS[this.shot].orbit, orbit: r(this.orbit), dodge: r(this.dodge), dist: r(this.dist), height: r(this.height), roll: r(this.roll) };
  }

  /** Establishing shot → chase blend. t in [0,1]. */
  intro(t: number, from: THREE.Vector3, fromLook: THREE.Vector3, bike: BikePhysics, ground: Ground) {
    this.update(1 / 60, bike, ground);
    const k = smootherstep(0, 1, t);
    const chasePos = this.camera.position.clone();
    const chaseLook = this.look.clone();
    this.camera.position.lerpVectors(from, chasePos, k);
    // keep the swoop above the ground (and grass); clearance eases into the chase cam's 0.6 m
    const cp = this.camera.position;
    cp.y = Math.max(cp.y, ground.heightAt(cp.x, cp.z) + THREE.MathUtils.lerp(2.0, 0.6, k));
    const lk = new THREE.Vector3().lerpVectors(fromLook, chaseLook, k);
    this.camera.lookAt(lk);
    this.camera.rotateZ(this.roll * k);
    this.camera.fov = THREE.MathUtils.lerp(46, this.fov, k);
    this.camera.updateProjectionMatrix();
    this.velocity.set(0, 0, 0);
    this.lastPos.copy(this.camera.position);
  }

  /** Focus of expansion (UV) and forward speed for the motion-blur pass. */
  motion(out: { forwardSpeed: number; foe: THREE.Vector2 }) {
    const v = this.velocity;
    const sp = v.length();
    const dir = this.tmp.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    out.forwardSpeed = sp > 0.5 ? Math.max(0, v.dot(dir)) : 0;
    if (sp > 0.5) {
      const p = this.tmp2.copy(this.camera.position).addScaledVector(v, 100 / sp).project(this.camera);
      out.foe.set(clamp(p.x * 0.5 + 0.5, -0.5, 1.5), clamp(p.y * 0.5 + 0.5, -0.5, 1.5));
    }
    return out;
  }
}
