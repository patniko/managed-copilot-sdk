/**
 * Ambience scenes. Each scene owns a few continuous "beds" (noise through slowly wandering
 * filters, surf cycles, drones) plus event generators (bird / gull / hawk calls, cow bells,
 * wind chimes) scheduled ahead of time by the shared lookahead pump. Switching kinds
 * crossfades the old scene out (~2 s) and disposes it.
 */
import type { AmbienceKind } from '../audioTypes';
import type { AudioCore } from './core';
import { NodeGroup, PulseTrain, Rng, SmoothParam, Voice, clamp, lerp, mtof } from './util';

const LOOKAHEAD = 0.35;
const FADE = 2.0;
const CURVE_RATE = 500; // control points per second for synthesized calls

// ------------------------------------------------------------------ call rendering

interface CallNote {
  /** start (s, relative) */
  t: number;
  /** duration (s) */
  d: number;
  f0: number;
  f1: number;
  /** optional mid frequency at `peakAt` (0..1) – arch contours */
  fm?: number;
  peakAt?: number;
  /** FM trill: [rate Hz, depth Hz] */
  trill?: [number, number];
  /** relative amplitude */
  a?: number;
  /** attack / release as fraction of the note */
  atk?: number;
  rel?: number;
}

interface CallCurves {
  freq: Float32Array<ArrayBuffer>;
  amp: Float32Array<ArrayBuffer>;
  dur: number;
}

function renderCall(notes: CallNote[], rng: Rng, jitter = 0, flutter = 0): CallCurves {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.t + n.d);
  const dur = end + 0.03;
  const N = Math.ceil(dur * CURVE_RATE) + 1;
  const freq = new Float32Array(N);
  const amp = new Float32Array(N);
  let lastF = notes[0].f0;
  let lastI = 0;
  for (const n of notes) {
    const i0 = Math.max(0, Math.round(n.t * CURVE_RATE));
    const i1 = Math.min(N - 1, Math.max(i0 + 2, Math.round((n.t + n.d) * CURVE_RATE)));
    // glide the (silent) pitch between notes so nothing jumps under an envelope tail
    for (let i = lastI; i < i0; i++) freq[i] = lerp(lastF, n.f0, (i - lastI) / Math.max(1, i0 - lastI));
    const atk = n.atk ?? 0.15;
    const rel = n.rel ?? 0.3;
    const a = n.a ?? 1;
    for (let i = i0; i <= i1; i++) {
      const u = (i - i0) / (i1 - i0);
      let f: number;
      if (n.fm !== undefined) {
        const p = n.peakAt ?? 0.5;
        f = u < p ? lerp(n.f0, n.fm, u / p) : lerp(n.fm, n.f1, (u - p) / (1 - p));
      } else {
        f = n.f0 * Math.pow(n.f1 / n.f0, u);
      }
      if (n.trill) f += n.trill[1] * Math.sin(2 * Math.PI * n.trill[0] * (i / CURVE_RATE));
      freq[i] = f;
      let e = 1;
      if (u < atk) e = Math.sin((u / atk) * Math.PI * 0.5) ** 2;
      else if (u > 1 - rel) e = Math.cos(((u - (1 - rel)) / rel) * Math.PI * 0.5) ** 2;
      amp[i] = Math.max(amp[i], e * a);
      lastF = f;
    }
    lastI = i1 + 1;
  }
  for (let i = lastI; i < N; i++) freq[i] = lastF;
  if (jitter > 0) {
    // band-limited random pitch wobble (raspy throat)
    let j = 0;
    for (let i = 0; i < N; i++) {
      j += (rng.next() * 2 - 1 - j) * 0.35;
      freq[i] *= 1 + jitter * j;
    }
  }
  if (flutter > 0) for (let i = 0; i < N; i++) amp[i] *= 1 - flutter * rng.next();
  return { freq, amp, dur };
}

type Species = 'robin' | 'tit' | 'chips' | 'warbler' | 'whistle' | 'cuckoo' | 'marmot';

