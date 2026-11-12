import type * as THREE from 'three';
import type { Noise } from '../core/noise';
import type { Rng } from '../core/rng';
import type { AmbienceKind, Surface } from '../core/audioTypes';
import type { PostSettings } from '../post/painterly';
import type { TerrainData } from './terrain';
import type { TrailNetwork } from './trails';
import type { JumpFeature } from './features';

export type RGB = [number, number, number];

export interface GroundSample {
  x: number;
  z: number;
  h: number;
  /** Normal y component (1 = flat, 0 = vertical). */
  ny: number;
  /** Distance to the nearest trail edge (negative = on the trail). */
  trailDist: number;
}

export interface TerrainSpec {
  /** Detailed, rideable region (world metres). The run starts near z = 0 and heads toward -Z. */
  region: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Heightmap cell size, metres. */
  cell: number;
  /** Full-detail height inside the region. */
  height(x: number, z: number): number;
  /** Cheap height for the distant backdrop (must agree with `height` at the region border). */
  farHeight(x: number, z: number): number;
  /** Linear RGB albedo for a ground sample (writes into out). */
  groundColor(s: GroundSample, out: RGB): void;
  /** Albedo for distant backdrop terrain. */
  farColor(x: number, z: number, h: number, ny: number, out: RGB): void;
  /** Surface type for physics/audio (off-trail). */
  surface(s: GroundSample): Surface;
  /** Optional sea level (water plane rendered when defined). */
  seaLevel?: number;
}

export interface CourseSpec {
  start: { x: number; z: number };
  /** Main trail length (m). */
  length: number;
  /** Lateral meander amplitude (m) and wavelengths (m). */
  meander: number;
  wavelengths: [number, number, number];
  /** Approximate number of jumps on the main line. */
  jumps: number;
  /** Side lines: [branch distance, rejoin distance, lateral offset, kind]. */
  sideLines: Array<{ from: number; to: number; offset: number; kind: 'pro' | 'flow' }>;
  /** Extra freeride kickers scattered off-trail. */
  freerideKickers: number;
  trailColor: RGB;
  trailEdgeColor: RGB;
  /** Allowed lateral bounds for trails (inside region). */
  marginX: number;
  /** Optional explicit main-line centre x(z) (overrides meander/xRange); lets an env shape terrain around its trail. */
  centerline?: (z: number) => number;
  /** Optional absolute x range for the main line centre (overrides marginX). */
  xRange?: [number, number];
}

export interface SkySpec {
  zenith: string;
  horizon: string;
  haze: string;
  sunColor: string;
  sunIntensity: number;
  /** Direction TO the sun (world). */
  sunDir: [number, number, number];
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  cloudCount: number;
  cloudLight: string;
  cloudShade: string;
  /** Azimuth range (radians, 0 = -Z) where big cumulus pile up, with weight. */
  cloudBanks: Array<{ azimuth: number; spread: number; weight: number }>;
  cloudHeight: [number, number];
  cloudDistance: [number, number];
  cloudScale: [number, number];
}

export interface FogSpec {
  color: string;
  sunColor: string;
  density: number;
  heightFalloff: number;
  base: number;
  max: number;
  mistColor?: string;
  mistTop?: number;
  mistBottom?: number;
  mistStrength?: number;
  mistNear?: number;
  /** Restrict the low mist to a disc (x, z) of this radius. */
  mistCenter?: [number, number];
  /** Mist planes rise by this much per metre of +z (follow a descending ridge). */
  mistSlope?: number;
  mistRadius?: number;
}

export interface WaterSpec {
  level: number;
  deep: string;
  shallow: string;
  foam: string;
  /** Depth (m) over which shallow→deep blends. */
  depthScale: number;
}

export type BushKind = 'round' | 'pine' | 'palm' | 'cactus' | 'mushroom' | 'crystal' | 'deadTree' | 'broadleaf' | 'marram';
export type RockKind = 'boulder' | 'sandstone' | 'granite' | 'crystalRock' | 'driftwood';

export interface ScatterLayer {
  kind: BushKind | RockKind;
  /** Instances per hectare (10 000 m²) at density 1. */
  perHectare: number;
  scale: [number, number];
  colorA: string;
  colorB: string;
  /** Minimum distance from trail edges (m). */
  trailClearance: number;
  /** Returns 0..1 placement probability for a sample. */
  density(s: GroundSample, n: Noise): number;
  /** Collision: 'solid' crashes the rider, 'soft' slows them, 'none'. */
  collide: 'solid' | 'soft' | 'none';
  /** Place in the far backdrop too (low detail). */
  far?: boolean;
}

export interface GrassSpec {
  enabled: boolean;
  base: string;
  tip: string;
  tipAlt: string;
  height: [number, number];
  density: number;
  /** 0..1 coverage given a ground sample. */
  coverage(s: GroundSample): number;
  flowers?: { colors: string[]; density: number };
}

export interface WorldContext {
  scene: THREE.Scene;
  terrain: TerrainData;
  trails: TrailNetwork;
  /** Every built jump feature (trail jumps and freeride kickers), for keep-out checks. */
  features: readonly JumpFeature[];
  noise: Noise;
  rng: Rng;
  /** Register a circular collider (XZ) for the physics. */
  addCollider(x: number, z: number, radius: number, top: number, kind: 'solid' | 'soft'): void;
}

export interface EnvironmentDef {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  /** CSS colours used for the select card. */
  cardColors: [string, string, string];
  seed: number;
  terrain: TerrainSpec;
  course: CourseSpec;
  sky: SkySpec;
  fog: FogSpec;
  water?: WaterSpec;
  grass: GrassSpec;
  scatter: ScatterLayer[];
  post?: Partial<Omit<PostSettings, 'shadowTint' | 'highlightTint'>> & {
    shadowTint?: [number, number, number];
    highlightTint?: [number, number, number];
  };
  ambience: AmbienceKind;
  /** Build bespoke set pieces (citadel wall, mesas, floating islands...). */
  buildSetPieces?(ctx: WorldContext): SetPieceHandle | void;
  /** Intro/establishing camera shot relative to the start: [camera pos offset, look-at offset]. */
  introShot?: { from: [number, number, number]; to: [number, number, number] };
  /** Adjustments to the cinematic chase camera for this world's layout. */
  camera?: CameraStyle;
}

/**
 * Per-world tweaks to the cinematic chase camera, e.g. keeping it on the open side of a rooftop so the view
 * drops over the edge the way the reference video's does.
 */
export interface CameraStyle {
  /** Raise the camera (m). */
  lift?: number;
  /** Raise the aim point (m); pairs with `lift` so the horizon stays put while the camera sees down over edges. */
  lookLift?: number;
  /** Bias every framing's orbit (rad, + = rear-left, - = rear-right). */
  orbit?: number;
  /** Scale the operator's orbit swings (default 1). */
  orbitScale?: number;
  /** Pan the aim toward the vista (m, + = right of the rider). */
  pan?: number;
}

export interface SetPieceHandle {
  update?(dt: number, time: number, camera: THREE.Camera): void;
  dispose?(): void;
}
