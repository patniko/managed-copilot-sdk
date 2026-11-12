/**
 * Gentle generative soundtrack: plucked pentatonic arpeggios over soft pads, a round bass,
 * light percussion that slowly builds, an occasional flute / glockenspiel melody built from
 * repeating motifs. All instruments are persistent voices driven by automation from a
 * 16th-note lookahead clock, so playing music allocates no nodes at all.
 */
import type { AmbienceKind } from '../audioTypes';
import type { AudioCore } from './core';
import { NodeGroup, Rng, clamp, lerp, mtof, smoothstep } from './util';

const LOOKAHEAD = 0.3;
/** Overall music level (instrument levels below are relative to this). */
const MUSIC_LEVEL = 2.2;
const IONIAN = [0, 2, 4, 5, 7, 9, 11];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const MIXOLYDIAN = [0, 2, 4, 5, 7, 9, 10];
const PENTA = [0, 2, 4, 7, 9];

interface Style {
  /** Tonic, MIDI (octave 4). */
  root: number;
  mode: readonly number[];
  bpm: number;
  pluck: 'harp' | 'kalimba' | 'uke';
  lead: 'flute' | 'bell';
  /** Chord scale degrees (0-based), one per `barsPerChord` bars. */
  progressions: readonly (readonly number[])[];
  barsPerChord: number;
  /** Delay of off-beat 8ths, as a fraction of a 16th. */
  swing: number;
  /** Pluck brightness. */
  bright: number;
  /** Percussion amount. */
  perc: number;
  /** Pluck decay (s). */
  decay: number;
}

const STYLES: Record<AmbienceKind, Style> = {
  menu: { root: 60, mode: IONIAN, bpm: 86, pluck: 'harp', lead: 'flute', progressions: [[0, 4, 5, 3], [0, 5, 3, 4], [3, 0, 4, 5], [0, 3, 5, 4]], barsPerChord: 1, swing: 0.1, bright: 0.8, perc: 0.8, decay: 0.42 },
  coast: { root: 62, mode: IONIAN, bpm: 92, pluck: 'uke', lead: 'flute', progressions: [[0, 3, 5, 4], [0, 2, 3, 4], [0, 4, 5, 3], [5, 3, 0, 4]], barsPerChord: 1, swing: 0.12, bright: 0.9, perc: 1, decay: 0.36 },
  desert: { root: 62, mode: MIXOLYDIAN, bpm: 84, pluck: 'kalimba', lead: 'flute', progressions: [[0, 6, 3, 0], [0, 4, 6, 3], [0, 6, 4, 3]], barsPerChord: 1, swing: 0.16, bright: 0.7, perc: 1.1, decay: 0.5 },
  alpine: { root: 65, mode: LYDIAN, bpm: 78, pluck: 'harp', lead: 'bell', progressions: [[0, 1, 0, 4], [0, 1, 5, 4], [0, 4, 5, 1]], barsPerChord: 1, swing: 0.05, bright: 0.75, perc: 0.7, decay: 0.48 },
  fantasy: { root: 63, mode: LYDIAN, bpm: 70, pluck: 'kalimba', lead: 'bell', progressions: [[0, 1, 0, 1], [0, 1, 5, 4], [0, 2, 1, 0]], barsPerChord: 2, swing: 0, bright: 0.6, perc: 0.45, decay: 0.7 },
  beach: { root: 67, mode: IONIAN, bpm: 98, pluck: 'uke', lead: 'flute', progressions: [[0, 4, 5, 3], [0, 3, 0, 4], [3, 4, 0, 0], [0, 5, 3, 4]], barsPerChord: 1, swing: 0.14, bright: 1, perc: 1.2, decay: 0.32 },
  // dusk over the boulevard: mellow, a little wistful (vi–IV–I–V turns)
  city: { root: 61, mode: IONIAN, bpm: 88, pluck: 'kalimba', lead: 'bell', progressions: [[5, 3, 0, 4], [0, 4, 5, 3], [5, 4, 3, 4], [3, 4, 0, 5]], barsPerChord: 1, swing: 0.08, bright: 0.7, perc: 0.9, decay: 0.46 },
};

