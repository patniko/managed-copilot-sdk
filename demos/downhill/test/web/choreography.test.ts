import { describe, expect, it } from 'vitest';
import { Choreographer, type Flight } from '../../src/web/game/choreography';
import type { LandingResult } from '../../src/web/game/bike';
import type { AirReport } from '../../src/web/game/tricks';
import { EMOTE_LENGTH, type Celebrations } from '../../src/web/game/rider/types';

const DT = 1 / 120;
const G = 9.81;

function flight(over: Partial<Flight> = {}): Flight {
  return { airborne: false, airTime: 0, timeToLand: 0, height: 0, tricking: 0, rotating: 0, preload: 0, ...over };
}

function landing(over: Partial<Extract<LandingResult, { ok: true }>> = {}): LandingResult {
  return { ok: true, perfect: false, impact: 6, pitchErr: 0, yawErr: 0, fakie: false, sketchy: false, ...over };
}

function report(total: number, perfect = false): AirReport {
  return { tricks: [{ name: 'Backflip', points: total }], total, multiplier: 1, perfect, airTime: 1, height: 2, title: 'Backflip' };
}

/** Ride `seconds` on the ground, recording `pick` each step. */
function ground(c: Choreographer, seconds: number, pick: (c: Choreographer) => number = () => 0): number[] {
  const out: number[] = [];
  for (let t = 0; t < seconds; t += DT) {
    c.update(DT, flight());
    out.push(pick(c));
  }
  return out;
}

/** Pop off a lip at `vy` and fly a ballistic arc back down to the same height, recording each step. */
function fly(c: Choreographer, vy: number, extra: Partial<Flight> = {}): Array<{ t: number; left: number; pop: number; tuck: number; spot: number; whoop: number }> {
  const air = (2 * vy) / G;
  c.launch({ popped: true, fromFeature: true, vy });
  const out = [];
  for (let t = 0; t < air; t += DT) {
    c.update(DT, flight({ airborne: true, airTime: t, timeToLand: air - t, height: vy * t - 0.5 * G * t * t, ...extra }));
    const j = c.jump;
    out.push({ t, left: air - t, pop: j.pop, tuck: j.tuck, spot: j.spot, whoop: j.whoop });
  }
  return out;
}

