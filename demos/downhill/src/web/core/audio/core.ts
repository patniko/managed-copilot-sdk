/**
 * AudioCore: the complete synthesis graph, constructible on any BaseAudioContext
 * (a realtime AudioContext in the game, an OfflineAudioContext in tests).
 *
 *   voices ─► bus.in ─► duck ─► volume ──────────────┐
 *          └► bus.send ─► duck ─► volume ─► reverb ───┤
 *                                                     ▼
 *     preMaster ─► master volume ─► mute ─► glue compressor ─► limiter ─► soft clip ─► out
 *
 * Time only advances through `pump()` (lookahead scheduling), so a test can drive the exact
 * same code from OfflineAudioContext.suspend() callbacks.
 */
import type { AmbienceKind, RideAudioState } from '../audioTypes';
import { AmbienceManager } from './ambience';
import { makeBuffers, makeSoftClipCurve, makeWaves, type SharedBuffers, type SharedWaves } from './buffers';
import { MusicPlayer } from './music';
import { RideLayers } from './ride';
import { Sfx } from './sfx';
import { Kit, NodeGroup, NodeStats, Rng, VoicePool, clamp01, glide } from './util';

export interface Volumes {
  master: number;
  music: number;
  sfx: number;
  ambience: number;
}

export interface CoreOptions {
  /** Deterministic randomness (tests). */
  seed?: number;
  /** Skip compressor / limiter / clipper (measure the raw mix headroom). */
  bypassDynamics?: boolean;
  volumes?: Volumes;
  muted?: boolean;
}

export interface CoreDebugStats {
  created: number;
  released: number;
  live: number;
  voices: number;
  peakVoices: number;
  droppedVoices: number;
  ambience: AmbienceKind | null;
  scenes: number;
  music: boolean;
  rideActive: boolean;
  time: number;
}

export const DEFAULT_VOLUMES: Volumes = { master: 0.9, music: 0.7, sfx: 1, ambience: 0.85 };
export const AMBIENCE_KINDS: readonly AmbienceKind[] = ['menu', 'coast', 'desert', 'alpine', 'fantasy', 'beach', 'city'];

/** Slider position (0..1) to linear gain: squared "audio taper". */
export const sliderToGain = (v: number): number => {
  const c = clamp01(Number.isFinite(v) ? v : 0);
  return c * c;
};

/** A mixer channel with a dry path and a reverb send path; both follow volume and ducking. */
export class Bus {
  readonly in: GainNode;
  readonly send: GainNode;
  private readonly duckDry: GainNode;
  private readonly duckWet: GainNode;
  private readonly volDry: GainNode;
  private readonly volWet: GainNode;
  constructor(g: NodeGroup, dest: AudioNode, reverbIn: AudioNode, volume: number) {
    this.in = g.gain(1);
    this.send = g.gain(1);
    this.duckDry = g.gain(1);
    this.duckWet = g.gain(1);
    this.volDry = g.gain(volume);
    this.volWet = g.gain(volume);
    this.in.connect(this.duckDry).connect(this.volDry).connect(dest);
    this.send.connect(this.duckWet).connect(this.volWet).connect(reverbIn);
  }
  setVolume(v: number, t: number): void {
    glide(this.volDry.gain, v, t, 0.05);
    glide(this.volWet.gain, v, t, 0.05);
  }
  /** Temporarily lower this bus (e.g. music under a big SFX moment). */
  duck(depth: number, t: number, hold: number, release = 0.8): void {
    const g = 1 - clamp01(depth);
    for (const p of [this.duckDry.gain, this.duckWet.gain]) {
      p.cancelScheduledValues(t);
      p.setTargetAtTime(g, t, 0.04);
      p.setTargetAtTime(1, t + hold, release / 3);
    }
  }
}

export class AudioCore {
  readonly ctx: BaseAudioContext;
  readonly stats = new NodeStats();
  readonly kit: Kit;
  readonly rng: Rng;
  readonly buffers: SharedBuffers;
  readonly waves: SharedWaves;
  readonly voices: VoicePool;
  readonly group: NodeGroup;

  readonly sfxBus: Bus;
  readonly ambBus: Bus;
  readonly musicBus: Bus;
  /** Final output node (connected to ctx.destination). */
  readonly output: AudioNode;

  readonly ride: RideLayers;
  readonly ambience: AmbienceManager;
  readonly fx: Sfx;
  music: MusicPlayer | null = null;
  private musicOn = false;
  private musicDisposeAt = 0;

  private readonly masterVol: GainNode;
  private readonly muteGain: GainNode;
  private volumes: Volumes;
  private muted: boolean;
  private hidden = false;
  private lastReap = 0;
  private disposed = false;