/** Key / scale of the soundtrack for each ambience kind (for tests and tooling). */
export function musicScale(kind: AmbienceKind): { root: number; mode: readonly number[]; bpm: number } {
  const s = STYLES[kind];
  return { root: s.root, mode: s.mode, bpm: s.bpm };
}

const ARP_PATTERNS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 3, 2, 1],
  [0, 2, 1, 3, 2, 4, 3, 5],
  [0, 1, 2, 4, 3, 2, 1, 2],
  [2, 1, 0, 1, 2, 3, 4, 3],
  [0, 2, 4, 2, 5, 4, 2, 1],
  [0, 3, 2, 4, 3, 5, 4, 2],
];

/** Melody rhythms for one bar: [start, length] in 16ths. */
const RHYTHMS: readonly (readonly [number, number][])[] = [
  [[0, 4], [4, 4], [8, 8]],
  [[0, 6], [6, 2], [8, 4], [12, 4]],
  [[0, 8], [8, 4], [12, 4]],
  [[0, 4], [4, 2], [6, 2], [8, 8]],
  [[0, 12], [12, 4]],
  [[4, 4], [8, 8]],
];

interface Motif {
  rhythm: [readonly [number, number][], readonly [number, number][]];
  steps: number[];
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Detaches an idle instrument from the mix (so its oscillators cost no CPU) and re-attaches on use. */
class Sleeper {
  private on = true;
  private until = 0;
  constructor(private readonly links: readonly (readonly [AudioNode, AudioNode])[]) {}
  /** Keep the instrument connected at least until `until`. */
  use(until: number): void {
    if (!this.on) {
      for (const [a, b] of this.links) a.connect(b);
      this.on = true;
    }
    if (until > this.until) this.until = until;
  }
  pump(now: number): void {
    if (this.on && now > this.until) {
      for (const [a, b] of this.links) a.disconnect(b);
      this.on = false;
    }
  }
}

export class MusicPlayer {
  private readonly core: AudioCore;
  private readonly rng: Rng;
  private readonly g: NodeGroup;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly fadeDry: GainNode;
  private readonly fadeWet: GainNode;
  private style: Style;
  private pending: Style | null = null;

  private playing = false;
  private stopping = false;
  private stopAt = 0;
  private started = false;
  private step = 0;
  private nextTime = 0;

  // structure
  private phrase = -1;
  private barInPhrase = -1;
  private progression: readonly number[] = [0, 4, 5, 3];
  private arp: readonly number[] = ARP_PATTERNS[0];
  private chord: number[] = [];
  private chordDeg = 0;
  private energy = 0;
  private energyFrom = 0.05;
  private energyTo = 0.12;
  private building = true;
  private leadOn = false;
  private motifA: Motif | null = null;
  private motifB: Motif | null = null;
  private padColor = 0;

  // instruments
  private readonly plucks: { osc: OscillatorNode; lp: BiquadFilterNode; vca: GainNode }[] = [];
  private pluckIdx = 0;
  private readonly pads: { oscs: OscillatorNode[]; vca: GainNode }[] = [];
  private padIdx = 0;
  private readonly bass: { osc: OscillatorNode; vca: GainNode };
  private readonly kick: { osc: OscillatorNode; vca: GainNode };
  private readonly shaker: GainNode;
  private readonly wood: { click: GainNode; tok: GainNode };
  private readonly lead: { osc: OscillatorNode; vib: GainNode; vca: GainNode };
  private readonly bells: { car: OscillatorNode; mod: OscillatorNode; idx: GainNode; vca: GainNode }[] = [];
  private bellIdx = 0;
  private readonly sleepers: Record<'bass' | 'kick' | 'shaker' | 'wood' | 'lead' | 'bells', Sleeper>;

