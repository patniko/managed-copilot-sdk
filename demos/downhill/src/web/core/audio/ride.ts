/**
 * Continuous riding layers. Everything is built once and only modulated afterwards
 * (setTargetAtTime / scheduled grain envelopes) – no per-frame node allocation.
 */
import type { RideAudioState, Surface } from '../audioTypes';
import type { AudioCore } from './core';
import { NodeGroup, PulseTrain, Rng, SmoothParam, clamp, clamp01, finite, smoothstep } from './util';

const WHEEL_R = 0.36;
const WHEEL_CIRC = 2 * Math.PI * WHEEL_R;
/** Freehub engagement points: ticks per wheel revolution. */
const HUB_POE = 18;
/** Wooden boardwalk plank pitch (m). */
const PLANK = 0.24;
const LOOKAHEAD = 0.1;
export const SURFACES: readonly Surface[] = ['dirt', 'grass', 'sand', 'rock', 'snow', 'wood'];

export type RideLayerName = 'wind' | 'tyre' | 'ticks' | 'chain' | 'brake' | 'skid' | 'whoosh';
export const RIDE_LAYERS: readonly RideLayerName[] = ['wind', 'tyre', 'ticks', 'chain', 'brake', 'skid', 'whoosh'];
type GatedLayer = Exclude<RideLayerName, 'wind' | 'tyre'>;
const GATED: readonly GatedLayer[] = ['ticks', 'chain', 'brake', 'skid', 'whoosh'];

/** Random slow modulator: picks a new target every [minDt, maxDt] seconds. */
class Wander {
  private next = 0;
  constructor(
    private readonly p: SmoothParam,
    private readonly rng: Rng,
    public lo: number,
    public hi: number,
    public minDt: number,
    public maxDt: number,
    public tau: number,
  ) {}
  pump(now: number, scale = 1): void {
    if (now < this.next) return;
    this.next = now + this.rng.range(this.minDt, this.maxDt);
    this.p.set(this.rng.range(this.lo, this.hi) * scale, now, this.tau);
  }
}

interface SurfaceChain {
  surface: Surface;
  out: GainNode;
  level: SmoothParam;
  /** Overall loudness of this surface relative to the others. */
  trim: number;
  /** Speed-dependent brightness of the main band. */
  bright?: { p: SmoothParam; base: number };
  trains: { train: PulseTrain; perMetre: number; mode: 'periodic' | 'poisson' }[];
  flutter?: Wander;
  connected: boolean;
  offAt: number;
}

interface SkidVoicing {
  f: number;
  q: number;
  grainF: number;
  grainAmp: number;
}

const SKID: Record<Surface, SkidVoicing> = {
  dirt: { f: 950, q: 0.8, grainF: 2400, grainAmp: 1 },
  grass: { f: 2100, q: 0.6, grainF: 3200, grainAmp: 0.2 },
  sand: { f: 3300, q: 0.7, grainF: 5200, grainAmp: 0.5 },
  rock: { f: 1500, q: 1.2, grainF: 3000, grainAmp: 1.1 },
  snow: { f: 1300, q: 1.0, grainF: 2600, grainAmp: 0.9 },
  wood: { f: 760, q: 1.5, grainF: 1600, grainAmp: 0.6 },
};

export class RideLayers {
  /** True while updateRide receives a state (false after null). */
  active = false;
  private readonly core: AudioCore;
  private readonly rng: Rng;
  private readonly g: NodeGroup;
  private readonly out: GainNode;
  private readonly post: GainNode;
  private readonly presence: SmoothParam;
  private connected = true;
  private inactiveSince = 0;
  private readonly masks: Record<RideLayerName, GainNode>;
  /** Optional layers are detached from the graph while silent so they cost no CPU. */
  private readonly gates: Record<GatedLayer, { on: boolean; offAt: number }> = {
    ticks: { on: false, offAt: 0 },
    chain: { on: false, offAt: 0 },
    brake: { on: false, offAt: 0 },
    skid: { on: false, offAt: 0 },
    whoosh: { on: false, offAt: 0 },
  };

  // latest sanitized state
  private speed = 0;
  private grounded = true;
  private surface: Surface = 'dirt';
  private pedaling = false;
  private braking = false;
  private skid = 0;
  private spin = 0;