  constructor(ctx: BaseAudioContext, opts: CoreOptions = {}) {
    this.ctx = ctx;
    this.kit = new Kit(ctx, this.stats);
    this.rng = new Rng(opts.seed ?? (Math.random() * 4294967296) >>> 0);
    this.buffers = makeBuffers(ctx, new Rng(opts.seed ?? 12345));
    this.waves = makeWaves(ctx);
    this.voices = new VoicePool(this.kit, 56);
    this.group = new NodeGroup(this.kit);
    this.volumes = { ...DEFAULT_VOLUMES, ...(opts.volumes ?? {}) };
    this.muted = opts.muted ?? false;
    const g = this.group;

    // ---- master chain
    const preMaster = g.gain(0.62);
    this.masterVol = g.gain(sliderToGain(this.volumes.master));
    this.muteGain = g.gain(this.muted ? 0 : 1);
    preMaster.connect(this.masterVol).connect(this.muteGain);
    if (opts.bypassDynamics) {
      this.muteGain.connect(ctx.destination);
      this.output = this.muteGain;
    } else {
      // gentle glue (note: browsers add automatic make-up gain, so the trim above compensates)
      const glue = g.add(this.kit.compressor(-15, 12, 2.2, 0.012, 0.25));
      const limiter = g.add(this.kit.compressor(-5, 1, 20, 0.0015, 0.12));
      const clip = g.add(this.kit.shaper(makeSoftClipCurve(), 'none'));
      this.muteGain.connect(glue).connect(limiter).connect(clip).connect(ctx.destination);
      this.output = clip;
    }

    // ---- shared reverb (one convolver for everything)
    const reverbIn = g.gain(1);
    const conv = g.add(this.kit.convolver(this.buffers.ir));
    const revHp = g.filter('highpass', 180, 0.6);
    const revLp = g.filter('lowpass', 7500, 0.5);
    const revOut = g.gain(0.55);
    reverbIn.connect(conv).connect(revHp).connect(revLp).connect(revOut).connect(preMaster);

    this.sfxBus = new Bus(g, preMaster, reverbIn, sliderToGain(this.volumes.sfx));
    this.ambBus = new Bus(g, preMaster, reverbIn, sliderToGain(this.volumes.ambience));
    this.musicBus = new Bus(g, preMaster, reverbIn, sliderToGain(this.volumes.music));

    this.ride = new RideLayers(this);
    this.ambience = new AmbienceManager(this);
    this.fx = new Sfx(this);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Advance all lookahead schedulers. Call often (timer + every frame). */
  pump(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.ride.pump(now);
    this.ambience.pump(now);
    if (this.music) {
      this.music.pump(now);
      if (!this.musicOn && this.musicDisposeAt > 0 && now >= this.musicDisposeAt) {
        this.music.dispose();
        this.music = null;
        this.musicDisposeAt = 0;
      }
    }
    if (now - this.lastReap > 1) {
      this.lastReap = now;
      this.voices.reap(now);
    }
  }

  updateRide(state: RideAudioState | null): void {
    if (this.disposed) return;
    this.ride.update(state, this.ctx.currentTime);
    this.pump();
  }

  setAmbience(kind: AmbienceKind): void {
    if (this.disposed || !AMBIENCE_KINDS.includes(kind)) return;
    this.ambience.set(kind, this.ctx.currentTime);
    this.music?.setStyle(kind);
    this.pump();
  }

  setMusic(on: boolean): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.musicOn = on;
    if (on) {
      this.musicDisposeAt = 0;
      if (!this.music) this.music = new MusicPlayer(this, this.ambience.kind ?? 'menu');
      this.music.start(now);
      this.pump();
    } else if (this.music) {
      this.music.stop(now);
      this.musicDisposeAt = now + 2.5;
    }
  }

  /** Current music key root as a MIDI pitch class (one-shot jingles harmonise with it). */
  get keyRoot(): number {
    return this.music && this.musicOn ? this.music.keyRoot : 0;
  }

  setVolumes(v: Volumes): void {
    this.volumes = { ...v };
    const t = this.ctx.currentTime;
    glide(this.masterVol.gain, sliderToGain(v.master), t, 0.05);
    this.sfxBus.setVolume(sliderToGain(v.sfx), t);
    this.ambBus.setVolume(sliderToGain(v.ambience), t);
    this.musicBus.setVolume(sliderToGain(v.music), t);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyMute();
  }

  /** Fade everything while the tab is hidden. */
  setHidden(h: boolean): void {
    this.hidden = h;
    this.applyMute();
  }

  private applyMute(): void {
    const p = this.muteGain.gain;
    const t = this.ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(this.muted || this.hidden ? 0 : 1, t, 0.08);
  }

  /** Debug: analyser fed from the final output (not connected to the destination). */
  createAnalyser(): AnalyserNode {
    const a = this.group.add(this.kit.analyser());
    a.fftSize = 2048;
    this.output.connect(a);
    return a;
  }

  debugStats(): CoreDebugStats {
    const s = this.stats;
    return {
      created: s.created,
      released: s.released,
      live: s.live,
      voices: s.voices,
      peakVoices: s.peakVoices,
      droppedVoices: s.droppedVoices,
      ambience: this.ambience.kind,
      scenes: this.ambience.sceneCount,
      music: this.musicOn,
      rideActive: this.ride.active,
      time: this.ctx.currentTime,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.voices.releaseAll();
    this.music?.dispose();
    this.music = null;
    this.ambience.dispose();
    this.ride.dispose();
    this.group.dispose();
  }
}