  constructor(core: AudioCore, kind: AmbienceKind) {
    this.core = core;
    this.rng = core.rng;
    this.style = STYLES[kind];
    const g = (this.g = new NodeGroup(core.kit));
    const W = core.waves;
    const B = core.buffers;
    const rng = this.rng;

    const dry = (this.dry = g.gain(MUSIC_LEVEL));
    const wet = (this.wet = g.gain(MUSIC_LEVEL));
    this.fadeDry = g.gain(0);
    this.fadeWet = g.gain(0);
    dry.connect(this.fadeDry).connect(core.musicBus.in);
    wet.connect(this.fadeWet).connect(core.musicBus.send);
    /** Stereo-placed instrument output with an optional reverb send (shared by voices). */
    const out = (send: number, pan = 0): AudioNode => {
      const p = g.pan(pan);
      p.connect(dry);
      if (send > 0) p.connect(g.gain(send)).connect(wet);
      return p;
    };

    // plucks: 6 round-robin voices alternating between two stereo sides
    const pluckWave = W[this.style.pluck];
    const sides = [out(0.28, -0.3), out(0.28, 0.3)];
    for (let i = 0; i < 6; i++) {
      const osc = g.osc(pluckWave, 440);
      const lp = g.filter('lowpass', 2000, 0.8);
      const vca = g.gain(0);
      osc.connect(lp).connect(vca).connect(sides[i % 2]);
      this.plucks.push({ osc, lp, vca });
    }

    // pads: 3 alternating sets of 3 detuned oscillators through one breathing low-pass
    const padLp = g.filter('lowpass', 1300, 0.5);
    padLp.connect(out(0.5, 0));
    const padLfo = g.osc('sine', 0.07);
    padLfo.connect(g.gain(380)).connect(padLp.frequency);
    for (let s = 0; s < 3; s++) {
      const vca = g.gain(0);
      vca.connect(padLp);
      const oscs: OscillatorNode[] = [];
      for (const det of [-6, 5, -2]) {
        const osc = g.osc(W.warm, 220, det + rng.range(-2, 2));
        osc.connect(vca);
        oscs.push(osc);
      }
      this.pads.push({ oscs, vca });
    }

    // bass (centre, dry)
    let bassLink: [AudioNode, AudioNode];
    {
      const osc = g.osc('triangle', 65);
      const vca = g.gain(0);
      osc.connect(g.filter('lowpass', 520, 0.7)).connect(vca).connect(dry);
      this.bass = { osc, vca };
      bassLink = [vca, dry];
    }
    // soft kick (centre, dry)
    let kickLink: [AudioNode, AudioNode];
    {
      const osc = g.osc('sine', 60);
      const vca = g.gain(0);
      osc.connect(vca).connect(dry);
      this.kick = { osc, vca };
      kickLink = [vca, dry];
    }
    // shaker + wood block share one noise source
    const noise = g.loop(B.white, rng.range(0, 3));
    let shakerLink: [AudioNode, AudioNode];
    {
      const vca = g.gain(0);
      noise.connect(g.filter('highpass', 6500, 0.7)).connect(vca);
      const o = out(0.12, 0.25);
      vca.connect(o);
      this.shaker = vca;
      shakerLink = [vca, o];
    }
    let woodLinks: [AudioNode, AudioNode][];
    {
      const o = out(0.18, -0.2);
      const click = g.gain(0);
      noise.connect(click);
      const clickOut = g.gain(2.2);
      click.connect(g.filter('bandpass', 1800, 7)).connect(clickOut).connect(o);
      const tok = g.gain(0);
      g.osc('sine', 880).connect(tok).connect(o);
      this.wood = { click, tok };
      woodLinks = [
        [clickOut, o],
        [tok, o],
      ];
    }
    // flute lead with delayed vibrato
    let leadLink: [AudioNode, AudioNode];
    {
      const osc = g.osc(W.flute, 523);
      const lfo = g.osc('sine', 5.1);
      const vib = g.gain(0);
      lfo.connect(vib).connect(osc.frequency);
      const vca = g.gain(0);
      const o = out(0.38, 0.12);
      osc.connect(g.filter('lowpass', 3600, 0.6)).connect(vca).connect(o);
      this.lead = { osc, vib, vca };
      leadLink = [vca, o];
    }
    // glockenspiel bells (FM), 3 round-robin voices
    const bellOut = out(0.5, 0.1);
    for (let i = 0; i < 3; i++) {
      const car = g.osc('sine', 880);
      const modu = g.osc('sine', 880 * 3.5);
      const idx = g.gain(0);
      modu.connect(idx).connect(car.frequency);
      const vca = g.gain(0);
      car.connect(vca).connect(bellOut);
      this.bells.push({ car, mod: modu, idx, vca });
    }
    this.sleepers = {
      bass: new Sleeper([bassLink]),
      kick: new Sleeper([kickLink]),
      shaker: new Sleeper([shakerLink]),
      wood: new Sleeper(woodLinks),
      lead: new Sleeper([leadLink]),
      bells: new Sleeper(this.bells.map((b) => [b.vca, bellOut] as const)),
    };
  }