function birdPhrase(sp: Species, rng: Rng): CallNote[] {
  const notes: CallNote[] = [];
  let t = 0;
  switch (sp) {
    case 'robin': {
      const n = rng.int(3, 6);
      for (let k = 0; k < n; k++) {
        const c = rng.range(1900, 3300);
        const d = rng.range(0.09, 0.2);
        const shape = rng.int(0, 2);
        if (shape === 0) notes.push({ t, d, f0: c * 0.86, f1: c * 1.1, a: rng.range(0.6, 1) });
        else if (shape === 1) notes.push({ t, d, f0: c * 1.15, f1: c * 0.86, a: rng.range(0.6, 1) });
        else notes.push({ t, d, f0: c * 0.9, fm: c * 1.12, f1: c * 0.95, peakAt: 0.4, a: rng.range(0.6, 1) });
        t += d + rng.range(0.05, 0.12);
      }
      break;
    }
    case 'tit': {
      const pairs = rng.int(2, 4);
      const hi = rng.range(4000, 4500);
      const lo = hi * rng.range(0.78, 0.84);
      for (let k = 0; k < pairs; k++) {
        notes.push({ t, d: 0.12, f0: hi, f1: hi * 0.96, a: 0.9 });
        t += 0.16;
        notes.push({ t, d: 0.13, f0: lo, f1: lo * 0.95, a: 0.8 });
        t += 0.25;
      }
      break;
    }
    case 'chips': {
      const n = rng.int(4, 9);
      let gap = 0.085;
      const top = rng.range(4800, 5600);
      for (let k = 0; k < n; k++) {
        notes.push({ t, d: rng.range(0.035, 0.05), f0: top, f1: top * 0.7, atk: 0.1, rel: 0.4, a: rng.range(0.7, 1) });
        t += gap;
        gap = Math.max(0.05, gap * 0.94);
      }
      break;
    }
    case 'warbler': {
      const d = rng.range(0.6, 1.1);
      const base = rng.range(4000, 4500);
      notes.push({ t, d, f0: base, f1: base * 1.2, trill: [rng.range(26, 40), rng.range(350, 520)], atk: 0.15, rel: 0.2, a: 0.8 });
      t += d + 0.03;
      notes.push({ t, d: 0.08, f0: base * 1.2, f1: base * 0.8, a: 0.9 });
      break;
    }
    case 'whistle': {
      const n = rng.int(2, 4);
      const pent = [0, 2, 4, 7, 9, 12];
      const root = rng.range(1500, 1900);
      let prev = root * Math.pow(2, rng.pick(pent) / 12);
      for (let k = 0; k < n; k++) {
        const next = root * Math.pow(2, rng.pick(pent) / 12);
        const d = rng.range(0.18, 0.3);
        notes.push({ t, d, f0: prev, f1: next, atk: 0.25, rel: 0.3, a: rng.range(0.7, 1) });
        prev = next;
        t += d + rng.range(0.01, 0.05);
      }
      break;
    }
    case 'cuckoo': {
      const f = rng.range(640, 720);
      const reps = rng.int(2, 3);
      for (let k = 0; k < reps; k++) {
        notes.push({ t, d: 0.2, f0: f, f1: f * 0.98, atk: 0.35, rel: 0.35 });
        notes.push({ t: t + 0.32, d: 0.32, f0: f * 0.8, f1: f * 0.78, atk: 0.3, rel: 0.45, a: 0.9 });
        t += 1.0;
      }
      break;
    }
    case 'marmot': {
      const reps = rng.int(1, 3);
      for (let k = 0; k < reps; k++) {
        notes.push({ t, d: 0.15, f0: 2600, fm: 2950, f1: 2500, peakAt: 0.3, atk: 0.05, rel: 0.4 });
        t += rng.range(0.7, 1.0);
      }
      break;
    }
  }
  return notes;
}

// ------------------------------------------------------------------ scene

interface Comp {
  pump(now: number, horizon: number): void;
}

class Scene {
  readonly g: NodeGroup;
  /** Dry input of the scene. */
  readonly dry: GainNode;
  /** Reverb send input of the scene. */
  readonly wet: GainNode;
  private readonly fadeDry: GainNode;
  private readonly fadeWet: GainNode;
  readonly comps: Comp[] = [];
  disposeAt = 0;
  private disposed = false;

  constructor(
    readonly core: AudioCore,
    readonly kind: AmbienceKind,
    readonly start: number,
  ) {
    const g = (this.g = new NodeGroup(core.kit));
    this.dry = g.gain(1);
    this.wet = g.gain(1);
    this.fadeDry = g.gain(0);
    this.fadeWet = g.gain(0);
    this.dry.connect(this.fadeDry).connect(core.ambBus.in);
    this.wet.connect(this.fadeWet).connect(core.ambBus.send);
  }

  get rng(): Rng {
    return this.core.rng;
  }

  fadeIn(now: number, dur: number): void {
    for (const p of [this.fadeDry.gain, this.fadeWet.gain]) {
      p.cancelScheduledValues(now);
      p.setValueAtTime(0, now);
      p.linearRampToValueAtTime(1, now + dur);
    }
  }

  fadeOut(now: number, dur: number): void {
    for (const p of [this.fadeDry.gain, this.fadeWet.gain]) {
      const v = p.value;
      p.cancelScheduledValues(now);
      p.setValueAtTime(v, now);
      p.linearRampToValueAtTime(0, now + dur);
    }
    this.disposeAt = now + dur + 0.25;
  }

  pump(now: number, horizon: number): void {
    for (const c of this.comps) c.pump(now, horizon);
  }

  /** Transient voice routed into this scene (low priority: dropped if the pool is full). */
  voice(send: number): Voice | null {
    const v = this.core.voices.create(this.dry, 0);
    if (v && send > 0) v.out.connect(v.gain(send)).connect(this.wet);
    return v;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.g.dispose();
  }
}

// ------------------------------------------------------------------ components

interface BreezeOpts {
  level: number;
  /** lowpass cutoff range following gust strength */
  lo: number;
  hi: number;
  gustMin: number;
  gustMax: number;
  minDt: number;
  maxDt: number;
  tauLo: number;
  tauHi: number;
  /** whistling / howling resonance that sings in strong gusts */
  howl?: { lo: number; hi: number; level: number; q: number };
}

