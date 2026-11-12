/**
 * Shared helpers for the procedural audio engine: deterministic RNG, math, a node factory that
 * counts every node it creates (debug leak detection), short-lived "voices" that disconnect
 * themselves after their sources end, and long-lived node groups that can be disposed at once.
 */

export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Replace NaN / Infinity by a fallback. */
export const finite = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);

/** mulberry32 – small, fast, deterministic. */
export class Rng {
  private s: number;
  constructor(seed: number = (Math.random() * 4294967296) >>> 0) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Integer in [a, b] inclusive. */
  int(a: number, b: number): number {
    return Math.min(b, a + Math.floor(this.next() * (b - a + 1)));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }
  /** Exponentially distributed value with the given mean (Poisson process intervals). */
  exp(mean: number): number {
    return -Math.log(1 - this.next() * 0.999999) * mean;
  }
  /** Roughly gaussian (Irwin–Hall), mean 0, sd ~1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }
}

/** Debug counters. `live` must stay bounded while the game runs. */
export class NodeStats {
  created = 0;
  released = 0;
  voices = 0;
  peakVoices = 0;
  droppedVoices = 0;
  get live(): number {
    return this.created - this.released;
  }
}

export interface FilterSpec {
  type: BiquadFilterType;
  f: number;
  Q?: number;
  gain?: number;
}

/** Node factory: every node in the engine is created through here so it is counted. */
export class Kit {
  constructor(
    readonly ctx: BaseAudioContext,
    readonly stats: NodeStats,
  ) {}
  private n<T extends AudioNode>(node: T): T {
    this.stats.created++;
    return node;
  }
  gain(v = 1): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return this.n(g);
  }
  filter(type: BiquadFilterType, f: number, Q = 0.7071, gainDb = 0): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = Q;
    b.gain.value = gainDb;
    return this.n(b);
  }
  osc(wave: OscillatorType | PeriodicWave, f: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (typeof wave === 'string') o.type = wave as OscillatorType;
    else o.setPeriodicWave(wave);
    o.frequency.value = f;
    o.detune.value = detune;
    return this.n(o);
  }
  buffer(buf: AudioBuffer, loop = true, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    s.playbackRate.value = rate;
    return this.n(s);
  }
  pan(p = 0): StereoPannerNode {
    const s = this.ctx.createStereoPanner();
    s.pan.value = p;
    return this.n(s);
  }
  constant(v = 1): ConstantSourceNode {
    const c = this.ctx.createConstantSource();
    c.offset.value = v;
    return this.n(c);
  }
  shaper(curve: Float32Array<ArrayBuffer>, oversample: OverSampleType = 'none'): WaveShaperNode {
    const w = this.ctx.createWaveShaper();
    w.curve = curve;
    w.oversample = oversample;
    return this.n(w);
  }
  convolver(buf: AudioBuffer): ConvolverNode {
    const c = this.ctx.createConvolver();
    c.normalize = true;
    c.buffer = buf;
    return this.n(c);
  }
  compressor(threshold: number, knee: number, ratio: number, attack: number, release: number): DynamicsCompressorNode {
    const c = this.ctx.createDynamicsCompressor();
    c.threshold.value = threshold;
    c.knee.value = knee;
    c.ratio.value = ratio;
    c.attack.value = attack;
    c.release.value = release;
    return this.n(c);
  }
  merger(inputs = 2): ChannelMergerNode {
    return this.n(this.ctx.createChannelMerger(inputs));
  }
  analyser(): AnalyserNode {
    return this.n(this.ctx.createAnalyser());
  }
}

/** Smoothly glide an AudioParam (ignores non-finite targets). */
export function glide(p: AudioParam, v: number, t: number, tau: number): void {
  if (!Number.isFinite(v)) return;
  p.setTargetAtTime(v, t, Math.max(0.002, tau));
}

/**
 * A continuously-modulated parameter that only issues automation when the target changes by a
 * meaningful amount – keeps the AudioParam timeline tiny when updated 60x per second.
 */
export class SmoothParam {
  private last = Number.NaN;
  constructor(
    readonly param: AudioParam,
    private readonly relEps = 0.01,
    private readonly absEps = 1e-5,
  ) {
    this.last = param.value;
  }
  set(v: number, t: number, tau: number): void {
    if (!Number.isFinite(v)) return;
    const d = Math.abs(v - this.last);
    if (d <= this.absEps || d <= Math.abs(this.last) * this.relEps) {
      // tiny change, but always allow reaching an exact zero (silence) target
      if (!(v === 0 && this.last !== 0)) return;
    }
    this.last = v;
    this.param.setTargetAtTime(v, t, Math.max(0.002, tau));
  }
  /** Force the next `set` to be issued. */
  invalidate(): void {
    this.last = Number.NaN;
  }
}

