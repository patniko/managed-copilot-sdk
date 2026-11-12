import type { AirState, BikePhysics, LandingResult } from './bike';

export interface TrickLine {
  name: string;
  points: number;
}

export interface AirReport {
  tricks: TrickLine[];
  total: number;
  multiplier: number;
  perfect: boolean;
  airTime: number;
  height: number;
  title: string;
}

const TAU = Math.PI * 2;

/** Tracks an airborne sequence and scores it on landing. */
export class TrickTracker {
  private grabHold = { superman: 0, noHander: 0, canCan: 0 };
  private tableHold = 0;
  private whipStart = 0;
  private barStart = 0;
  active = false;
  /** Live preview of the current air (for the HUD). */
  live: string[] = [];

  start(bike: BikePhysics) {
    this.active = true;
    this.grabHold.superman = this.grabHold.noHander = this.grabHold.canCan = 0;
    this.tableHold = 0;
    this.whipStart = bike.tricks.tailwhipCount;
    this.barStart = bike.tricks.barspinCount;
    this.live = [];
  }

  update(dt: number, bike: BikePhysics) {
    if (!this.active) return;
    const g = bike.tricks.grabs;
    for (const k of ['superman', 'noHander', 'canCan'] as const) if (g[k] > 0.75) this.grabHold[k] += dt;
    if (Math.abs(bike.air.roll) > 0.5) this.tableHold += dt;
    this.live = this.describe(bike.air, bike).map((t) => t.name);
  }

  private describe(air: AirState, bike: BikePhysics): TrickLine[] {
    const out: TrickLine[] = [];
    const flips = Math.floor((Math.abs(air.flip) + 1.0) / TAU);
    if (flips > 0) {
      const front = air.flip > 0;
      const base = front ? 'Frontflip' : 'Backflip';
      const name = flips === 1 ? base : flips === 2 ? `Double ${base}` : `${flips}x ${base}`;
      out.push({ name, points: flips * (front ? 1300 : 1100) + (flips - 1) * 600 });
    }
    const halfSpins = Math.floor((Math.abs(air.spin) + 0.8) / Math.PI);
    if (halfSpins > 0) {
      const deg = halfSpins * 180;
      const pts = [0, 300, 800, 1300, 2000, 2800, 3800][Math.min(6, halfSpins)];
      out.push({ name: `${deg}`, points: pts });
    }
    const hold = this.grabHold;
    if (hold.superman > 0.12) out.push({ name: 'Superman', points: Math.round(450 + hold.superman * 700) });
    if (hold.noHander > 0.12) out.push({ name: 'No-Hander', points: Math.round(350 + hold.noHander * 550) });
    if (hold.canCan > 0.12) out.push({ name: 'Can-Can', points: Math.round(380 + hold.canCan * 550) });
    const whips = bike.tricks.tailwhipCount - this.whipStart;
    if (whips > 0) out.push({ name: whips === 1 ? 'Tailwhip' : whips === 2 ? 'Double Whip' : `${whips}x Whip`, points: whips * 750 + (whips - 1) * 400 });
    const bars = bike.tricks.barspinCount - this.barStart;
    if (bars > 0) out.push({ name: bars === 1 ? 'Barspin' : `${bars}x Barspin`, points: bars * 550 });
    if (this.tableHold > 0.25) out.push({ name: 'Tabletop', points: Math.round(300 + this.tableHold * 300) });
    return out;
  }

  /** Score a completed landing. Returns null for tiny hops. */
  finish(res: LandingResult, air: AirState, bike: BikePhysics): AirReport | null {
    this.active = false;
    if (!res.ok) return null;
    const tricks = this.describe(air, bike);
    const height = Math.max(0, air.maxY - Math.min(air.startY, bike.pos.y));
    if (air.time > 0.55) tricks.unshift({ name: height > 5 ? 'Big Air' : 'Air', points: Math.round(air.time * 120 + height * 25) });
    if (!tricks.length) return null;
    const distinct = tricks.filter((t) => t.name !== 'Air' && t.name !== 'Big Air').length;
    const multiplier = distinct >= 4 ? 2.5 : distinct === 3 ? 2 : distinct === 2 ? 1.5 : 1;
    let total = tricks.reduce((a, t) => a + t.points, 0) * multiplier;
    if (res.perfect && distinct > 0) total *= 1.25;
    total = Math.round(total / 10) * 10;
    const named = tricks.filter((t) => t.name !== 'Air' && t.name !== 'Big Air').map((t) => t.name);
    const title = named.length ? named.join(' + ') : tricks[0].name;
    return { tricks, total, multiplier, perfect: res.perfect, airTime: air.time, height, title };
  }
}
