/**
 * Audio lab: manual test bench (buttons / sliders) + `window.audioLab`, an offline measurement
 * API that renders every sound through the real engine graph into an OfflineAudioContext.
 * Used by scripts/audio-check.mjs.
 */
import { AMBIENCE_PARTS, AudioCore, RIDE_LAYERS, SURFACES, audio, musicScale, type RideLayerName } from '../core/audio';
import type { AmbienceKind, RideAudioState, Surface } from '../core/audioTypes';

const SR = 48000;
const KINDS: AmbienceKind[] = ['menu', 'coast', 'desert', 'alpine', 'fantasy', 'beach', 'city'];

// ====================================================================== offline lab

export interface CaseResult {
  id: string;
  group: string;
  expectSound: boolean;
  seconds: number;
  peak: number;
  rms: number;
  /** RMS over the window where the sound is meant to play. */
  activeRms: number;
  /** RMS over the final window (one-shots must have decayed). */
  tailRms: number | null;
  nan: number;
  dc: number;
  /** zero crossings per second (brightness proxy) */
  zcr: number;
  /** L/R level difference over the active window, dB */
  balanceDb: number;
  seg?: number[];
  /** peak of the raw mix (compressor / limiter / clipper bypassed) */
  rawPeak?: number;
  live: number;
  voicesLeft: number;
  ms: number;
  extra?: Record<string, unknown>;
}

interface RenderOpts {
  seconds: number;
  seed?: number;
  bypass?: boolean;
  /** control callbacks per second (pump + tick); 0 = none */
  rate?: number;
  setup?: (c: AudioCore) => void;
  tick?: (c: AudioCore, t: number) => void;
}

async function render(o: RenderOpts): Promise<{ buf: AudioBuffer; core: AudioCore; ms: number }> {
  const t0 = performance.now();
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(SR * o.seconds), sampleRate: SR });
  const core = new AudioCore(ctx, { seed: o.seed ?? 1234, bypassDynamics: o.bypass });
  o.setup?.(core);
  core.pump();
  const rate = o.rate ?? 0;
  if (rate > 0) {
    const step = 1 / rate;
    let k = 1;
    const next = (): void => {
      const t = k * step;
      if (t >= o.seconds - 2 * step) return;
      ctx
        .suspend(t)
        .then(() => {
          try {
            o.tick?.(core, t);
            core.pump();
          } catch (e) {
            // surface engine exceptions as console errors (the check script fails on them)
            console.error('audio engine threw during offline render:', e);
          }
          k++;
          next();
          return ctx.resume();
        })
        .catch((e: unknown) => console.error('suspend failed', e));
    };
    next();
  }
  const buf = await ctx.startRendering();
  // let pending `ended` events run
  await new Promise((r) => setTimeout(r, 20));
  return { buf, core, ms: performance.now() - t0 };
}

interface Measure {
  peak: number;
  rms: number;
  activeRms: number;
  tailRms: number | null;
  nan: number;
  dc: number;
  zcr: number;
  /** L/R level difference over the active window, dB */
  balanceDb: number;
  seg?: number[];
}

function measure(buf: AudioBuffer, active: [number, number], tail?: [number, number], segment?: number): Measure {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const n = L.length;
  let peak = 0;
  let sum = 0;
  let nan = 0;
  let dc = 0;
  let zc = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const l = L[i];
    const r = R[i];
    if (!Number.isFinite(l) || !Number.isFinite(r)) {
      nan++;
      continue;
    }
    const al = Math.abs(l);
    const ar = Math.abs(r);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
    sum += l * l + r * r;
    dc += l + r;
    const m = l + r;
    if ((m >= 0) !== (prev >= 0)) zc++;
    prev = m;
  }
  const win = (a: number, b: number): number => {
    const i0 = Math.max(0, Math.floor(a * SR));
    const i1 = Math.min(n, Math.floor(b * SR));
    let s = 0;
    for (let i = i0; i < i1; i++) {
      const l = L[i];
      const r = R[i];
      if (Number.isFinite(l) && Number.isFinite(r)) s += l * l + r * r;
    }
    return Math.sqrt(s / Math.max(1, 2 * (i1 - i0)));
  };
  const seg: number[] = [];
  if (segment) for (let a = 0; a + segment <= buf.duration + 1e-6; a += segment) seg.push(win(a, a + segment));
  let sl = 0;
  let sr = 0;
  for (let i = Math.floor(active[0] * SR); i < Math.min(n, Math.floor(active[1] * SR)); i++) {
    if (Number.isFinite(L[i]) && Number.isFinite(R[i])) {
      sl += L[i] * L[i];
      sr += R[i] * R[i];
    }
  }
  const balanceDb = sl > 1e-12 && sr > 1e-12 ? 10 * Math.log10(sl / sr) : 0;
  return {
    peak,
    rms: Math.sqrt(sum / Math.max(1, 2 * n)),
    activeRms: win(active[0], active[1]),
    tailRms: tail ? win(tail[0], tail[1]) : null,
    nan,
    dc: dc / Math.max(1, 2 * n),
    zcr: zc / buf.duration,
    balanceDb,
    seg: segment ? seg : undefined,
  };
}

