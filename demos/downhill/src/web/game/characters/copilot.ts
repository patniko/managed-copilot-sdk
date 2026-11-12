import * as THREE from 'three';
import { glossMaterial, paintMaterial } from '../../render/globals';
import type { RiderColors, RiderRig } from '../rider/types';
import { HumanoidRig, type HumanoidSpec } from './humanoid';
import { box, clamp01, ellipsoid, limb, merge, outfit, place, repaint, roundedSlab, tint, tube, v3, type Outfit } from './util';

export const COPILOT_COLORS = {
  shell: '#ecebf4',
  lilac: '#cfc6f2',
  purple: '#8957e5',
  purpleDeep: '#6e40c9',
  visor: '#0d1117',
  lens: '#7ec6ff',
  eye: '#e2fdff',
  eyeGlow: '#5ce8ff',
  joint: '#3b3552',
} as const;
const C = COPILOT_COLORS;

export const COPILOT_SPEC: HumanoidSpec = {
  hipHalf: 0.1,
  thigh: 0.4,
  shin: 0.4,
  ankleHeight: 0.165,
  ballForward: 0.075,
  torso: 0.34,
  shoulderHalf: 0.2,
  shoulderDrop: 0.075,
  upperArm: 0.27,
  forearm: 0.31,
  seatUp: 0.1,
  seatBack: -0.02,
  standUp: 0.12,
  standBack: 0.05,
  seatedPitch: 0.85,
  attackPitch: 1.0,
  reachMax: 0.95,
  reachMin: 0.68,
  attackReach: 0.87,
  celebrateHand: new THREE.Vector3(0.38, 0.4, -0.06),
};

/* --------------------------------------------------------------- head helpers */

const HEAD_C = v3(0, 0.29, 0);
const HEAD_R = v3(0.272, 0.255, 0.26);

/** Point on the helmet ellipsoid at azimuth (rad, + towards +X) / elevation, scaled by `lift`. */
function helmetPoint(az: number, el: number, lift: number, out = new THREE.Vector3()): THREE.Vector3 {
  const ce = Math.cos(el);
  return out.set(Math.sin(az) * ce * HEAD_R.x * lift, Math.sin(el) * HEAD_R.y * lift, -Math.cos(az) * ce * HEAD_R.z * lift).add(HEAD_C);
}

/** Orientation with local +Z along the helmet surface normal and +Y "up" along the surface. */
function helmetFrame(az: number, el: number): THREE.Quaternion {
  const ce = Math.cos(el);
  const n = v3(
    (Math.sin(az) * ce) / HEAD_R.x,
    Math.sin(el) / HEAD_R.y,
    (-Math.cos(az) * ce) / HEAD_R.z,
  ).normalize();
  const up = v3(0, 1, 0).addScaledVector(n, -n.y).normalize();
  const x = new THREE.Vector3().crossVectors(up, n);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, n));
}