class Breeze implements Comp {
  private next = 0;
  private readonly cutL: SmoothParam;
  private readonly cutR: SmoothParam;
  private readonly gust: SmoothParam;
  private readonly howlLevel: SmoothParam | null = null;
  private readonly howlF: SmoothParam | null = null;
  private readonly howlF2: SmoothParam | null = null;
  constructor(
    private readonly s: Scene,
    private readonly o: BreezeOpts,
  ) {
    const g = s.g;
    const B = s.core.buffers;
    const rng = s.rng;
    const fL = g.filter('lowpass', o.lo, 0.5);
    const fR = g.filter('lowpass', o.lo, 0.5);
    const m = g.merger(2);
    g.loop(B.pink, rng.range(0, 4)).connect(fL).connect(m, 0, 0);
    g.loop(B.pink, rng.range(0, 4)).connect(fR).connect(m, 0, 1);
    const hp = g.filter('highpass', 90, 0.5);
    const gust = g.gain(o.level * o.gustMin);
    m.connect(hp).connect(gust).connect(s.dry);
    this.cutL = new SmoothParam(fL.frequency);
    this.cutR = new SmoothParam(fR.frequency);
    this.gust = new SmoothParam(gust.gain, 0.002);
    if (o.howl) {
      const bp = g.filter('bandpass', o.howl.lo, o.howl.q);
      const bp2 = g.filter('bandpass', o.howl.lo * 1.5, o.howl.q);
      const lvl = g.gain(0);
      const src = g.loop(B.white, rng.range(0, 3));
      src.connect(bp).connect(lvl);
      src.connect(bp2).connect(g.gain(0.5)).connect(lvl);
      lvl.connect(g.pan(rng.range(-0.4, 0.4))).connect(s.dry);
      this.howlLevel = new SmoothParam(lvl.gain, 0.002);
      this.howlF = new SmoothParam(bp.frequency);
      this.howlF2 = new SmoothParam(bp2.frequency);
    }
    this.next = s.start;
  }
  pump(now: number): void {
    if (now < this.next) return;
    const o = this.o;
    const rng = this.s.rng;
    this.next = now + rng.range(o.minDt, o.maxDt);
    const x = Math.pow(rng.next(), 1.3);
    const tau = rng.range(o.tauLo, o.tauHi);
    this.gust.set(o.level * lerp(o.gustMin, o.gustMax, x), now, tau);
    const cut = lerp(o.lo, o.hi, x);
    this.cutL.set(cut * rng.range(0.92, 1.08), now, tau);
    this.cutR.set(cut * rng.range(0.92, 1.08), now, tau);
    if (o.howl && this.howlLevel && this.howlF && this.howlF2) {
      this.howlLevel.set(o.howl.level * x * x, now, tau * 1.2);
      const hf = lerp(o.howl.lo, o.howl.hi, x) * rng.range(0.96, 1.04);
      this.howlF.set(hf, now, tau * 1.5);
      this.howlF2.set(hf * 1.5, now, tau * 1.5);
    }
  }
}

interface CallerOpts {
  level: number;
  /** mean seconds between calls */
  every: number;
  minGap: number;
  first: [number, number];
}

class Birds implements Comp {
  private next: number;
  constructor(
    private readonly s: Scene,
    private readonly species: readonly Species[],
    private readonly o: CallerOpts,
  ) {
    this.next = s.start + s.rng.range(o.first[0], o.first[1]);
  }
  pump(_now: number, horizon: number): void {
    const rng = this.s.rng;
    while (this.next < horizon) {
      const t = this.next;
      this.call(t);
      // occasionally another bird answers soon after
      this.next = t + (rng.chance(0.25) ? rng.range(1.2, 2.2) : Math.max(this.o.minGap, rng.exp(this.o.every)));
    }
  }
  private call(t: number): void {
    const s = this.s;
    const rng = s.rng;
    const sp = rng.pick(this.species);
    const dist = sp === 'cuckoo' ? rng.range(0.55, 0.95) : rng.range(0.1, 0.85);
    const v = s.voice(0.15 + 0.5 * dist);
    if (!v) return;
    const c = renderCall(birdPhrase(sp, rng), rng, sp === 'marmot' ? 0.004 : 0.002, 0.05);
    const end = t + c.dur + 0.05;
    const osc = v.osc(sp === 'cuckoo' ? 'sine' : s.core.waves.sweet, c.freq[0], t, end);
    osc.frequency.setValueCurveAtTime(c.freq, t, c.dur);
    const env = v.gain(0);
    env.gain.setValueCurveAtTime(c.amp, t, c.dur);
    const lp = v.filter('lowpass', 9500 - 5500 * dist, 0.6);
    const lvl = this.o.level * (1 - 0.65 * dist) * rng.range(0.7, 1);
    osc.connect(env).connect(lp).connect(v.gain(lvl)).connect(v.pan(rng.range(-0.85, 0.85))).connect(v.out);
  }
}

class Gulls implements Comp {
  private next: number;
  constructor(
    private readonly s: Scene,
    private readonly o: CallerOpts & { near: number },
  ) {
    this.next = s.start + s.rng.range(o.first[0], o.first[1]);
  }
  pump(_now: number, horizon: number): void {
    const rng = this.s.rng;
    while (this.next < horizon) {
      const t = this.next;
      this.call(t);
      this.next = t + Math.max(this.o.minGap, rng.exp(this.o.every));
    }
  }
  private call(t: number): void {
    const s = this.s;
    const rng = s.rng;
    const dist = clamp(1 - this.o.near + rng.range(-0.25, 0.25), 0.05, 1);
    const v = s.voice(0.2 + 0.5 * dist);
    if (!v) return;
    const notes: CallNote[] = [];
    const base = rng.range(0.9, 1.15);
    let tt = 0;
    if (rng.chance(0.7)) {
      const d = rng.range(0.32, 0.5);
      notes.push({ t: tt, d, f0: 680 * base, fm: 1380 * base, f1: 1080 * base, peakAt: 0.28, atk: 0.18, rel: 0.35 });
      tt += d + rng.range(0.08, 0.14);
    }
    const kek = rng.int(1, 5);
    for (let k = 0; k < kek; k++) {
      const d = rng.range(0.11, 0.16);
      notes.push({ t: tt, d, f0: 950 * base, fm: 1260 * base, f1: 1040 * base, peakAt: 0.35, atk: 0.12, rel: 0.4, a: rng.range(0.6, 0.9) });
      tt += d + rng.range(0.06, 0.11);
    }
    const c = renderCall(notes, rng, 0.03, 0.25);
    const end = t + c.dur + 0.05;
    const osc = v.osc(s.core.waves.reed, c.freq[0], t, end);
    osc.frequency.setValueCurveAtTime(c.freq, t, c.dur);
    const env = v.gain(0);
    env.gain.setValueCurveAtTime(c.amp, t, c.dur);
    const formant = v.filter('bandpass', 1750, 1.1);
    const lp = v.filter('lowpass', 7000 - 4000 * dist, 0.6);
    const lvl = this.o.level * (1 - 0.6 * dist);
    osc.connect(formant).connect(env).connect(lp).connect(v.gain(lvl)).connect(v.pan(rng.range(-0.9, 0.9))).connect(v.out);
  }
}