function ride(p: Partial<RideAudioState>): RideAudioState {
  return { speed: 0, grounded: true, surface: 'dirt', pedaling: false, braking: false, skid: 0, spinRate: 0, dt: 1 / 60, ...p };
}

// ---------------------------------------------------------------------- pitch analysis

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const br = re[b] * cr - im[b] * ci;
        const bi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - br;
        im[b] = im[a] - bi;
        re[a] += br;
        im[a] += bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Pitch-class energy profile (sums to 1) of [from, to] s, from spectral peaks between fmin and fmax. */
function chroma(buf: AudioBuffer, from: number, to: number, fmin = 180, fmax = 2600): number[] {
  const N = 16384;
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const out = new Array<number>(12).fill(0);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const i1 = Math.min(L.length, Math.floor(to * SR));
  for (let s = Math.floor(from * SR); s + N <= i1; s += N >> 1) {
    for (let i = 0; i < N; i++) {
      re[i] = (L[s + i] + R[s + i]) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = Math.ceil((fmin * N) / SR); k <= Math.floor((fmax * N) / SR); k++) {
      const midi = 69 + 12 * Math.log2((k * SR) / N / 440);
      const near = Math.round(midi);
      if (Math.abs(midi - near) > 0.3) continue; // ignore bins between semitones
      out[((near % 12) + 12) % 12] += re[k] * re[k] + im[k] * im[k];
    }
  }
  const total = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((x) => x / total);
}

const PC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function keyReport(buf: AudioBuffer, from: number, to: number, root: number, mode: readonly number[]): Record<string, unknown> {
  const ch = chroma(buf, from, to);
  const scale = mode.map((m) => (root + m) % 12);
  const penta = [0, 2, 4, 7, 9].map((m) => (root + m) % 12);
  const fit = (pcs: number[]): number => Math.round(pcs.reduce((a, pc) => a + ch[pc], 0) * 1000) / 1000;
  const top = ch
    .map((v, pc) => [v, pc] as const)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 5)
    .map(([, pc]) => PC_NAMES[pc]);
  return { key: `${PC_NAMES[root % 12]}`, scaleFit: fit(scale), pentaFit: fit(penta), top: top.join(' ') };
}

interface CaseDef {
  id: string;
  group: string;
  expectSound: boolean;
  seconds: number;
  rate?: number;
  active: [number, number];
  tail?: [number, number];
  segment?: number;
  /** also render with dynamics bypassed to report raw headroom */
  raw?: boolean;
  setup?: (c: AudioCore) => void;
  tick?: (c: AudioCore, t: number) => void;
  extra?: (c: AudioCore) => Record<string, unknown>;
  /** extra analysis of the rendered buffer */
  analyze?: (buf: AudioBuffer) => Record<string, unknown>;
}

function oneShot(id: string, fire: (c: AudioCore) => void, seconds = 7, analyze?: (buf: AudioBuffer) => Record<string, unknown>): CaseDef {
  // fired at 0.5 s so the master dynamics have settled (as in the running game)
  return {
    id,
    group: 'oneshot',
    expectSound: true,
    seconds,
    rate: 20,
    active: [0.5, 2],
    tail: [seconds - 0.5, seconds],
    raw: true,
    tick: (c, t) => {
      if (Math.abs(t - 0.5) < 0.026) fire(c);
    },
    analyze,
  };
}

const IONIAN = [0, 2, 4, 5, 7, 9, 11];
const inC = (buf: AudioBuffer): Record<string, unknown> => keyReport(buf, 0.5, 3, 0, IONIAN);

