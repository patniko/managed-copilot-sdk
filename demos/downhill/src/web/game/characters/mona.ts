import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { glossMaterial, paintMaterial } from '../../render/globals';
import { BIKE, type BikeAnchors, type RiderColors, type RiderPose, type RiderRig } from '../rider/types';
import { RideDynamics } from './dynamics';
import { blend } from './humanoid';
import { TentacleBundle } from './tentacles';
import { clamp, clamp01, ellipsoid, enableShadows, lerp, merge, outfit, place, repaint, smooth01, tint, tube, v3, wobble, type Outfit } from './util';

export const MONA_COLORS = {
  body: '#353c46',
  bodyLight: '#47505c',
  face: '#f6c7b6',
  earInner: '#f2a0b4',
  nose: '#e8879c',
  eye: '#1f1b1d',
  whisker: '#3a3f47',
} as const;
const C = MONA_COLORS;

/* ------------------------------------------------------------------ head shape */

const HR = { x: 0.285, y: 0.232, z: 0.262 };

/** Octocat head: wide, slightly flattened on top, chubby cheeks. Input is a unit direction. */
function headPoint(dx: number, dy: number, dz: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
  const low = smooth01((0.3 - dy) / 1.1);
  const wx = 1 + 0.07 * low;
  const top = dy > 0 ? 1 - 0.08 * dy * dy : 1;
  return out.set(dx * HR.x * wx * lift, dy * HR.y * top * lift, dz * HR.z * (1 + 0.03 * low) * lift);
}

const DEG = Math.PI / 180;
function dirAzEl(azDeg: number, elDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const az = azDeg * DEG;
  const el = elDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

/** Surface point + outward normal (numerical) at az/el (degrees). */
function surface(azDeg: number, elDeg: number, lift: number, outP: THREE.Vector3, outN: THREE.Vector3): void {
  const d = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  dirAzEl(azDeg, elDeg, d);
  headPoint(d.x, d.y, d.z, lift, outP);
  dirAzEl(azDeg + 0.5, elDeg, d);
  headPoint(d.x, d.y, d.z, lift, a).sub(outP);
  dirAzEl(azDeg, elDeg + 0.5, d);
  headPoint(d.x, d.y, d.z, lift, b).sub(outP);
  outN.crossVectors(b, a).normalize();
  if (outN.dot(outP) < 0) outN.negate();
}

function surfaceFrame(n: THREE.Vector3): THREE.Quaternion {
  const up = v3(0, 1, 0).addScaledVector(n, -n.y).normalize();
  const x = new THREE.Vector3().crossVectors(up, n);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, n));
}

/* ------------------------------------------------------------------ face texture */

const FACE = { az0: -80, az1: 80, elTop: 35, elBot: -75 };