class Hawk implements Comp {
  private next: number;
  constructor(
    private readonly s: Scene,
    private readonly level: number,
  ) {
    this.next = s.start + s.rng.range(4, 10);
  }
  pump(_now: number, horizon: number): void {
    const rng = this.s.rng;
    while (this.next < horizon) {
      const t = this.next;
      this.cry(t, 1);
      if (rng.chance(0.45)) this.cry(t + rng.range(1.9, 2.6), 0.75);
      this.next = t + rng.range(25, 60);
    }
  }
  private cry(t: number, a: number): void {
    const s = this.s;
    const rng = s.rng;
    const v = s.voice(0.6);
    if (!v) return;
    const d = rng.range(1.1, 1.8) * (a < 1 ? 0.6 : 1);
    const k = rng.range(0.93, 1.07);
    const c = renderCall([{ t: 0, d, f0: 2500 * k, fm: 3250 * k, f1: 1850 * k, peakAt: 0.12, atk: 0.06, rel: 0.45 }], rng, 0.025, 0.35);
    const end = t + c.dur + 0.05;
    const osc = v.osc(s.core.waves.reed, c.freq[0], t, end);
    osc.frequency.setValueCurveAtTime(c.freq, t, c.dur);
    const env = v.gain(0);
    env.gain.setValueCurveAtTime(c.amp, t, c.dur);
    const bp = v.filter('bandpass', 2600, 1.3);
    const lp = v.filter('lowpass', 4200, 0.6);
    osc.connect(bp).connect(env).connect(lp).connect(v.gain(this.level * a)).connect(v.pan(rng.range(-0.7, 0.7))).connect(v.out);
  }
}

/** Cicada-like pulsing buzz that swells and pauses. */
class Insects implements Comp {
  private next: number;
  private on = false;
  private readonly level: SmoothParam;
  constructor(
    private readonly s: Scene,
    private readonly peak: number,
    f: number,
    pan: number,
  ) {
    const g = s.g;
    const rng = s.rng;
    const bp = g.filter('bandpass', f, 3.5);
    const bp2 = g.filter('bandpass', f * 1.9, 4);
    const am = g.gain(0.5);
    const lvl = g.gain(0);
    const src = g.loop(s.core.buffers.white, rng.range(0, 3));
    src.connect(bp).connect(am);
    src.connect(bp2).connect(g.gain(0.4)).connect(am);
    am.connect(lvl).connect(g.pan(pan)).connect(s.dry);
    const buzz = g.osc('square', rng.range(95, 130));
    buzz.connect(g.gain(0.32)).connect(am.gain);
    const pulse = g.osc('sine', rng.range(5, 8));
    pulse.connect(g.gain(0.15)).connect(am.gain);
    this.level = new SmoothParam(lvl.gain, 0.002);
    this.next = s.start + rng.range(0.5, 3);
  }
  pump(now: number): void {
    if (now < this.next) return;
    const rng = this.s.rng;
    this.on = !this.on;
    if (this.on) {
      this.level.set(this.peak * rng.range(0.6, 1), now, rng.range(0.8, 1.6));
      this.next = now + rng.range(5, 11);
    } else {
      this.level.set(0, now, rng.range(0.8, 1.5));
      this.next = now + rng.range(4, 12);
    }
  }
}

interface SurfOpts {
  distant: boolean;
  level: number;
  period: [number, number];
}