function buildCases(): CaseDef[] {
  const cases: CaseDef[] = [];
  // ---- one-shots
  for (const s of SURFACES) cases.push(oneShot(`landing.${s}.1.0`, (c) => c.fx.playLanding(1, s)));
  cases.push(oneShot('landing.dirt.0.3', (c) => c.fx.playLanding(0.3, 'dirt')));
  cases.push(oneShot('landing.dirt.0.6', (c) => c.fx.playLanding(0.6, 'dirt')));
  cases.push(oneShot('pop.0.2', (c) => c.fx.playPop(0.2)));
  cases.push(oneShot('pop.1.0', (c) => c.fx.playPop(1)));
  cases.push(oneShot('trickStart', (c) => c.fx.playTrickStart()));
  cases.push(oneShot('trickLanded.100.c0', (c) => c.fx.playTrickLanded(100, 0, false), 7, inC));
  cases.push(oneShot('trickLanded.1500.c3.perfect', (c) => c.fx.playTrickLanded(1500, 3, true), 7, inC));
  cases.push(oneShot('trickLanded.4000.c8.perfect', (c) => c.fx.playTrickLanded(4000, 8, true), 7, inC));
  cases.push(oneShot('crash.0.4', (c) => c.fx.playCrash(0.4)));
  cases.push(oneShot('crash.1.0', (c) => c.fx.playCrash(1)));
  cases.push(oneShot('checkpoint', (c) => c.fx.playCheckpoint(), 9, inC));
  for (const n of [3, 2, 1, 0]) cases.push(oneShot(`countdown.${n}`, (c) => c.fx.playCountdown(n), 5));
  cases.push(oneShot('finish', (c) => c.fx.playFinish(), 9, inC));
  cases.push(oneShot('uiHover', (c) => c.fx.playUiHover(), 3));
  cases.push(oneShot('uiClick', (c) => c.fx.playUiClick(), 3));
  cases.push(oneShot('bushHit', (c) => c.fx.playBushHit(), 5));
  cases.push(oneShot('whoosh.flyby.0.4', (c) => c.fx.playWhoosh(0.4, 0.6), 4));
  cases.push(oneShot('whoosh.boost.1.0', (c) => c.fx.playWhoosh(1, 0), 4));

  // ---- ambience parts in isolation (calibration aid)
  for (const k of KINDS) {
    for (const part of AMBIENCE_PARTS[k]) {
      cases.push({
        id: `ambpart.${k}.${part}`,
        group: 'ambpart',
        expectSound: true,
        seconds: 20,
        rate: 20,
        active: [3, 20],
        setup: (c) => c.ambience.set(k, 0, [part]),
      });
    }
  }

  // ---- ambience
  for (const k of KINDS) {
    cases.push({
      id: `ambience.${k}`,
      group: 'ambience',
      expectSound: true,
      seconds: 20,
      rate: 20,
      active: [3, 20],
      segment: 5,
      setup: (c) => c.setAmbience(k),
    });
  }
  cases.push({
    id: 'ambience.crossfade.coast>beach>alpine',
    group: 'ambience',
    expectSound: true,
    seconds: 14,
    rate: 20,
    active: [1, 14],
    segment: 2,
    setup: (c) => c.setAmbience('coast'),
    tick: (c, t) => {
      if (Math.abs(t - 5) < 0.026) c.setAmbience('beach');
      if (Math.abs(t - 6) < 0.026) c.setAmbience('alpine');
    },
    extra: (c) => ({ scenesAtEnd: c.debugStats().scenes }),
  });

  // ---- music
  for (const k of KINDS) {
    const sc = musicScale(k);
    cases.push({
      id: `music.${k}`,
      group: 'music',
      expectSound: true,
      seconds: 24,
      rate: 20,
      active: [3, 24],
      segment: 6,
      setup: (c) => {
        // music only (no ambience scene), but in the style of `k`
        c.ambience.kind = k;
        c.setMusic(true);
      },
      analyze: (buf) => keyReport(buf, 2, 24, sc.root, sc.mode),
    });
  }
  const menuScale = musicScale('menu');
  cases.push({
    id: 'music.menu.evolution.100s',
    group: 'music',
    expectSound: true,
    seconds: 100,
    rate: 20,
    active: [3, 100],
    segment: 10,
    setup: (c) => c.setMusic(true),
    analyze: (buf) => keyReport(buf, 2, 100, menuScale.root, menuScale.mode),
  });
  const desert = musicScale('desert');
  cases.push({
    id: 'music.keychange.menu>desert',
    group: 'music',
    expectSound: true,
    seconds: 40,
    rate: 20,
    active: [3, 40],
    segment: 10,
    setup: (c) => c.setMusic(true),
    tick: (c, t) => {
      if (Math.abs(t - 3) < 0.026) c.setAmbience('desert');
    },
    // after at most 4 bars (+ fade) the soundtrack must be in the desert key
    analyze: (buf) => ({ ...keyReport(buf, 18, 40, desert.root, desert.mode), keyRootAtEnd: PC_NAMES[desert.root % 12] }),
  });
  cases.push({
    id: 'music.stop',
    group: 'music',
    expectSound: false,
    seconds: 8,
    rate: 20,
    active: [5, 8],
    setup: (c) => c.setMusic(true),
    tick: (c, t) => {
      if (Math.abs(t - 3) < 0.026) c.setMusic(false);
    },
    extra: (c) => ({ musicDisposed: c.music === null }),
  });

  // ---- ride: every surface at 5 / 15 / 25 m/s
  const rideCase = (id: string, st: RideAudioState, solo: RideLayerName | null, group = 'ride'): CaseDef => ({
    id,
    group,
    expectSound: true,
    seconds: 3,
    rate: 60,
    active: [1.5, 3],
    setup: (c) => {
      c.ride.solo(solo);
      c.updateRide(st);
    },
    tick: (c) => c.updateRide(st),
  });
  for (const s of SURFACES) for (const v of [5, 15, 25]) cases.push(rideCase(`ride.${s}.${v}`, ride({ speed: v, surface: s }), null));
  for (const layer of ['wind', 'tyre', 'ticks'] as RideLayerName[]) {
    for (const v of [5, 15, 25]) cases.push(rideCase(`solo.${layer}.${v}`, ride({ speed: v, surface: 'dirt' }), layer, 'solo'));
  }
  for (const s of SURFACES) for (const v of [5, 15, 25]) cases.push(rideCase(`solo.tyre.${s}.${v}`, ride({ speed: v, surface: s }), 'tyre', 'solo'));
  cases.push(rideCase('solo.wind.air.15', ride({ speed: 15, grounded: false }), 'wind', 'solo'));
  cases.push(rideCase('solo.chain.pedal.8', ride({ speed: 8, pedaling: true }), 'chain', 'solo'));
  cases.push(rideCase('solo.brake.12', ride({ speed: 12, braking: true }), 'brake', 'solo'));
  cases.push(rideCase('solo.skid.dirt.10', ride({ speed: 10, skid: 0.8 }), 'skid', 'solo'));
  cases.push(rideCase('solo.skid.rock.10', ride({ speed: 10, skid: 0.8, surface: 'rock' }), 'skid', 'solo'));
  cases.push(rideCase('solo.whoosh.spin8', ride({ speed: 15, grounded: false, spinRate: 8 }), 'whoosh', 'solo'));
  cases.push(rideCase('ride.all.pedal.brake.skid', ride({ speed: 18, pedaling: true, braking: true, skid: 0.6, surface: 'rock' }), null));
  cases.push({
    id: 'ride.fadeout.null',
    group: 'ride',
    expectSound: false,
    seconds: 4,
    rate: 60,
    active: [3, 4],
    setup: (c) => c.updateRide(ride({ speed: 20 })),
    tick: (c, t) => c.updateRide(t < 1 ? ride({ speed: 20 }) : null),
    extra: (c) => ({ rideActive: c.ride.active }),
  });

  // ---- full mix stress: ambience + music + ride + frequent one-shots
  cases.push({
    id: 'mix.busy.coast',
    group: 'mix',
    expectSound: true,
    seconds: 16,
    rate: 60,
    active: [2, 16],
    segment: 2,
    raw: true,
    setup: (c) => {
      c.setAmbience('coast');
      c.setMusic(true);
    },
    tick: (c, t) => {
      const speed = 12 + 10 * Math.sin(t * 0.7);
      const air = t % 4 > 3;
      c.updateRide(ride({ speed, grounded: !air, spinRate: air ? 9 : 0, skid: t % 5 > 4 ? 0.7 : 0, surface: SURFACES[Math.floor(t / 3) % 6] }));
      const f = Math.round(t * 60);
      if (f % 240 === 239) c.fx.playLanding(0.9, 'rock');
      if (f % 240 === 120) c.fx.playTrickLanded(2500, Math.floor(t / 4), true);
      if (f === 600) c.fx.playCrash(1);
      if (f === 300) c.fx.playFinish();
      if (f % 50 === 0) c.fx.playBushHit();
      if (f % 7 === 0) c.fx.playUiHover();
    },
  });
  // ---- garbage in: every API with NaN / Infinity / unknown enums must neither throw nor emit NaN
  cases.push({
    id: 'robust.garbage-inputs',
    group: 'robust',
    expectSound: true,
    seconds: 4,
    rate: 60,
    active: [0, 4],
    setup: (c) => {
      c.setAmbience('lava' as AmbienceKind);
      c.setAmbience('beach');
      c.setMusic(true);
    },
    tick: (c, t) => {
      const bad = [NaN, Infinity, -Infinity, -5, 1e9][Math.floor(t * 60) % 5];
      c.updateRide({ speed: bad, grounded: t % 1 > 0.5, surface: 'lava' as Surface, pedaling: true, braking: true, skid: bad, spinRate: bad, dt: bad });
      if (Math.round(t * 60) % 20 === 0) {
        c.fx.playLanding(bad, 'lava' as Surface);
        c.fx.playPop(bad);
        c.fx.playTrickLanded(bad, bad, true);
        c.fx.playCrash(bad);
        c.fx.playCountdown(bad);
        c.setVolumes({ master: 0.9, music: 0.7, sfx: 1, ambience: 0.85 });
      }
    },
  });
  cases.push({
    id: 'mix.muted',
    group: 'mix',
    expectSound: false,
    seconds: 4,
    rate: 20,
    active: [1, 4],
    setup: (c) => {
      c.setAmbience('beach');
      c.setMusic(true);
      c.fx.playCrash(1);
      c.setMuted(true);
    },
  });
  return cases;
}

