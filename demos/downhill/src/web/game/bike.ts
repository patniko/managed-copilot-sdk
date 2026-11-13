import * as THREE from 'three';
import { clamp, damp, wrapAngle } from '../core/math';
import type { Surface } from '../core/audioTypes';
import type { InputFrame, GrabTrick } from '../core/input';
import { makeHit, type Ground, type GroundHit } from '../world/ground';

export const GRAVITY = 9.81;
const RR: Record<Surface, number> = { dirt: 0.012, wood: 0.01, grass: 0.04, sand: 0.11, rock: 0.02, snow: 0.05 };
const GRIP: Record<Surface, number> = { dirt: 11, wood: 12, grass: 7.5, sand: 4.5, rock: 9, snow: 4 };
const DRAG = 0.003;
const HALF_WB = 0.58;

/**
 * A bike standing still at (x, z), facing `heading`: the height and pitch that put both wheels on the ground as it's
 * drawn (the trail's ribbon included). For bikes placed outside a ride (the shop's preview, the select screen).
 */
export function standingOn(ground: Ground, x: number, z: number, heading: number): { y: number; pitch: number } {
  const fx = Math.sin(heading) * HALF_WB;
  const fz = -Math.cos(heading) * HALF_WB;
  const hf = ground.drawnHeightAt(x + fx, z + fz);
  const hr = ground.drawnHeightAt(x - fx, z - fz);
  return { y: (hf + hr) / 2, pitch: Math.atan2(hr - hf, HALF_WB * 2) };
}
/** Pedalling: peak drive (m/s²) fading to nothing at PEDAL_TOP (m/s). */
const PEDAL_ACCEL = 6.8;
const PEDAL_TOP = 17.5;
/** Boosts (trick landings) surge at this rate (m/s²) and stop adding speed above BOOST_TOP (m/s). */
const BOOST_ACCEL = 10;
const BOOST_TOP = 22;

export type LandingResult =
  | { ok: true; perfect: boolean; impact: number; pitchErr: number; yawErr: number }
  | { ok: false; reason: string; impact: number };

export interface AirState {
  time: number;
  flip: number;
  spin: number;
  roll: number;
  flipVel: number;
  spinVel: number;
  takeoffHeading: number;
  takeoffPitch: number;
  /** Heading of the velocity at takeoff (camera follows this, not the spinning bike). */
  travelHeading: number;
  startY: number;
  maxY: number;
  fromFeature: boolean;
  popped: boolean;
}

export interface TrickTimers {
  /** Grab blend weights 0..1. */
  grabs: Record<'superman' | 'noHander' | 'canCan', number>;
  /** One-shot rotation progress 0..1 (0 = idle). */
  tailwhip: number;
  barspin: number;
  tailwhipCount: number;
  barspinCount: number;
}

export interface BikeEvents {
  onLaunch?(air: AirState, bike: BikePhysics): void;
  onLand?(res: LandingResult, air: AirState, bike: BikePhysics): void;
  onCrash?(reason: string, bike: BikePhysics): void;
  onPop?(charge: number): void;
  onBush?(): void;
  onTrickStart?(name: GrabTrick): void;
}

/** Arcade-but-grounded mountain bike physics (single contact point + orientation). */
export class BikePhysics {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  heading = 0;
  grounded = true;
  crashed = false;
  normal = new THREE.Vector3(0, 1, 0);
  surface: Surface = 'grass';
  feature: GroundHit['feature'] = null;
  trailDist = 1e4;
  /** Smoothed visual values. */
  steer = 0;
  lean = 0;
  pitch = 0;
  compress = 0;
  preload = 0;
  skid = 0;
  pedaling = false;
  braking = false;
  wheelAngle = 0;
  crank = 0;
  airTime = 0;
  air: AirState = {
    time: 0,
    flip: 0,
    spin: 0,
    roll: 0,
    flipVel: 0,
    spinVel: 0,
    takeoffHeading: 0,
    takeoffPitch: 0,
    travelHeading: 0,
    startY: 0,
    maxY: 0,
    fromFeature: false,
    popped: false,
  };
  tricks: TrickTimers = { grabs: { superman: 0, noHander: 0, canCan: 0 }, tailwhip: 0, barspin: 0, tailwhipCount: 0, barspinCount: 0 };
  private hit = makeHit();
  private hit2 = makeHit();
  private jumpHeld = false;
  private jumpHoldT = 0;
  private lastPopT = -10;
  private t = 0;
  private prevGrab = { tailwhip: false, barspin: false };
  /** Assist strength 0..1 (auto-level in the air). */
  assist = 1;
  /** Speed still to be added by an active boost (m/s). */
  boostLeft = 0;
  events: BikeEvents = {};