class SurfLayer implements Comp {
  private nextWave: number;
  private readonly rumble: GainNode;
  private readonly rumbleLp: BiquadFilterNode;
  private readonly wash: GainNode;
  private readonly washBp: BiquadFilterNode;
  private readonly foam: GainNode | null = null;
  private readonly foamTrain: PulseTrain | null = null;
  constructor(
    private readonly s: Scene,
    private readonly o: SurfOpts,
    pan: number,
    offset: number,
  ) {
    const g = s.g;
    const B = s.core.buffers;
    const rng = s.rng;
    const out = g.pan(pan);
    out.connect(s.dry);
    out.connect(g.gain(o.distant ? 0.55 : 0.25)).connect(s.wet);
    this.rumbleLp = g.filter('lowpass', 300, 0.6);
    this.rumble = g.gain(o.level * 0.3 * (o.distant ? 0.6 : 0.5));
    g.loop(B.brown, rng.range(0, 4)).connect(this.rumbleLp).connect(this.rumble).connect(out);
    this.washBp = g.filter('bandpass', 900, 0.55);
    this.wash = g.gain(0);
    g.loop(B.white, rng.range(0, 3)).connect(this.washBp).connect(this.wash).connect(out);
    if (!o.distant) {
      const vca = g.gain(0);
      g.loop(B.white, rng.range(0, 3)).connect(vca);
      this.foam = g.gain(0);
      vca.connect(g.filter('highpass', 3500, 0.6)).connect(this.foam).connect(out);
      this.foamTrain = new PulseTrain(vca.gain, rng);
      this.foamTrain.mode = 'poisson';
      this.foamTrain.rate = 260;
      this.foamTrain.powerLaw = 1.7;
      this.foamTrain.tau = 0.0015;
      this.foamTrain.tauVar = 0.6;
    }
    this.nextWave = s.start + offset;
  }
  pump(now: number, horizon: number): void {
    while (this.nextWave < horizon) {
      const t = this.nextWave;
      this.wave(t);
      this.nextWave = t + this.s.rng.range(this.o.period[0], this.o.period[1]);
    }
    this.foamTrain?.pump(now, horizon);
  }
  private wave(t0: number): void {
    const rng = this.s.rng;
    const o = this.o;
    const L = o.level;
    const A = rng.range(0.55, 1);
    const rise = rng.range(1.8, 3.2);
    const tc = t0 + rise;
    const tw = tc + rng.range(0.5, 0.9);
    const washT = rng.range(1.3, 2.1);
    const rg = this.rumble.gain;
    const rf = this.rumbleLp.frequency;
    const wg = this.wash.gain;
    const wf = this.washBp.frequency;
    // breaking "shhh" dominates up close, the low roar carries further
    const washK = o.distant ? 0.9 : 2.6;
    const rumK = o.distant ? 0.6 : 0.5;
    // swell
    rg.setTargetAtTime(L * A * 0.75 * rumK, t0, rise / 2.5);
    rf.setTargetAtTime(o.distant ? 330 + 250 * A : 450 + 600 * A, t0, rise / 2.5);
    wg.setTargetAtTime(L * A * 0.25 * washK, t0, rise / 2);
    wf.setTargetAtTime(o.distant ? 650 : 1100, t0, rise / 2);
    // crash / break
    rg.setTargetAtTime(L * A * rumK, tc, 0.18);
    rf.setTargetAtTime(o.distant ? 650 : 1500, tc, 0.2);
    wg.setTargetAtTime(L * A * washK, tc, o.distant ? 0.35 : 0.12);
    wf.setTargetAtTime(o.distant ? 1100 : 3300 * (0.8 + 0.4 * A), tc, 0.15);
    // wash / recede
    rg.setTargetAtTime(L * 0.3 * rumK, tw, 1.7);
    rf.setTargetAtTime(o.distant ? 300 : 420, tw, 1.6);
    wg.setTargetAtTime(L * A * 0.06 * washK, tw, washT);
    wf.setTargetAtTime(o.distant ? 550 : 1700, tw, 1.8);
    if (this.foam) {
      const fg = this.foam.gain;
      fg.setTargetAtTime(L * A * 1.6, tc + 0.1, 0.15);
      fg.setTargetAtTime(0, tw + 0.4, washT * 0.9);
    }
  }
}

class CowBells implements Comp {
  private readonly cows: { f: number; pan: number; dist: number; next: number }[] = [];
  constructor(
    private readonly s: Scene,
    private readonly level: number,
  ) {
    const rng = s.rng;
    for (let k = 0; k < 3; k++) {
      this.cows.push({ f: rng.range(520, 900), pan: rng.range(-0.8, 0.8), dist: rng.range(0.4, 0.95), next: s.start + rng.range(0.5, 6) });
    }
  }
  pump(_now: number, horizon: number): void {
    const rng = this.s.rng;
    for (const cow of this.cows) {
      while (cow.next < horizon) {
        let t = cow.next;
        const n = rng.int(1, 4);
        for (let k = 0; k < n; k++) {
          this.clank(t, cow);
          t += rng.range(0.18, 0.55);
        }
        cow.next = t + rng.range(3, 12);
      }
    }
  }
  private clank(t: number, cow: { f: number; pan: number; dist: number }): void {
    const s = this.s;
    const rng = s.rng;
    const v = s.voice(0.35 + 0.35 * cow.dist);
    if (!v) return;
    const f = cow.f * rng.range(0.99, 1.01);
    const decay = rng.range(0.3, 0.55);
    const end = t + decay * 6;
    const car = v.osc('sine', f, t, end);
    const mod = v.osc('sine', f * 1.47, t, end);
    const idx = v.gain(0);
    mod.connect(idx).connect(car.frequency);
    idx.gain.setValueAtTime(f * rng.range(1.6, 2.6), t);
    idx.gain.setTargetAtTime(f * 0.25, t + 0.002, 0.07);
    const env = v.gain(0);
    const pk = this.level * (1 - 0.6 * cow.dist) * rng.range(0.5, 1);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(pk, t + 0.002);
    env.gain.setTargetAtTime(0, t + 0.003, decay);
    const lp = v.filter('lowpass', 3200 - 1600 * cow.dist, 0.6);
    car.connect(env).connect(lp).connect(v.pan(cow.pan)).connect(v.out);
  }
}