  get keyRoot(): number {
    return mod(this.style.root, 12);
  }

  setStyle(kind: AmbienceKind): void {
    const s = STYLES[kind];
    if (s === this.style) {
      this.pending = null;
      return;
    }
    if (!this.started) this.applyStyle(s);
    else this.pending = s;
  }

  private applyStyle(s: Style): void {
    this.style = s;
    const wave = this.core.waves[s.pluck];
    for (const p of this.plucks) p.osc.setPeriodicWave(wave);
  }

  start(now: number): void {
    const wasStopping = this.stopping;
    this.stopping = false;
    for (const p of [this.fadeDry.gain, this.fadeWet.gain]) {
      const v = p.value;
      p.cancelScheduledValues(now);
      p.setValueAtTime(v, now);
      p.linearRampToValueAtTime(1, now + (this.started ? 1.2 : 2.5));
    }
    if (!this.playing || !this.started) {
      this.playing = true;
      if (!this.started) {
        this.started = true;
        this.step = 0;
        this.nextTime = now + 0.12;
      }
    }
    if (wasStopping && this.nextTime < now) this.nextTime = now + 0.05;
  }

  stop(now: number): void {
    if (!this.playing) return;
    this.stopping = true;
    this.stopAt = now + 1.6;
    for (const p of [this.fadeDry.gain, this.fadeWet.gain]) {
      const v = p.value;
      p.cancelScheduledValues(now);
      p.setValueAtTime(v, now);
      p.linearRampToValueAtTime(0, now + 1.5);
    }
  }

  private get stepDur(): number {
    return 60 / this.style.bpm / 4;
  }

  pump(now: number): void {
    if (!this.playing) return;
    if (this.stopping && now >= this.stopAt) {
      this.playing = false;
      return;
    }
    // fell far behind (tab throttled): skip ahead instead of bursting notes
    if (this.nextTime < now - 0.05) {
      const missed = Math.ceil((now - this.nextTime) / this.stepDur);
      this.step += missed;
      this.nextTime += missed * this.stepDur;
    }
    const horizon = now + LOOKAHEAD;
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 64) {
      this.scheduleStep(this.step, this.nextTime);
      this.nextTime += this.stepDur;
      this.step++;
    }
    for (const s of Object.values(this.sleepers)) s.pump(now);
  }

  // ------------------------------------------------------------------ composition

  private newPhrase(): void {
    if (this.pending) {
      this.applyStyle(this.pending);
      this.pending = null;
    }
    const rng = this.rng;
    this.phrase++;
    this.energyFrom = this.energyTo;
    if (this.phrase > 0) {
      if (this.building) {
        this.energyTo = Math.min(0.95, this.energyTo + rng.range(0.1, 0.2));
        if (this.energyTo > 0.78 && rng.chance(0.45)) this.building = false;
      } else {
        this.energyTo = rng.range(0.18, 0.38);
        this.building = true;
      }
    }
    this.progression = rng.pick(this.style.progressions);
    this.arp = rng.pick(ARP_PATTERNS);
    this.leadOn = this.energyTo > 0.45 && rng.chance(0.65);
    this.motifA = this.makeMotif();
    this.motifB = this.makeMotif();
  }

  private makeMotif(): Motif {
    const rng = this.rng;
    const rhythm: Motif['rhythm'] = [rng.pick(RHYTHMS), rng.pick(RHYTHMS)];
    const steps: number[] = [];
    const n = rhythm[0].length + rhythm[1].length;
    for (let k = 0; k < n; k++) {
      const r = rng.next();
      steps.push(r < 0.05 ? 0 : r < 0.75 ? rng.sign() : 2 * rng.sign());
    }
    return { rhythm, steps };
  }