/** Keeps track of transient voices (for leak-proof cleanup and polyphony limits). */
export class VoicePool {
  private readonly active = new Set<Voice>();
  constructor(
    readonly kit: Kit,
    readonly maxVoices: number,
  ) {}
  /** Returns null when the polyphony budget is exhausted (and `priority` is low). */
  create(dest: AudioNode, priority = 1): Voice | null {
    const stats = this.kit.stats;
    if (this.active.size >= this.maxVoices) {
      if (priority < 2) {
        stats.droppedVoices++;
        return null;
      }
      // steal the oldest voice for important sounds
      const oldest = this.active.values().next().value;
      if (oldest) oldest.release();
    }
    const v = new Voice(this, dest);
    this.active.add(v);
    stats.voices = this.active.size;
    stats.peakVoices = Math.max(stats.peakVoices, stats.voices);
    return v;
  }
  /** @internal */
  remove(v: Voice): void {
    this.active.delete(v);
    this.kit.stats.voices = this.active.size;
  }
  /** Safety net: release voices whose sources should have ended long ago (ended event lost). */
  reap(now: number): void {
    for (const v of this.active) {
      if (v.endTime > 0 ? now > v.endTime + 1.5 : now > v.createdAt + 5) v.release();
    }
  }
  releaseAll(): void {
    for (const v of [...this.active]) v.release();
  }
  get size(): number {
    return this.active.size;
  }
}

/**
 * A short-lived group of nodes (one-shot sound / ambience event). Every source is started and
 * stopped explicitly; when the last one ends all nodes are disconnected and accounted released.
 */
export class Voice {
  readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private ended = 0;
  private done = false;
  endTime = 0;
  readonly createdAt: number;
  /** Voice output (connect your chain into this). */
  readonly out: GainNode;

  constructor(
    private readonly pool: VoicePool,
    dest: AudioNode,
  ) {
    this.createdAt = pool.kit.ctx.currentTime;
    this.out = this.gain(1);
    this.out.connect(dest);
  }
  get kit(): Kit {
    return this.pool.kit;
  }
  get ctx(): BaseAudioContext {
    return this.pool.kit.ctx;
  }
  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  gain(v = 1): GainNode {
    return this.add(this.kit.gain(v));
  }
  filter(type: BiquadFilterType, f: number, Q = 0.7071, gainDb = 0): BiquadFilterNode {
    return this.add(this.kit.filter(type, f, Q, gainDb));
  }
  pan(p: number): StereoPannerNode {
    return this.add(this.kit.pan(p));
  }
  /** Serially connected filters (empty array if none). */
  chain(specs: readonly FilterSpec[]): BiquadFilterNode[] {
    const nodes = specs.map((s) => this.filter(s.type, s.f, s.Q ?? 0.7071, s.gain ?? 0));
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes;
  }
  /** Oscillator started at `start` and stopped at `stop`. */
  osc(wave: OscillatorType | PeriodicWave, f: number, start: number, stop: number, detune = 0): OscillatorNode {
    const o = this.add(this.kit.osc(wave, f, detune));
    this.track(o, start, stop);
    return o;
  }
  /** Buffer source (random start offset for noise loops) started/stopped explicitly. */
  buffer(buf: AudioBuffer, start: number, stop: number, offset = 0, rate = 1, loop = true): AudioBufferSourceNode {
    const s = this.add(this.kit.buffer(buf, loop, rate));
    this.sources.push(s);
    s.onended = this.onEnded;
    s.start(start, offset % buf.duration);
    s.stop(stop);
    this.endTime = Math.max(this.endTime, stop);
    return s;
  }
  constant(v: number, start: number, stop: number): ConstantSourceNode {
    const c = this.add(this.kit.constant(v));
    this.track(c, start, stop);
    return c;
  }
  private track(s: AudioScheduledSourceNode, start: number, stop: number): void {
    this.sources.push(s);
    s.onended = this.onEnded;
    s.start(start);
    s.stop(stop);
    this.endTime = Math.max(this.endTime, stop);
  }
  private readonly onEnded = (): void => {
    this.ended++;
    if (this.ended >= this.sources.length) this.release();
  };
  release(): void {
    if (this.done) return;
    this.done = true;
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.pool.kit.stats.released += this.nodes.length;
    this.pool.remove(this);
  }
}