  constructor(readonly ground: Ground) {}

  reset(x: number, z: number, heading: number, speed = 0) {
    this.ground.query(x, z, this.hit);
    this.pos.set(x, this.hit.h, z);
    this.heading = heading;
    const fwd = this.forward2(new THREE.Vector3());
    this.vel.copy(fwd).multiplyScalar(speed);
    this.grounded = true;
    this.crashed = false;
    this.normal.set(this.hit.nx, this.hit.ny, this.hit.nz);
    this.steer = this.lean = this.compress = this.preload = this.skid = 0;
    this.air.flip = this.air.spin = this.air.roll = this.air.flipVel = this.air.spinVel = 0;
    this.tricks.grabs.superman = this.tricks.grabs.noHander = this.tricks.grabs.canCan = 0;
    this.tricks.tailwhip = this.tricks.barspin = 0;
    this.jumpHeld = false;
    this.boostLeft = 0;
    this.pitch = this.groundPitch();
  }

  /** Shove the bike forward to at least `speed` along the ground (a drop-in start). */
  push(speed: number) {
    if (!this.grounded || this.forwardSpeed >= speed) return;
    this.ground.query(this.pos.x, this.pos.z, this.hit);
    const f = this.forward2(new THREE.Vector3());
    const n = new THREE.Vector3(this.hit.nx, this.hit.ny, this.hit.nz);
    f.addScaledVector(n, -f.dot(n)).normalize();
    this.vel.copy(f).multiplyScalar(speed);
  }

  /** Queue a burst of extra speed (m/s), delivered over a fraction of a second while riding. */
  boost(dv: number) {
    this.boostLeft = Math.min(4, this.boostLeft + Math.max(0, dv));
  }