  /** Scale degree (0-based, may exceed 6) to MIDI note around octave 4. */
  private degree(d: number): number {
    const m = this.style.mode;
    return this.style.root + 12 * Math.floor(d / 7) + m[mod(d, 7)];
  }

  /** Major pentatonic of the tonic (fits ionian, lydian and mixolydian). */
  private penta(i: number, octave: number): number {
    return this.style.root + 12 * (octave + Math.floor(i / 5)) + PENTA[mod(i, 5)];
  }

  private setChord(deg: number): void {
    this.chordDeg = deg;
    // root, third, fifth, colour (7th or 9th)
    const color = this.padColor % 2 === 0 ? 6 : 8;
    this.chord = [this.degree(deg), this.degree(deg + 2), this.degree(deg + 4), this.degree(deg + color)];
    this.padColor++;
  }

  private pcInChord(midi: number): boolean {
    return this.chord.some((c) => mod(c - midi, 12) === 0);
  }

  private scheduleStep(step: number, tBase: number): void {
    const st = this.style;
    const rng = this.rng;
    const s16 = step % 16;
    if (s16 === 0) {
      // phrases are 8 bars; a pending key/style change (new ambience) starts a fresh phrase
      // at the next 4-bar boundary instead of waiting for the end of the phrase
      this.barInPhrase++;
      if (this.barInPhrase >= 8 || this.phrase < 0 || (this.pending && this.barInPhrase === 4)) {
        this.barInPhrase = 0;
        this.newPhrase();
      }
    }
    const barInPhrase = Math.max(0, this.barInPhrase);
    if (s16 === 0) {
      this.energy = lerp(this.energyFrom, this.energyTo, smoothstep(0, 7, barInPhrase));
      // denser arrangements get a little quieter so the build stays gentle
      const lvl = MUSIC_LEVEL * (1 - 0.32 * this.energy);
      this.dry.gain.setTargetAtTime(lvl, tBase, 1.5);
      this.wet.gain.setTargetAtTime(lvl, tBase, 1.5);
      if (barInPhrase % st.barsPerChord === 0 || this.chord.length === 0) {
        const idx = Math.floor(barInPhrase / st.barsPerChord) % this.progression.length;
        this.setChord(this.progression[idx]);
        this.chordChange(tBase);
      }
      this.barEvents(tBase, barInPhrase);
    }
    const e = this.energy;
    const sd = this.stepDur;
    let t = tBase;
    if (s16 % 4 === 2) t += st.swing * sd;

    // pluck arpeggio on 8ths (+ occasional 16th pickups when energetic)
    if (s16 % 2 === 0) {
      const i8 = s16 / 2;
      const sparse = e < 0.3 && !(i8 === 0 || i8 === 3 || i8 === 4 || i8 === 6);
      if (!sparse) {
        const pool = this.arpPool();
        const idx = this.arp[i8] + (barInPhrase % 4 === 3 && i8 >= 6 ? 1 : 0);
        const midi = pool[Math.min(pool.length - 1, idx)];
        const accent = i8 === 0 ? 1 : i8 === 4 ? 0.85 : 0.62;
        this.pluck(t + rng.range(-0.004, 0.004), midi, accent * (0.75 + 0.25 * rng.next()) * (0.75 + 0.35 * e));
      }
    } else if (e > 0.6 && (s16 === 7 || s16 === 15) && rng.chance(0.3)) {
      const pool = this.arpPool();
      this.pluck(t, pool[rng.int(1, 4)], 0.45);
    }

    // percussion (builds with energy)
    const p = st.perc;
    if (e > 0.25 && p > 0) {
      const shakerAcc = [0.35, 0.12, 0.75, 0.18];
      // off-beat 8ths at first, steady 16ths once the groove has built up
      if (s16 % 4 === 2 || e > 0.5) {
        this.shake(t, shakerAcc[s16 % 4] * p * (0.6 + 0.4 * e) * (0.85 + 0.15 * rng.next()));
      }
      if (e > 0.5 && (s16 === 0 || (e > 0.65 && s16 === 8))) this.kickHit(t, (s16 === 0 ? 1 : 0.75) * Math.min(1, p));
      if (e > 0.7 && (s16 === 4 || s16 === 12)) this.woodHit(t, 0.75 * p);
      if (e > 0.6 && barInPhrase === 7 && s16 >= 12 && s16 % 2 === 0) this.woodHit(t, 0.45 * p);
    }
  }

