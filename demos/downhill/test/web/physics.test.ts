import { describe, expect, it } from 'vitest';
import { TerrainData } from '../../src/web/world/terrain';
import { TrailNetwork } from '../../src/web/world/trails';
import { JumpFeature, SHAPES } from '../../src/web/world/features';
import { Ground } from '../../src/web/world/ground';
import { BikePhysics } from '../../src/web/game/bike';
import { TrickTracker, type AirReport } from '../../src/web/game/tricks';
import { emptyFrame, type InputFrame } from '../../src/web/core/input';
import type { TerrainSpec } from '../../src/web/world/types';

const SLOPE = 0.14;

function makeWorld(shapeKey?: keyof typeof SHAPES, slope = SLOPE) {
  const spec: TerrainSpec = {
    region: { minX: -100, maxX: 100, minZ: -600, maxZ: 40 },
    cell: 2,
    height: (_x, z) => 200 + slope * z,
    farHeight: (_x, z) => 200 + slope * z,
    groundColor: (_s, out) => out.fill(0.5),
    farColor: (_x, _z, _h, _n, out) => out.fill(0.5),
    surface: () => 'dirt',
  };
  const terrain = new TerrainData(spec);
  terrain.fill();
  const features: JumpFeature[] = [];
  if (shapeKey) {
    const f = new JumpFeature(0, -100, 0, SHAPES[shapeKey], 'main');
    f.bake(terrain);
    features.push(f);
  }
  const ground = new Ground(terrain, new TrailNetwork(), features, spec);
  return { terrain, ground, features };
}

function ride(bike: BikePhysics, seconds: number, inp: (t: number, b: BikePhysics) => Partial<InputFrame> = () => ({}), dt = 1 / 120) {
  const base = emptyFrame();
  for (let t = 0; t < seconds; t += dt) {
    const f = { ...base, ...inp(t, bike), grabs: { ...base.grabs, ...(inp(t, bike).grabs ?? {}) } };
    bike.step(dt, f);
    if (bike.crashed) break;
  }
}