  // wind
  private readonly windLevel: SmoothParam;
  private readonly windCutL: SmoothParam;
  private readonly windCutR: SmoothParam;
  private readonly airLevel: SmoothParam;
  private readonly rumbleLevel: SmoothParam;
  private readonly gust: Wander;
  private readonly windPan: Wander;

  // tyres
  private readonly chains: SurfaceChain[] = [];
  private readonly tyreOut: GainNode;

  // freewheel
  private readonly ticks: PulseTrain;
  private readonly tickLevel: SmoothParam;

  // drivetrain
  private readonly chainLevel: SmoothParam;
  private readonly meshF: SmoothParam;
  private readonly toneF: SmoothParam;
  private readonly strokeF: SmoothParam;

  // brakes
  private readonly rubLevel: SmoothParam;
  private readonly squealLevel: SmoothParam;
  private readonly squealF: SmoothParam;
  private readonly squealVibDepth: SmoothParam;
  private squealWobble = 0.6;
  private nextWobble = 0;

  // skid
  private readonly skidLevel: SmoothParam;
  private readonly skidF: SmoothParam;
  private readonly skidQ: SmoothParam;
  private readonly skidGrainF: SmoothParam;
  private readonly skidGrains: PulseTrain;

  // airborne whoosh
  private readonly whooshLevel: SmoothParam;
  private readonly whooshRate: SmoothParam;