  private arpPool(): number[] {
    // pentatonic chord tones over two octaves from E4 (the pads carry the full harmony);
    // fall back to all chord tones if the chord shares too few notes with the pentatonic scale
    const pent = PENTA.map((p) => mod(this.style.root + p, 12));
    const chordPcs = this.chord.map((c) => mod(c, 12));
    let pcs = chordPcs.filter((pc) => pent.includes(pc));
    if (new Set(pcs).size < 3) pcs = chordPcs;
    const pool: number[] = [];
    for (let m = 64; m <= 91 && pool.length < 9; m++) if (pcs.includes(mod(m, 12))) pool.push(m);
    return pool;
  }

  private chordChange(t: number): void {
    const e = this.energy;
    // pad voicing: third, fifth, colour placed between G3 and C5
    const tones = [this.chord[1], this.chord[2], this.chord[3]].map((m) => {
      let x = m;
      while (x < 55) x += 12;
      while (x > 72) x -= 12;
      return x;
    });
    this.padChange(t, tones, 0.03 * (0.75 + 0.35 * e));
    if (e > 0.4 && this.rng.chance(0.3)) {
      const top = Math.max(...tones) + 12;
      this.bell(t + this.stepDur * 0.02, top, 0.5);
    }
  }

  private barEvents(t: number, barInPhrase: number): void {
    const e = this.energy;
    const sd = this.stepDur;
    // bass
    let root = this.chord[0];
    while (root >= 48) root -= 12;
    while (root < 36) root += 12;
    if (e > 0.28) {
      if (e > 0.75) {
        this.bassNote(t, root, sd * 5.5, 1);
        this.bassNote(t + sd * 6, root, sd * 1.8, 0.7);
        this.bassNote(t + sd * 12, root + 7, sd * 3.6, 0.8);
      } else if (e > 0.55) {
        this.bassNote(t, root, sd * 11, 1);
        this.bassNote(t + sd * 12, root + 7, sd * 3.6, 0.75);
      } else {
        this.bassNote(t, root, sd * 15, 0.9);
      }
    }
    // melody
    if (this.leadOn && this.motifA && this.motifB) {
      const half = barInPhrase % 2;
      let motif = this.motifA;
      let startDeg = 2;
      if (barInPhrase === 2 || barInPhrase === 3) startDeg = 3;
      if (barInPhrase === 4 || barInPhrase === 5) {
        motif = this.motifB;
        startDeg = 4;
      }
      if (barInPhrase === 7) {
        this.leadNote(t, this.penta(0, 1), sd * 14, 0.9);
        return;
      }
      let d = startDeg;
      let k = 0;
      if (half === 1) {
        for (let j = 0; j < motif.rhythm[0].length; j++) d += motif.steps[k++];
      }
      for (const [start, len] of motif.rhythm[half]) {
        d = clamp(d + (motif.steps[k++] ?? 0), -2, 8);
        let midi = this.penta(d, 1);
        if (len >= 6 && !this.pcInChord(midi)) {
          const up = this.penta(d + 1, 1);
          midi = this.pcInChord(up) ? up : this.penta(d - 1, 1);
        }
        this.leadNote(t + start * sd, midi, len * sd * 0.92, 0.85);
      }
    }
  }

  // ------------------------------------------------------------------ instruments

