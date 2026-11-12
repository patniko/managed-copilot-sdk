import { clamp, wrapAngle } from '../core/math';
import { emptyFrame, type InputFrame } from '../core/input';
import type { BikePhysics } from './bike';
import { GRAVITY } from './bike';
import type { TrailNetwork, Trail } from '../world/trails';
import type { JumpFeature } from '../world/features';

type BotTrick = 'backflip' | 'frontflip' | 'spin' | 'superman' | 'noHander' | 'canCan' | 'tailwhip' | 'barspin' | 'none';

/** Simple trail-following rider AI with tricks. */
export class Autopilot {
  private frame: InputFrame = emptyFrame();
  private trick: BotTrick = 'none';
  private trickT = 0;
  private holdJump = 0;
  private trail: Trail;
  tricksEnabled = true;
  targetSpeed = 16.5;
  private rng = Math.random;

  constructor(
    private net: TrailNetwork,
    private features: JumpFeature[],
    trail?: Trail,
  ) {
    this.trail = trail ?? net.main;
  }

  read(bike: BikePhysics, dt: number): InputFrame {
    const f = this.frame;
    f.steer = f.throttle = f.brake = f.flip = f.spin = f.roll = 0;
    f.jump = false;
    f.grabs.superman = f.grabs.noHander = f.grabs.canCan = f.grabs.tailwhip = f.grabs.barspin = false;
    if (bike.crashed) return f;
    const sp = bike.speed;
    if (bike.grounded) {
      this.trick = 'none';
      const hit = this.net.nearest(bike.pos.x, bike.pos.z, 80, (t) => t === this.trail) ?? this.net.nearest(bike.pos.x, bike.pos.z, 200);
      if (hit) {
        const look = 4 + sp * 0.55;
        const target = this.net.sample(hit.trail, hit.s + look);
        const want = Math.atan2(target.x - bike.pos.x, -(target.z - bike.pos.z));
        const err = wrapAngle(want - bike.heading);
        f.steer = clamp(err * 2.4, -1, 1);
        // curvature ahead → slow down
        const ahead = this.net.sample(hit.trail, hit.s + look + 15);
        const turn = Math.abs(wrapAngle(ahead.heading - target.heading));
        const limit = turn > 0.6 ? 11 : turn > 0.35 ? 14 : this.targetSpeed + 4.5;
        if (sp < Math.min(limit, this.targetSpeed)) f.throttle = 1;
        if (sp > limit + 1.5) f.brake = clamp((sp - limit) / 4, 0.2, 1);
        // pop at kicker lips
        const k = this.upcomingLip(bike);
        if (k !== null && k < 2.2 && k > 0.2) this.holdJump = 0.3;
      }
      if (this.holdJump > 0) {
        this.holdJump -= dt;
        f.jump = this.holdJump > 0.05;
      }
    } else {
      this.holdJump = 0;
      const a = bike.air;
      if (this.tricksEnabled && this.trick === 'none' && a.time > 0.12 && a.time < 0.3 && bike.vel.y > 2.5) {
        // only commit to what fits in the remaining airtime (flips ≈1.1 s plus levelling, spins ≈0.85 s); the
        // estimate ignores drag, so keep a margin
        const left = this.airtimeLeft(bike);
        const opts: BotTrick[] = [];
        if (left > 0.8) opts.push('superman', 'noHander', 'canCan', 'tailwhip', 'barspin');
        if (left > 1.1) opts.push('spin');
        if (left > 1.5 && bike.vel.y > 4.5) opts.push('backflip', 'backflip', 'frontflip');
        if (opts.length) this.trick = opts[Math.floor(this.rng() * opts.length)];
        this.trickT = 0;
      }
      this.trickT += dt;
      const t = this.trickT;
      switch (this.trick) {
        case 'backflip':
          if (Math.abs(a.flip) < Math.PI * 2 - 0.9) f.flip = -1;
          break;
        case 'frontflip':
          if (Math.abs(a.flip) < Math.PI * 2 - 0.9) f.flip = 1;
          break;
        case 'spin':
          if (Math.abs(a.spin) < Math.PI * 2 - 0.9) f.spin = 1;
          break;
        case 'superman':
        case 'noHander':
        case 'canCan':
          f.grabs[this.trick] = t < 0.45 && bike.vel.y > -6;
          break;
        case 'tailwhip':
        case 'barspin':
          f.grabs[this.trick] = t < 0.1;
          break;
      }
    }
    return f;
  }

  /** Ballistic estimate of the seconds until touchdown (ignores drag; slightly optimistic). */
  private airtimeLeft(bike: BikePhysics): number {
    const dt = 1 / 30;
    let x = bike.pos.x,
      y = bike.pos.y,
      z = bike.pos.z,
      vy = bike.vel.y;
    for (let t = dt; t < 4; t += dt) {
      vy -= GRAVITY * dt;
      x += bike.vel.x * dt;
      y += vy * dt;
      z += bike.vel.z * dt;
      if (y <= bike.ground.heightAt(x, z)) return t;
    }
    return 4;
  }

  /** Distance to the next kicker lip straight ahead, or null. */
  private upcomingLip(bike: BikePhysics): number | null {
    let best: number | null = null;
    for (const ft of this.features) {
      const l = ft.toLocal(bike.pos.x, bike.pos.z);
      if (Math.abs(l.v) > ft.shape.hw) continue;
      const d = ft.lipU - l.u;
      if (l.u > -1 && d >= 0 && d < 6 && ft.shape.lip > 0.3) best = best === null ? d : Math.min(best, d);
    }
    return best;
  }
}
