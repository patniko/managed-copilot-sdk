import * as THREE from 'three';
import { EMOTE_LENGTH, type EmoteKind, type EmotePose, type JumpPose } from '../rider/types';
import { clamp01, damp, lerp, smooth01 } from './util';

/**
 * Shared choreography for the riders' emotes: each one is a short procedural clip that says where the hands go, how the
 * body and head move, and what the face does. Rigs turn a frame of it into their own motion (humanoid arms, Mona's
 * tentacles), so every character performs the same celebrations in its own body.
 */

/** How a character's body performs emotes. */
export interface EmoteStyle {
  /** Raised arms swing this much further out to the side, so they clear a big head. */
  splay: number;
  /** Head centre in the head's own frame, and its radius (m): salutes and brow wipes go to the face. */
  headCenter: THREE.Vector3;
  headRadius: number;
}

/** A hand's part in an emote. */
export interface EmoteHand {
  /** 0..1 off the grip, at the emote's target. */
  w: number;
  /**
   * Where the hand goes. From the shoulder: a direction in the bike frame (+x right, +y up, +z back) and a distance in
   * arm lengths. From the head (`head` = 1): a direction in the head's frame (-z = the face) and a distance in head radii.
   */
  dir: THREE.Vector3;
  ext: number;
  head: number;
  /** Elbow pole hint (bike frame), and its weight while the hand still grips the bar (elbows flared for balance). */
  elbow: THREE.Vector3;
  elbowW: number;
}

/** Expression weights, 0..1. */
export interface Face {
  /** Happy: closed, smiling eyes. */
  joy: number;
  /** Wide eyes. */
  surprise: number;
  /** Effort: narrowed eyes. */
  strain: number;
  /** Phew: eyes closed, content. */
  relief: number;
  /** Knocked silly (crashes). */
  dizzy: number;
  /** Mouth open (a whoop, a shout, a gasp). */
  mouth: number;
}

export interface EmoteFrame {
  /** Overall weight of the emote this frame (its envelope, faded). */
  w: number;
  hands: [EmoteHand, EmoteHand];
  /** Additive torso pitch (+ forward), yaw (+ left) and roll (+ right), rad; pelvis lift (standing up), m. */
  pitch: number;
  yaw: number;
  roll: number;
  lift: number;
  /** Additive head pitch (+ down), yaw (+ left) and roll (+ right), rad. */
  headPitch: number;
  headYaw: number;
  headRoll: number;
  face: Face;
}

export function neutralFace(): Face {
  return { joy: 0, surprise: 0, strain: 0, relief: 0, dizzy: 0, mouth: 0 };
}

function hand(): EmoteHand {
  return { w: 0, dir: new THREE.Vector3(), ext: 0, head: 0, elbow: new THREE.Vector3(), elbowW: 0 };
}

export function emoteFrame(): EmoteFrame {
  return { w: 0, hands: [hand(), hand()], pitch: 0, yaw: 0, roll: 0, lift: 0, headPitch: 0, headYaw: 0, headRoll: 0, face: neutralFace() };
}

function clear(f: EmoteFrame): void {
  f.w = f.pitch = f.yaw = f.roll = f.lift = f.headPitch = f.headYaw = f.headRoll = 0;
  for (const h of f.hands) {
    h.w = h.ext = h.head = h.elbowW = 0;
    h.dir.set(0, 1, 0);
    h.elbow.set(0, -1, 0);
  }
  Object.assign(f.face, neutralFace());
}

/* ------------------------------------------------------------------ curves */

const TAU = Math.PI * 2;
const _v = new THREE.Vector3();
/** 0 -> 1 between a and b. */
const ramp = (t: number, a: number, b: number) => smooth01((t - a) / (b - a));
/** Fades in over [start, start + rise], holds, and fades out over [end - fall, end]. */
const span = (t: number, start: number, rise: number, end: number, fall: number) => ramp(t, start, start + rise) * (1 - ramp(t, end - fall, end));
/** A beat that rises over `rise` to peak at `at`, then falls back over `fall`. */
function beat(t: number, at: number, rise: number, fall: number): number {
  return t <= at ? ramp(t, at - rise, at) : 1 - ramp(t, at, at + fall);
}

/* ------------------------------------------------------------------ clips */

type Clip = (t: number, k: number, s: EmoteStyle, f: EmoteFrame) => void;