let CASES: CaseDef[] | null = null;
function cases(): CaseDef[] {
  if (!CASES) CASES = buildCases();
  return CASES;
}

async function runCase(id: string): Promise<CaseResult> {
  const def = cases().find((c) => c.id === id);
  if (!def) throw new Error(`unknown case ${id}`);
  const { buf, core, ms } = await render({ seconds: def.seconds, rate: def.rate, setup: def.setup, tick: def.tick });
  const m = measure(buf, def.active, def.tail, def.segment);
  const res: CaseResult = {
    id: def.id,
    group: def.group,
    expectSound: def.expectSound,
    seconds: def.seconds,
    ...m,
    live: core.stats.live,
    voicesLeft: core.stats.voices,
    ms,
    extra: def.extra || def.analyze ? { ...(def.extra?.(core) ?? {}), ...(def.analyze?.(buf) ?? {}) } : undefined,
  };
  if (def.raw) {
    const r = await render({ seconds: def.seconds, rate: def.rate, setup: def.setup, tick: def.tick, bypass: true });
    res.rawPeak = measure(r.buf, def.active).peak;
    r.core.dispose();
  }
  core.dispose();
  return res;
}

/** updateRide() at 60 Hz for `seconds` with a constantly changing state: node count must stay flat. */
async function nodeGrowth(seconds = 10, withMix = false): Promise<Record<string, unknown>> {
  const samples: { t: number; live: number; created: number; voices: number }[] = [];
  let calls = 0;
  const { core, ms } = await render({
    seconds: seconds + 0.5,
    rate: 60,
    setup: (c) => {
      if (withMix) {
        c.setAmbience('alpine');
        c.setMusic(true);
      }
    },
    tick: (c, t) => {
      calls++;
      const phase = t % 6;
      c.updateRide(
        ride({
          speed: 15 + 14 * Math.sin(t * 1.3),
          grounded: phase < 4.5,
          surface: SURFACES[Math.floor(t * 1.7) % SURFACES.length],
          pedaling: Math.floor(t * 0.8) % 3 === 0,
          braking: Math.floor(t * 1.1) % 4 === 1,
          skid: Math.max(0, Math.sin(t * 2.3)),
          spinRate: phase >= 4.5 ? 10 : 0,
        }),
      );
      if (withMix && Math.round(t * 60) % 90 === 0) c.fx.playLanding(0.7, 'dirt');
      const f = Math.round(t * 60);
      if (f % 30 === 0) samples.push({ t: Math.round(t * 100) / 100, live: c.stats.live, created: c.stats.created, voices: c.stats.voices });
    },
  });
  const res = {
    seconds,
    withMix,
    updateRideCalls: calls,
    renderMs: Math.round(ms),
    liveAt1s: samples.find((s) => s.t >= 1)?.live ?? null,
    liveAtEnd: samples[samples.length - 1]?.live ?? null,
    liveMax: Math.max(...samples.map((s) => s.live)),
    liveMin: Math.min(...samples.filter((s) => s.t >= 1).map((s) => s.live)),
    createdAt1s: samples.find((s) => s.t >= 1)?.created ?? null,
    createdAtEnd: samples[samples.length - 1]?.created ?? null,
    peakVoices: core.stats.peakVoices,
    samples,
  };
  core.dispose();
  return res;
}