function faceTexture(): THREE.Texture {
  const W = 1024;
  const H = 704;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (!g) return tex;
  const sx = W / (FACE.az1 - FACE.az0);
  const sy = H / (FACE.elTop - FACE.elBot);
  const X = (az: number) => (az - FACE.az0) * sx;
  const Y = (el: number) => (FACE.elTop - el) * sy;
  g.clearRect(0, 0, W, H);
  g.fillStyle = C.face;
  g.beginPath();
  g.ellipse(X(0), Y(-25), 61 * sx, 41 * sy, 0, 0, Math.PI * 2);
  g.fill();
  for (const s of [-1, 1]) {
    g.beginPath();
    g.ellipse(X(s * 26), Y(1), 25 * sx, 25 * sy, 0, 0, Math.PI * 2);
    g.fill();
  }
  // soft blush
  for (const s of [-1, 1]) {
    const grd = g.createRadialGradient(X(s * 43), Y(-28), 0, X(s * 43), Y(-28), 10 * sx);
    grd.addColorStop(0, 'rgba(240,140,150,0.55)');
    grd.addColorStop(1, 'rgba(240,140,150,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(X(s * 43), Y(-28), 10 * sx, 7 * sy, 0, 0, Math.PI * 2);
    g.fill();
  }
  // little mouth
  g.strokeStyle = '#8a4b47';
  g.lineCap = 'round';
  g.lineWidth = 1.1 * sx;
  g.beginPath();
  g.moveTo(X(0), Y(-19));
  g.lineTo(X(0), Y(-24));
  g.moveTo(X(-6), Y(-23.5));
  g.quadraticCurveTo(X(-3), Y(-28), X(0), Y(-24));
  g.quadraticCurveTo(X(3), Y(-28), X(6), Y(-23.5));
  g.stroke();
  // whisker roots on the cheeks (continued in 3D past the silhouette)
  g.strokeStyle = '#4a3a3a';
  g.lineWidth = 0.9 * sx;
  for (const s of [-1, 1]) {
    for (const k of [-1, 0, 1]) {
      g.beginPath();
      g.moveTo(X(s * 40), Y(-21 + k * 5));
      g.lineTo(X(s * 60), Y(-18 + k * 8));
      g.stroke();
    }
  }
  tex.needsUpdate = true;
  return tex;
}

function facePatch(): THREE.BufferGeometry {
  const segU = 40;
  const segV = 28;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let j = 0; j <= segV; j++) {
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      const v = j / segV;
      const az = lerp(FACE.az0, FACE.az1, u);
      const el = lerp(FACE.elBot, FACE.elTop, v);
      dirAzEl(az, el, d);
      headPoint(d.x, d.y, d.z, 1.007, p);
      pos.push(p.x, p.y, p.z);
      uv.push(u, v);
    }
  }
  const row = segU + 1;
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * row + i;
      idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function headGeometry(): THREE.BufferGeometry {
  let sphere: THREE.BufferGeometry = new THREE.SphereGeometry(1, 48, 34);
  sphere.deleteAttribute('uv');
  sphere.deleteAttribute('normal');
  sphere = mergeVertices(sphere);
  const pos = sphere.getAttribute('position');
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    headPoint(pos.getX(i), pos.getY(i), pos.getZ(i), 1, p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  sphere.computeVertexNormals();
  tint(sphere, C.body);
  const parts: THREE.BufferGeometry[] = [sphere];
  // soft "skirt" under the head where the tentacles gather
  parts.push(ellipsoid(0.17, 0.09, 0.16, v3(0, -0.175, 0.02), C.body, 20, 10));

  // ears: flattened cones leaning outwards
  for (const s of [-1, 1]) {
    const base = new THREE.Vector3();
    const n = new THREE.Vector3();
    surface(s * 50, 48, 0.94, base, n);
    const rot = new THREE.Euler(-0.12, 0, -s * 0.42, 'XYZ');
    const outer = new THREE.ConeGeometry(0.112, 0.175, 16, 1);
    outer.translate(0, 0.0875, 0);
    outer.scale(1, 1, 0.48);
    place(outer, base, rot);
    parts.push(tint(outer, C.body));
    const inner = new THREE.ConeGeometry(0.07, 0.12, 12, 1);
    inner.scale(1, 1, 0.42);
    inner.translate(0, 0.07, -0.034);
    place(inner, base, rot);
    parts.push(tint(inner, C.earInner));
  }
  // nose
  {
    const p0 = new THREE.Vector3();
    const n = new THREE.Vector3();
    surface(0, -13, 1.0, p0, n);
    parts.push(place(ellipsoid(0.03, 0.019, 0.018, v3(), C.nose, 12, 8), p0.addScaledVector(n, 0.004), surfaceFrame(n)));
  }
  // whiskers poking out past the silhouette
  for (const s of [-1, 1]) {
    for (const k of [-1, 0, 1]) {
      const p0 = new THREE.Vector3();
      const n = new THREE.Vector3();
      surface(s * 58, -19 + k * 6, 1.0, p0, n);
      const dir = v3(s, 0.16 * k, -0.28).normalize();
      parts.push(tube(p0, p0.clone().addScaledVector(dir, 0.17), 0.0055, 0.0032, C.whisker, 5));
    }
  }
  return merge(parts);
}

/** Eyes (+ glints) built around the eyes' midpoint so the group can blink via scale.y. */
function eyeGeometries(): { eyes: THREE.BufferGeometry; glints: THREE.BufferGeometry; center: THREE.Vector3 } {
  const eyes: THREE.BufferGeometry[] = [];
  const glints: THREE.BufferGeometry[] = [];
  const pts: THREE.Vector3[] = [];
  const ns: THREE.Vector3[] = [];
  for (const s of [-1, 1]) {
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    surface(s * 27, 1, 1.0, p, n);
    pts.push(p);
    ns.push(n);
  }
  const center = pts[0].clone().add(pts[1]).multiplyScalar(0.5);
  for (let i = 0; i < 2; i++) {
    const q = surfaceFrame(ns[i]);
    const p = pts[i].clone().sub(center);
    eyes.push(place(ellipsoid(0.056, 0.073, 0.03, v3(), C.eye, 18, 14), p, q));
    const g1 = ellipsoid(0.017, 0.02, 0.008, v3(0.02, 0.028, 0.027), '#ffffff', 10, 8);
    const g2 = ellipsoid(0.008, 0.009, 0.006, v3(-0.018, -0.03, 0.025), '#ffffff', 8, 6);
    glints.push(place(g1, p, q), place(g2, p, q));
  }
  return { eyes: merge(eyes), glints: merge(glints), center };
}

/* ------------------------------------------------------------------ rig */

interface Weights {
  seated: number;
  compress: number;
  lean: number;
  steer: number;
  air: number;
  crash: number;
  celebrate: number;
  superman: number;
  noHander: number;
  canCan: number;
  tailwhip: number;
  barspin: number;
  tabletop: number;
}

const TRICK_KEYS = ['superman', 'noHander', 'canCan', 'tailwhip', 'barspin', 'tabletop'] as const;

/** Tentacle roots in head space (head centre = origin, facing -Z). */
const ROOTS = [
  { p: v3(-0.12, -0.15, -0.1), d: v3(-0.3, -0.8, -0.5).normalize(), r: 0.05 }, // grip L
  { p: v3(0.12, -0.15, -0.1), d: v3(0.3, -0.8, -0.5).normalize(), r: 0.05 }, // grip R
  { p: v3(-0.12, -0.16, 0.06), d: v3(-0.55, -0.8, 0.1).normalize(), r: 0.054 }, // pedal L
  { p: v3(0.12, -0.16, 0.06), d: v3(0.55, -0.8, 0.1).normalize(), r: 0.054 }, // pedal R
  { p: v3(0.06, -0.14, 0.14), d: v3(0.5, -0.65, 0.57).normalize(), r: 0.052 }, // tail
];
const SEGS = 32;
const BEZ = 23;
const TIP_R = 0.011;

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _d0 = new THREE.Vector3();
const _c = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _side = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

class MonaRig implements RiderRig {
  readonly root = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly eyes = new THREE.Group();
  private readonly tent: TentacleBundle;
  private readonly hc = new THREE.Vector3();
  private readonly saddleRef = new THREE.Vector3();
  private readonly free = new THREE.Vector3();
  private readonly gripAxis = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private primed = false;
  /** Body bounce on the tentacles over bumps and landings (shared rider suspension model). */
  private readonly dyn = new RideDynamics();
  private readonly w: Weights = {
    seated: 1,
    compress: 0,
    lean: 0,
    steer: 0,
    air: 0,
    crash: 0,
    celebrate: 0,
    superman: 0,
    noHander: 0,
    canCan: 0,
    tailwhip: 0,
    barspin: 0,
    tabletop: 0,
  };

  constructor(colors?: RiderColors) {
    this.root.name = 'rider-mona';
    const look = outfit(MONA_COLORS, colors);
    const bodyMat = (_bodyMat ??= glossMaterial(0xffffff, 0.5, 0.0, { vertexColors: true }));
    const faceMat = (_faceMat ??= paintMaterial({ map: faceTexture(), alphaTest: 0.5 }));
    const eyeMat = (_eyeMat ??= glossMaterial(C.eye, 0.1, 0.0));
    const glintMat = (_glintMat ??= paintMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.9 }));

    const headMesh = new THREE.Mesh(monaHead(look), bodyMat);
    headMesh.name = 'head';
    const face = new THREE.Mesh(monaGeometries().face, faceMat);
    face.name = 'face';
    const eg = monaGeometries().eyes;
    this.eyes.position.copy(eg.center);
    this.eyes.add(new THREE.Mesh(eg.eyes, eyeMat), new THREE.Mesh(eg.glints, glintMat));
    this.head.add(headMesh, face, this.eyes);

    this.tent = new TentacleBundle(ROOTS.length, SEGS, 10, bodyMat, look.palette.body, look.palette.bodyLight);
    this.tent.mesh.name = 'tentacles';
    for (let i = 0; i < ROOTS.length; i++) {
      const r = this.tent.radii[i];
      for (let k = 0; k <= SEGS; k++) {
        const s = k / SEGS;
        r[k] = TIP_R + (ROOTS[i].r - TIP_R) * Math.pow(1 - s, 1.5);
      }
    }
    this.root.add(this.head, this.tent.mesh);
    enableShadows(this.root);
  }

  /** Writes one tentacle: cubic bezier root -> curl start, then a helix curl. */
  private shape(
    i: number,
    P0: THREE.Vector3,
    D0: THREE.Vector3,
    C0: THREE.Vector3,
    up: THREE.Vector3,
    fwd: THREE.Vector3,
    axis: THREE.Vector3,
    rc: number,
    alphaEnd: number,
    advance: number,
    wave: number,
    time: number,
  ): void {
    const pts = this.tent.points[i];
    _p3.copy(C0).addScaledVector(up, rc);
    const len = P0.distanceTo(_p3);
    _p1.copy(P0).addScaledVector(D0, len * 0.4);
    _p2.copy(_p3).addScaledVector(fwd, -len * 0.3).addScaledVector(up, len * 0.16);
    // a sideways direction for the travelling wave
    _side.subVectors(_p3, P0).cross(up);
    if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0);
    _side.normalize();
    for (let k = 0; k < BEZ; k++) {
      const u = k / (BEZ - 1);
      const a = (1 - u) * (1 - u) * (1 - u);
      const b = 3 * u * (1 - u) * (1 - u);
      const c = 3 * u * u * (1 - u);
      const d = u * u * u;
      const wv = Math.sin(time * 3.1 - u * 7 + i * 1.7) * Math.sin(Math.PI * u) * wave;
      pts[k * 3] = P0.x * a + _p1.x * b + _p2.x * c + _p3.x * d + _side.x * wv;
      pts[k * 3 + 1] = P0.y * a + _p1.y * b + _p2.y * c + _p3.y * d + _side.y * wv;
      pts[k * 3 + 2] = P0.z * a + _p1.z * b + _p2.z * c + _p3.z * d + _side.z * wv;
    }
    const n = SEGS + 1 - BEZ;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const al = alphaEnd * f;
      const r = rc * (1 - 0.35 * f);
      const ca = Math.cos(al) * r;
      const sa = Math.sin(al) * r;
      const adv = advance * f;
      const o = (BEZ - 1 + k) * 3;
      pts[o] = C0.x + up.x * ca + fwd.x * sa + axis.x * adv;
      pts[o + 1] = C0.y + up.y * ca + fwd.y * sa + axis.y * adv;
      pts[o + 2] = C0.z + up.z * ca + fwd.z * sa + axis.z * adv;
    }
  }

  update(pose: RiderPose, anchors: BikeAnchors, dt: number): void {
    const w = this.w;
    const t = pose.time || 0;
    const tr = pose.tricks;
    const snap = !this.primed;
    w.seated = blend(snap, w.seated, clamp01(pose.seated), 7, dt);
    w.compress = blend(snap, w.compress, clamp01(pose.compress), 14, dt);
    w.lean = blend(snap, w.lean, clamp(pose.lean || 0, -1.2, 1.2), 10, dt);
    w.steer = blend(snap, w.steer, clamp(pose.steer || 0, -1, 1), 8, dt);
    w.air = blend(snap, w.air, pose.airborne ? 1 : 0, 6, dt);
    w.crash = blend(snap, w.crash, pose.crashed ? 1 : 0, 5, dt);
    w.celebrate = blend(snap, w.celebrate, clamp01(pose.celebrate || 0), 9, dt);
    for (const key of TRICK_KEYS) w[key] = blend(snap, w[key], clamp01(tr ? tr[key] : 0), 12, dt);
    this.primed = true;

    const seated = smooth01(w.seated);
    const att = 1 - seated;
    const comp = w.compress;
    const sup = smooth01(w.superman);
    const nh = smooth01(w.noHander);
    const cc = smooth01(w.canCan);
    const tw = smooth01(w.tailwhip);
    const bs = smooth01(w.barspin);
    const tt = smooth01(w.tabletop);
    const crash = smooth01(w.crash);
    const cel = smooth01(w.celebrate) * (1 - crash);

    const pL = anchors.pedalL;
    const pR = anchors.pedalR;
    const crank = Math.atan2(-(pR.y - pL.y) * 0.5, -(pR.z - pL.z) * 0.5);

    /* ---------------- head placement */
    this.saddleRef.copy(anchors.saddle).lerp(BIKE.saddle, tw);
    const hc = this.hc;
    hc.copy(this.saddleRef);
    hc.x += w.lean * 0.1 + cc * 0.06;
    hc.y += lerp(0.33, 0.4, seated) + Math.sin(crank * 2) * 0.012 * seated + Math.sin(t * 2.3) * 0.006;
    hc.z += lerp(-0.22, -0.05, seated);
    hc.y -= comp * 0.12 + w.air * 0.03 * att;
    hc.y += sup * 0.1 + nh * 0.1 + cc * 0.06 + tw * 0.15 + bs * 0.05 + tt * 0.04 + cel * 0.04;
    hc.z += sup * -0.16 + nh * 0.04;
    const parent = this.root.parent;
    if (parent) parent.updateWorldMatrix(true, false);
    const dyn = this.dyn;
    dyn.update(dt, parent ? parent.matrixWorld : null, pose.velocity, pose.roughness ?? 0, pose.speed || 0, !pose.airborne, pose.crashed ? 0 : 1);
    hc.add(dyn.offset);
    let pitch = lerp(0.3, 0.12, seated) + comp * 0.1 + sup * 0.3 + tt * 0.5 - cel * 0.3 - nh * 0.1 + dyn.pitch * 0.6;
    let yaw = -w.steer * 0.32 + tt * 0.45 - cc * 0.2 + Math.sin(t * 0.41) * 0.04;
    // tabletop: the game rolls the bike (assumed to the right); keep the head upright-ish
    let roll = w.lean * 0.5 + cc * 0.15 - tt * 0.7 + Math.sin(t * 0.9) * 0.02 * seated + dyn.roll;
    if (crash > 0.001) {
      hc.lerp(_tmp.set(0, 1.08, 0.3), crash);
      pitch = lerp(pitch, 0.6 * wobble(t * 1.1, 1), crash);
      yaw = lerp(yaw, 0.9 * wobble(t * 0.8, 2), crash);
      roll = lerp(roll, 0.8 * wobble(t * 0.9, 3), crash);
    }
    this.head.position.copy(hc);
    _e.set(-pitch, yaw, -roll, 'YXZ');
    this.head.quaternion.setFromEuler(_e);
    // squash & stretch on landings
    // squash & stretch on landings, plus a soft jelly wobble from the bounce velocity (volume preserving)
    const jig = clamp(dyn.velocity.y * 0.09, -0.07, 0.07);
    const sq = (1 - comp * 0.06) * (1 + jig);
    const wide = (1 + comp * 0.04) / Math.sqrt(1 + jig);
    this.head.scale.set(wide, sq, wide);

    // blink every ~4.3 s
    const ph = t % 4.3;
    this.eyes.scale.y = 0.1 + 0.9 * clamp01(Math.abs(ph - 0.15) / 0.07);

    /* ---------------- tentacles */
    const q = this.head.quaternion;
    this.gripAxis.subVectors(anchors.gripR, anchors.gripL);
    if (this.gripAxis.lengthSq() < 1e-6) this.gripAxis.set(1, 0, 0);
    this.gripAxis.normalize();
    _up.set(0, 1, 0);
    this.fwd.crossVectors(_up, this.gripAxis).normalize();

    for (let i = 0; i < ROOTS.length; i++) {
      const R = ROOTS[i];
      const sg = i % 2 === 0 ? -1 : 1;
      _p0.copy(R.p).applyQuaternion(q).add(hc);
      _d0.copy(R.d).applyQuaternion(q);
      _up.set(0, 1, 0);
      if (i < 2) {
        /* grips */
        const grip = i === 0 ? anchors.gripL : anchors.gripR;
        let freeW = Math.max(nh, bs, crash);
        _c.copy(grip);
        if (bs > 0.001) {
          this.free.set(sg * BIKE.gripOffset * 1.2, BIKE.bar.y + 0.05 + Math.sin(t * 6 + i) * 0.02, BIKE.bar.z + 0.02);
          _c.lerp(this.free, bs);
        }
        if (nh > 0.001) {
          this.free.set(sg * (0.46 + Math.sin(t * 4 + i * 2) * 0.05), 0.12 + Math.sin(t * 5.3 + i * 1.3) * 0.08, -0.06).add(hc);
          _c.lerp(this.free, nh);
        }
        if (i === 1 && cel > 0.001) {
          // happy wave out to the side
          this.free.set(0.48 + Math.sin(t * 9) * 0.07, 0.3 + Math.sin(t * 12) * 0.05, -0.02).add(hc);
          _c.lerp(this.free, cel);
          freeW = Math.max(freeW, cel);
        }
        if (crash > 0.001) {
          _tmp.set(sg * 0.8, 0.2 + 0.5 * wobble(t * 1.2, 10 + i), -0.4 + 0.4 * wobble(t, 12 + i)).normalize();
          this.free.copy(hc).addScaledVector(_tmp, 0.62);
          _c.lerp(this.free, crash);
        }
        _ax.copy(this.gripAxis).multiplyScalar(sg);
        _fw.copy(this.fwd);
        const rc = lerp(0.031, 0.05, freeW);
        const alphaEnd = lerp(Math.PI * 1.75, Math.PI * 1.1, freeW);
        this.shape(i, _p0, _d0, _c, _up, _fw, _ax, rc, alphaEnd, lerp(0.035, 0.0, freeW), lerp(0.008, 0.035, freeW), t);
      } else if (i < 4) {
        /* pedals */
        const pedal = i === 2 ? pL : pR;
        const off = Math.max(sup, tw, crash, i === 2 ? cc : 0);
        _c.copy(pedal);
        if (sup > 0.001) {
          this.free.set(sg * 0.13, -0.3 + Math.sin(t * 3 + i) * 0.03, 0.95).add(hc);
          _c.lerp(this.free, sup);
        }
        if (tw > 0.001) {
          this.free.set(sg * 0.42, -0.42 + Math.sin(t * 4 + i) * 0.03, 0.02).add(hc);
          _c.lerp(this.free, tw);
        }
        if (i === 2 && cc > 0.001) {
          // swing over the top tube to the other side
          const u = cc;
          const a = (1 - u) * (1 - u);
          const b = 2 * u * (1 - u);
          const c = u * u;
          _c.set(_c.x * a + 0.05 * b + 0.6 * c, _c.y * a + 1.2 * b + 0.82 * c, _c.z * a + 0.0 * b - 0.12 * c);
        }
        if (crash > 0.001) {
          _tmp.set(sg * 0.6, -0.7 + 0.4 * wobble(t * 1.1, 20 + i), 0.5 * wobble(t * 0.9, 22 + i)).normalize();
          this.free.copy(hc).addScaledVector(_tmp, 0.7);
          _c.lerp(this.free, crash);
        }
        _ax.set(sg, 0, 0);
        _fw.set(0, 0, -1);
        const rc = lerp(0.043, 0.05, off);
        const alphaEnd = lerp(Math.PI * 1.35, Math.PI * 1.1, off);
        this.shape(i, _p0, _d0, _c, _up, _fw, _ax, rc, alphaEnd, lerp(0.02, 0, off), lerp(0.006, 0.03, off), t);
      } else {
        /* tail: swishes out behind & to the side like a cat's, tip curling up; wags slowly */
        const wag = Math.sin(t * 2.2) * (1 - crash);
        _c.copy(hc).add(_tmp.set(0.3 + wag * 0.09, -0.2 + Math.sin(t * 1.7) * 0.03 - w.air * 0.04, 0.4 + w.air * 0.05));
        _c.addScaledVector(_tmp.set(-0.25, 0.05, 0.3), sup);
        if (crash > 0.001) {
          _tmp.set(0.5 * wobble(t, 30), 0.4 * wobble(t * 1.3, 31), 0.8).normalize();
          this.free.copy(hc).addScaledVector(_tmp, 0.6);
          _c.lerp(this.free, crash);
        }
        // curl plane: tip rises then hooks back towards the bike's centre line
        _up.set(-0.55, 0, 0.84);
        _fw.set(0.15 * wag, 1, 0).normalize();
        _ax.set(0, 0, 1);
        this.shape(i, _p0, _d0, _c, _up, _fw, _ax, 0.06, Math.PI * 1.35, 0, 0.045, t);
      }
    }
    this.tent.rebuild();
  }
}

let _bodyMat: THREE.MeshStandardMaterial | null = null;
let _faceMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshStandardMaterial | null = null;
let _glintMat: THREE.MeshLambertMaterial | null = null;
let _geo: { head: THREE.BufferGeometry; face: THREE.BufferGeometry; eyes: ReturnType<typeof eyeGeometries> } | null = null;
/** Static head geometry, built once and shared by every Mona instance (tentacles are per instance). */
function monaGeometries(): NonNullable<typeof _geo> {
  return (_geo ??= { head: headGeometry(), face: facePatch(), eyes: eyeGeometries() });
}

const _heads = new Map<string, THREE.BufferGeometry>();
/** The head in an outfit's colours, built once per outfit. */
function monaHead(look: Outfit<keyof typeof MONA_COLORS>): THREE.BufferGeometry {
  const base = monaGeometries().head;
  if (!look.key) return base;
  let head = _heads.get(look.key);
  if (!head) _heads.set(look.key, (head = repaint(base, look.swap)));
  return head;
}

/** GitHub's Octocat: a cat head riding with five tentacles, in her own colours or a shop outfit's. */
export function createMonaRider(colors?: RiderColors): RiderRig {
  return new MonaRig(colors);
}