  constructor(core: AudioCore) {
    this.core = core;
    this.rng = core.rng;
    const g = (this.g = new NodeGroup(core.kit));
    const B = core.buffers;
    const rng = this.rng;

    this.out = g.gain(0);
    this.presence = new SmoothParam(this.out.gain);
    this.post = g.gain(1);
    this.out.connect(this.post);
    this.post.connect(core.sfxBus.in);
    // a touch of space so the bike sits in the same world as the one-shots
    const send = g.gain(0.04);
    this.post.connect(send).connect(core.sfxBus.send);

    const mask = (connected: boolean): GainNode => {
      const m = g.gain(1);
      if (connected) m.connect(this.out);
      return m;
    };
    this.masks = {
      wind: mask(true),
      tyre: mask(true),
      ticks: mask(false),
      chain: mask(false),
      brake: mask(false),
      skid: mask(false),
      whoosh: mask(false),
    };

    // shared noise sources (decorrelated by offsets)
    const pinkL = g.loop(B.pink, 0);
    const pinkR = g.loop(B.pink, 2.17);
    const white = g.loop(B.white, 0.71);
    const white2 = g.loop(B.white, 1.93);
    const brown = g.loop(B.brown, 1.31);

    // ---------------------------------------------------------------- wind rush
    {
      const lpL = g.filter('lowpass', 400, 0.55);
      const lpR = g.filter('lowpass', 400, 0.55);
      const merger = g.merger(2);
      pinkL.connect(lpL).connect(merger, 0, 0);
      pinkR.connect(lpR).connect(merger, 0, 1);
      const pan = g.pan(0);
      const gust = g.gain(1);
      const level = g.gain(0);
      merger.connect(pan).connect(gust).connect(level).connect(this.masks.wind);
      // airy top band (louder when airborne)
      const airHp = g.filter('highpass', 3200, 0.5);
      const airLp = g.filter('lowpass', 11000, 0.5);
      const air = g.gain(0);
      white.connect(airHp).connect(airLp).connect(air).connect(gust);
      // low buffeting at high speed
      const rumLp = g.filter('lowpass', 120, 0.6);
      const rum = g.gain(0);
      brown.connect(rumLp).connect(rum).connect(this.masks.wind);

      this.windLevel = new SmoothParam(level.gain);
      this.windCutL = new SmoothParam(lpL.frequency);
      this.windCutR = new SmoothParam(lpR.frequency);
      this.airLevel = new SmoothParam(air.gain);
      this.rumbleLevel = new SmoothParam(rum.gain);
      this.gust = new Wander(new SmoothParam(gust.gain, 0.002), rng, 0.8, 1.12, 0.25, 0.9, 0.22);
      this.windPan = new Wander(new SmoothParam(pan.pan, 0.002, 0.002), rng, -0.32, 0.32, 1.0, 2.6, 0.7);
    }

    // ---------------------------------------------------------------- tyres
    this.tyreOut = g.gain(0.7);
    this.tyreOut.connect(this.masks.tyre);
    const bp = (f: number, q: number): BiquadFilterNode => g.filter('bandpass', f, q);
    const lp = (f: number, q = 0.7071): BiquadFilterNode => g.filter('lowpass', f, q);
    const hp = (f: number, q = 0.7071): BiquadFilterNode => g.filter('highpass', f, q);
    const amp = (v: number): GainNode => g.gain(v);
    const vca = (src: AudioNode): GainNode => {
      const v = g.gain(0);
      src.connect(v);
      return v;
    };
    const mkChain = (surface: Surface, trim: number): SurfaceChain => {
      const out = g.gain(0);
      const c: SurfaceChain = {
        surface,
        out,
        level: new SmoothParam(out.gain),
        trim,
        trains: [],
        connected: false,
        offAt: 0,
      };
      this.chains.push(c);
      return c;
    };
    const train = (c: SurfaceChain, v: GainNode, perMetre: number, mode: 'periodic' | 'poisson'): PulseTrain => {
      const t = new PulseTrain(v.gain, rng);
      t.mode = mode;
      c.trains.push({ train: t, perMetre, mode });
      return t;
    };

    // dirt: rolling rumble + crunchy mids + gravel crackle grains
    {
      const c = mkChain('dirt', 1);
      brown.connect(lp(380, 0.7)).connect(amp(0.12)).connect(c.out);
      const mid = bp(1100, 0.8);
      pinkL.connect(mid).connect(amp(0.42)).connect(c.out);
      c.bright = { p: new SmoothParam(mid.frequency), base: 1100 };
      const v = vca(white);
      v.connect(bp(2600, 1.3)).connect(hp(900)).connect(amp(0.55)).connect(c.out);
      const t = train(c, v, 7, 'poisson');
      t.powerLaw = 2.2;
      t.tau = 0.0016;
      t.tauVar = 0.5;
    }
    // grass: soft swish with blade flutter
    {
      const c = mkChain('grass', 0.8);
      const fl = amp(0.8);
      pinkR.connect(hp(1700, 0.6)).connect(lp(5200, 0.6)).connect(fl).connect(amp(0.6)).connect(c.out);
      brown.connect(lp(240)).connect(amp(0.08)).connect(c.out);
      c.flutter = new Wander(new SmoothParam(fl.gain, 0.002), rng, 0.4, 1, 0.05, 0.16, 0.035);
    }
    // sand: fine hiss + soft drag + tiny grains
    {
      const c = mkChain('sand', 0.8);
      const fl = amp(0.8);
      const band = hp(2400, 0.5);
      white2.connect(band).connect(lp(8500, 0.5)).connect(fl).connect(amp(0.45)).connect(c.out);
      c.bright = { p: new SmoothParam(band.frequency), base: 2400 };
      brown.connect(lp(320)).connect(amp(0.08)).connect(c.out);
      c.flutter = new Wander(new SmoothParam(fl.gain, 0.002), rng, 0.6, 1, 0.04, 0.12, 0.03);
      const v = vca(white);
      v.connect(hp(4500)).connect(amp(0.3)).connect(c.out);
      const t = train(c, v, 30, 'poisson');
      t.powerLaw = 1.5;
      t.tau = 0.0009;
    }
    // rock: vibration rumble + rattly chatter
    {
      const c = mkChain('rock', 1.05);
      brown.connect(lp(240, 0.9)).connect(amp(0.16)).connect(c.out);
      const mid = bp(1500, 1.6);
      pinkL.connect(mid).connect(amp(0.4)).connect(c.out);
      c.bright = { p: new SmoothParam(mid.frequency), base: 1500 };
      const v = vca(white2);
      v.connect(bp(1900, 5)).connect(amp(0.8)).connect(c.out);
      v.connect(bp(3100, 6)).connect(amp(0.55)).connect(c.out);
      const t = train(c, v, 9, 'poisson');
      t.powerLaw = 1.6;
      t.tau = 0.003;
      t.tauVar = 0.5;
    }
    // snow: compressed crunch + squeaky grains
    {
      const c = mkChain('snow', 1.3);
      const fl = amp(0.8);
      const band = bp(1700, 1.0);
      pinkR.connect(band).connect(fl).connect(amp(0.5)).connect(c.out);
      c.bright = { p: new SmoothParam(band.frequency), base: 1700 };
      brown.connect(lp(220)).connect(amp(0.06)).connect(c.out);
      c.flutter = new Wander(new SmoothParam(fl.gain, 0.002), rng, 0.35, 1, 0.03, 0.09, 0.02);
      const v = vca(white);
      v.connect(bp(2300, 9)).connect(amp(1.0)).connect(c.out);
      v.connect(bp(3450, 10)).connect(amp(0.6)).connect(c.out);
      const t = train(c, v, 5, 'poisson');
      t.attack = 0.002;
      t.tau = 0.007;
      t.tauVar = 0.4;
      t.ampVar = 0.6;
    }
    // wood: hollow plank knocks (both wheels) over a boomy hum
    {
      const c = mkChain('wood', 0.62);
      pinkL.connect(bp(300, 1.2)).connect(amp(0.35)).connect(c.out);
      const v = vca(brown);
      v.connect(bp(190, 4)).connect(amp(1.2)).connect(c.out);
      v.connect(bp(480, 5)).connect(amp(0.8)).connect(c.out);
      const t = train(c, v, 2 / PLANK, 'periodic');
      t.jitter = 0.18;
      t.tau = 0.018;
      t.ampVar = 0.35;
    }

    // ---------------------------------------------------------------- freewheel ticks
    {
      const v = vca(white2);
      const lvl = g.gain(0);
      v.connect(bp(3500, 7)).connect(amp(1.0)).connect(lvl);
      v.connect(bp(6100, 9)).connect(amp(0.7)).connect(lvl);
      v.connect(bp(1700, 5)).connect(amp(0.45)).connect(lvl);
      lvl.connect(this.masks.ticks);
      this.ticks = new PulseTrain(v.gain, rng);
      this.ticks.mode = 'periodic';
      this.ticks.jitter = 0.06;
      this.ticks.ampVar = 0.3;
      this.ticks.tau = 0.0012;
      this.tickLevel = new SmoothParam(lvl.gain);
    }

    // ---------------------------------------------------------------- drivetrain whir
    {
      const band = bp(2000, 1.3);
      const am = g.gain(0.65);
      const level = g.gain(0);
      const stroke = g.gain(0.75);
      pinkR.connect(band).connect(am).connect(level).connect(stroke).connect(this.masks.chain);
      const mesh = g.osc('triangle', 40);
      const meshDepth = g.gain(0.35);
      mesh.connect(meshDepth).connect(am.gain);
      const tone = g.osc('triangle', 80);
      tone.connect(lp(320)).connect(amp(0.22)).connect(level);
      const strokeOsc = g.osc('sine', 2);
      const strokeDepth = g.gain(0.25);
      strokeOsc.connect(strokeDepth).connect(stroke.gain);
      this.chainLevel = new SmoothParam(level.gain);
      this.meshF = new SmoothParam(mesh.frequency);
      this.toneF = new SmoothParam(tone.frequency);
      this.strokeF = new SmoothParam(strokeOsc.frequency);
    }

    // ---------------------------------------------------------------- brakes
    {
      const rub = g.gain(0);
      white.connect(bp(1300, 1.1)).connect(rub).connect(this.masks.brake);
      const sq = g.osc(core.waves.sweet, 1900);
      const vib = g.osc('sine', 5.3);
      const vibDepth = g.gain(10);
      vib.connect(vibDepth).connect(sq.frequency);
      const sqLevel = g.gain(0);
      sq.connect(lp(4800, 0.5)).connect(sqLevel).connect(this.masks.brake);
      this.rubLevel = new SmoothParam(rub.gain);
      this.squealLevel = new SmoothParam(sqLevel.gain);
      this.squealF = new SmoothParam(sq.frequency);
      this.squealVibDepth = new SmoothParam(vibDepth.gain);
    }

    // ---------------------------------------------------------------- skid scrape
    {
      const band = bp(SKID.dirt.f, SKID.dirt.q);
      const level = g.gain(0);
      white2.connect(band).connect(amp(1)).connect(level);
      pinkL.connect(bp(420, 0.8)).connect(amp(0.55)).connect(level);
      level.connect(this.masks.skid);
      const v = vca(white);
      const gbp = bp(SKID.dirt.grainF, 2);
      v.connect(gbp).connect(amp(1.2)).connect(level);
      this.skidGrains = new PulseTrain(v.gain, rng);
      this.skidGrains.mode = 'poisson';
      this.skidGrains.powerLaw = 1.8;
      this.skidGrains.tau = 0.0025;
      this.skidGrains.tauVar = 0.5;
      this.skidLevel = new SmoothParam(level.gain);
      this.skidF = new SmoothParam(band.frequency);
      this.skidQ = new SmoothParam(band.Q);
      this.skidGrainF = new SmoothParam(gbp.frequency);
    }

    // ---------------------------------------------------------------- airborne whoosh
    {
      const band = bp(750, 1.8);
      const am = g.gain(0.55);
      const level = g.gain(0);
      pinkR.connect(band).connect(am).connect(level).connect(this.masks.whoosh);
      const lfo = g.osc('sine', 1);
      const dA = g.gain(0.45);
      const dF = g.gain(380);
      lfo.connect(dA).connect(am.gain);
      lfo.connect(dF).connect(band.frequency);
      this.whooshLevel = new SmoothParam(level.gain);
      this.whooshRate = new SmoothParam(lfo.frequency);
    }

    // start with the dirt chain wired up
    this.connectChain(this.chains[0]);
  }