/** Real-time smoke test on the actual singleton (needs autoplay permission). */
async function realtime(seconds = 10): Promise<Record<string, unknown>> {
  await audio.unlock();
  const ctx = audio.context;
  const out: Record<string, unknown> = { unlocked: audio.unlocked, state: ctx?.state ?? null, sampleRate: ctx?.sampleRate ?? null };
  if (!ctx) return out;
  audio.setAmbience('beach');
  audio.setMusic(true);
  const samples: { t: number; live: number; voices: number }[] = [];
  const start = performance.now();
  let calls = 0;
  await new Promise<void>((resolve) => {
    const id = setInterval(() => {
      const t = (performance.now() - start) / 1000;
      calls++;
      audio.updateRide(
        ride({ speed: 14 + 10 * Math.sin(t), surface: SURFACES[Math.floor(t) % 6], pedaling: t % 3 < 1, skid: Math.max(0, Math.sin(t * 3)) * 0.5 }),
      );
      if (calls % 60 === 0) {
        audio.playLanding(0.5, 'dirt');
        const s = audio.debugStats();
        if (s) samples.push({ t: Math.round(t * 10) / 10, live: s.live, voices: s.voices });
      }
      if (calls % 150 === 0) audio.playTrickLanded(1200, 2, true);
      if (t >= seconds) {
        clearInterval(id);
        resolve();
      }
    }, 1000 / 60);
  });
  audio.updateRide(null);
  audio.setMusic(false);
  // persistence round trip
  const before = audio.volumes;
  audio.setVolumes({ music: 0.42 });
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem('downhill.audio') ?? 'null');
  } catch {
    stored = 'unparseable';
  }
  audio.setVolumes(before);
  return { ...out, stateAfter: ctx.state, updateRideCalls: calls, samples, stored };
}