  private pluck(t: number, midi: number, vel: number): void {
    const v = this.plucks[this.pluckIdx++ % this.plucks.length];
    const st = this.style;
    const f = mtof(midi);
    const g = v.vca.gain;
    g.setTargetAtTime(0, t - 0.008, 0.002);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.12 * vel, t + 0.003);
    g.setTargetAtTime(0, t + 0.003, st.decay * (0.8 + 0.4 * vel));
    v.osc.frequency.setValueAtTime(f, t);
    v.lp.frequency.setValueAtTime(Math.min(14000, f * (3 + 7 * st.bright * vel)), t);
    v.lp.frequency.setTargetAtTime(f * 1.4 + 250, t + 0.003, st.decay * 0.3);
  }

  private padChange(t: number, notes: number[], level: number): void {
    const prev = this.pads[this.padIdx % 3];
    this.padIdx++;
    const cur = this.pads[this.padIdx % 3];
    cur.vca.gain.cancelScheduledValues(t);
    cur.vca.gain.setValueAtTime(0, t);
    for (let i = 0; i < cur.oscs.length; i++) cur.oscs[i].frequency.setValueAtTime(mtof(notes[i]), t);
    cur.vca.gain.setTargetAtTime(level, t, 0.45);
    prev.vca.gain.setTargetAtTime(0, t, 0.6);
  }

  private bassNote(t: number, midi: number, dur: number, vel: number): void {
    this.sleepers.bass.use(t + dur + 0.7);
    const g = this.bass.vca.gain;
    g.setTargetAtTime(0, t - 0.03, 0.006);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.1 * vel, t + 0.02);
    g.setTargetAtTime(0.065 * vel, t + 0.02, 0.25);
    g.setTargetAtTime(0, t + dur, 0.07);
    this.bass.osc.frequency.setValueAtTime(mtof(midi), t);
  }

  private kickHit(t: number, vel: number): void {
    this.sleepers.kick.use(t + 0.9);
    const f = this.kick.osc.frequency;
    f.setValueAtTime(125, t);
    f.exponentialRampToValueAtTime(46, t + 0.11);
    const g = this.kick.vca.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.12 * vel, t + 0.004);
    g.setTargetAtTime(0, t + 0.01, 0.075);
  }

  private shake(t: number, vel: number): void {
    this.sleepers.shaker.use(t + 0.4);
    const g = this.shaker.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.07 * vel, t + 0.01);
    g.setTargetAtTime(0, t + 0.012, 0.022);
  }

  private woodHit(t: number, vel: number): void {
    this.sleepers.wood.use(t + 0.5);
    const c = this.wood.click.gain;
    c.setValueAtTime(0.5 * vel, t);
    c.setTargetAtTime(0, t + 0.0005, 0.004);
    const k = this.wood.tok.gain;
    k.setValueAtTime(0, t);
    k.linearRampToValueAtTime(0.045 * vel, t + 0.001);
    k.setTargetAtTime(0, t + 0.002, 0.03);
  }

  private leadNote(t: number, midi: number, dur: number, vel: number): void {
    if (this.style.lead === 'bell') {
      this.bell(t, midi + 12, vel);
      return;
    }
    const f = mtof(midi);
    const L = this.lead;
    this.sleepers.lead.use(t + dur + 0.8);
    L.osc.frequency.setTargetAtTime(f, t, 0.012);
    L.vib.gain.setTargetAtTime(0, t, 0.02);
    L.vib.gain.setTargetAtTime(f * 0.007, t + Math.min(0.25, dur * 0.4), 0.2);
    L.vca.gain.setTargetAtTime(0.075 * vel, t, 0.03);
    L.vca.gain.setTargetAtTime(0, t + dur, 0.07);
  }

  private bell(t: number, midi: number, vel: number): void {
    this.sleepers.bells.use(t + 4);
    const b = this.bells[this.bellIdx++ % this.bells.length];
    const f = mtof(Math.min(midi, 100));
    b.vca.gain.setTargetAtTime(0, t - 0.008, 0.002);
    b.car.frequency.setValueAtTime(f, t);
    b.mod.frequency.setValueAtTime(f * 3.5, t);
    b.idx.gain.setValueAtTime(f * 1.8, t);
    b.idx.gain.setTargetAtTime(f * 0.12, t + 0.002, 0.09);
    b.vca.gain.setValueAtTime(0, t);
    b.vca.gain.linearRampToValueAtTime(0.05 * vel, t + 0.002);
    b.vca.gain.setTargetAtTime(0, t + 0.003, 0.55);
  }

  dispose(): void {
    this.playing = false;
    this.g.dispose();
  }
}