describe('rider choreography', () => {
  it('acts out a jump: loads, pops off the lip, tucks, spots the landing and soaks it up', () => {
    const c = new Choreographer();
    for (let t = 0; t < 0.4; t += DT) c.update(DT, flight({ preload: Math.min(1, t / 0.35) }));
    expect(c.jump.load).toBeGreaterThan(0.8);

    const air = fly(c, 5.6);
    const peak = air.reduce((a, b) => (b.pop > a.pop ? b : a));
    expect(peak.pop).toBeGreaterThan(0.95);
    expect(peak.t).toBeLessThan(0.15);
    expect(air.find((s) => s.t > 0.55)!.pop).toBeLessThan(0.1);
    const mid = air.find((s) => s.t > 0.5)!;
    expect(mid.tuck).toBeGreaterThan(0.4);
    // big air (over a second): a whoop at the top, gone by the time the rider looks down at the landing
    expect(mid.whoop).toBeGreaterThan(0.2);
    const touchdown = air[air.length - 1];
    expect(touchdown.spot).toBeGreaterThan(0.8);
    expect(touchdown.whoop).toBeLessThan(0.1);
    expect(c.jump.load).toBeLessThan(0.01);

    c.land(landing({ impact: 9 }), null, 1);
    const absorb = ground(c, 1.4, (k) => k.jump.absorb);
    const deepest = Math.max(...absorb);
    expect(deepest).toBeGreaterThan(0.95);
    expect(absorb.indexOf(deepest) * DT).toBeLessThan(0.25);
    // the legs spring back past neutral, then settle
    expect(Math.min(...absorb)).toBeLessThan(-0.1);
    expect(Math.abs(absorb[absorb.length - 1])).toBeLessThan(0.02);
    expect(c.jump.spot).toBeLessThan(0.05);
  });

  it('soaks up a harder landing deeper, and keeps little hops and spinning flights quiet', () => {
    const depth = (impact: number) => {
      const c = new Choreographer();
      c.land(landing({ impact }), null, 1);
      return Math.max(...ground(c, 0.5, (k) => k.jump.absorb));
    };
    expect(depth(9)).toBeGreaterThan(depth(3) * 2);

    const hop = fly(new Choreographer(), 1.4);
    expect(Math.max(...hop.map((s) => s.spot))).toBe(0);
    expect(Math.max(...hop.map((s) => s.whoop))).toBe(0);
    const flipping = fly(new Choreographer(), 5.6, { rotating: 1 });
    expect(Math.max(...flipping.map((s) => s.whoop))).toBe(0);
    expect(Math.max(...flipping.map((s) => s.tuck))).toBeGreaterThan(0.4);
  });

  it('celebrates by how the landing went, in the character’s own way', () => {
    const style: Celebrations = { greet: 'wave', trick: ['salute', 'pump'], big: ['victory'] };
    const after = (res: LandingResult, rep: AirReport | null, combo = 1) => {
      const c = new Choreographer(style, () => 0);
      c.land(res, rep, combo);
      ground(c, 0.3);
      return c.emote?.kind ?? null;
    };
    expect(after(landing({ sketchy: true }), report(900))).toBe('phew');
    expect(after(landing(), report(2600))).toBe('victory');
    // a perfect landing deep in a combo counts as big
    expect(after(landing({ perfect: true }), report(1300, true), 3)).toBe('victory');
    expect(after(landing(), report(900))).toBe('salute');
    expect(after(landing(), report(300))).toBe('nod');
    expect(after(landing(), null)).toBeNull();

    // it waits for the landing to be soaked up first, and doesn't repeat itself when it has a choice
    const c = new Choreographer(style, () => 0);
    c.land(landing(), report(900), 1);
    ground(c, 0.1);
    expect(c.emote).toBeNull();
    ground(c, EMOTE_LENGTH.salute + 0.2);
    expect(c.emote).toBeNull();
    c.land(landing(), report(900), 1);
    ground(c, 0.3);
    expect(c.emote?.kind).toBe('pump');
  });

  it('cuts a celebration short on takeoff, and drops it in a crash', () => {
    const c = new Choreographer();
    c.play('victory');
    ground(c, 0.5);
    expect(c.emote?.weight).toBe(1);
    c.launch({ popped: true, fromFeature: false, vy: 4 });
    c.update(DT, flight({ airborne: true, airTime: DT, timeToLand: 0.6, height: 0.02 }));
    expect(c.emote!.weight).toBeLessThan(1);
    for (let t = 0; t < 0.4; t += DT) c.update(DT, flight({ airborne: true, airTime: t, timeToLand: 0.5, height: 0.5 }));
    expect(c.emote).toBeNull();

    c.play('pump');
    c.crash();
    expect(c.emote).toBeNull();
    expect(c.jump.pop).toBe(0);
  });

  it('lets a playing emote fade before the next starts, and saves the finish line’s celebration through a last jump', () => {
    const c = new Choreographer(undefined, () => 0);
    c.play('wave');
    ground(c, 0.5);
    c.finish();
    ground(c, 0.2);
    expect(c.emote?.kind).toBe('wave');
    expect(c.emote!.weight).toBeLessThan(1);
    ground(c, 0.4);
    expect(c.emote?.kind).toBe('victory');
    expect(c.emote?.t).toBeLessThan(0.4);

    const air = new Choreographer(undefined, () => 0);
    air.finish();
    fly(air, 3);
    air.land(landing(), report(900), 1);
    ground(air, 0.3);
    expect(air.emote?.kind).toBe('victory');
  });
});