  private connectChain(c: SurfaceChain): void {
    if (c.connected) return;
    c.out.connect(this.tyreOut);
    c.connected = true;
    c.offAt = 0;
  }

  /** Debug: isolate one layer (null = all). */
  solo(layer: RideLayerName | null): void {
    for (const name of RIDE_LAYERS) this.masks[name].gain.value = layer === null || layer === name ? 1 : 0;
  }

  update(state: RideAudioState | null, now: number): void {
    if (!state) {
      if (this.active) {
        this.active = false;
        this.inactiveSince = now;
        this.presence.set(0, now, 0.22);
        this.speed = 0;
        this.skid = 0;
        this.spin = 0;
        this.braking = false;
        this.pedaling = false;
        this.applyTargets(now);
      }
      return;
    }
    if (!this.active) {
      this.active = true;
      if (!this.connected) {
        this.out.connect(this.post);
        this.connected = true;
      }
      this.presence.set(1, now, 0.08);
    }
    this.speed = clamp(finite(state.speed), 0, 45);
    this.grounded = !!state.grounded;
    this.surface = SURFACES.includes(state.surface) ? state.surface : 'dirt';
    this.pedaling = !!state.pedaling;
    this.braking = !!state.braking;
    this.skid = clamp01(finite(state.skid));
    this.spin = clamp(Math.abs(finite(state.spinRate)), 0, 60);
    this.applyTargets(now);
  }