/** Tuned wind chimes (free-free bar partials) struck more often in gusts. */
class Chimes implements Comp {
  private next: number;
  private wind = 0.3;
  private nextWind = 0;
  constructor(
    private readonly s: Scene,
    private readonly notes: readonly number[],
    private readonly level: number,
  ) {
    this.next = s.start + s.rng.range(0.3, 1.5);
  }
  pump(now: number, horizon: number): void {
    const rng = this.s.rng;
    if (now >= this.nextWind) {
      this.nextWind = now + rng.range(2, 6);
      this.wind = Math.pow(rng.next(), 1.5);
    }
    while (this.next < horizon) {
      const t = this.next;
      this.strike(t);
      const rate = 0.2 + 1.8 * this.wind;
      this.next = t + Math.max(0.09, rng.exp(1 / rate));
    }
  }
  private strike(t: number): void {
    const s = this.s;
    const rng = s.rng;
    const v = s.voice(0.5);
    if (!v) return;
    const f = mtof(rng.pick(this.notes));
    const pk = this.level * rng.range(0.4, 1) * (0.5 + 0.5 * this.wind);
    const pan = v.pan(rng.range(-0.75, 0.75));
    pan.connect(v.out);
    const parts: [number, number, number][] = [
      [1, 1, rng.range(2.2, 3.4)],
      [2.756, 0.38, rng.range(0.9, 1.4)],
      [5.404, 0.14, rng.range(0.35, 0.55)],
    ];
    for (const [ratio, a, tau] of parts) {
      const o = v.osc('sine', f * ratio, t, t + tau * 6, rng.range(-3, 3));
      const env = v.gain(0);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(pk * a, t + 0.003);
      env.gain.setTargetAtTime(0, t + 0.004, tau);
      o.connect(env).connect(pan);
    }
  }
}

/** Soft fairy-dust tinkles. */
class Sparkles implements Comp {
  private next: number;
  constructor(
    private readonly s: Scene,
    private readonly notes: readonly number[],
    private readonly level: number,
  ) {
    this.next = s.start + s.rng.range(1, 4);
  }
  pump(_now: number, horizon: number): void {
    const rng = this.s.rng;
    while (this.next < horizon) {
      const t = this.next;
      this.burst(t);
      this.next = t + rng.range(3, 8);
    }
  }
  private burst(t: number): void {
    const s = this.s;
    const rng = s.rng;
    const v = s.voice(0.6);
    if (!v) return;
    const n = rng.int(3, 7);
    const up = rng.chance(0.5);
    const start = rng.int(0, Math.max(0, this.notes.length - n));
    const pan = v.pan(rng.range(-0.8, 0.8));
    pan.connect(v.out);
    for (let k = 0; k < n; k++) {
      const idx = up ? start + k : start + n - 1 - k;
      const f = mtof(this.notes[Math.min(this.notes.length - 1, idx)]);
      const tk = t + k * rng.range(0.05, 0.09);
      const tau = rng.range(0.06, 0.12);
      const o = v.osc('sine', f, tk, tk + tau * 6);
      const env = v.gain(0);
      env.gain.setValueAtTime(0, tk);
      env.gain.linearRampToValueAtTime(this.level * rng.range(0.6, 1), tk + 0.002);
      env.gain.setTargetAtTime(0, tk + 0.003, tau);
      o.connect(env).connect(pan);
    }
  }
}

/** Warm airy drone (root, fifth, ninth) with slowly breathing filter. */
class Drone implements Comp {
  constructor(s: Scene, root: number, level: number) {
    const g = s.g;
    const rng = s.rng;
    const W = s.core.waves;
    const lp = g.filter('lowpass', 900, 0.6);
    const lvl = g.gain(level);
    lp.connect(lvl);
    lvl.connect(s.dry);
    lvl.connect(g.gain(0.8)).connect(s.wet);
    const voices: [number, number, OscillatorType | PeriodicWave, number][] = [
      [root, -4, W.warm, 1],
      [root + 7, 3, W.warm, 0.7],
      [root + 14, 2, 'sine', 0.3],
      [root - 12, 0, 'triangle', 0.35],
    ];
    for (const [m, det, wave, a] of voices) g.osc(wave, mtof(m), det + rng.range(-1, 1)).connect(g.gain(a)).connect(lp);
    const lfo = g.osc('sine', 0.045);
    lfo.connect(g.gain(320)).connect(lp.frequency);
    const swell = g.osc('sine', 0.031);
    swell.connect(g.gain(level * 0.3)).connect(lvl.gain);
    // breath: noise resonating on drone harmonics
    const n = g.loop(s.core.buffers.pink, rng.range(0, 4));
    const b1 = g.filter('bandpass', mtof(root) * 4, 9);
    const b2 = g.filter('bandpass', mtof(root) * 6, 11);
    n.connect(b1).connect(g.gain(0.9)).connect(lvl);
    n.connect(b2).connect(g.gain(0.6)).connect(lvl);
  }
  pump(): void {
    /* continuous */
  }
}

// ------------------------------------------------------------------ city

