import { clamp, damp, smoothstep } from '../core/math';
import type { LandingResult } from './bike';
import type { AirReport } from './tricks';
import {
  DEFAULT_CELEBRATIONS,
  EMOTE_LENGTH,
  defaultJumpPose,
  type Celebrations,
  type EmoteKind,
  type EmotePose,
  type JumpPose,
  type RiderPose,
} from './rider/types';

/** How the wheels left the ground. */
export interface Takeoff {
  /** The rider popped (released jump) rather than rolling off the lip. */
  popped: boolean;
  /** Off a kicker, drop or gap, rather than a bump in the trail. */
  fromFeature: boolean;
  /** Upward speed leaving the ground, m/s. */
  vy: number;
}

/** The flight, as the rider sees it each frame. */
export interface Flight {
  airborne: boolean;
  /** Seconds since takeoff. */
  airTime: number;
  /** Seconds until the wheels touch down: Infinity when that's further off than LOOK_AHEAD. */
  timeToLand: number;
  /** Height of the bike above the ground below it, m. */
  height: number;
  /** 0..1 how much a trick has hold of the rider's body (grabs, whips, tabletops). */
  tricking: number;
  /** 0..1 how fast the bike is flipping or spinning (the rider is busy riding the rotation, not whooping). */
  rotating: number;
  /** 0..1 jump preload (holding jump). */
  preload: number;
}

/** How far ahead (s) the rider looks for the landing. */
export const LOOK_AHEAD = 1.2;
/** The takeoff's extension peaks this long (s) after the lip. */
const POP_PEAK = 0.1;
/** Landing absorption: the legs-and-arms spring's frequency (Hz) and decay time (s). */
const ABSORB_W = 2 * Math.PI * 1.2;
const ABSORB_DECAY = 0.28;
/** First dip of e^(-t/decay)·sin(wt), so `absorb` peaks at exactly the landing's strength. */
const ABSORB_PEAK = (() => {
  const t = Math.atan(ABSORB_W * ABSORB_DECAY) / ABSORB_W;
  return Math.exp(-t / ABSORB_DECAY) * Math.sin(ABSORB_W * t);
})();
/** Celebrations start once the landing has been soaked up. */
const CELEBRATE_DELAY = 0.22;
/** A flight at least this long (s), or this high above the ground (m), is big air. */
const BIG_AIR_TIME = 1.05;
const BIG_AIR_HEIGHT = 2.6;

/**
 * Directs the rider's acting from what happens to the bike: how the body takes off, flies and lands (`jump`), and the
 * celebration or reaction it plays (`emote`). The rigs turn these into motion; this decides only what and when.
 */
export class Choreographer {
  readonly jump: JumpPose = defaultJumpPose();
  /** The emote playing, if any. */
  emote: EmotePose | null = null;
  private sinceLaunch = Infinity;
  private popK = 0;
  private sinceLand = Infinity;
  private landK = 0;
  private bigAir = false;
  private fading = false;
  private cued: { kind: EmoteKind; strength: number; delay: number; final?: boolean } | null = null;
  private last: EmoteKind | null = null;

  constructor(
    readonly celebrations: Celebrations = DEFAULT_CELEBRATIONS,
    private readonly random: () => number = Math.random,
  ) {}

  reset(): void {
    Object.assign(this.jump, defaultJumpPose());
    this.emote = null;
    this.cued = null;
    this.fading = false;
    this.sinceLaunch = this.sinceLand = Infinity;
    this.popK = this.landK = 0;
    this.bigAir = false;
  }

  /** The wheels left the ground: pop, and cut any celebration short. */
  launch(t: Takeoff): void {
    this.sinceLaunch = 0;
    this.sinceLand = Infinity;
    this.bigAir = false;
    this.popK = t.popped ? 1 : t.fromFeature ? clamp(0.4 + t.vy * 0.06, 0.4, 0.8) : clamp(t.vy * 0.15, 0.1, 0.45);
    // a celebration waiting to start is dropped, but not the finish line's: it waits for the landing
    if (!this.cued?.final) this.cued = null;
    if (this.emote) this.fading = true;
  }

  /**
   * The wheels touched down: soak it up in proportion to the impact, then celebrate (or not) by how it went.
   * `report` is the scored air (null for a small hop), `combo` the combo it landed in.
   */
  land(res: LandingResult, report: AirReport | null, combo: number): void {
    if (!res.ok) return;
    this.sinceLand = 0;
    this.landK = clamp(res.impact / 9, 0.2, 1);
    const pick = this.pick(res.sketchy, res.impact, report, combo);
    // (the finish line's celebration, if it's waiting, comes first)
    if (pick && !this.cued?.final) this.cued = { ...pick, delay: pick.kind === 'phew' ? 0 : CELEBRATE_DELAY };
  }

