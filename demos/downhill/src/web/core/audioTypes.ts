export type Surface = 'dirt' | 'grass' | 'sand' | 'rock' | 'snow' | 'wood';

export type AmbienceKind = 'menu' | 'coast' | 'desert' | 'alpine' | 'fantasy' | 'beach' | 'city';

/** Continuous riding state, pushed to the audio engine every frame. */
export interface RideAudioState {
  /** Forward speed, m/s (0..~30). */
  speed: number;
  grounded: boolean;
  surface: Surface;
  /** Rider is pedalling (chain/drivetrain sound; no freewheel ticks). */
  pedaling: boolean;
  braking: boolean;
  /** 0..1 lateral skid / drift intensity. */
  skid: number;
  /** Absolute rotation rate while airborne (rad/s) – drives a "whoosh". */
  spinRate: number;
  /** Seconds since the frame before (clamped). */
  dt: number;
}

export interface IAudio {
  /** Must be called from a user gesture (click/keydown); safe to call repeatedly. */
  unlock(): Promise<void>;
  readonly unlocked: boolean;
  setVolumes(v: { master?: number; music?: number; sfx?: number; ambience?: number }): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  setAmbience(kind: AmbienceKind): void;
  /** Start/stop the gentle generative soundtrack. */
  setMusic(on: boolean): void;
  /** Call every frame while riding; pass null when not riding (menus/paused) to fade ride sounds out. */
  updateRide(state: RideAudioState | null): void;
  playLanding(intensity: number, surface: Surface): void; // intensity 0..1
  playPop(charge: number): void; // 0..1
  playTrickStart(): void;
  playTrickLanded(points: number, comboCount: number, perfect: boolean): void;
  playCrash(intensity: number): void;
  playCheckpoint(): void;
  playCountdown(n: number): void; // 3,2,1 then 0 = GO
  playFinish(): void;
  playUiHover(): void;
  playUiClick(): void;
  playBushHit(): void;
  /** Air rushing past: a close flyby (pan -1 left .. 1 right) or a speed boost (pan 0). Intensity 0..1. */
  playWhoosh(intensity: number, pan: number): void;
}
