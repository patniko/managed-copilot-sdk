/**
 * One-shot sound effects. Each call builds a tiny transient graph inside a Voice which
 * disconnects itself once its sources have ended.
 */
import type { Surface } from '../audioTypes';
import type { AudioCore } from './core';
import { type FilterSpec, Rng, Voice, clamp, clamp01, finite, mtof } from './util';

type NoiseKind = 'white' | 'pink' | 'brown';

interface EnvOpts {
  t: number;
  peak: number;
  /** Exponential decay time constant (s). */
  decay: number;
  attack?: number;
  hold?: number;
  pan?: number;
  dest?: AudioNode;
}

interface NoiseOpts extends EnvOpts {
  kind?: NoiseKind;
  filters?: FilterSpec[];
  /** Share an already running source (must cover the envelope). */
  src?: AudioNode;
}

interface ToneOpts extends EnvOpts {
  wave: OscillatorType | PeriodicWave;
  f: number;
  fTo?: number;
  fTime?: number;
  detune?: number;
  lp?: number;
}

const PENTA = [0, 2, 4, 7, 9];
const SURFACES: readonly Surface[] = ['dirt', 'grass', 'sand', 'rock', 'snow', 'wood'];

/** Landing impact voicing per surface. */
const LAND: Record<Surface, { lp: number; thud: number; body: number }> = {
  dirt: { lp: 900, thud: 1, body: 1 },
  grass: { lp: 650, thud: 0.8, body: 0.85 },
  sand: { lp: 700, thud: 0.75, body: 0.7 },
  rock: { lp: 2200, thud: 1, body: 1.05 },
  snow: { lp: 1100, thud: 0.75, body: 0.75 },
  wood: { lp: 600, thud: 0.9, body: 0.9 },
};

export class Sfx {
  private readonly core: AudioCore;
  private readonly rng: Rng;
  private readonly last = new Map<string, number>();

  constructor(core: AudioCore) {
    this.core = core;
    this.rng = core.rng;
  }

  // ------------------------------------------------------------------ helpers

  private gate(name: string, minGap: number): boolean {
    const now = this.core.ctx.currentTime;
    const prev = this.last.get(name);
    if (prev !== undefined && now - prev < minGap && now >= prev) return false;
    this.last.set(name, now);
    return true;
  }

  private open(priority: number, send: number): Voice | null {
    const v = this.core.voices.create(this.core.sfxBus.in, priority);
    if (!v) return null;
    if (send > 0) v.out.connect(v.gain(send)).connect(this.core.sfxBus.send);
    return v;
  }

  private get t0(): number {
    return this.core.ctx.currentTime + 0.004;
  }

  private envelope(v: Voice, input: AudioNode, o: EnvOpts): GainNode {
    const env = v.gain(0);
    input.connect(env);
    const dest = o.dest ?? v.out;
    if (o.pan) env.connect(v.pan(clamp(o.pan, -1, 1))).connect(dest);
    else env.connect(dest);
    const a = o.attack ?? 0.002;
    const h = o.hold ?? 0;
    const p = env.gain;
    p.setValueAtTime(0, o.t);
    p.linearRampToValueAtTime(o.peak, o.t + a);
    if (h > 0) p.setValueAtTime(o.peak, o.t + a + h);
    p.setTargetAtTime(0, o.t + a + h, o.decay);
    return env;
  }

  private endOf(o: EnvOpts): number {
    // 6 time constants = -52 dB below the peak: inaudible when the source stops
    return o.t + (o.attack ?? 0.002) + (o.hold ?? 0) + o.decay * 6 + 0.02;
  }

  /** Noise source for a voice (random offset into the loop). */
  private src(v: Voice, kind: NoiseKind, t: number, end: number): AudioBufferSourceNode {
    const buf = this.core.buffers[kind];
    return v.buffer(buf, t, end, this.rng.range(0, buf.duration));
  }