/** Distant traffic far below: a low roar that swells as buses and bunches of cars pass. */
class TrafficHum implements Comp {
  private next: number;
  private readonly level: SmoothParam;
  private readonly cut: SmoothParam;
  constructor(
    private readonly s: Scene,
    private readonly peak: number,
  ) {
    const g = s.g;
    const B = s.core.buffers;
    const rng = s.rng;
    const lp = g.filter('lowpass', 420, 0.6);
    const lvl = g.gain(peak * 0.6);
    const m = g.merger(2);
    g.loop(B.brown, rng.range(0, 4)).connect(g.filter('lowpass', 260, 0.5)).connect(m, 0, 0);
    g.loop(B.brown, rng.range(0, 4)).connect(g.filter('lowpass', 260, 0.5)).connect(m, 0, 1);
    // tyre hiss on the asphalt, much quieter, an octave of pink noise around 1 kHz
    const hiss = g.filter('bandpass', 1100, 0.7);
    g.loop(B.pink, rng.range(0, 4)).connect(hiss).connect(g.gain(0.18)).connect(lp);
    m.connect(lp).connect(lvl);
    lvl.connect(s.dry);
    lvl.connect(g.gain(0.5)).connect(s.wet);
    this.level = new SmoothParam(lvl.gain, 0.002);
    this.cut = new SmoothParam(lp.frequency);
    this.next = s.start;
  }
  pump(now: number): void {
    if (now < this.next) return;
    const rng = this.s.rng;
    const x = rng.next();
    const tau = rng.range(1.2, 3);
    this.level.set(this.peak * lerp(0.55, 1, x), now, tau);
    this.cut.set(lerp(320, 700, x), now, tau);
    this.next = now + rng.range(2, 6);
  }
}

/** Far-off car horns and the odd siren drifting up from the boulevard. */
class StreetCalls implements Comp {
  private nextHorn: number;
  private nextSiren: number;
  constructor(
    private readonly s: Scene,
    private readonly level: number,
  ) {
    this.nextHorn = s.start + s.rng.range(4, 9);
    this.nextSiren = s.start + s.rng.range(20, 45);
  }
  pump(_now: number, horizon: number): void {
    const rng = this.s.rng;
    while (this.nextHorn < horizon) {
      const t = this.nextHorn;
      this.horn(t);
      if (rng.chance(0.35)) this.horn(t + rng.range(0.25, 0.5));
      this.nextHorn = t + Math.max(3, rng.exp(11));
    }
    while (this.nextSiren < horizon) {
      this.siren(this.nextSiren);
      this.nextSiren += rng.range(45, 90);
    }
  }
  private horn(t: number): void {
    const s = this.s;
    const rng = s.rng;
    const v = s.voice(0.7);
    if (!v) return;
    const d = rng.range(0.18, 0.55);
    const f = rng.range(330, 470);
    const end = t + d + 0.1;
    const env = v.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(this.level * rng.range(0.4, 1), t + 0.02);
    env.gain.setValueAtTime(this.level * 0.8, t + d);
    env.gain.linearRampToValueAtTime(0, t + d + 0.06);
    // two slightly detuned reeds a third apart, muffled by distance
    const lp = v.filter('lowpass', 1500, 0.7);
    for (const r of [1, 1.26]) v.osc(s.core.waves.reed, f * r, t, end, rng.range(-8, 8)).connect(env);
    env.connect(lp).connect(v.pan(rng.range(0.1, 0.9))).connect(v.out);
  }
  private siren(t: number): void {
    const s = this.s;
    const rng = s.rng;
    const v = s.voice(0.8);
    if (!v) return;
    const dur = rng.range(7, 11);
    const end = t + dur;
    const osc = v.osc('triangle', 700, t, end);
    // wailing between ~650 and ~1250 Hz, 4 s cycles
    const n = Math.ceil(dur * 50);
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = 950 + 300 * Math.sin((i / 50) * ((Math.PI * 2) / 4) - Math.PI / 2);
    osc.frequency.setValueCurveAtTime(curve, t, dur);
    const env = v.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(this.level * 0.35, t + dur * 0.4);
    env.gain.linearRampToValueAtTime(0, end);
    const pan = v.pan(0);
    pan.pan.setValueAtTime(-0.2, t);
    pan.pan.linearRampToValueAtTime(0.85, end);
    osc.connect(v.filter('lowpass', 1800, 0.7)).connect(env).connect(pan).connect(v.out);
  }
}

// ------------------------------------------------------------------ scenes per kind

const PENTA = [0, 2, 4, 7, 9];
function pentatonic(root: number, octaves: number): number[] {
  const out: number[] = [];
  for (let o = 0; o < octaves; o++) for (const p of PENTA) out.push(root + 12 * o + p);
  return out;
}

export type AmbiencePart = 'breeze' | 'birds' | 'gulls' | 'surf' | 'hawk' | 'insects' | 'cowbells' | 'chimes' | 'sparkles' | 'drone' | 'traffic' | 'street';