/** Curved superellipse patch on the helmet (visor). */
function helmetPatch(
  az0: number,
  az1: number,
  el0: number,
  el1: number,
  exponent: number,
  lift: number,
  color: THREE.ColorRepresentation,
  segU = 22,
  segV = 16,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= segV; j++) {
    for (let i = 0; i <= segU; i++) {
      let u = (i / segU) * 2 - 1;
      let v = (j / segV) * 2 - 1;
      const r = Math.max(Math.abs(u), Math.abs(v));
      if (r > 1e-6) {
        const th = Math.atan2(v, u);
        const c = Math.abs(Math.cos(th));
        const s = Math.abs(Math.sin(th));
        const rse = Math.pow(Math.pow(c, exponent) + Math.pow(s, exponent), -1 / exponent);
        const rsq = 1 / Math.max(c, s);
        u *= rse / rsq;
        v *= rse / rsq;
      }
      helmetPoint(az0 + ((u + 1) / 2) * (az1 - az0), el0 + ((v + 1) / 2) * (el1 - el0), lift, p);
      pos.push(p.x, p.y, p.z);
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
  g.setIndex(idx);
  g.computeVertexNormals();
  return tint(g, color);
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function plate(w: number, h: number, r: number, depth: number, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(roundedRect(w, h, r), {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.4,
    bevelSize: Math.min(r * 0.5, 0.008),
    bevelSegments: 2,
    curveSegments: 5,
  });
  g.translate(0, 0, -depth / 2);
  return tint(g, color);
}

/* --------------------------------------------------------------- body parts */

function headParts(): { shell: THREE.BufferGeometry; glass: THREE.BufferGeometry; eyes: THREE.BufferGeometry; eyeCenter: THREE.Vector3 } {
  const shell: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  shell.push(tube(v3(0, -0.03, 0.01), v3(0, 0.08, 0.01), 0.056, 0.06, C.joint, 14));
  shell.push(ellipsoid(HEAD_R.x, HEAD_R.y, HEAD_R.z, HEAD_C, C.shell, 30, 22));
  // forehead strap (tilted ring) holding the goggles: the plane section of the helmet, slightly inflated
  {
    const tilt = 0.32;
    const h = 0.055;
    const d = h * Math.cos(tilt);
    const k = Math.sqrt(1 - (d / HEAD_R.y) ** 2) * 1.035;
    const strap = new THREE.TorusGeometry(1, 0.075, 6, 40);
    strap.rotateX(Math.PI / 2);
    strap.scale(HEAD_R.x * k, 0.27, HEAD_R.z * k);
    strap.rotateX(tilt);
    strap.translate(HEAD_C.x, HEAD_C.y + d * Math.cos(tilt), HEAD_C.z + d * Math.sin(tilt));
    shell.push(tint(strap, C.purple));
  }
  // goggles on the forehead
  for (const s of [-1, 1]) {
    const az = s * 0.37;
    const el = 0.5;
    const q = helmetFrame(az, el);
    const p = helmetPoint(az, el, 1.03);
    shell.push(place(plate(0.13, 0.092, 0.035, 0.03, '#f6f4fd'), p, q));
    const lens = plate(0.1, 0.066, 0.026, 0.02, C.lens);
    lens.translate(0, 0, 0.014);
    glass.push(place(lens, p, q));
  }
  shell.push(place(box(0.07, 0.022, 0.03, v3(), '#f6f4fd'), helmetPoint(0, 0.52, 1.04), helmetFrame(0, 0.52)));
  // ear pods (scaled with the helmet)
  const ex = HEAD_R.x / 0.25;
  const ey = HEAD_C.y - 0.015;
  for (const s of [-1, 1]) {
    shell.push(tube(v3(s * 0.205 * ex, ey, 0.015), v3(s * 0.262 * ex, ey, 0.015), 0.082 * ex, 0.078 * ex, C.shell, 20));
    shell.push(tube(v3(s * 0.258 * ex, ey, 0.015), v3(s * 0.276 * ex, ey, 0.015), 0.062 * ex, 0.055 * ex, C.purple, 20));
    shell.push(tube(v3(s * 0.272 * ex, ey, 0.015), v3(s * 0.28 * ex, ey, 0.015), 0.032 * ex, 0.028 * ex, C.lilac, 14));
  }
  // chin trim under the visor
  glass.push(helmetPatch(-0.98, 0.98, -0.66, 0.22, 4.2, 1.012, C.visor, 20, 14));

  // glowing pill eyes, built around their shared centre so they can blink (scale.y)
  const eyeCenter = helmetPoint(0, -0.2, 1.0);
  const eyes: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const az = s * 0.3;
    const el = -0.2;
    const q = helmetFrame(az, el);
    const cap = new THREE.CapsuleGeometry(0.029, 0.058, 4, 12);
    cap.scale(1, 1, 0.42);
    place(cap, helmetPoint(az, el, 1.035).sub(eyeCenter), q);
    eyes.push(tint(cap, C.eye));
  }
  return { shell: merge(shell), glass: merge(glass), eyes: merge(eyes), eyeCenter };
}

function torsoGeometry(): THREE.BufferGeometry {
  const prof: Array<[number, number]> = [
    [0, -0.07],
    [0.13, -0.05],
    [0.168, 0.02],
    [0.183, 0.11],
    [0.181, 0.2],
    [0.166, 0.27],
    [0.132, 0.32],
    [0.075, 0.35],
    [0, 0.362],
  ];
  const body = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y)), 24);
  body.scale(1, 1, 0.86);
  tint(body, C.shell);
  const parts: THREE.BufferGeometry[] = [body];
  parts.push(place(tint(new THREE.TorusGeometry(0.17, 0.026, 8, 30), C.purpleDeep), v3(0, 0.005, 0), new THREE.Euler(Math.PI / 2, 0, 0), v3(1, 0.86, 1)));
  // chest badge with a little light
  parts.push(ellipsoid(0.062, 0.05, 0.022, v3(0, 0.2, -0.148), C.purple, 14, 10));
  parts.push(ellipsoid(0.022, 0.016, 0.01, v3(0, 0.2, -0.168), '#9ef3ff', 8, 6));
  // shoulder joints
  for (const s of [-1, 1]) parts.push(ellipsoid(0.086, 0.086, 0.086, v3(s * 0.19, 0.265, 0), C.lilac, 16, 12));
  // small lilac service panel on the back (kept simple so it never reads as a face from the chase cam)
  parts.push(ellipsoid(0.1, 0.085, 0.03, v3(0, 0.215, 0.142), C.lilac, 14, 8, new THREE.Euler(-0.18, 0, 0)));
  return merge(parts);
}