const CLIPS: Record<EmoteKind, Clip> = {
  /** Fist pump: the right fist punches the sky three times, chin up, shouting. */
  pump(t, k, s, f) {
    const w = span(t, 0, 0.22, EMOTE_LENGTH.pump, 0.32);
    const up = Math.max(beat(t, 0.42, 0.1, 0.22), beat(t, 0.78, 0.1, 0.22), beat(t, 1.12, 0.1, 0.24));
    const h = f.hands[1];
    h.w = w;
    h.dir.set(0.3 + s.splay, lerp(0.3, 1, up), lerp(0.1, -0.05, up));
    h.ext = lerp(0.5, 0.98, up);
    h.elbow.set(1, -0.55, 0.35);
    f.w = w;
    f.pitch = -0.3 * k * w;
    f.roll = 0.05 * w;
    f.lift = 0.04 * k * w;
    f.headPitch = (-0.08 - 0.12 * up) * w;
    f.face.joy = w;
    f.face.mouth = w * (0.3 + 0.7 * up);
  },
  /** Both arms up in a V, standing tall on the pedals, fists shaking. */
  victory(t, k, s, f) {
    const L = EMOTE_LENGTH.victory;
    const shake = Math.sin(t * TAU * 3.5) * span(t, 0.4, 0.15, 1.4, 0.15);
    for (let i = 0; i < 2; i++) {
      const sg = i === 0 ? -1 : 1;
      // the left hand follows the right a beat later
      const lag = i === 0 ? 0.07 : 0;
      const h = f.hands[i];
      h.w = span(t - lag, 0, 0.3, L - 0.07, 0.4);
      h.dir.set(sg * (0.42 + s.splay), 1, 0.12);
      h.ext = 0.95 + 0.03 * shake;
      h.elbow.set(sg, -0.35, 0.3);
    }
    const w = span(t, 0, 0.3, L, 0.4);
    const sway = Math.sin(t * TAU * 1.1);
    f.w = w;
    f.pitch = -0.55 * k * w;
    f.lift = 0.08 * k * w;
    f.roll = 0.05 * sway * w;
    f.headPitch = -0.3 * w;
    f.headRoll = 0.07 * Math.sin(t * TAU * 1.1 + 0.6) * w;
    f.face.joy = w;
    f.face.mouth = w * (0.75 + 0.25 * Math.abs(shake));
  },
  /** Points to the sky and follows it with a look. */
  point(t, k, s, f) {
    const w = span(t, 0, 0.28, EMOTE_LENGTH.point, 0.38);
    const jab = beat(t, 0.55, 0.08, 0.2);
    const h = f.hands[1];
    h.w = w;
    h.dir.set(0.12 + s.splay * 0.6, 1, -0.5);
    h.ext = 0.93 + 0.06 * jab;
    h.elbow.set(1, -0.2, 0.5);
    f.w = w;
    f.pitch = -0.32 * k * w;
    f.lift = 0.03 * k * w;
    f.roll = -0.04 * w;
    f.headPitch = -0.42 * w;
    f.headYaw = -0.12 * w;
    f.face.joy = w;
    f.face.mouth = w * (0.25 + 0.5 * jab);
  },
  /** A big wave, looking round over the right shoulder. */
  wave(t, k, s, f) {
    const L = EMOTE_LENGTH.wave;
    const w = span(t, 0, 0.3, L, 0.35);
    const wag = Math.sin((t - 0.3) * TAU * 2.3) * span(t, 0.25, 0.15, L - 0.3, 0.15);
    const h = f.hands[1];
    h.w = w;
    h.dir.set(0.6 + s.splay + 0.32 * wag, 0.85, 0.02);
    h.ext = 0.72;
    h.elbow.set(1, -0.45, 0.1);
    f.w = w;
    f.pitch = -0.25 * k * w;
    f.roll = 0.04 * w;
    f.lift = 0.03 * k * w;
    f.headYaw = -0.5 * w;
    f.headPitch = -0.08 * w;
    f.headRoll = 0.1 * w;
    f.face.joy = w;
    f.face.mouth = 0.35 * w;
  },
  /** A crisp salute off the brow, flicked out to the side. */
  salute(t, k, _s, f) {
    const L = EMOTE_LENGTH.salute;
    const out = ramp(t, 0.55, 0.72);
    const w = ramp(t, 0, 0.2) * (1 - ramp(t, 0.85, L - 0.05));
    const h = f.hands[1];
    h.w = w;
    h.head = 1;
    h.dir.set(lerp(0.55, 1, out), lerp(0.55, 0.35, out), lerp(-0.75, -0.55, out));
    h.ext = lerp(1.15, 2.6, out);
    h.elbow.set(1, -0.1, 0.2);
    f.w = w;
    f.pitch = -0.28 * k * w;
    f.lift = 0.03 * k * w;
    f.headPitch = -0.12 * w;
    f.headRoll = -0.1 * w * (1 - out);
    f.face.joy = w;
    f.face.mouth = 0.2 * w * out;
  },
  /** A small, satisfied double nod. */
  nod(t, k, _s, f) {
    const n = beat(t, 0.16, 0.12, 0.16) + 0.7 * beat(t, 0.46, 0.1, 0.18);
    const w = span(t, 0, 0.1, EMOTE_LENGTH.nod, 0.2);
    f.w = w;
    f.headPitch = 0.3 * n * (0.6 + 0.4 * k);
    f.pitch = 0.04 * n;
    f.face.joy = 0.8 * w;
  },
  /** Whoa! Fighting for balance after a sketchy landing, then a wipe of the brow. */
  phew(t, k, _s, f) {
    const L = EMOTE_LENGTH.phew;
    const whoa = span(t, 0, 0.06, 0.85, 0.3);
    const sway = Math.sin(t * TAU * 3.1) * Math.exp(-t * 1.4) * whoa;
    const wipe = span(t, 0.62, 0.22, L - 0.08, 0.4);
    const across = ramp(t, 0.86, 1.18);
    const away = ramp(t, 1.18, 1.36);
    for (let i = 0; i < 2; i++) {
      const h = f.hands[i];
      h.elbow.set(i === 0 ? -1 : 1, -0.1, 0.25);
      h.elbowW = 0.8 * whoa;
    }
    const h = f.hands[1];
    h.w = wipe;
    h.head = 1;
    h.dir.set(lerp(lerp(-0.25, 0.55, across), 1.1, away), lerp(0.5, 0.25, away), lerp(-0.8, -0.2, away));
    h.ext = lerp(1.12, 2.2, away);
    if (wipe > 0) h.elbow.lerp(_v.set(1, -0.15, 0.1), wipe);
    f.w = Math.max(whoa, wipe);
    f.roll = 0.17 * k * sway;
    f.yaw = 0.08 * k * Math.sin(t * TAU * 2.3 + 0.8) * whoa;
    f.pitch = -0.15 * k * wipe;
    f.headRoll = -0.1 * k * sway;
    f.headPitch = 0.1 * wipe;
    f.headYaw = 0.12 * Math.sin(t * TAU * 2.2) * span(t, 1.3, 0.1, 1.75, 0.15);
    f.face.surprise = whoa;
    f.face.mouth = 0.65 * whoa;
    f.face.relief = span(t, 0.75, 0.2, L, 0.3);
  },
};