  private applyTargets(now: number): void {
    const v = this.speed;
    const s = Math.min(v / 25, 1.25);
    const s2 = s * s;
    const air = !this.grounded;

    // wind ∝ speed²
    this.windLevel.set(0.5 * s2 * (air ? 1.3 : 1), now, 0.1);
    const cut = (260 + 2500 * Math.pow(s, 1.25)) * (air ? 1.35 : 1);
    this.windCutL.set(cut, now, 0.12);
    this.windCutR.set(cut * 1.07, now, 0.12);
    this.airLevel.set((air ? 0.6 : 0.16) * s2, now, 0.15);
    this.rumbleLevel.set(0.1 * s2 * s, now, 0.12);

    // tyres: rolling noise grows a little slower than speed
    const roll = this.grounded ? smoothstep(0.2, 2.5, v) * Math.min(1.2, 0.15 + 0.85 * Math.pow(v / 25, 0.9)) : 0;
    for (const c of this.chains) {
      const on = c.surface === this.surface && roll > 0;
      c.level.set(on ? roll * c.trim : 0, now, on ? 0.06 : 0.09);
      if (on) {
        this.connectChain(c);
        if (c.bright) c.bright.p.set(c.bright.base * (0.8 + 0.4 * Math.min(1, s)), now, 0.15);
      } else if (c.connected && c.offAt === 0) {
        c.offAt = now + 0.6;
      }
      if (on) c.offAt = 0;
    }

    // freewheel ticks (rear wheel turns in the air too)
    const hubOn = !this.pedaling && v > 1;
    const wheelHz = v / WHEEL_CIRC;
    this.ticks.rate = hubOn ? wheelHz * HUB_POE : 0;
    this.ticks.tau = 0.0013 - 0.0005 * Math.min(1, s);
    this.tickLevel.set(hubOn ? 0.32 + 0.2 * Math.min(1, v / 15) : 0, now, 0.03);

    // drivetrain
    const cadence = clamp(wheelHz / 2.4, 0.75, 1.7);
    const pedal = this.pedaling && this.active;
    this.chainLevel.set(pedal ? 0.1 * smoothstep(0.2, 2.5, v) * (0.75 + 0.25 * Math.min(1, s * 2)) : 0, now, 0.1);
    this.meshF.set(cadence * 32, now, 0.1);
    this.toneF.set(cadence * 32 * 2, now, 0.1);
    this.strokeF.set(cadence * 2, now, 0.1);

    // brakes
    const brk = this.braking && this.active;
    this.rubLevel.set(brk ? 0.16 * smoothstep(0.5, 6, v) * (this.grounded ? 1 : 0.35) : 0, now, brk ? 0.05 : 0.08);
    const sq = brk && this.grounded ? 0.02 * smoothstep(5, 12, v) * this.squealWobble : 0;
    this.squealLevel.set(sq, now, sq > 0 ? 0.12 : 0.06);
    const sf = 1750 + 16 * Math.min(v, 30);
    this.squealF.set(sf, now, 0.3);
    this.squealVibDepth.set(sf * 0.006, now, 0.3);

    // skid
    const sk = this.grounded ? this.skid * smoothstep(0.5, 6, v) : 0;
    const voicing = SKID[this.surface];
    this.skidLevel.set(0.38 * sk, now, 0.05);
    this.skidF.set(voicing.f * (0.85 + 0.3 * Math.min(1, s)), now, 0.08);
    this.skidQ.set(voicing.q, now, 0.08);
    this.skidGrainF.set(voicing.grainF, now, 0.08);
    this.skidGrains.rate = sk > 0.02 ? 6 * v * sk + 10 : 0;
    this.skidGrains.amp = voicing.grainAmp;

    // airborne spin whoosh: two "whooshes" per revolution
    const wh = air ? smoothstep(1, 12, this.spin) : 0;
    this.whooshLevel.set(0.85 * wh, now, 0.08);
    this.whooshRate.set(clamp(this.spin / Math.PI, 0.3, 9), now, 0.1);

    this.gate('ticks', hubOn, now);
    this.gate('chain', pedal && v > 0.2, now);
    this.gate('brake', brk && v > 0.5, now);
    this.gate('skid', sk > 0.005, now);
    this.gate('whoosh', wh > 0.001, now);
  }