  private noise(v: Voice, o: NoiseOpts): { env: GainNode; filters: BiquadFilterNode[] } {
    const source = o.src ?? this.src(v, o.kind ?? 'white', o.t, this.endOf(o));
    const filters = o.filters ? v.chain(o.filters) : [];
    let head: AudioNode = source;
    if (filters.length) {
      source.connect(filters[0]);
      head = filters[filters.length - 1];
    }
    const env = this.envelope(v, head, o);
    return { env, filters };
  }

  private tone(v: Voice, o: ToneOpts): { osc: OscillatorNode; env: GainNode } {
    const osc = v.osc(o.wave, o.f, o.t, this.endOf(o), o.detune ?? 0);
    if (o.fTo !== undefined) {
      osc.frequency.setValueAtTime(o.f, o.t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.fTo), o.t + (o.fTime ?? 0.1));
    }
    let head: AudioNode = osc;
    if (o.lp) {
      const f = v.filter('lowpass', o.lp, 0.7);
      osc.connect(f);
      head = f;
    }
    return { osc, env: this.envelope(v, head, o) };
  }

  /** Random grain spikes on a gain param (crackles, rustles, rattles). Front-loaded density. */
  private spikes(p: AudioParam, t0: number, dur: number, count: number, peak: number, tauLo: number, tauHi: number, skew = 1.8): void {
    const times: number[] = [];
    for (let k = 0; k < count; k++) times.push(t0 + dur * Math.pow(this.rng.next(), skew));
    times.sort((a, b) => a - b);
    p.setValueAtTime(0, t0);
    for (const tk of times) {
      const fade = Math.exp((-(tk - t0) / dur) * 2.2);
      const a = peak * fade * (0.25 + 0.75 * Math.pow(this.rng.next(), 1.6));
      p.setValueAtTime(a, tk);
      p.setTargetAtTime(0, tk + 0.0003, this.rng.range(tauLo, tauHi));
    }
  }

  /** FM bell / glockenspiel note. */
  private bell(v: Voice, t: number, f: number, peak: number, decay: number, ratio = 2, index = 1.6, pan = 0, dest?: AudioNode): void {
    const end = t + decay * 6 + 0.05;
    const car = v.osc('sine', f, t, end);
    const mod = v.osc('sine', f * ratio, t, end);
    const idx = v.gain(0);
    mod.connect(idx).connect(car.frequency);
    idx.gain.setValueAtTime(f * index, t);
    idx.gain.setTargetAtTime(f * 0.08, t + 0.002, Math.min(0.18, decay * 0.4));
    this.envelope(v, car, { t, peak, decay, attack: 0.0015, pan, dest });
  }

  private key(): number {
    return this.core.keyRoot;
  }

  // ------------------------------------------------------------------ sounds

  playLanding(intensity: number, surface: Surface): void {
    if (!this.gate('land', 0.06)) return;
    const i = clamp01(finite(intensity));
    const sf: Surface = SURFACES.includes(surface) ? surface : 'dirt';
    const L = LAND[sf];
    const v = this.open(2, 0.05);
    if (!v) return;
    const t = this.t0;
    const r = this.rng;

    // body thump
    this.tone(v, { wave: 'sine', f: 92 + 30 * i, fTo: 42, fTime: 0.13, t, attack: 0.002, decay: 0.05 + 0.07 * i, peak: (0.16 + 0.42 * i) * L.body });
    // impact
    this.noise(v, {
      kind: 'brown',
      t,
      peak: (0.2 + 0.45 * i) * L.thud,
      decay: 0.035 + 0.05 * i,
      filters: [{ type: 'lowpass', f: L.lp * (0.8 + 0.4 * i), Q: 0.7 }],
    });

    // surface texture
    const tex = 0.5 + 0.5 * i;
    switch (sf) {
      case 'dirt': {
        const n = this.noise(v, { kind: 'pink', t, peak: 0, decay: 0.06, hold: 0.18, filters: [{ type: 'bandpass', f: 1800, Q: 1 }] });
        this.spikes(n.env.gain, t, 0.2 + 0.1 * i, 10 + Math.round(10 * i), 0.55 * tex, 0.002, 0.008);
        break;
      }
      case 'grass':
        this.noise(v, { kind: 'pink', t, peak: 0.16 * tex, decay: 0.09, attack: 0.006, filters: [{ type: 'bandpass', f: 1500, Q: 0.7 }] });
        break;
      case 'sand':
        this.noise(v, {
          kind: 'white',
          t: t + 0.005,
          peak: 0.07 * tex,
          decay: 0.14,
          attack: 0.012,
          filters: [
            { type: 'highpass', f: 2500 },
            { type: 'lowpass', f: 9000 },
          ],
        });
        break;
      case 'rock': {
        this.noise(v, { kind: 'white', t, peak: 0.22 * tex, decay: 0.012, filters: [{ type: 'bandpass', f: 2400, Q: 3 }] });
        const n = this.noise(v, { kind: 'white', t, peak: 0, decay: 0.02, hold: 0.15, filters: [{ type: 'bandpass', f: 3200, Q: 6 }] });
        this.spikes(n.env.gain, t + 0.01, 0.16, 6 + Math.round(6 * i), 0.7 * tex, 0.002, 0.006);
        break;
      }
      case 'snow': {
        this.noise(v, { kind: 'brown', t, peak: 0.16 * tex, decay: 0.07, filters: [{ type: 'lowpass', f: 600 }] });
        const n = this.noise(v, { kind: 'white', t, peak: 0, decay: 0.03, hold: 0.16, filters: [{ type: 'bandpass', f: 1650, Q: 1.6 }] });
        this.spikes(n.env.gain, t, 0.18, 16 + Math.round(12 * i), 0.45 * tex, 0.003, 0.01, 1.3);
        break;
      }
      case 'wood': {
        this.tone(v, { wave: 'sine', f: 150, fTo: 118, fTime: 0.1, t, decay: 0.11, peak: 0.22 * tex });
        this.noise(v, { kind: 'pink', t, peak: 0.3 * tex, decay: 0.08, filters: [{ type: 'bandpass', f: 220, Q: 6 }] });
        this.noise(v, { kind: 'pink', t: t + 0.045, peak: 0.16 * tex, decay: 0.06, filters: [{ type: 'bandpass', f: 480, Q: 5 }] });
        break;
      }
    }

    // suspension bottoming clunk + chain slap
    if (i > 0.15) {
      const tc = t + 0.03 + 0.025 * (1 - i);
      const k = Math.pow(i, 1.4);
      this.tone(v, { wave: 'triangle', f: 210, fTo: 120, fTime: 0.05, t: tc, attack: 0.001, decay: 0.035, peak: 0.13 * k, lp: 1300 });
      this.noise(v, { kind: 'white', t: tc, peak: 0.12 * k, decay: 0.01, filters: [{ type: 'bandpass', f: 950, Q: 2.5 }] });
    }
    if (i > 0.35) {
      const ts = t + r.range(0.04, 0.07);
      this.noise(v, { kind: 'white', t: ts, peak: 0.07 * i, decay: 0.03, filters: [{ type: 'bandpass', f: 3600, Q: 9 }], pan: 0.15 });
      this.noise(v, { kind: 'white', t: ts + r.range(0.06, 0.1), peak: 0.035 * i, decay: 0.025, filters: [{ type: 'bandpass', f: 4100, Q: 9 }], pan: 0.15 });
    }
  }

  playPop(charge: number): void {
    if (!this.gate('pop', 0.08)) return;
    const c = clamp01(finite(charge));
    const v = this.open(1, 0.03);
    if (!v) return;
    const t = this.t0;
    this.tone(v, { wave: 'sine', f: 150, fTo: 70, fTime: 0.08, t, decay: 0.05, peak: 0.12 + 0.18 * c });
    this.noise(v, { kind: 'brown', t, peak: 0.14 + 0.14 * c, decay: 0.03, filters: [{ type: 'lowpass', f: 1200 }] });
    const w = this.noise(v, { kind: 'pink', t, peak: 0.05 + 0.07 * c, decay: 0.08, attack: 0.03, filters: [{ type: 'bandpass', f: 500, Q: 1.4 }] });
    w.filters[0].frequency.setTargetAtTime(1600 + 600 * c, t, 0.08);
  }

  playTrickStart(): void {
    if (!this.gate('trick', 0.1)) return;
    const v = this.open(1, 0.08);
    if (!v) return;
    const t = this.t0;
    const dir = this.rng.sign();
    const pan = v.pan(-0.5 * dir);
    pan.connect(v.out);
    pan.pan.setValueAtTime(-0.5 * dir, t);
    pan.pan.linearRampToValueAtTime(0.5 * dir, t + 0.3);
    const w = this.noise(v, { kind: 'pink', t, peak: 0.3, decay: 0.08, attack: 0.07, hold: 0.04, filters: [{ type: 'bandpass', f: 450, Q: 1.4 }], dest: pan });
    w.filters[0].frequency.setValueAtTime(450, t);
    w.filters[0].frequency.exponentialRampToValueAtTime(2600, t + 0.22);
    this.noise(v, { kind: 'white', t, peak: 0.06, decay: 0.07, attack: 0.08, hold: 0.03, filters: [{ type: 'highpass', f: 5000 }], dest: pan });
  }

  playTrickLanded(points: number, comboCount: number, perfect: boolean): void {
    if (!this.gate('landed', 0.08)) return;
    const pts = Math.max(0, finite(points));
    const combo = clamp(Math.floor(finite(comboCount)), 0, 12);
    const size = clamp01(pts / 2000);
    const v = this.open(2, 0.22);
    if (!v) return;
    const t = this.t0;
    const key = this.key();
    const n = 3 + Math.round(size * 3);
    // C-E-G-C-E-G shaped pentatonic arpeggio; each combo step starts it one pentatonic degree higher
    const steps = [0, 2, 3, 5, 7, 8];
    const spacing = 0.062 - 0.012 * size;
    const deg0 = Math.min(combo, 6);
    for (let k = 0; k < n; k++) {
      const d = deg0 + steps[k];
      const midi = 72 + key + 12 * Math.floor(d / 5) + PENTA[d % 5];
      const last = k === n - 1;
      const peak = (0.1 + 0.045 * size) * (last ? 1.25 : 1);
      this.bell(v, t + k * spacing, mtof(Math.min(midi, 105)), peak, last ? 0.65 : 0.32, 2, 1.4, -0.3 + (0.6 * k) / Math.max(1, n - 1));
    }
    if (size > 0.55) {
      // warm chord swell underneath big tricks
      const root = 60 + key;
      for (const iv of [0, 4, 7]) {
        this.tone(v, { wave: this.core.waves.warm, f: mtof(root + iv), t, attack: 0.09, decay: 0.45, peak: 0.035, lp: 1800 });
      }
    }
    if (perfect) {
      const ts = t + n * spacing * 0.6;
      for (let k = 0; k < 10; k++) {
        const d = Math.floor(this.rng.next() * 10);
        const midi = 84 + key + 12 * Math.floor(d / 5) + PENTA[d % 5];
        this.tone(v, {
          wave: 'sine',
          f: mtof(Math.min(midi, 106)),
          t: ts + k * 0.03 + this.rng.range(0, 0.012),
          attack: 0.002,
          decay: this.rng.range(0.05, 0.1),
          peak: this.rng.range(0.022, 0.04),
          pan: this.rng.range(-0.7, 0.7),
        });
      }
      this.noise(v, { kind: 'white', t: ts, attack: 0.12, decay: 0.25, peak: 0.022, filters: [{ type: 'highpass', f: 7000 }] });
    }
    this.core.musicBus.duck(0.35, t, 0.5 + 0.3 * size);
  }

  playCrash(intensity: number): void {
    if (!this.gate('crash', 0.25)) return;
    const i = clamp01(finite(intensity));
    const v = this.open(3, 0.08);
    if (!v) return;
    const t = this.t0;
    const r = this.rng;
    // heavy thump
    this.tone(v, { wave: 'sine', f: 85, fTo: 34, fTime: 0.16, t, decay: 0.12, peak: 0.3 + 0.3 * i });
    this.noise(v, { kind: 'brown', t, peak: 0.28 + 0.28 * i, decay: 0.12, filters: [{ type: 'lowpass', f: 380 }] });
    // tumble: body bumps + scrape
    const dur = 0.7 + 0.7 * i;
    const bumps = this.noise(v, { kind: 'brown', t, peak: 0, decay: 0.08, hold: dur, filters: [{ type: 'lowpass', f: 520 }] });
    this.spikes(bumps.env.gain, t + 0.08, dur, 5 + Math.round(6 * i), 0.5 + 0.3 * i, 0.03, 0.07, 1.2);
    const scr = this.noise(v, { kind: 'pink', t: t + 0.05, peak: 0.1 + 0.1 * i, decay: 0.3 * (0.6 + i), attack: 0.06, hold: 0.25 * dur, filters: [{ type: 'bandpass', f: 950, Q: 0.8 }] });
    scr.filters[0].frequency.setTargetAtTime(480, t + 0.2, 0.4);
    // bike clatter: metallic clanks + spoke rings
    const clanks = 5 + Math.round(4 * i);
    const end = t + 1.6;
    const white = this.src(v, 'white', t, end + 0.1);
    for (let k = 0; k < clanks; k++) {
      const tk = t + 0.04 + 0.9 * Math.pow(r.next(), 1.6);
      const f = r.range(1800, 5200);
      const pk = (0.07 + 0.11 * i) * r.range(0.5, 1);
      this.noise(v, { src: white, t: tk, peak: pk, decay: r.range(0.03, 0.1), filters: [{ type: 'bandpass', f, Q: r.range(7, 13) }], pan: r.range(-0.4, 0.4) });
      if (r.chance(0.5)) this.tone(v, { wave: 'sine', f: f * 0.5, t: tk, decay: r.range(0.08, 0.18), peak: pk * 0.18, pan: r.range(-0.4, 0.4) });
    }
    this.core.musicBus.duck(0.5, t, 1.4);
    this.core.ambBus.duck(0.25, t, 1.0);
  }

  playCheckpoint(): void {
    if (!this.gate('checkpoint', 0.15)) return;
    const v = this.open(2, 0.3);
    if (!v) return;
    const t = this.t0;
    const key = this.key();
    const partials: [number, number, number][] = [
      // ratio, amplitude, decay tau
      [0.5, 0.16, 1.6],
      [1, 1, 1.2],
      [2, 0.42, 0.75],
      [3, 0.2, 0.45],
      [4.2, 0.12, 0.22],
    ];
    const notes = [67 + key, 72 + key];
    notes.forEach((m, k) => {
      const tn = t + k * 0.17;
      const f = mtof(m);
      const scale = k === 0 ? 0.11 : 0.13;
      for (const [ratio, a, tau] of partials) {
        this.tone(v, { wave: 'sine', f: f * ratio, detune: (this.rng.next() - 0.5) * 6, t: tn, attack: 0.002, decay: tau, peak: scale * a, pan: k === 0 ? -0.15 : 0.15 });
      }
    });
    this.core.musicBus.duck(0.25, t, 0.5);
  }

  playCountdown(n: number): void {
    if (!this.gate('countdown', 0.2)) return;
    const v = this.open(3, 0.1);
    if (!v) return;
    const t = this.t0;
    const go = Math.round(finite(n)) <= 0;
    if (!go) {
      this.tone(v, { wave: 'triangle', f: 880, t, attack: 0.004, hold: 0.08, decay: 0.05, peak: 0.2, lp: 3500 });
      this.tone(v, { wave: 'sine', f: 440, t, attack: 0.004, hold: 0.08, decay: 0.05, peak: 0.07 });
    } else {
      this.tone(v, { wave: 'triangle', f: 1760, t, attack: 0.004, hold: 0.28, decay: 0.12, peak: 0.16, lp: 4500 });
      this.tone(v, { wave: 'triangle', f: 880, t, attack: 0.004, hold: 0.28, decay: 0.14, peak: 0.12, lp: 3500 });
      this.tone(v, { wave: 'sine', f: 1318.5, t: t + 0.01, attack: 0.01, hold: 0.25, decay: 0.12, peak: 0.05 });
    }
  }

  playFinish(): void {
    if (!this.gate('finish', 1)) return;
    const v = this.open(3, 0.25);
    if (!v) return;
    const t = this.t0;
    const key = this.key();
    const base = 60 + key;
    const W = this.core.waves;
    const brass = (tn: number, midi: number, hold: number, peak: number, pan: number): void => {
      const f = mtof(midi);
      const end = tn + 0.02 + hold + 0.22 * 6 + 0.02;
      const lp = v.filter('lowpass', 700, 0.9);
      for (const det of [-7, 7]) v.osc(W.brass, f, tn, end, det).connect(lp);
      lp.frequency.setValueAtTime(700, tn);
      lp.frequency.linearRampToValueAtTime(Math.min(9000, f * 6), tn + 0.03);
      lp.frequency.setTargetAtTime(Math.min(6000, f * 3), tn + 0.04, 0.2);
      this.envelope(v, lp, { t: tn, attack: 0.02, hold, decay: 0.22, peak, pan });
    };
    // rising arpeggio
    [0, 4, 7, 12].forEach((iv, k) => brass(t + k * 0.09, base + 12 + iv, 0.05, 0.075, -0.3 + k * 0.2));
    // final chord
    const tc = t + 0.38;
    [0, 4, 7, 12, 16].forEach((iv, k) => brass(tc, base + 12 + iv, 0.85, 0.05, -0.4 + k * 0.2));
    // soft timpani + cymbal shimmer
    this.tone(v, { wave: 'sine', f: mtof(base - 12) * 1.0, fTo: mtof(base - 12) * 0.85, fTime: 0.3, t: tc, decay: 0.25, peak: 0.2 });
    this.noise(v, { kind: 'brown', t: tc, peak: 0.12, decay: 0.08, filters: [{ type: 'lowpass', f: 400 }] });
    this.noise(v, { kind: 'white', t: tc, attack: 0.01, decay: 0.45, peak: 0.04, filters: [{ type: 'highpass', f: 6500 }] });
    // sparkle cascade
    for (let k = 0; k < 12; k++) {
      const d = 14 - k;
      const midi = base + 36 + 12 * Math.floor(d / 5) - 24 + PENTA[((d % 5) + 5) % 5];
      this.tone(v, { wave: 'sine', f: mtof(Math.min(midi, 108)), t: tc + 0.12 + k * 0.045, decay: 0.12, peak: 0.03, pan: this.rng.range(-0.7, 0.7) });
    }
    this.core.musicBus.duck(0.6, t, 2.2, 1.2);
  }

  playUiHover(): void {
    if (!this.gate('hover', 0.03)) return;
    const v = this.open(0, 0);
    if (!v) return;
    const t = this.t0;
    const f = 2300 * (1 + this.rng.range(-0.03, 0.03));
    this.noise(v, { kind: 'white', t, peak: 0.07, decay: 0.004, filters: [{ type: 'bandpass', f: 3600, Q: 4 }] });
    this.tone(v, { wave: 'sine', f, t, attack: 0.001, decay: 0.012, peak: 0.04 });
  }

  playUiClick(): void {
    if (!this.gate('click', 0.03)) return;
    const v = this.open(1, 0.03);
    if (!v) return;
    const t = this.t0;
    this.tone(v, { wave: 'sine', f: 1100, fTo: 720, fTime: 0.05, t, attack: 0.001, decay: 0.035, peak: 0.13 });
    this.tone(v, { wave: 'sine', f: 1650, t, attack: 0.001, decay: 0.05, peak: 0.03 });
    this.noise(v, { kind: 'white', t, peak: 0.08, decay: 0.004, filters: [{ type: 'bandpass', f: 2500, Q: 2 }] });
  }

  playBushHit(): void {
    if (!this.gate('bush', 0.05)) return;
    const v = this.open(1, 0.05);
    if (!v) return;
    const t = this.t0;
    const r = this.rng;
    const pan = r.range(-0.3, 0.3);
    const dur = r.range(0.35, 0.55);
    const leaves = this.noise(v, {
      kind: 'white',
      t,
      peak: 0,
      decay: 0.03,
      hold: dur,
      filters: [
        { type: 'bandpass', f: r.range(2800, 3800), Q: 0.9 },
        { type: 'highpass', f: 1200 },
      ],
      pan,
    });
    this.spikes(leaves.env.gain, t, dur, r.int(28, 42), 0.55, 0.004, 0.014, 1.5);
    const sw = this.noise(v, { kind: 'pink', t, peak: 0.08, decay: 0.12, attack: 0.02, filters: [{ type: 'bandpass', f: 2600, Q: 1 }], pan });
    sw.filters[0].frequency.setTargetAtTime(1300, t + 0.02, 0.1);
    this.noise(v, { kind: 'brown', t, peak: 0.09, decay: 0.06, filters: [{ type: 'lowpass', f: 300 }] });
    const snaps = r.int(0, 2);
    for (let k = 0; k < snaps; k++) {
      this.noise(v, { kind: 'white', t: t + r.range(0.01, 0.2), peak: 0.07, decay: 0.004, filters: [{ type: 'bandpass', f: r.range(1700, 2600), Q: 3 }], pan });
    }
  }

  /** Doppler-like swish of air: a band of pink noise sweeping up as the object closes in, then falling away. */
  playWhoosh(intensity: number, pan: number): void {
    if (!this.gate('whoosh', 0.14)) return;
    const i = clamp01(finite(intensity));
    const p = clamp(finite(pan), -0.9, 0.9);
    const v = this.open(1, 0.1);
    if (!v) return;
    const t = this.t0;
    const r = this.rng;
    const rise = 0.11 + 0.05 * (1 - i);
    const fPeak = (1700 + 1500 * i) * r.range(0.9, 1.1);
    const body = this.noise(v, {
      kind: 'pink',
      t,
      peak: 0.1 + 0.2 * i,
      attack: rise,
      hold: 0.02,
      decay: 0.11 + 0.06 * i,
      filters: [{ type: 'bandpass', f: 420, Q: 1.3 }],
      pan: p,
    });
    const f = body.filters[0].frequency;
    f.setValueAtTime(420, t);
    f.exponentialRampToValueAtTime(fPeak, t + rise);
    f.exponentialRampToValueAtTime(520, t + rise + 0.35);
    // airy edge on the closest point
    this.noise(v, { kind: 'white', t: t + rise * 0.6, peak: 0.025 + 0.045 * i, attack: rise * 0.4, decay: 0.07, filters: [{ type: 'highpass', f: 5200 }], pan: p });
    // low push of displaced air for big boosts
    if (i > 0.5) this.noise(v, { kind: 'brown', t, peak: 0.08 * i, attack: rise, decay: 0.16, filters: [{ type: 'lowpass', f: 260 }] });
  }
}