/** Evaluate `e` into `out` (a neutral frame when there's no emote). */
export function evalEmote(e: EmotePose | null, style: EmoteStyle, out: EmoteFrame): EmoteFrame {
  clear(out);
  if (!e || !(e.weight > 0)) return out;
  CLIPS[e.kind](Math.max(0, e.t), clamp01(e.strength), style, out);
  const k = clamp01(e.weight);
  if (k < 1) {
    out.w *= k;
    out.pitch *= k;
    out.yaw *= k;
    out.roll *= k;
    out.lift *= k;
    out.headPitch *= k;
    out.headYaw *= k;
    out.headRoll *= k;
    for (const h of out.hands) {
      h.w *= k;
      h.elbowW *= k;
    }
    const fc = out.face;
    fc.joy *= k;
    fc.surprise *= k;
    fc.strain *= k;
    fc.relief *= k;
    fc.mouth *= k;
  }
  return out;
}

/** The expression for this frame: the emote's, the effort and thrill of the jump, and a crash's daze. */
export function faceTarget(frame: EmoteFrame, jump: JumpPose, crash: number, out: Face): Face {
  const f = frame.face;
  const calm = 1 - crash;
  out.joy = Math.max(f.joy, jump.whoop) * calm;
  out.surprise = Math.max(f.surprise, jump.spot * 0.5) * calm;
  out.strain = Math.max(f.strain, jump.load * 0.9, jump.pop * 0.9, clamp01(jump.absorb) * 0.8) * calm;
  out.relief = f.relief * calm;
  out.dizzy = crash;
  out.mouth = Math.max(f.mouth * calm, jump.whoop * 0.9 * calm, crash * 0.7);
  return out;
}

/** A face that eases between expressions (the mouth moves quicker than the eyes). */
export class FaceState implements Face {
  joy = 0;
  surprise = 0;
  strain = 0;
  relief = 0;
  dizzy = 0;
  mouth = 0;
  private readonly target = neutralFace();

  update(frame: EmoteFrame, jump: JumpPose, crash: number, dt: number, snap: boolean): void {
    const t = faceTarget(frame, jump, crash, this.target);
    const ease = (cur: number, to: number, rate: number) => (snap ? to : damp(cur, to, rate, dt));
    this.joy = ease(this.joy, t.joy, 12);
    this.surprise = ease(this.surprise, t.surprise, 12);
    this.strain = ease(this.strain, t.strain, 14);
    this.relief = ease(this.relief, t.relief, 10);
    this.dizzy = ease(this.dizzy, t.dizzy, 8);
    this.mouth = ease(this.mouth, t.mouth, 22);
  }
}
