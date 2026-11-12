/**
 * Procedural audio engine (Web Audio, no asset files).
 *
 * Usage:
 *   import { audio } from './core/audio';
 *   window.addEventListener('pointerdown', () => audio.unlock());   // any user gesture, repeatable
 *   audio.setAmbience('coast'); audio.setMusic(true);                // may be called before unlock
 *   // every frame while riding:  audio.updateRide(state);  in menus / pause: audio.updateRide(null)
 *   audio.playLanding(0.7, 'dirt');  ...
 *
 * Everything is a safe no-op until `unlock()` has created the AudioContext; ambience / music /
 * volume / mute requests made before that are remembered and applied on unlock.
 */
import type { AmbienceKind, IAudio, RideAudioState, Surface } from './audioTypes';
import { AMBIENCE_KINDS, AudioCore, DEFAULT_VOLUMES, type CoreDebugStats, type Volumes } from './audio/core';

export { AMBIENCE_KINDS, AudioCore, DEFAULT_VOLUMES, sliderToGain } from './audio/core';
export type { CoreDebugStats, CoreOptions, Volumes } from './audio/core';
export { RIDE_LAYERS, SURFACES, type RideLayerName } from './audio/ride';
export { AMBIENCE_PARTS, type AmbiencePart } from './audio/ambience';
export { musicScale } from './audio/music';

const STORAGE_KEY = 'downhill.audio';
const PUMP_MS = 25;

interface Persisted extends Volumes {
  muted: boolean;
}

const clampVol = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

export class AudioEngine implements IAudio {
  /** Fade out and suspend the context while the tab is hidden. */
  pauseWhenHidden = true;

  private ctx: AudioContext | null = null;
  private core: AudioCore | null = null;
  private _unlocked = false;
  private _muted = false;
  private vol: Volumes = { ...DEFAULT_VOLUMES };
  private ambienceKind: AmbienceKind | null = null;
  private musicOn = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private hidden = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private warned = false;

  constructor() {
    this.load();
  }

  get unlocked(): boolean {
    return this._unlocked;
  }

  get muted(): boolean {
    return this._muted;
  }

  /** Current volume slider values (0..1). */
  get volumes(): Volumes {
    return { ...this.vol };
  }