/** Long-lived node group (ambience scene, music band, ride layer...) that is disposed at once. */
export class NodeGroup {
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private disposed = false;
  constructor(readonly kit: Kit) {}
  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  gain(v = 1): GainNode {
    return this.add(this.kit.gain(v));
  }
  filter(type: BiquadFilterType, f: number, Q = 0.7071, gainDb = 0): BiquadFilterNode {
    return this.add(this.kit.filter(type, f, Q, gainDb));
  }
  pan(p = 0): StereoPannerNode {
    return this.add(this.kit.pan(p));
  }
  merger(n = 2): ChannelMergerNode {
    return this.add(this.kit.merger(n));
  }
  osc(wave: OscillatorType | PeriodicWave, f: number, detune = 0, start = 0): OscillatorNode {
    const o = this.add(this.kit.osc(wave, f, detune));
    this.sources.push(o);
    o.start(start);
    return o;
  }
  /** Looping buffer source started immediately at a random offset. */
  loop(buf: AudioBuffer, offset: number, rate = 1, start = 0): AudioBufferSourceNode {
    const s = this.add(this.kit.buffer(buf, true, rate));
    this.sources.push(s);
    s.start(start, offset % buf.duration);
    return s;
  }
  constant(v = 0, start = 0): ConstantSourceNode {
    const c = this.add(this.kit.constant(v));
    this.sources.push(c);
    c.start(start);
    return c;
  }
  get size(): number {
    return this.nodes.length;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.kit.stats.released += this.nodes.length;
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}

/**
 * Schedules short gain "grains" on a persistent VCA (no node allocation per grain): used for
 * freewheel ticks, gravel crackle, plank knocks, foam fizz, rattles...
 */
export class PulseTrain {
  /** Pulses per second (0 = off). */
  rate = 0;
  /** 'periodic' = evenly spaced with jitter, 'poisson' = random arrivals. */
  mode: 'periodic' | 'poisson' = 'periodic';
  /** Relative timing jitter for periodic mode. */
  jitter = 0.04;
  /** Mean grain amplitude and random variation (0..1). */
  amp = 1;
  ampVar = 0.2;
  /** If > 0, amplitude is drawn from a power law (many small, few big grains). */
  powerLaw = 0;
  /** Decay time constant (s), and its random variation. */
  tau = 0.002;
  tauVar = 0;
  /** Attack time (s) – 0 = instant click. */
  attack = 0;
  private next = 0;
  private wasActive = false;

  constructor(
    readonly param: AudioParam,
    private readonly rng: Rng,
  ) {
    param.value = 0;
  }

  /** Schedule all pulses that fall before `horizon`. */
  pump(now: number, horizon: number): void {
    const active = this.rate > 0.05;
    if (!active) {
      if (this.wasActive) this.silence(now);
      this.wasActive = false;
      return;
    }
    if (!this.wasActive || this.next < now) {
      this.next = now + (this.mode === 'poisson' ? this.rng.exp(1 / this.rate) : 0.004);
    }
    this.wasActive = true;
    let guard = 0;
    const p = this.param;
    while (this.next < horizon && guard++ < 512) {
      const t = this.next;
      let a: number;
      if (this.powerLaw > 0) a = this.amp * Math.pow(this.rng.next(), this.powerLaw);
      else a = this.amp * (1 - this.ampVar * this.rng.next());
      const tau = this.tau * (1 + this.tauVar * (this.rng.next() * 2 - 1));
      if (this.attack > 0) {
        p.setValueAtTime(0, t);
        p.linearRampToValueAtTime(a, t + this.attack);
        p.setTargetAtTime(0, t + this.attack, tau);
      } else {
        p.setValueAtTime(a, t);
        p.setTargetAtTime(0, t + 0.0002, tau);
      }
      if (this.mode === 'poisson') this.next += this.rng.exp(1 / this.rate);
      else this.next += (1 / this.rate) * (1 + this.jitter * (this.rng.next() * 2 - 1));
    }
  }

  /** Cancel pending grains (e.g. when the rider starts pedalling). */
  silence(now: number): void {
    this.param.cancelScheduledValues(now + 0.001);
    this.param.setTargetAtTime(0, now + 0.001, 0.004);
    this.wasActive = false;
  }
}