function pelvisGeometry(): THREE.BufferGeometry {
  return merge([
    ellipsoid(0.16, 0.105, 0.13, v3(0, -0.015, 0.01), C.lilac, 18, 12),
    ellipsoid(0.07, 0.05, 0.03, v3(0, -0.02, -0.125), C.purpleDeep, 10, 8),
  ]);
}

function upperArmGeometry(len: number): THREE.BufferGeometry {
  return merge([
    limb(len, [[0, 0.068], [0.5, 0.064], [1, 0.06]], C.shell, 14),
    ellipsoid(0.075, 0.075, 0.075, v3(0, len, 0), C.lilac, 14, 10),
  ]);
}

function forearmGeometry(): THREE.BufferGeometry {
  return merge([
    limb(0.23, [[0, 0.06], [1, 0.056]], C.shell, 14),
    place(tint(new THREE.TorusGeometry(0.058, 0.018, 6, 18), C.purple), v3(0, 0.205, 0), new THREE.Euler(Math.PI / 2, 0, 0)),
  ]);
}

function mittenGeometry(): THREE.BufferGeometry {
  return merge([
    ellipsoid(0.064, 0.074, 0.062, v3(0, -0.004, 0), C.purpleDeep, 14, 10),
    ellipsoid(0.026, 0.036, 0.028, v3(0, -0.012, -0.056), C.purpleDeep, 8, 6),
  ]);
}

function thighGeometry(len: number): THREE.BufferGeometry {
  return merge([
    limb(len, [[0, 0.086], [0.5, 0.078], [1, 0.07]], C.shell, 14),
    ellipsoid(0.084, 0.084, 0.084, v3(0, len, 0), C.lilac, 14, 10),
  ]);
}

function shinGeometry(len: number): THREE.BufferGeometry {
  return limb(len, [[0, 0.068], [0.5, 0.066], [1, 0.062]], C.shell, 14);
}

function bootGeometry(ankle: number): THREE.BufferGeometry {
  return merge([
    tube(v3(0, -0.035, 0.005), v3(0, 0.035, 0.005), 0.078, 0.072, C.lilac, 16),
    ellipsoid(0.086, 0.086, 0.12, v3(0, -0.07, -0.025), C.purple, 16, 12),
    ellipsoid(0.08, 0.056, 0.09, v3(0, -0.1, -0.13), C.purple, 14, 10),
    ellipsoid(0.088, 0.02, 0.104, v3(0, -0.058, -0.03), C.purpleDeep, 14, 6),
    place(roundedSlab(0.15, 0.28, 0.042, 0.06, C.shell), v3(0, -ankle + 0.021, -0.06)),
  ]);
}

/* --------------------------------------------------------------- materials */

let _shellMat: THREE.MeshStandardMaterial | null = null;
let _glassMat: THREE.MeshStandardMaterial | null = null;
let _eyeMat: THREE.MeshLambertMaterial | null = null;

