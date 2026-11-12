/**
 * Procedurally generated audio material: seamless noise loops, a sparse "crackle" loop,
 * a natural-sounding stereo reverb impulse response, a soft-clip curve and periodic waves.
 */
import { Rng } from './util';

export interface SharedBuffers {
  /** Mono white noise loop (RMS ~0.25). */
  white: AudioBuffer;
  /** Mono pink noise loop (RMS ~0.25). */
  pink: AudioBuffer;
  /** Mono brown (red) noise loop (RMS ~0.25). */
  brown: AudioBuffer;
  /** Stereo reverb impulse response (~2.6 s, darkening tail). */
  ir: AudioBuffer;
}

export interface SharedWaves {
  /** Warm plucked-string spectrum (harp / nylon guitar). */
  harp: PeriodicWave;
  /** Mellow kalimba-like spectrum. */
  kalimba: PeriodicWave;
  /** Bright ukulele / steel-string spectrum. */
  uke: PeriodicWave;
  /** Soft pad spectrum. */
  warm: PeriodicWave;
  /** Breathy ocarina / flute spectrum. */
  flute: PeriodicWave;
  /** Rich nasal spectrum for gulls / hawks. */
  reed: PeriodicWave;
  /** Sine with a touch of 2nd/3rd harmonic (birds, chimes). */
  sweet: PeriodicWave;
  /** Brass-ish (fanfare). */
  brass: PeriodicWave;
}

/** Fill `len` samples with a generator and make the loop seamless with an equal-power crossfade. */
function seamless(len: number, fade: number, gen: () => number): Float32Array<ArrayBuffer> {
  const tmp = new Float32Array(len + fade);
  for (let i = 0; i < tmp.length; i++) tmp[i] = gen();
  const out = new Float32Array(len);
  out.set(tmp.subarray(0, len));
  for (let i = 0; i < fade; i++) {
    const th = (i / fade) * Math.PI * 0.5;
    out[i] = tmp[len + i] * Math.cos(th) + tmp[i] * Math.sin(th);
  }
  return out;
}

function normalizeRms(d: Float32Array, target: number): void {
  let mean = 0;
  for (let i = 0; i < d.length; i++) mean += d[i];
  mean /= d.length;
  let s = 0;
  for (let i = 0; i < d.length; i++) {
    d[i] -= mean;
    s += d[i] * d[i];
  }
  const rms = Math.sqrt(s / d.length) || 1;
  const k = target / rms;
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

function monoBuffer(ctx: BaseAudioContext, data: Float32Array<ArrayBuffer>): AudioBuffer {
  const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
  b.copyToChannel(data, 0);
  return b;
}

export function makeBuffers(ctx: BaseAudioContext, rng: Rng): SharedBuffers {
  const sr = ctx.sampleRate;
  const fade = Math.floor(sr * 0.05);

  const white = seamless(Math.floor(sr * 3.1), fade, () => rng.next() * 2 - 1);
  normalizeRms(white, 0.25);

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  const pink = seamless(Math.floor(sr * 4.3), fade, () => {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return p;
  });
  normalizeRms(pink, 0.25);

  // Brown noise: leaky integrator, then a gentle DC-blocking high-pass (~15 Hz) to keep the
  // sub-sonic drift (which only eats headroom) out of the loop.
  let last = 0;
  let hpIn = 0;
  let hpOut = 0;
  const hpA = Math.exp((-2 * Math.PI * 15) / sr);
  const brown = seamless(Math.floor(sr * 4.7), fade, () => {
    const w = rng.next() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    const x = last;
    hpOut = hpA * (hpOut + x - hpIn);
    hpIn = x;
    return hpOut;
  });
  normalizeRms(brown, 0.25);

  return {
    white: monoBuffer(ctx, white),
    pink: monoBuffer(ctx, pink),
    brown: monoBuffer(ctx, brown),
    ir: makeImpulseResponse(ctx, rng, 2.6),
  };
}

/**
 * Stereo IR: short pre-delay, a few early reflections, then an exponentially decaying diffuse
 * tail whose high frequencies die faster (bright start, dark end) like a real open space.
 */
export function makeImpulseResponse(ctx: BaseAudioContext, rng: Rng, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const pre = 0.014;
  const decay = 6.9 / (seconds - pre); // -60 dB at the end
  for (let ch = 0; ch < 2; ch++) {
    const d = new Float32Array(len);
    let lp = 0;
    let lp2 = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      if (t < pre) continue;
      const tt = t - pre;
      const env = Math.exp(-tt * decay) * (1 - Math.exp(-tt / 0.006));
      const fc = 1100 + 8500 * Math.exp(-tt * 2.4);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      lp += a * (rng.next() * 2 - 1 - lp);
      lp2 += a * (lp - lp2);
      d[i] = lp2 * env;
    }
    // early reflections (different per channel for width)
    for (let k = 0; k < 9; k++) {
      const t = pre + rng.range(0.004, 0.09);
      const idx = Math.floor(t * sr);
      if (idx < len) d[idx] += rng.sign() * rng.range(0.15, 0.45) * Math.exp(-(t - pre) * 14);
    }
    // smooth the very end to avoid a step
    const tail = Math.floor(sr * 0.05);
    for (let i = 0; i < tail; i++) d[len - 1 - i] *= i / tail;
    buf.copyToChannel(d, ch);
  }
  return buf;
}

/**
 * Final safety soft-clipper: identity below |x| = 0.82, smooth tanh knee above, and since a
 * WaveShaper clamps its input to [-1, 1] the output can never exceed curve[end] (~0.95).
 */
export function makeSoftClipCurve(n = 4096): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const a = 0.82;
  const ceil = 0.975;
  const k = ceil - a;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= a ? ax : a + k * Math.tanh((ax - a) / k);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

function wave(ctx: BaseAudioContext, amps: readonly number[]): PeriodicWave {
  const real = new Float32Array(amps.length + 1);
  const imag = new Float32Array(amps.length + 1);
  for (let i = 0; i < amps.length; i++) imag[i + 1] = amps[i];
  return ctx.createPeriodicWave(real, imag);
}

export function makeWaves(ctx: BaseAudioContext): SharedWaves {
  const harp: number[] = [];
  const uke: number[] = [];
  const brass: number[] = [];
  for (let n = 1; n <= 14; n++) {
    harp.push((1 / Math.pow(n, 1.7)) * (n % 2 === 0 ? 0.75 : 1));
    uke.push((1 / Math.pow(n, 1.25)) * (n === 2 ? 0.9 : 1));
    brass.push(1 / Math.pow(n, 1.05));
  }
  return {
    harp: wave(ctx, harp),
    kalimba: wave(ctx, [1, 0.04, 0.12, 0.02, 0.05, 0.015]),
    uke: wave(ctx, uke),
    warm: wave(ctx, [1, 0.42, 0.22, 0.12, 0.06, 0.035, 0.02]),
    flute: wave(ctx, [1, 0.16, 0.06, 0.025]),
    reed: wave(ctx, [0.6, 0.9, 1, 0.75, 0.55, 0.4, 0.3, 0.22, 0.15, 0.1, 0.07, 0.05]),
    sweet: wave(ctx, [1, 0.12, 0.03]),
    brass: wave(ctx, brass),
  };
}