/** Offline render-speed benchmark: DSP cost of each subsystem as % of one core (suspend overhead subtracted). */
async function bench(seconds = 20): Promise<Record<string, unknown>> {
  const rate = 12;
  const st = ride({ speed: 15, surface: 'dirt' });
  const run = async (setup: (c: AudioCore) => void, tick?: (c: AudioCore) => void): Promise<number> => {
    const r = await render({ seconds, rate, setup, tick: tick ? (c) => tick(c) : undefined });
    r.core.dispose();
    return r.ms;
  };
  const idle = await run(() => undefined);
  // pure suspend/resume overhead: an empty context with the same control schedule
  const t0 = performance.now();
  {
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(SR * seconds), sampleRate: SR });
    let k = 1;
    const next = (): void => {
      const t = k / rate;
      if (t >= seconds - 2 / rate) return;
      void ctx.suspend(t).then(() => {
        k++;
        next();
        return ctx.resume();
      });
    };
    next();
    await ctx.startRendering();
  }
  const base = performance.now() - t0;
  const rideMs = await run((c) => c.updateRide(st), (c) => c.updateRide(st));
  const ambMs: Record<string, number> = {};
  for (const k of KINDS) ambMs[k] = await run((c) => c.setAmbience(k));
  const musicMs = await run((c) => c.setMusic(true));
  const full = await run(
    (c) => {
      c.setAmbience('beach');
      c.setMusic(true);
      c.updateRide(st);
    },
    (c) => c.updateRide(st),
  );
  const pct = (ms: number): number => Math.round((Math.max(0, ms - idle) / (seconds * 1000)) * 1000) / 10;
  return {
    seconds,
    idleMs: Math.round(idle),
    masterChainPct: Math.round((Math.max(0, idle - base) / (seconds * 1000)) * 1000) / 10,
    ridePct: pct(rideMs),
    ambiencePct: Object.fromEntries(Object.entries(ambMs).map(([k, v]) => [k, pct(v)])),
    musicPct: pct(musicMs),
    fullPct: pct(full),
    fullRealtimeFactor: Math.round(((seconds * 1000) / full) * 10) / 10,
  };
}

const lab = {
  ready: true,
  listCases: (): { id: string; group: string }[] => cases().map((c) => ({ id: c.id, group: c.group })),
  runCase,
  nodeGrowth,
  realtime,
  bench,
};

declare global {
  interface Window {
    audioLab: typeof lab;
  }
}
window.audioLab = lab;

// ====================================================================== manual UI

const app = document.getElementById('app') as HTMLDivElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
}