  private gate(name: GatedLayer, wanted: boolean, now: number): void {
    const s = this.gates[name];
    if (wanted) {
      s.offAt = 0;
      if (!s.on) {
        this.masks[name].connect(this.out);
        s.on = true;
      }
    } else if (s.on && s.offAt === 0) {
      s.offAt = now + 0.6; // after the level has faded out
    }
  }

  pump(now: number): void {
    const horizon = now + LOOKAHEAD;
    const v = this.active ? this.speed : 0;
    const s = Math.min(v / 25, 1.25);
    for (const name of GATED) {
      const gs = this.gates[name];
      if (gs.on && gs.offAt > 0 && now >= gs.offAt) {
        this.masks[name].disconnect();
        gs.on = false;
        gs.offAt = 0;
      }
    }
    // tyre grain trains follow the active surface
    for (const c of this.chains) {
      const on = this.active && this.grounded && c.surface === this.surface && v > 0.4;
      for (const tr of c.trains) {
        tr.train.rate = on ? v * tr.perMetre : 0;
        tr.train.pump(now, horizon);
      }
      if (on && c.flutter) c.flutter.pump(now);
      if (c.connected && c.offAt > 0 && now >= c.offAt) {
        c.out.disconnect();
        c.connected = false;
        c.offAt = 0;
      }
    }
    if (!this.active) {
      this.ticks.rate = 0;
      this.skidGrains.rate = 0;
    }
    this.ticks.pump(now, horizon);
    this.skidGrains.pump(now, horizon);

    if (this.active) {
      this.gust.lo = 0.82 - 0.12 * s;
      this.gust.pump(now);
      this.windPan.pump(now);
      if (now >= this.nextWobble) {
        this.nextWobble = now + this.rng.range(0.15, 0.55);
        this.squealWobble = this.rng.chance(0.25) ? this.rng.range(0.05, 0.3) : this.rng.range(0.5, 1);
      }
    } else if (this.connected && now - this.inactiveSince > 1.5) {
      // nothing audible any more: detach the whole ride graph so it costs no CPU
      this.out.disconnect(this.post);
      this.connected = false;
    }
  }

  dispose(): void {
    this.g.dispose();
  }
}