describe('bike physics', () => {
  it('coasts faster downhill and settles at a sane terminal speed', () => {
    const { ground } = makeWorld();
    const b = new BikePhysics(ground);
    b.reset(0, 0, 0, 0);
    ride(b, 3);
    const v3 = b.speed;
    expect(v3).toBeGreaterThan(2.5);
    ride(b, 40);
    expect(b.speed).toBeGreaterThan(v3);
    expect(b.speed).toBeGreaterThan(14);
    expect(b.speed).toBeLessThan(26);
    expect(b.crashed).toBe(false);
  });

  it('pedalling on the flat reaches a brisk cruising speed quickly', () => {
    const { ground } = makeWorld(undefined, 0);
    const b = new BikePhysics(ground);
    b.reset(0, 0, 0, 0);
    ride(b, 3, () => ({ throttle: 1 }));
    // snappy: well past a jog within three seconds
    expect(b.speed).toBeGreaterThan(9);
    ride(b, 17, () => ({ throttle: 1 }));
    expect(b.speed).toBeGreaterThan(12);
    expect(b.speed).toBeLessThan(17.5);
  });

  it('drops in rolling and a boost surges the bike forward without overshooting its cap', () => {
    const { ground } = makeWorld(undefined, 0);
    const b = new BikePhysics(ground);
    b.reset(0, 0, 0, 0);
    b.push(7);
    expect(b.forwardSpeed).toBeCloseTo(7, 5);
    b.push(3); // never slows the bike down
    expect(b.forwardSpeed).toBeCloseTo(7, 5);
    b.boost(3);
    ride(b, 0.5);
    // ~3 m/s added within half a second (minus a little rolling resistance and drag)
    expect(b.speed).toBeGreaterThan(9.3);
    expect(b.boostLeft).toBe(0);
    // above the boost cap a boost is spent without adding speed
    b.reset(0, 0, 0, 23);
    b.boost(4);
    ride(b, 0.6);
    expect(b.speed).toBeLessThan(23);
    expect(b.boostLeft).toBe(0);
  });

  it('brakes to a stop', () => {
    const { ground } = makeWorld(undefined, 0);
    const b = new BikePhysics(ground);
    b.reset(0, 0, 0, 12);
    ride(b, 3, () => ({ brake: 1 }));
    expect(b.speed).toBeLessThan(0.5);
  });

  it('steers in a circle with a reasonable radius', () => {
    const { ground } = makeWorld(undefined, 0);
    const b = new BikePhysics(ground);
    b.reset(0, 0, 0, 8);
    const h0 = b.heading;
    ride(b, 1, () => ({ steer: 1, throttle: 0.3 }));
    expect(b.heading - h0).toBeGreaterThan(0.5);
    expect(b.crashed).toBe(false);
  });

  for (const key of ['small', 'medium', 'large', 'step', 'gap', 'hero', 'drop'] as const) {
    it(`launches off a ${key} jump and lands cleanly at a sensible speed`, () => {
      const { ground, features } = makeWorld(key);
      const f = features[0];
      const b = new BikePhysics(ground);
      const speeds = { small: 10, medium: 12.5, large: 14.5, step: 11, gap: 15, hero: 18, drop: 9 };
      b.reset(0, -100 + 25, 0, speeds[key]);
      let launched = false;
      let landed: boolean | null = null;
      let air = 0;
      let landU = 0;
      b.events = {
        onLaunch: () => (launched = true),
        onLand: (res, a) => {
          landed = res.ok;
          air = a.time;
          landU = f.toLocal(b.pos.x, b.pos.z).u;
        },
        onCrash: () => (landed = false),
      };
      // keep speed roughly constant on approach by light pedalling
      ride(b, 6, (_t, bb) => ({ throttle: bb.grounded && bb.speed < speeds[key] ? 0.6 : 0 }));
      expect(launched).toBe(true);
      expect(landed).toBe(true);
      expect(air).toBeGreaterThan(key === 'small' ? 0.35 : 0.5);
      // landed beyond the lip, ideally on the landing ramp or just past it
      expect(landU).toBeGreaterThan(f.lipU + 1);
    });
  }

  for (const key of ['small', 'medium', 'large', 'step', 'gap', 'hero', 'drop'] as const) {
    // (the hero gap is a pro-line feature: much above 20 m/s it is overshot onto the run-out, a real mistake)
    const top = key === 'hero' ? 20 : 21;
    it(`rides a ${key} jump hands-off at any typical approach speed (14-${top} m/s) without a false crash`, () => {
      const bad: string[] = [];
      for (const slope of [0.08, 0.16, 0.26]) {
        for (let v = 14; v <= top; v += 0.5) {
          const { ground, features } = makeWorld(key, slope);
          const f = features[0];
          const b = new BikePhysics(ground);
          b.reset(0, -100 + 8, 0, v);
          b.events = { onCrash: (why) => bad.push(`slope ${slope} ${v} m/s: ${why} at u=${f.toLocal(b.pos.x, b.pos.z).u.toFixed(1)}`) };
          // hold the approach speed up to the kicker, then let go
          ride(b, 5, (_t, bb) => {
            if (!bb.grounded || f.toLocal(bb.pos.x, bb.pos.z).u >= 0) return {};
            return bb.speed < v ? { throttle: 1 } : bb.speed > v + 0.3 ? { brake: 0.5 } : {};
          });
        }
      }
      expect(bad).toEqual([]);
    });
  }

  it('a held backflip on the hero gap is scored as a Backflip', () => {
    const { ground } = makeWorld('hero');
    const b = new BikePhysics(ground);
    const tracker = new TrickTracker();
    b.reset(0, -100 + 25, 0, 18);
    let report: AirReport | null = null;
    let crashed = '';
    b.events = {
      onLaunch: () => tracker.start(b),
      onLand: (res, a) => (report = tracker.finish(res, a, b)),
      onCrash: (r) => (crashed = r),
    };
    ride(b, 7, (_t, bb) => {
      tracker.update(1 / 120, bb);
      if (bb.grounded) return { throttle: bb.speed < 18 ? 0.6 : 0 };
      return { flip: Math.abs(bb.air.flip) < Math.PI * 2 - 0.7 ? -1 : 0 };
    });
    expect(crashed).toBe('');
    expect(report).not.toBeNull();
    expect(report!.tricks.map((t) => t.name)).toContain('Backflip');
  });

  it('bails when still holding a grab at touchdown', () => {
    const { ground } = makeWorld('large');
    const b = new BikePhysics(ground);
    b.reset(0, -100 + 25, 0, 14.5);
    let crashed = '';
    b.events = { onCrash: (r) => (crashed = r) };
    ride(b, 6, (_t, bb) => (bb.grounded ? { throttle: bb.speed < 14.5 ? 0.6 : 0 } : { grabs: { superman: true } as InputFrame['grabs'] }));
    expect(crashed).toMatch(/grab/i);
  });

  it('a superman released in time lands and scores', () => {
    const { ground } = makeWorld('large');
    const b = new BikePhysics(ground);
    const tracker = new TrickTracker();
    b.reset(0, -100 + 25, 0, 14.5);
    let report: AirReport | null = null;
    b.events = { onLaunch: () => tracker.start(b), onLand: (res, a) => (report = tracker.finish(res, a, b)) };
    ride(b, 6, (_t, bb) => {
      tracker.update(1 / 120, bb);
      if (bb.grounded) return { throttle: bb.speed < 14.5 ? 0.6 : 0 };
      return { grabs: { superman: bb.air.time < 0.5 } as InputFrame['grabs'] };
    });
    expect(report).not.toBeNull();
    expect(report!.tricks.map((t) => t.name)).toContain('Superman');
  });
});