  forward2(out: THREE.Vector3) {
    return out.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  get speed() {
    return this.vel.length();
  }

  /** Forward speed along the heading (signed). */
  get forwardSpeed() {
    return this.vel.x * Math.sin(this.heading) - this.vel.z * Math.cos(this.heading);
  }

  groundPitch() {
    const fx = Math.sin(this.heading) * HALF_WB;
    const fz = -Math.cos(this.heading) * HALF_WB;
    const hf = this.ground.heightAt(this.pos.x + fx, this.pos.z + fz);
    const hr = this.ground.heightAt(this.pos.x - fx, this.pos.z - fz);
    return Math.atan2(hr - hf, HALF_WB * 2);
  }

  /** Advance by dt (call with small fixed steps). */
  step(dt: number, inp: InputFrame) {
    this.t += dt;
    if (this.crashed) return;
    // jump preload / pop
    if (inp.jump) {
      this.jumpHoldT += dt;
      this.preload = Math.min(1, this.jumpHoldT / 0.35);
    }
    let popCharge = -1;
    if (!inp.jump && this.jumpHeld) {
      popCharge = Math.min(1, this.jumpHoldT / 0.35);
      this.jumpHoldT = 0;
    }
    if (!inp.jump) this.preload = damp(this.preload, 0, 10, dt);
    this.jumpHeld = inp.jump;

    if (this.grounded) this.stepGround(dt, inp, popCharge);
    else this.stepAir(dt, inp);
    this.stepTricks(dt, inp);

    // obstacles
    const c = this.ground.collide(this.pos.x, this.pos.z, this.pos.y + 0.4, 0.35);
    if (c) {
      if (c.kind === 'soft') {
        const k = Math.exp(-2.2 * dt);
        this.vel.x *= k;
        this.vel.z *= k;
        this.events.onBush?.();
      } else if (this.speed > 5.5) {
        this.crash('Smashed into an obstacle');
        return;
      } else {
        // push out
        const dx = this.pos.x - c.x;
        const dz = this.pos.z - c.z;
        const d = Math.hypot(dx, dz) || 1;
        this.pos.x = c.x + (dx / d) * (c.r + 0.36);
        this.pos.z = c.z + (dz / d) * (c.r + 0.36);
        this.vel.multiplyScalar(0.3);
      }
    }
    // wheels and cranks
    const fs = this.forwardSpeed;
    this.wheelAngle += (fs / 0.36) * dt;
    if (this.pedaling) this.crank += Math.min(9, 1.6 + Math.abs(fs) * 0.55) * dt;
  }

  private stepGround(dt: number, inp: InputFrame, popCharge: number) {
    const g = this.ground.query(this.pos.x, this.pos.z, this.hit);
    this.surface = g.surface;
    this.feature = g.feature;
    this.trailDist = g.trailDist;
    const f2x = Math.sin(this.heading);
    const f2z = -Math.cos(this.heading);
    // Riding plane from a BACKWARD difference along travel (so sharp lips keep the ramp angle)
    // and a central lateral difference.
    const e = 0.16;
    const back = this.forwardSpeed >= 0 ? 1 : -1;
    const hb = this.ground.heightAt(this.pos.x - f2x * e * back, this.pos.z - f2z * e * back);
    const hl = this.ground.heightAt(this.pos.x - Math.cos(this.heading) * e, this.pos.z - Math.sin(this.heading) * e);
    const hr = this.ground.heightAt(this.pos.x + Math.cos(this.heading) * e, this.pos.z + Math.sin(this.heading) * e);
    let sF = ((g.h - hb) / e) * back;
    // At a crease the two sides disagree. Behind a kicker lip the bike really rode the ramp, but just after touching
    // down on the knuckle of a landing the face behind the wheel was never ridden: keep whichever side matches the
    // bike's actual path.
    const ha = this.ground.heightAt(this.pos.x + f2x * e * back, this.pos.z + f2z * e * back);
    const sA = ((ha - g.h) / e) * back;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (Math.abs(sF - sA) > 0.5 && hs > 1) {
      const sV = (this.vel.y / hs) * back;
      if (Math.abs(sA - sV) < Math.abs(sF - sV)) sF = sA;
    }
    const sR = (hr - hl) / (2 * e);
    // n = R x T with T = (f, sF), R = (right, sR)
    const Rx = Math.cos(this.heading),
      Rz = Math.sin(this.heading);
    let nx = sR * f2z - Rz * sF,
      ny = Rz * f2x - Rx * f2z,
      nz = Rx * sF - sR * f2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const n = this.normal.set(nx, ny, nz);
    // tangent along heading
    const fd = f2x * n.x + f2z * n.z;
    let tx = f2x - n.x * fd,
      ty = -n.y * fd,
      tz = f2z - n.z * fd;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // right = t x n
    let rx = ty * n.z - tz * n.y,
      ry = tz * n.x - tx * n.z,
      rz = tx * n.y - ty * n.x;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl;
    ry /= rl;
    rz /= rl;
    let v = this.vel.x * tx + this.vel.y * ty + this.vel.z * tz;
    let vl = this.vel.x * rx + this.vel.y * ry + this.vel.z * rz;
    // Rotate (not project) the velocity into the riding plane so smooth transitions keep speed;
    // only an impact into the surface costs energy.
    const vn0 = this.vel.x * n.x + this.vel.y * n.y + this.vel.z * n.z;
    const inPlane = Math.hypot(v, vl);
    if (inPlane > 1e-3) {
      const full = this.vel.length();
      const k = Math.max(0, full - Math.max(0, -vn0 - 0.9) * 0.35) / inPlane;
      v *= k;
      vl *= k;
    }
    this.compress = damp(this.compress, clamp(-vn0 * 0.5, 0, 1) + this.preload * 0.6, 6, dt);

    // longitudinal forces
    let a = -GRAVITY * ty;
    this.pedaling = inp.throttle > 0.05;
    this.braking = inp.brake > 0.05;
    if (this.pedaling) a += inp.throttle * PEDAL_ACCEL * Math.max(0, 1 - v / PEDAL_TOP);
    if (this.boostLeft > 0) {
      const add = Math.min(this.boostLeft, BOOST_ACCEL * dt);
      this.boostLeft -= add;
      if (v < BOOST_TOP && !this.braking) a += add / dt;
    }
    const rr = RR[this.surface] * GRAVITY * n.y;
    a -= Math.sign(v) * rr;
    a -= DRAG * (1 - 0.25 * this.preload) * v * Math.abs(v);
    v += a * dt;
    if (this.braking) {
      const b = inp.brake * 8.5 * dt;
      v = Math.abs(v) <= b ? 0 : v - Math.sign(v) * b;
    }
    if (v < -3) v = -3;

    // steering (tighter at low speed)
    this.steer = damp(this.steer, inp.steer, 9, dt);
    const sp = Math.max(0, v);
    const R = 3.2 + 0.085 * sp * sp;
    const omega = this.steer * Math.min(1.7, (sp + 1.4) / R);
    this.heading = wrapAngle(this.heading + omega * dt);
    // lateral grip
    const grip = GRIP[this.surface] * (this.braking ? 0.75 : 1);
    vl *= Math.exp(-grip * dt);
    this.skid = clamp(Math.abs(vl) / 3.2 + (this.braking && sp > 6 ? 0.3 : 0), 0, 1);
    // visual lean into the turn (with berm banking feeling)
    const targetLean = clamp(Math.atan2(sp * omega, GRAVITY), -0.75, 0.75);
    this.lean = damp(this.lean, targetLean, 8, dt);

    this.vel.set(tx * v + rx * vl, ty * v + ry * vl, tz * v + rz * vl);

    // pop
    if (popCharge >= 0) {
      const onKicker = !!g.feature;
      const impulse = (2.6 + 2.6 * popCharge) * (onKicker ? 1.25 : 1);
      this.vel.addScaledVector(n, impulse);
      this.lastPopT = this.t;
      this.events.onPop?.(popCharge);
      this.launch(true, !!g.feature);
      this.pos.addScaledVector(this.vel, dt);
      return;
    }

    // integrate and follow the ground
    const prevH = g.h;
    this.pos.addScaledVector(this.vel, dt);
    const g2 = this.ground.query(this.pos.x, this.pos.z, this.hit2);
    const gap = this.pos.y - g2.h;
    const aNeed = (2 * gap) / (dt * dt);
    const aAllow = GRAVITY * n.y + 5.5;
    if (gap > 0.004 && aNeed > aAllow) {
      this.launch(this.t - this.lastPopT < 0.3, !!g.feature);
      return;
    }
    // ran into a steep face (cased landing / jump face)
    if (g2.h - prevH > 0.45 && g2.ny < 0.6 && this.speed > 4) {
      this.crash('Cased it!');
      return;
    }
    this.pos.y = g2.h;
    this.pitch = damp(this.pitch, this.groundPitch(), 18, dt);
    this.airTime = 0;
  }

  private launch(popped: boolean, fromFeature: boolean) {
    this.grounded = false;
    const a = this.air;
    a.time = 0;
    a.flip = 0;
    a.spin = 0;
    a.roll = 0;
    a.flipVel = 0;
    a.spinVel = 0;
    a.takeoffHeading = this.heading;
    a.takeoffPitch = this.pitch;
    a.travelHeading = Math.atan2(this.vel.x, -this.vel.z);
    a.startY = this.pos.y;
    a.maxY = this.pos.y;
    a.fromFeature = fromFeature;
    a.popped = popped;
    this.events.onLaunch?.(a, this);
  }

  private stepAir(dt: number, inp: InputFrame) {
    const a = this.air;
    a.time += dt;
    this.airTime = a.time;
    this.pedaling = false;
    this.braking = false;
    this.vel.y -= GRAVITY * dt;
    const s = this.vel.length();
    this.vel.multiplyScalar(1 - DRAG * 0.6 * s * dt);
    this.pos.addScaledVector(this.vel, dt);
    a.maxY = Math.max(a.maxY, this.pos.y);
    this.compress = damp(this.compress, this.preload * 0.5 + 0.15, 6, dt);
    this.lean = damp(this.lean, 0, 3, dt);
    this.steer = damp(this.steer, 0, 4, dt);
    this.skid = 0;

    // predicted landing slope pitch (for assist)
    const hdg = a.takeoffHeading + a.spin;
    const fx = Math.sin(hdg) * HALF_WB,
      fz = -Math.cos(hdg) * HALF_WB;
    const lx = this.pos.x + this.vel.x * 0.25,
      lz = this.pos.z + this.vel.z * 0.25;
    const slopePitch = Math.atan2(this.ground.heightAt(lx - fx, lz - fz) - this.ground.heightAt(lx + fx, lz + fz), HALF_WB * 2);
    // flips
    const flipTarget = inp.flip * 6.9;
    if (Math.abs(inp.flip) > 0.1) a.flipVel = damp(a.flipVel, flipTarget, 7, dt);
    else {
      a.flipVel = damp(a.flipVel, 0, 6.5, dt);
      const pitchNow = a.takeoffPitch + a.flip;
      const err = wrapAngle(slopePitch - pitchNow);
      // assist: level out toward the landing when close (or when no rotation is underway)
      if (Math.abs(err) < 0.9 && Math.abs(a.flipVel) < 4) a.flip += err * Math.min(1, 3.2 * dt) * this.assist;
    }
    a.flip += a.flipVel * dt;
    // spins
    const spinTarget = inp.spin * 7.6;
    if (Math.abs(inp.spin) > 0.1) a.spinVel = damp(a.spinVel, spinTarget, 7, dt);
    else {
      a.spinVel = damp(a.spinVel, 0, 6.5, dt);
      const travel = Math.atan2(this.vel.x, -this.vel.z);
      const err = wrapAngle(travel - (a.takeoffHeading + a.spin));
      if (Math.abs(err) < 0.85 && Math.abs(a.spinVel) < 4) a.spin += err * Math.min(1, 3 * dt) * this.assist;
    }
    a.spin += a.spinVel * dt;
    // tabletop always lays the bike right-side-down (the rider rigs counter-twist that way)
    a.roll = damp(a.roll, Math.abs(inp.roll) * 0.95, 6, dt);
    this.pitch = a.takeoffPitch + a.flip;

    // landing
    const g = this.ground.query(this.pos.x, this.pos.z, this.hit);
    if (this.pos.y <= g.h) {
      this.pos.y = g.h;
      const px = this.pos.x,
        pz = this.pos.z;
      const hr = this.ground.heightAt(px - fx, pz - fz);
      const hf = this.ground.heightAt(px + fx, pz + fz);
      let touchPitch = Math.atan2(hr - hf, HALF_WB * 2);
      // touching down on an edge (the end of a deck, the knuckle of a landing) leaves one wheel over the drop: the
      // bike lands on the half under the other wheel, so judge the landing against whichever half fits it best
      const rearP = Math.atan2(hr - g.h, HALF_WB);
      const frontP = Math.atan2(g.h - hf, HALF_WB);
      if (Math.abs(rearP - frontP) > 0.35) {
        const bikeP = a.takeoffPitch + a.flip;
        touchPitch = Math.abs(wrapAngle(bikeP - rearP)) < Math.abs(wrapAngle(bikeP - frontP)) ? rearP : frontP;
        // the queried normal there belongs to the face below the edge: land on the chosen half's plane instead
        // (n = right × forward tangent, the tangent descending at the touch pitch)
        const rx = Math.cos(hdg);
        const rz = Math.sin(hdg);
        const ty = -Math.tan(touchPitch);
        const nx = -rz * ty;
        const ny = rz * Math.sin(hdg) + rx * Math.cos(hdg);
        const nz = rx * ty;
        const nl = Math.hypot(nx, ny, nz);
        g.nx = nx / nl;
        g.ny = ny / nl;
        g.nz = nz / nl;
      }
      this.land(g, touchPitch);
    }
  }

  private land(g: GroundHit, slopePitch: number) {
    const a = this.air;
    const n = this.normal.set(g.nx, g.ny, g.nz);
    const impact = Math.max(0, -this.vel.dot(n));
    const hdg = a.takeoffHeading + a.spin;
    const travel = Math.atan2(this.vel.x, -this.vel.z);
    const yawErr = wrapAngle(hdg - travel);
    const pitchErr = wrapAngle(a.takeoffPitch + a.flip - slopePitch);
    const tw = this.tricks;
    const midRotation = (tw.tailwhip > 0.12 && tw.tailwhip < 0.8) || (tw.barspin > 0.12 && tw.barspin < 0.8);
    const grab = Math.max(tw.grabs.superman, tw.grabs.noHander, tw.grabs.canCan);
    let reason = '';
    if (impact > 15) reason = 'Too hard — flat landing!';
    else if (Math.abs(pitchErr) > 0.8) reason = pitchErr > 0 ? 'Over-rotated!' : 'Looped out!';
    else if (Math.abs(yawErr) > 0.9) reason = 'Landed sideways!';
    else if (Math.abs(a.roll) > 0.65) reason = 'Too much tabletop!';
    else if (grab > 0.55) reason = 'Still holding the grab!';
    else if (midRotation) reason = 'Bike still spinning!';
    if (reason) {
      this.grounded = true;
      this.crash(reason, impact);
      return;
    }
    // complete partially finished rotations
    if (tw.tailwhip >= 0.8) tw.tailwhip = 0;
    if (tw.barspin >= 0.8) tw.barspin = 0;
    this.heading = wrapAngle(hdg);
    this.grounded = true;
    const vn = this.vel.dot(n);
    this.vel.addScaledVector(n, -vn);
    const loss = 0.22 * clamp(impact / 12, 0, 1) + 0.25 * clamp((Math.abs(yawErr) - 0.25) / 0.6, 0, 1);
    this.vel.multiplyScalar(1 - loss);
    // align velocity with the new heading
    const sp = this.vel.length();
    const f2 = this.forward2(new THREE.Vector3());
    const fd = f2.dot(n);
    const t = f2.addScaledVector(n, -fd).normalize();
    this.vel.copy(t).multiplyScalar(sp);
    this.compress = clamp(impact / 7, 0.25, 1);
    this.pitch = slopePitch;
    const perfect = Math.abs(pitchErr) < 0.2 && Math.abs(yawErr) < 0.22 && impact < 9;
    this.events.onLand?.({ ok: true, perfect, impact, pitchErr, yawErr }, a, this);
    a.flip = a.spin = a.roll = a.flipVel = a.spinVel = 0;
  }

  private stepTricks(dt: number, inp: InputFrame) {
    const tw = this.tricks;
    const air = !this.grounded;
    const canStart = air && this.air.time > 0.05;
    for (const k of ['superman', 'noHander', 'canCan'] as const) {
      const want = canStart && inp.grabs[k] ? 1 : 0;
      if (want && tw.grabs[k] < 0.05) this.events.onTrickStart?.(k);
      tw.grabs[k] = damp(tw.grabs[k], want, want ? 7 : 9, dt);
    }
    // one-shot rotations
    for (const k of ['tailwhip', 'barspin'] as const) {
      const pressed = inp.grabs[k] && !this.prevGrab[k];
      this.prevGrab[k] = inp.grabs[k];
      if (pressed && canStart && tw[k] === 0) {
        tw[k] = 0.001;
        this.events.onTrickStart?.(k);
      }
      if (tw[k] > 0) {
        tw[k] += dt / (k === 'tailwhip' ? 0.62 : 0.45);
        if (tw[k] >= 1) {
          tw[k] = 0;
          if (k === 'tailwhip') tw.tailwhipCount++;
          else tw.barspinCount++;
        }
      }
    }
    if (!air) {
      tw.grabs.superman = damp(tw.grabs.superman, 0, 14, dt);
      tw.grabs.noHander = damp(tw.grabs.noHander, 0, 14, dt);
      tw.grabs.canCan = damp(tw.grabs.canCan, 0, 14, dt);
    }
  }

  crash(reason: string, _impact = 0) {
    if (this.crashed) return;
    this.crashed = true;
    this.boostLeft = 0;
    this.events.onCrash?.(reason, this);
  }

  /** Visual orientation of the bike (rotation order YXZ). */
  orientation(out: THREE.Euler) {
    if (this.grounded) return out.set(-this.pitch, -this.heading, -this.lean, 'YXZ');
    const a = this.air;
    return out.set(-(a.takeoffPitch + a.flip), -(a.takeoffHeading + a.spin), -a.roll, 'YXZ');
  }
}
