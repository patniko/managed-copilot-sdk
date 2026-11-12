import * as THREE from 'three';

/**
 * Bike geometry contract, in the BIKE-LOCAL frame:
 *   forward = -Z, up = +Y, right = +X,
 *   origin  = ground contact point midway between the two wheels.
 * The physics treats the bike as a point at this origin; visuals must line up with these numbers.
 */
export const BIKE = {
  wheelRadius: 0.36,
  wheelbase: 1.16,
  rearAxle: new THREE.Vector3(0, 0.36, 0.56),
  frontAxle: new THREE.Vector3(0, 0.36, -0.6),
  bottomBracket: new THREE.Vector3(0, 0.32, 0.12),
  crankLength: 0.17,
  /** Lateral offset of each pedal from the bike centre plane. */
  pedalOffset: 0.11,
  /** Top of saddle. */
  saddle: new THREE.Vector3(0, 0.98, 0.36),
  /** Steering axis passes through the front axle, tilted back by headAngle from vertical. */
  headAngle: THREE.MathUtils.degToRad(25),
  /** Handlebar centre (at zero steer). */
  bar: new THREE.Vector3(0, 1.08, -0.4),
  /** Half width of the handlebar (grip centre distance from bike centre). */
  gripOffset: 0.36,
} as const;

/** Points the rider attaches to, in bike-local space, after steer / barspin / tailwhip are applied. */
export interface BikeAnchors {
  gripL: THREE.Vector3;
  gripR: THREE.Vector3;
  pedalL: THREE.Vector3;
  pedalR: THREE.Vector3;
  saddle: THREE.Vector3;
}

export interface BikeVisualState {
  /** Wheel rotation angles in radians (accumulated; rolling forward = positive). */
  rearSpin: number;
  frontSpin: number;
  /** Crank angle in radians. 0 = right crank pointing forward (-Z), increases when pedalling forward. */
  crank: number;
  /** Handlebar steer angle in radians (+ = turning right). Visual only, small (< 0.5). */
  steer: number;
  /** Extra handlebar rotation around the steering axis for the BARSPIN trick (0..2PI). */
  barspin: number;
  /** Frame rotation around the steering axis for the TAILWHIP trick (0..2PI). Front wheel + bars stay put. */
  tailwhip: number;
  /** 0..1 suspension compression (visual sag of fork / shock). */
  suspension: number;
}

export interface BikeVisual {
  /** Bike model root in bike-local frame. Meshes should cast shadows. */
  root: THREE.Group;
  /** Apply state; must refresh `anchors`. */
  update(state: BikeVisualState): void;
  /** Rider attachment points (bike-local), refreshed by update(). */
  readonly anchors: BikeAnchors;
}

export interface TrickPose {
  /** 0..1 blends. */
  superman: number;
  noHander: number;
  canCan: number;
  /** 0..1: rider's feet off pedals while the frame whips around (frame rotation handled by bike). */
  tailwhip: number;
  /** 0..1: hands off the bars while they spin (bar rotation handled by bike). */
  barspin: number;
  /** 0..1: rider twists the bike flat sideways (the game rolls the whole bike; rider counter-twists torso). */
  tabletop: number;
}

export interface RiderPose {
  /** Seconds since start, for idle/secondary animation. */
  time: number;
  /** Forward speed in m/s. */
  speed: number;
  /** 0..1: 1 = seated pedalling, 0 = standing "attack" position (descending). */
  seated: number;
  /** Body lean in radians (+ = leaning right), additional to the bike roll the game applies. */
  lean: number;
  /** -1..1 steering input. */
  steer: number;
  /** 0..1 compression (crouch) from landings / pumping / preloading a jump. */
  compress: number;
  airborne: boolean;
  /** When true the rider has been thrown off: play a limp tumbling pose (no IK to bike). */
  crashed: boolean;
  tricks: TrickPose;
  /** 0..1 celebratory fist-pump / wave after a landed trick. */
  celebrate: number;
  /** World-space velocity of the bike in m/s, when known: drives the body's inertia and the wind on loose clothing. */
  velocity?: THREE.Vector3;
  /** 0..1 roughness of the ground under the wheels (adds chatter to the rider's body). */
  roughness?: number;
}

export interface RiderRig {
  /** Root group, placed by the game as a child of the bike root (bike-local frame). Meshes should cast shadows. */
  root: THREE.Group;
  /** Pose the rider. Hands/feet IK to `anchors` unless a trick or crash releases them. */
  update(pose: RiderPose, anchors: BikeAnchors, dt: number): void;
}

export type CharacterId = 'rider' | 'mona' | 'copilot';

/** A rider's outfit from the shop: colours that replace entries of the character's own palette, by name. */
export type RiderColors = Readonly<Record<string, string>>;

/** A bike paint job from the shop: colours that replace entries of the character's bike style. */
export type BikePaint = Readonly<Partial<Record<'frame' | 'swingarm' | 'downTubeBand' | 'topTubeBand' | 'accent' | 'forkLower' | 'forkCrown' | 'rimStripe' | 'hub' | 'saddle' | 'saddleAccent' | 'grip' | 'chainring' | 'pedal' | 'spring', string>>>;

export interface CharacterDef {
  id: CharacterId;
  name: string;
  tagline: string;
  /** CSS colour used for UI accents on the select screen. */
  accent: string;
  /** Stays seated while coasting downhill (like the video's rider) instead of standing in the attack position. */
  ridesSeated?: boolean;
  /** Warm up expensive assets in the background; `createRider` works without it (just slower the first time). */
  preload?(): Promise<void>;
  createBike(paint?: BikePaint): BikeVisual;
  createRider(colors?: RiderColors): RiderRig;
}

/** The character in a shop outfit, on a painted bike (either may be absent: the character's own look). */
export function dressed(def: CharacterDef, colors?: RiderColors, paint?: BikePaint): CharacterDef {
  if (!colors && !paint) return def;
  return { ...def, createRider: () => def.createRider(colors), createBike: () => def.createBike(paint) };
}

export function defaultTrickPose(): TrickPose {
  return { superman: 0, noHander: 0, canCan: 0, tailwhip: 0, barspin: 0, tabletop: 0 };
}

export function defaultRiderPose(): RiderPose {
  return {
    time: 0,
    speed: 0,
    seated: 1,
    lean: 0,
    steer: 0,
    compress: 0,
    airborne: false,
    crashed: false,
    tricks: defaultTrickPose(),
    celebrate: 0,
  };
}