function card(title: string, ...kids: Node[]): HTMLDivElement {
  return el('div', { className: 'card' }, el('h2', { textContent: title }), ...kids);
}

function row(...kids: (Node | string)[]): HTMLDivElement {
  return el('div', { className: 'row' }, ...kids);
}

function button(text: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { textContent: text, className: cls });
  b.addEventListener('click', () => {
    void audio.unlock();
    audio.playUiClick();
    onClick();
  });
  b.addEventListener('mouseenter', () => audio.playUiHover());
  return b;
}

function slider(label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLLabelElement {
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = el('output', { textContent: String(value) });
  input.addEventListener('input', () => {
    out.textContent = input.value;
    onInput(Number(input.value));
  });
  return el('label', { className: 'slider' }, label, input, out);
}

function select<T extends string>(options: readonly T[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = el('select');
  for (const o of options) s.append(el('option', { value: o, textContent: o, selected: o === value }));
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

function check(label: string, value: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const c = el('input', { type: 'checkbox', checked: value });
  c.addEventListener('change', () => onChange(c.checked));
  return el('label', {}, c, label);
}

// ---- global
const status = el('span', { textContent: 'locked' });
const vols = audio.volumes;
const globalCard = card(
  'Engine',
  row(
    button('Unlock audio', () => undefined, 'primary'),
    status,
    check('mute', audio.muted, (m) => audio.setMuted(m)),
  ),
  slider('master', 0, 1, 0.01, vols.master, (v) => audio.setVolumes({ master: v })),
  slider('music', 0, 1, 0.01, vols.music, (v) => audio.setVolumes({ music: v })),
  slider('sfx', 0, 1, 0.01, vols.sfx, (v) => audio.setVolumes({ sfx: v })),
  slider('ambience', 0, 1, 0.01, vols.ambience, (v) => audio.setVolumes({ ambience: v })),
  el('canvas', { id: 'meter', width: 600, height: 26 }),
  el('pre', { id: 'stats' }),
);

// ---- ambience & music
let musicOn = false;
const musicBtn = button('Music: off', () => {
  musicOn = !musicOn;
  audio.setMusic(musicOn);
  musicBtn.textContent = `Music: ${musicOn ? 'on' : 'off'}`;
  musicBtn.classList.toggle('on', musicOn);
});
const ambRow = row();
const ambBtns: HTMLButtonElement[] = [];
for (const k of KINDS) {
  const b = button(k, () => {
    audio.setAmbience(k);
    for (const x of ambBtns) x.classList.toggle('on', x === b);
  });
  ambBtns.push(b);
  ambRow.append(b);
}
const ambCard = card('Ambience & music', ambRow, row(musicBtn));

// ---- one-shots
let landI = 0.7;
let landS: Surface = 'dirt';
let popC = 0.6;
let crashI = 0.8;
let points = 800;
let combo = 1;
let perfect = false;
const shotsCard = card(
  'One-shots',
  row(button('Landing', () => audio.playLanding(landI, landS)), select(SURFACES, landS, (s) => (landS = s))),
  slider('landing intensity', 0, 1, 0.05, landI, (v) => (landI = v)),
  row(button('Pop / bunny hop', () => audio.playPop(popC)), button('Trick start', () => audio.playTrickStart())),
  slider('pop charge', 0, 1, 0.05, popC, (v) => (popC = v)),
  row(button('Trick landed', () => audio.playTrickLanded(points, combo, perfect)), check('perfect', perfect, (p) => (perfect = p))),
  slider('points', 0, 5000, 50, points, (v) => (points = v)),
  slider('combo', 0, 12, 1, combo, (v) => (combo = v)),
  row(button('Crash', () => audio.playCrash(crashI)), button('Bush hit', () => audio.playBushHit())),
  row(button('Flyby whoosh (right)', () => audio.playWhoosh(0.5, 0.6)), button('Boost whoosh', () => audio.playWhoosh(1, 0))),
  slider('crash intensity', 0, 1, 0.05, crashI, (v) => (crashI = v)),
  row(
    button('Checkpoint', () => audio.playCheckpoint()),
    button('Finish', () => audio.playFinish()),
    button('3', () => audio.playCountdown(3)),
    button('2', () => audio.playCountdown(2)),
    button('1', () => audio.playCountdown(1)),
    button('GO', () => audio.playCountdown(0)),
    button('3-2-1-GO', () => [3, 2, 1, 0].forEach((n, i) => setTimeout(() => audio.playCountdown(n), i * 1000))),
  ),
  row(button('UI hover', () => audio.playUiHover()), button('UI click', () => undefined)),
);

// ---- ride simulator
const st: RideAudioState = ride({ speed: 12 });
let riding = false;
const rideCard = card(
  'Ride simulator',
  row(
    check('riding', riding, (r) => (riding = r)),
    check('grounded', st.grounded, (g) => (st.grounded = g)),
    check('pedaling', st.pedaling, (p) => (st.pedaling = p)),
    check('braking', st.braking, (b) => (st.braking = b)),
  ),
  row(
    'surface',
    select(SURFACES, st.surface, (s) => (st.surface = s)),
    'solo layer',
    select(['all', ...RIDE_LAYERS] as const, 'all', (s) => audio.debugSoloRide(s === 'all' ? null : s)),
  ),
  slider('speed m/s', 0, 30, 0.5, st.speed, (v) => (st.speed = v)),
  slider('spin rad/s', 0, 15, 0.5, st.spinRate, (v) => (st.spinRate = v)),
  slider('skid', 0, 1, 0.05, st.skid, (v) => (st.skid = v)),
);

// ---- offline checks
const results = el('div');
const offlineCard = card(
  'Offline checks',
  row(
    button('Run all offline renders', () => {
      void runAllInPage(results);
    }),
  ),
  results,
);

app.append(el('div', { className: 'grid' }, globalCard, ambCard, shotsCard, rideCard, offlineCard));

async function runAllInPage(target: HTMLElement): Promise<void> {
  const table = el('table');
  table.append(el('tr', {}, ...['case', 'peak', 'peak dB', 'rms dB', 'tail dB', 'NaN', 'raw peak'].map((h) => el('th', { textContent: h }))));
  target.replaceChildren(table);
  const db = (x: number | null | undefined): string => (x === null || x === undefined ? '' : x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');
  for (const c of cases()) {
    const r = await runCase(c.id);
    const bad = r.peak > 0.98 || r.nan > 0 || (r.expectSound && r.activeRms < 3e-4);
    const tr = el(
      'tr',
      { className: bad ? 'bad' : '' },
      ...[r.id, r.peak.toFixed(3), db(r.peak), db(r.activeRms), db(r.tailRms), String(r.nan), r.rawPeak?.toFixed(3) ?? ''].map((v) => el('td', { textContent: v })),
    );
    table.append(tr);
  }
}

// ---- frame loop: ride updates, meter, stats
const meter = document.getElementById('meter') as HTMLCanvasElement;
const statsPre = document.getElementById('stats') as HTMLPreElement;
let analyser: AnalyserNode | null = null;
let data: Float32Array<ArrayBuffer> | null = null;
let lastStats = 0;
let peakHold = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (audio.unlocked) {
    audio.updateRide(riding ? { ...st, dt: 1 / 60 } : null);
    if (!analyser) {
      analyser = audio.createAnalyser();
      if (analyser) data = new Float32Array(analyser.fftSize);
    }
  }
  status.textContent = audio.unlocked ? `running @ ${audio.context?.sampleRate ?? '?'} Hz` : 'locked – click unlock';
  const g = meter.getContext('2d');
  if (g && analyser && data) {
    analyser.getFloatTimeDomainData(data);
    let pk = 0;
    let s = 0;
    for (const x of data) {
      pk = Math.max(pk, Math.abs(x));
      s += x * x;
    }
    const rms = Math.sqrt(s / data.length);
    peakHold = Math.max(pk, peakHold * 0.97);
    const w = meter.width;
    const toX = (v: number): number => (Math.max(-60, 20 * Math.log10(Math.max(v, 1e-6))) / 60 + 1) * w;
    g.clearRect(0, 0, w, meter.height);
    g.fillStyle = '#7fc8a9';
    g.fillRect(0, 4, toX(rms), meter.height - 8);
    g.fillStyle = peakHold > 0.9 ? '#e74c3c' : '#f4d35e';
    g.fillRect(toX(peakHold) - 2, 2, 3, meter.height - 4);
  }
  if (now - lastStats > 400) {
    lastStats = now;
    const s = audio.debugStats();
    statsPre.textContent = s
      ? `nodes live ${s.live} (created ${s.created}, released ${s.released})\nvoices ${s.voices} (peak ${s.peakVoices}, dropped ${s.droppedVoices})\nambience ${s.ambience ?? '-'} scenes ${s.scenes} · music ${s.music ? 'on' : 'off'} · ride ${s.rideActive ? 'active' : 'idle'}`
      : 'not unlocked';
  }
}
requestAnimationFrame(frame);