/** Build the components of a scene; `only` (debug) restricts it to some part types. */
function buildScene(s: Scene, only?: readonly AmbiencePart[]): void {
  const add = (part: AmbiencePart, make: () => Comp): void => {
    if (!only || only.includes(part)) s.comps.push(make());
  };
  switch (s.kind) {
    case 'menu':
      add('breeze', () => new Breeze(s, { level: 0.27, lo: 380, hi: 950, gustMin: 0.5, gustMax: 1, minDt: 2, maxDt: 5, tauLo: 0.9, tauHi: 1.8 }));
      add('birds', () => new Birds(s, ['robin', 'tit', 'whistle', 'chips', 'warbler'], { level: 0.3, every: 4.5, minGap: 1.2, first: [0.4, 2] }));
      break;
    case 'coast':
      add('surf', () => new SurfLayer(s, { distant: true, level: 0.32, period: [8, 13] }, -0.45, 0.2));
      add('surf', () => new SurfLayer(s, { distant: true, level: 0.26, period: [9, 14] }, 0.5, 4.5));
      add('breeze', () => new Breeze(s, { level: 0.21, lo: 420, hi: 1100, gustMin: 0.5, gustMax: 1, minDt: 2, maxDt: 5, tauLo: 0.9, tauHi: 1.8 }));
      add('gulls', () => new Gulls(s, { level: 0.42, every: 14, minGap: 6, first: [3, 7], near: 0.35 }));
      add('birds', () => new Birds(s, ['robin', 'whistle', 'chips'], { level: 0.24, every: 8, minGap: 2, first: [1, 4] }));
      break;
    case 'desert':
      add(
        'breeze',
        () =>
          new Breeze(s, {
            level: 0.31,
            lo: 450,
            hi: 1700,
            gustMin: 0.3,
            gustMax: 1.1,
            minDt: 0.8,
            maxDt: 3,
            tauLo: 0.4,
            tauHi: 1.2,
            howl: { lo: 600, hi: 950, level: 0.18, q: 9 },
          }),
      );
      add('hawk', () => new Hawk(s, 0.4));
      add('insects', () => new Insects(s, 0.2, 5200, -0.5));
      add('insects', () => new Insects(s, 0.14, 6100, 0.55));
      break;
    case 'alpine':
      add(
        'breeze',
        () =>
          new Breeze(s, {
            level: 0.3,
            lo: 600,
            hi: 2300,
            gustMin: 0.3,
            gustMax: 1.15,
            minDt: 1.2,
            maxDt: 4,
            tauLo: 0.5,
            tauHi: 1.4,
            howl: { lo: 820, hi: 1350, level: 0.22, q: 12 },
          }),
      );
      add('cowbells', () => new CowBells(s, 0.075));
      add('birds', () => new Birds(s, ['cuckoo', 'chips', 'robin', 'tit', 'cuckoo', 'marmot'], { level: 0.22, every: 7, minGap: 2, first: [1, 4] }));
      break;
    case 'fantasy': {
      const root = 63; // E-flat, matches the fantasy music key
      add('breeze', () => new Breeze(s, { level: 0.15, lo: 500, hi: 1300, gustMin: 0.5, gustMax: 1, minDt: 2, maxDt: 5, tauLo: 1, tauHi: 2 }));
      add('chimes', () => new Chimes(s, pentatonic(root + 12, 2), 0.06));
      add('sparkles', () => new Sparkles(s, pentatonic(root + 24, 2), 0.035));
      add('drone', () => new Drone(s, root - 12, 0.025));
      break;
    }
    case 'beach':
      add('surf', () => new SurfLayer(s, { distant: false, level: 0.34, period: [6, 10] }, -0.3, 0.1));
      add('surf', () => new SurfLayer(s, { distant: false, level: 0.26, period: [7, 11] }, 0.35, 3.8));
      add('breeze', () => new Breeze(s, { level: 0.21, lo: 500, hi: 1250, gustMin: 0.5, gustMax: 1, minDt: 2, maxDt: 5, tauLo: 0.8, tauHi: 1.6 }));
      add('gulls', () => new Gulls(s, { level: 0.5, every: 8, minGap: 3, first: [1, 4], near: 0.65 }));
      break;
    case 'city':
      // wind at height (whistling through the railing), the boulevard's roar far below, horns and sirens
      add(
        'breeze',
        () =>
          new Breeze(s, {
            level: 0.27,
            lo: 500,
            hi: 1800,
            gustMin: 0.35,
            gustMax: 1.1,
            minDt: 1,
            maxDt: 3.5,
            tauLo: 0.5,
            tauHi: 1.3,
            howl: { lo: 700, hi: 1150, level: 0.14, q: 10 },
          }),
      );
      add('traffic', () => new TrafficHum(s, 0.22));
      add('street', () => new StreetCalls(s, 0.07));
      add('birds', () => new Birds(s, ['chips', 'tit'], { level: 0.12, every: 14, minGap: 4, first: [3, 8] }));
      break;
  }
}

/** Which part types each ambience kind uses (debug / tests). */
export const AMBIENCE_PARTS: Record<AmbienceKind, readonly AmbiencePart[]> = {
  menu: ['breeze', 'birds'],
  coast: ['surf', 'breeze', 'gulls', 'birds'],
  desert: ['breeze', 'hawk', 'insects'],
  alpine: ['breeze', 'cowbells', 'birds'],
  fantasy: ['breeze', 'chimes', 'sparkles', 'drone'],
  beach: ['surf', 'breeze', 'gulls'],
  city: ['breeze', 'traffic', 'street', 'birds'],
};

// ------------------------------------------------------------------ manager

export class AmbienceManager {
  kind: AmbienceKind | null = null;
  private current: Scene | null = null;
  private readonly fading: Scene[] = [];

  constructor(private readonly core: AudioCore) {}

  /** Crossfade to `kind`. `only` (debug) builds just some part types of the scene. */
  set(kind: AmbienceKind, now: number, only?: readonly AmbiencePart[]): void {
    if (kind === this.kind && this.current && !only) return;
    this.kind = kind;
    if (this.current) {
      this.current.fadeOut(now, FADE);
      this.fading.push(this.current);
    }
    while (this.fading.length > 2) this.fading.shift()?.dispose();
    const s = new Scene(this.core, kind, now);
    buildScene(s, only);
    s.fadeIn(now, FADE);
    this.current = s;
  }

  pump(now: number): void {
    const horizon = now + LOOKAHEAD;
    this.current?.pump(now, horizon);
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const s = this.fading[i];
      if (now >= s.disposeAt) {
        s.dispose();
        this.fading.splice(i, 1);
      }
    }
  }

  get sceneCount(): number {
    return (this.current ? 1 : 0) + this.fading.length;
  }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
    for (const s of this.fading) s.dispose();
    this.fading.length = 0;
  }
}