interface CopilotGeometries {
  head: ReturnType<typeof headParts>;
  pelvis: THREE.BufferGeometry;
  torso: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  forearm: THREE.BufferGeometry;
  mitten: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  boot: THREE.BufferGeometry;
}
let _geo: CopilotGeometries | null = null;
/** Built once, shared by every Copilot instance. */
function copilotGeometries(): CopilotGeometries {
  const S = COPILOT_SPEC;
  return (_geo ??= {
    head: headParts(),
    pelvis: pelvisGeometry(),
    torso: torsoGeometry(),
    upperArm: upperArmGeometry(S.upperArm),
    forearm: forearmGeometry(),
    mitten: mittenGeometry(),
    thigh: thighGeometry(S.thigh),
    shin: shinGeometry(S.shin),
    boot: bootGeometry(S.ankleHeight),
  });
}

const _looks = new Map<string, { geo: CopilotGeometries; eyeMat: THREE.MeshLambertMaterial }>();
/** The geometry and glowing eyes in an outfit's colours, built once per outfit. */
function copilotLook(look: Outfit<keyof typeof COPILOT_COLORS>): { geo: CopilotGeometries; eyeMat: THREE.MeshLambertMaterial } {
  const base = copilotGeometries();
  const baseEyes = (_eyeMat ??= paintMaterial({ color: '#0e3d48', emissive: C.eyeGlow, emissiveIntensity: 1.25 }));
  if (!look.key) return { geo: base, eyeMat: baseEyes };
  let dressed = _looks.get(look.key);
  if (!dressed) {
    const paint = (g: THREE.BufferGeometry) => repaint(g, look.swap);
    dressed = {
      geo: {
        head: { ...base.head, shell: paint(base.head.shell), glass: paint(base.head.glass) },
        pelvis: paint(base.pelvis),
        torso: paint(base.torso),
        upperArm: paint(base.upperArm),
        forearm: paint(base.forearm),
        mitten: paint(base.mitten),
        thigh: paint(base.thigh),
        shin: paint(base.shin),
        boot: paint(base.boot),
      },
      eyeMat: look.palette.eyeGlow === C.eyeGlow ? baseEyes : paintMaterial({ color: '#0e3d48', emissive: look.palette.eyeGlow, emissiveIntensity: 1.25 }),
    };
    _looks.set(look.key, dressed);
  }
  return dressed;
}

/** GitHub Copilot's pilot-robot mascot, in its own colours or a shop outfit's. */
export function createCopilotRider(colors?: RiderColors): RiderRig {
  const shellMat = (_shellMat ??= glossMaterial(0xffffff, 0.36, 0.0, { vertexColors: true }));
  const glassMat = (_glassMat ??= glossMaterial(0xffffff, 0.12, 0.15, { vertexColors: true }));
  const { geo: G, eyeMat } = copilotLook(outfit(COPILOT_COLORS, colors));

  const mesh = (g: THREE.BufferGeometry, name: string, m: THREE.Material = shellMat) => {
    const o = new THREE.Mesh(g, m);
    o.name = name;
    return o;
  };

  const head = new THREE.Group();
  head.name = 'head';
  head.add(mesh(G.head.shell, 'helmet'), mesh(G.head.glass, 'visor', glassMat));
  const eyes = mesh(G.head.eyes, 'eyes', eyeMat);
  eyes.position.copy(G.head.eyeCenter);
  head.add(eyes);

  return new HumanoidRig(COPILOT_SPEC, {
    pelvis: mesh(G.pelvis, 'pelvis'),
    torso: mesh(G.torso, 'torso'),
    head,
    upperArm: [mesh(G.upperArm, 'upperArmL'), mesh(G.upperArm, 'upperArmR')],
    forearm: [mesh(G.forearm, 'forearmL'), mesh(G.forearm, 'forearmR')],
    hand: [mesh(G.mitten, 'handL'), mesh(G.mitten, 'handR')],
    thigh: [mesh(G.thigh, 'thighL'), mesh(G.thigh, 'thighR')],
    shin: [mesh(G.shin, 'shinL'), mesh(G.shin, 'shinR')],
    foot: [mesh(G.boot, 'footL'), mesh(G.boot, 'footR')],
    tick: (time) => {
      // blink every ~3.7 s (double blink now and then)
      const period = 3.7;
      const ph = time % period;
      const second = Math.floor(time / period) % 3 === 1 ? Math.abs(ph - 0.32) : 1;
      const d = Math.min(Math.abs(ph - 0.12), second);
      eyes.scale.y = 0.12 + 0.88 * clamp01(d / 0.07);
    },
  });
}
