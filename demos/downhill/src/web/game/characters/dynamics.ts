import * as THREE from 'three';
import { clamp } from './util';

const GRAVITY = 9.81;
const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Standard normal sample (Box-Muller). */
function gauss(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface Axis {
  /** Natural frequency (Hz) and damping ratio of the limb "suspension" along this axis. */
  hz: number;
  zeta: number;
  /** How strongly the bike's specific force drives the body (fraction of a free mass). */
  gain: number;
  min: number;
  max: number;
}

const AXES: Axis[] = [
  { hz: 2.0, zeta: 0.55, gain: 0.1, min: -0.045, max: 0.045 }, // x: sway
  { hz: 2.7, zeta: 0.42, gain: 0.26, min: -0.09, max: 0.045 }, // y: heave (arms + legs absorb)
  { hz: 1.9, zeta: 0.5, gain: 0.22, min: -0.06, max: 0.06 }, // z: surge (braking / landing pitch)
];

/**
 * Secondary "ride" motion: the rider's arms and legs act as suspension between the body and the bike.
 * Each frame the bike's specific-force impulse (the velocity change an accelerometer on the bike would
 * integrate, minus the 1 g resting load, in the bike frame) kicks a damped spring per axis, plus random
 * terrain chatter; the result offsets the pelvis and adds a little torso pitch / roll. Using the impulse
 * (not the clamped acceleration) keeps the response proportional to how hard a landing is, independent
 * of the frame rate. Shared by every character rig.
 */
export class RideDynamics {
  /** Body offset relative to the bike, bike-local metres (x right, y up, z back). */
  readonly offset = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  private readonly prevV = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private hasPrev = false;

  /** Extra torso pitch (rad, + = further forward) and roll (+ = right) implied by the offset. */
  get pitch(): number {
    return clamp(-this.offset.z * 2.4 - this.offset.y * 0.9, -0.16, 0.22);
  }
  get roll(): number {
    return clamp(this.offset.x * 2.2, -0.12, 0.12);
  }

  reset(): void {
    this.offset.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.hasPrev = false;
  }

  /**
   * @param bikeWorld world matrix of the bike frame (the rig root's parent)
   * @param velocity world velocity of the bike (m/s); estimated from motion when absent
   * @param amount 0..1 overall strength (0 while crashed)
   */
  update(dt: number, bikeWorld: THREE.Matrix4 | null, velocity: THREE.Vector3 | undefined, roughness: number, speed: number, grounded: boolean, amount: number): void {
    if (!(dt > 0) || dt > 0.25 || amount <= 0) {
      this.reset();
      return;
    }
    // bike velocity (world)
    let v = _s;
    if (bikeWorld) _p.setFromMatrixPosition(bikeWorld);
    if (velocity) v.copy(velocity);
    else if (bikeWorld && this.hasPrev) v.copy(_p).sub(this.prevPos).divideScalar(dt);
    else v.set(0, 0, 0);
    if (bikeWorld) this.prevPos.copy(_p);
    // a velocity jump no rider could feel (respawn, teleport) restarts the springs instead of kicking them
    if (this.hasPrev && v.distanceToSquared(this.prevV) > 30 * 30) this.reset();
    if (!this.hasPrev) {
      this.prevV.copy(v);
      this.hasPrev = true;
    }
    // specific-force impulse over the frame, into the bike frame, relative to the resting 1 g
    _f.copy(v).sub(this.prevV);
    this.prevV.copy(v);
    _f.y += GRAVITY * dt;
    if (bikeWorld) {
      _q.setFromRotationMatrix(bikeWorld).invert();
      _f.applyQuaternion(_q);
    }
    _f.y -= GRAVITY * dt;
    // no landing is harder than ~7 m/s of sudden stop (bigger values are physics glitches)
    _f.clampLength(0, 7);

    const o = this.offset;
    const ov = this.velocity;
    const chatter = grounded ? clamp(roughness, 0, 1) * clamp(speed / 14, 0, 1.4) : 0;
    for (let a = 0; a < 3; a++) {
      const ax = AXES[a];
      const w = 2 * Math.PI * ax.hz;
      let x = o.getComponent(a);
      // the body lags the bike: it receives the opposite of the bike's impulse (scaled by the limb gain)
      let xv = ov.getComponent(a) - ax.gain * _f.getComponent(a) * amount;
      // semi-implicit Euler is stable for these stiffnesses at >= 30 fps
      xv += (-w * w * x - 2 * ax.zeta * w * xv) * dt;
      // white-noise terrain chatter (mostly vertical, a little sway)
      if (chatter > 0) xv += gauss() * Math.sqrt((a === 1 ? 0.34 : a === 0 ? 0.05 : 0.08) * chatter * amount * dt);
      x += xv * dt;
      if (x < ax.min) {
        x = ax.min;
        if (xv < 0) xv *= -0.2;
      } else if (x > ax.max) {
        x = ax.max;
        if (xv > 0) xv *= -0.2;
      }
      o.setComponent(a, x);
      ov.setComponent(a, xv);
    }
  }
}