  /** Crossed the finish line. */
  finish(): void {
    this.cued = { kind: this.choose(this.celebrations.big), strength: 1, delay: 0.15, final: true };
  }

  /** Thrown off the bike: the tumble takes over. */
  crash(): void {
    this.reset();
  }

  /** Start an emote now. */
  play(kind: EmoteKind, strength = 1): void {
    this.emote = { kind, t: 0, strength, weight: 1 };
    this.fading = false;
    this.last = kind;
  }

  private pick(sketchy: boolean, impact: number, report: AirReport | null, combo: number): { kind: EmoteKind; strength: number } | null {
    if (sketchy) return { kind: 'phew', strength: clamp(impact / 10, 0.5, 1) };
    if (!report) return null;
    const total = report.total;
    const strength = clamp(0.45 + total / 3000, 0.45, 1);
    if (total >= 2400 || (total >= 1200 && (report.perfect || combo >= 3))) return { kind: this.choose(this.celebrations.big), strength };
    if (total >= 700) return { kind: this.choose(this.celebrations.trick), strength };
    return { kind: 'nod', strength };
  }

  /** One of `options`, favouring the first, and not the one just played when there's a choice. */
  private choose(options: readonly EmoteKind[]): EmoteKind {
    const pool = options.length > 1 ? options.filter((k) => k !== this.last) : options;
    if (!pool.length) return 'pump';
    const weight = (k: EmoteKind) => (k === options[0] ? 2 : 1);
    let r = this.random() * pool.reduce((sum, k) => sum + weight(k), 0);
    for (const k of pool) {
      r -= weight(k);
      if (r < 0) return k;
    }
    return pool[pool.length - 1];
  }

  update(dt: number, f: Flight): void {
    const j = this.jump;
    this.sinceLaunch += dt;
    this.sinceLand += dt;
    const sl = this.sinceLaunch;
    j.load = damp(j.load, f.airborne ? 0 : f.preload, 18, dt);
    // the pop: a quick extension off the lip that settles over ~0.4 s
    j.pop = sl < 0.8 ? this.popK * (sl / POP_PEAK) * Math.exp(1 - sl / POP_PEAK) : 0;
    if (f.airborne) {
      if (f.airTime + Math.min(f.timeToLand, LOOK_AHEAD) > BIG_AIR_TIME || f.height > BIG_AIR_HEIGHT) this.bigAir = true;
      // eyes on the landing for its last half second (but not for little hops)
      const spot = f.airTime + Math.min(f.timeToLand, LOOK_AHEAD) > 0.45 ? smoothstep(0.55, 0.12, f.timeToLand) : 0;
      j.spot = damp(j.spot, spot, 14, dt);
      const tuck = smoothstep(0.06, 0.3, sl) * (this.bigAir ? 0.85 : 0.55) * (1 - j.spot) * (1 - f.tricking);
      j.tuck = damp(j.tuck, tuck, 10, dt);
      const whoop = this.bigAir ? smoothstep(0.2, 0.5, f.airTime) * (1 - j.spot) * (1 - f.tricking) * (1 - f.rotating) : 0;
      // a whoop builds up, and is dropped quickly to focus on the landing
      j.whoop = damp(j.whoop, whoop, whoop > j.whoop ? 7 : 14, dt);
    } else {
      j.spot = damp(j.spot, 0, 6, dt);
      j.tuck = damp(j.tuck, 0, 12, dt);
      j.whoop = damp(j.whoop, 0, 8, dt);
    }
    const tl = this.sinceLand;
    j.absorb = tl < 1.6 ? (this.landK * Math.exp(-tl / ABSORB_DECAY) * Math.sin(ABSORB_W * tl)) / ABSORB_PEAK : 0;

    // the emote plays out (fading away if cut short), then a cued one starts once any playing emote has faded out
    const e = this.emote;
    if (e) {
      e.t += dt;
      if (this.fading || f.airborne) e.weight = damp(e.weight, 0, 14, dt);
      if (e.t >= EMOTE_LENGTH[e.kind] || e.weight < 0.02) {
        this.emote = null;
        this.fading = false;
      }
    }
    if (this.cued && !f.airborne) {
      this.cued.delay -= dt;
      if (this.cued.delay <= 0) {
        if (this.emote) this.fading = true;
        else {
          this.play(this.cued.kind, this.cued.strength);
          this.cued = null;
        }
      }
    }
  }

  /** The acting, into a pose. */
  write(pose: RiderPose): void {
    Object.assign(pose.jump, this.jump);
    pose.emote = this.emote;
  }
}