  /** The underlying context (null before unlock). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  unlock(): Promise<void> {
    if (typeof window === 'undefined') return Promise.resolve();
    if (!this.ctx) {
      const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return Promise.resolve();
      let ctx: AudioContext;
      try {
        ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        try {
          ctx = new Ctor(); // old WebKit rejects the options bag
        } catch {
          return Promise.resolve();
        }
      }
      this.ctx = ctx;
      // resume synchronously inside the gesture, before building the graph
      const resumed = Promise.resolve(ctx.resume());
      this.safe(() => {
        const core = new AudioCore(ctx, { volumes: this.vol, muted: this._muted });
        this.core = core;
        this.kickSilentBuffer(ctx);
        if (this.ambienceKind) core.setAmbience(this.ambienceKind);
        if (this.musicOn) core.setMusic(true);
      });
      this.timer = setInterval(() => this.safe(() => this.core?.pump()), PUMP_MS);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'running') this._unlocked = true;
      });
      return resumed.then(
        () => this.afterResume(),
        () => undefined,
      );
    }
    const ctx = this.ctx;
    if (ctx.state === 'running') {
      this._unlocked = true;
      return Promise.resolve();
    }
    if (this.hidden && this.pauseWhenHidden) return Promise.resolve();
    return ctx.resume().then(
      () => this.afterResume(),
      () => undefined,
    );
  }

  private afterResume(): void {
    if (this.ctx?.state === 'running') this._unlocked = true;
    this.safe(() => this.core?.pump());
  }

  /** iOS Safari needs a buffer started inside the gesture to really unlock output. */
  private kickSilentBuffer(ctx: AudioContext): void {
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.onended = () => src.disconnect();
      src.start(0);
    } catch {
      /* ignore */
    }
  }

  private readonly onVisibility = (): void => {
    if (!this.ctx || !this.core || typeof document === 'undefined') return;
    const hidden = document.visibilityState === 'hidden';
    if (hidden === this.hidden || !this.pauseWhenHidden) return;
    this.hidden = hidden;
    const ctx = this.ctx;
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    if (hidden) {
      this.core.setHidden(true);
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if (this.hidden && ctx.state === 'running') ctx.suspend().catch(() => undefined);
      }, 300);
    } else {
      this.core.setHidden(false);
      if (ctx.state !== 'running' && this._unlocked) ctx.resume().catch(() => undefined);
    }
  };

  setVolumes(v: { master?: number; music?: number; sfx?: number; ambience?: number }): void {
    const cur = this.vol;
    this.vol = {
      master: clampVol(v?.master, cur.master),
      music: clampVol(v?.music, cur.music),
      sfx: clampVol(v?.sfx, cur.sfx),
      ambience: clampVol(v?.ambience, cur.ambience),
    };
    this.save();
    this.safe(() => this.core?.setVolumes(this.vol));
  }

  setMuted(muted: boolean): void {
    this._muted = !!muted;
    this.save();
    this.safe(() => this.core?.setMuted(this._muted));
  }

  setAmbience(kind: AmbienceKind): void {
    if (!AMBIENCE_KINDS.includes(kind)) return;
    this.ambienceKind = kind;
    this.safe(() => this.core?.setAmbience(kind));
  }

  setMusic(on: boolean): void {
    this.musicOn = !!on;
    this.safe(() => this.core?.setMusic(this.musicOn));
  }

  updateRide(state: RideAudioState | null): void {
    if (this.core) this.safe(() => this.core?.updateRide(state));
  }

  playLanding(intensity: number, surface: Surface): void {
    this.safe(() => this.core?.fx.playLanding(intensity, surface));
  }
  playPop(charge: number): void {
    this.safe(() => this.core?.fx.playPop(charge));
  }
  playTrickStart(): void {
    this.safe(() => this.core?.fx.playTrickStart());
  }
  playTrickLanded(points: number, comboCount: number, perfect: boolean): void {
    this.safe(() => this.core?.fx.playTrickLanded(points, comboCount, perfect));
  }
  playCrash(intensity: number): void {
    this.safe(() => this.core?.fx.playCrash(intensity));
  }
  playCheckpoint(): void {
    this.safe(() => this.core?.fx.playCheckpoint());
  }
  playCountdown(n: number): void {
    this.safe(() => this.core?.fx.playCountdown(n));
  }
  playFinish(): void {
    this.safe(() => this.core?.fx.playFinish());
  }
  playUiHover(): void {
    this.safe(() => this.core?.fx.playUiHover());
  }
  playUiClick(): void {
    this.safe(() => this.core?.fx.playUiClick());
  }
  playBushHit(): void {
    this.safe(() => this.core?.fx.playBushHit());
  }
  playWhoosh(intensity: number, pan: number): void {
    this.safe(() => this.core?.fx.playWhoosh(intensity, pan));
  }

  /** Audio must never take the game loop down: swallow (and report once) unexpected errors. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[audio] suppressed error:', e);
      }
    }
  }

  /** Debug counters (node leak detection); null before unlock. */
  debugStats(): CoreDebugStats | null {
    return this.core?.debugStats() ?? null;
  }

  /** Debug: analyser on the final output (for meters); null before unlock. */
  createAnalyser(): AnalyserNode | null {
    return this.core?.createAnalyser() ?? null;
  }

  /** Debug: solo one ride layer (null = all). */
  debugSoloRide(layer: Parameters<AudioCore['ride']['solo']>[0]): void {
    this.core?.ride.solo(layer);
  }

  /** Tear everything down (tests / hot reload). */
  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.core?.dispose();
    this.core = null;
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this._unlocked = false;
  }

  private load(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<Persisted> | null;
      if (!p || typeof p !== 'object') return;
      this.vol = {
        master: clampVol(p.master, DEFAULT_VOLUMES.master),
        music: clampVol(p.music, DEFAULT_VOLUMES.music),
        sfx: clampVol(p.sfx, DEFAULT_VOLUMES.sfx),
        ambience: clampVol(p.ambience, DEFAULT_VOLUMES.ambience),
      };
      this._muted = p.muted === true;
    } catch {
      /* corrupt or unavailable storage: keep defaults */
    }
  }

  private save(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const p: Persisted = { ...this.vol, muted: this._muted };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch {
      /* storage full / disabled */
    }
  }
}

export const audio = new AudioEngine();
