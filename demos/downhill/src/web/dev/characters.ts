import * as THREE from 'three';
import { CHARACTERS } from '../game/characters';
import { HumanoidRig } from '../game/characters/humanoid';
import { meshStats } from '../game/characters/util';
import {
  BIKE,
  defaultRiderPose,
  type BikeVisual,
  type BikeVisualState,
  type CharacterDef,
  type RiderPose,
  type RiderRig,
} from '../game/rider/types';
import { G, paintMaterial } from '../render/globals';

declare global {
  interface Window {
    __ready?: boolean;
    __stats?: Record<
      string,
      {
        triangles: number;
        drawCalls: number;
        riderTriangles: number;
        riderDrawCalls: number;
        handErr: number;
        footErr: number;
        nan: boolean;
      }
    >;
  }
}

/* ------------------------------------------------------------------ params */

const params = new URLSearchParams(location.search);
const poseName = params.get('pose') ?? 'pedal';
const view = params.get('view') ?? 'three-quarter';
const tParam = params.get('t');
const frozen = tParam !== null && tParam !== '';
const only = params.get('only');
const toneParam = params.get('tm') ?? 'aces';
const zoom = parseFloat(params.get('zoom') ?? '1') || 1;
const hud = document.getElementById('hud') as HTMLDivElement;
if (params.has('nohud')) hud.classList.add('hidden');

/* ------------------------------------------------------------------ renderer / scene */

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping =
  toneParam === 'none' ? THREE.NoToneMapping : toneParam === 'neutral' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setScissorTest(true);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#8ec5ff');

scene.add(new THREE.HemisphereLight('#9cc8ff', '#6b8f3a', 1.2));
const sun = new THREE.DirectionalLight('#fff3dc', 2.8);
sun.position.set(5, 9, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = -12;
sc.right = 12;
sc.top = 12;
sc.bottom = -12;
sc.near = 0.5;
sc.far = 40;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
G.uSunDir.value.copy(sun.position).normalize();

const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), paintMaterial({ color: '#79b043' }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* ------------------------------------------------------------------ characters */

interface Entry {
  def: CharacterDef;
  holder: THREE.Group;
  bike: BikeVisual;
  rider: RiderRig;
  camera: THREE.PerspectiveCamera;
}

const SPACING = 8;
const defs = only ? CHARACTERS.filter((c) => c.id === only) : CHARACTERS;
const entries: Entry[] = defs.map((def, i) => {
  const holder = new THREE.Group();
  holder.position.x = (i - (defs.length - 1) / 2) * SPACING;
  const bike = def.createBike();
  const rider = def.createRider();
  bike.root.add(rider.root);
  holder.add(bike.root);
  scene.add(holder);
  return { def, holder, bike, rider, camera: new THREE.PerspectiveCamera(36, 1, 0.05, 200) };
});

/* ------------------------------------------------------------------ poses */

interface Frame {
  pose: RiderPose;
  bike: BikeVisualState;
  /** Whole-bike roll (game-applied) and height above ground. */
  roll: number;
  lift: number;
  crashTumble: number;
}

function frameAt(name: string, t: number): Frame {
  if (name === 'cycle') {
    // a new pose every 1.5 s, so mid-transition blends can be inspected (e.g. ?pose=cycle&t=3.1)
    const seq = ['pedal', 'attack', 'superman', 'noHander', 'canCan', 'tailwhip', 'barspin', 'tabletop', 'celebrate', 'crash'];
    return frameAt(seq[Math.floor(t / 1.5) % seq.length], t);
  }
  const pose = defaultRiderPose();
  pose.time = t;
  pose.speed = 8;
  const spin = (t * 8) / BIKE.wheelRadius;
  const bike: BikeVisualState = { rearSpin: spin, frontSpin: spin, crank: 0, steer: 0, barspin: 0, tailwhip: 0, suspension: 0.2 };
  const f: Frame = { pose, bike, roll: 0, lift: 0, crashTumble: 0 };
  const air = () => {
    pose.airborne = true;
    pose.seated = 0;
    bike.suspension = 0;
    f.lift = 0.55;
  };
  switch (name) {
    case 'pedal':
      pose.seated = 1;
      pose.speed = 6;
      bike.crank = t * Math.PI * 2 * 1.2;
      break;
    case 'attack':
      pose.seated = 0;
      pose.speed = 14;
      pose.compress = 0.15;
      bike.suspension = 0.35;
      bike.steer = 0.06 * Math.sin(t * 0.9);
      pose.steer = 0.25 * Math.sin(t * 0.9);
      break;
    case 'superman':
      air();
      pose.tricks.superman = 1;
      break;
    case 'noHander':
      air();
      pose.tricks.noHander = 1;
      break;
    case 'canCan':
      air();
      pose.tricks.canCan = 1;
      break;
    case 'tailwhip':
      air();
      pose.tricks.tailwhip = 1;
      bike.tailwhip = (t * Math.PI * 2 * 0.8) % (Math.PI * 2);
      break;
    case 'barspin':
      air();
      pose.tricks.barspin = 1;
      bike.barspin = (t * Math.PI * 2 * 1.1) % (Math.PI * 2);
      break;
    case 'tabletop':
      air();
      pose.tricks.tabletop = 1;
      f.roll = -0.9;
      break;
    case 'crash':
      pose.crashed = true;
      pose.seated = 0;
      f.crashTumble = 1;
      break;
    case 'celebrate':
      pose.seated = 0.3;
      pose.celebrate = 1;
      bike.crank = 0.3;
      break;
    case 'compress':
      pose.seated = 0;
      pose.compress = 1;
      bike.suspension = 1;
      break;
    case 'lean':
      // right-hand turn: the game rolls the bike right (negative Z rotation here), rider leans in a bit more
      pose.seated = 0;
      pose.lean = 0.25;
      pose.steer = 0.7;
      bike.steer = 0.2;
      f.roll = -0.45;
      break;
    default:
      break;
  }
  return f;
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _euler = new THREE.Euler();
const PIVOT = new THREE.Vector3(0, 0.6, 0);
const CRASH_PIVOT = new THREE.Vector3(0, 1.0, 0.32);
/** Where the preview drops the tumbling rider (front-right of the bike, visible from every preset view). */
const CRASH_OFFSET = new THREE.Vector3(0.85, -0.3, -1.0);

function step(t: number, dt: number): void {
  for (const e of entries) {
    const f = frameAt(poseName, t);
    e.bike.update(f.bike);
    e.rider.update(f.pose, e.bike.anchors, dt);
    // game-applied whole-bike roll (tabletop / cornering), about a point mid-bike
    _q.setFromAxisAngle(_v.set(0, 0, 1), f.roll);
    e.bike.root.quaternion.copy(_q);
    e.bike.root.position.copy(PIVOT).sub(_v.copy(PIVOT).applyQuaternion(_q));
    e.bike.root.position.y += f.lift;
    // crash: the game would tumble the rider root; preview a frozen tumble next to the bike
    if (f.crashTumble > 0) {
      _q.setFromEuler(_euler.set(0.5 + Math.sin(t * 0.7) * 0.4, 0.3, 1.1 + t * 0.2, 'XYZ'));
      e.rider.root.quaternion.copy(_q);
      e.rider.root.position.copy(CRASH_PIVOT).sub(_v.copy(CRASH_PIVOT).applyQuaternion(_q)).add(CRASH_OFFSET);
    } else {
      e.rider.root.quaternion.identity();
      e.rider.root.position.set(0, 0, 0);
    }
  }
}

/** True if any transform under `root` contains NaN (rig robustness check). */
function hasNaN(root: THREE.Object3D): boolean {
  let bad = false;
  root.traverse((o) => {
    const p = o.position;
    const q = o.quaternion;
    const s = o.scale;
    if (!Number.isFinite(p.x + p.y + p.z + q.x + q.y + q.z + q.w + s.x + s.y + s.z)) bad = true;
  });
  return bad;
}

/* ------------------------------------------------------------------ cameras */

const VIEWS: Record<string, { pos: [number, number, number]; look: [number, number, number]; fov: number }> = {
  back: { pos: [0, 1.5, 3.3], look: [0, 0.95, -0.25], fov: 38 },
  chase: { pos: [0, 1.85, 3.3], look: [0, 1.15, -3], fov: 55 },
  side: { pos: [5.6, 1.05, -0.05], look: [0, 0.85, -0.05], fov: 34 },
  left: { pos: [-5.6, 1.05, -0.05], look: [0, 0.85, -0.05], fov: 34 },
  front: { pos: [0, 1.35, -3.9], look: [0, 0.9, -0.05], fov: 36 },
  'three-quarter': { pos: [3.0, 1.65, -3.3], look: [0, 0.85, -0.05], fov: 36 },
  'back-three-quarter': { pos: [2.6, 1.7, 3.0], look: [0, 0.9, 0], fov: 38 },
  top: { pos: [0.01, 4.8, 0.0], look: [0, 0.5, 0], fov: 36 },
};

function placeCameras(lift: number): void {
  const v = VIEWS[view] ?? VIEWS['three-quarter'];
  for (const e of entries) {
    const look = new THREE.Vector3(...v.look).add(e.holder.position);
    look.y += lift;
    const pos = new THREE.Vector3(...v.pos).add(e.holder.position);
    pos.y += lift;
    pos.sub(look).multiplyScalar(1 / zoom).add(look);
    e.camera.fov = v.fov;
    e.camera.position.copy(pos);
    e.camera.lookAt(look);
  }
}

function render(): void {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const n = entries.length;
  const vw = W / n;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  entries.forEach((e, i) => {
    for (const o of entries) o.holder.visible = o === e;
    renderer.shadowMap.needsUpdate = true;
    e.camera.aspect = vw / H;
    e.camera.updateProjectionMatrix();
    renderer.setViewport(i * vw, 0, vw, H);
    renderer.setScissor(i * vw, 0, vw, H);
    renderer.render(scene, e.camera);
  });
  for (const o of entries) o.holder.visible = true;
}

function updateHud(t: number): void {
  const stats: NonNullable<Window['__stats']> = {};
  const lines = [`pose=${poseName}  view=${view}  t=${t.toFixed(2)}`];
  for (const e of entries) {
    const all = meshStats(e.bike.root);
    const rider = meshStats(e.rider.root);
    const ik = ikError(e);
    const nan = hasNaN(e.bike.root);
    stats[e.def.id] = { ...all, riderTriangles: rider.triangles, riderDrawCalls: rider.drawCalls, ...ik, nan };
    const ikTxt = ik.handErr >= 0 ? `  ik hand ${(ik.handErr * 100).toFixed(1)}cm foot ${(ik.footErr * 100).toFixed(1)}cm` : '';
    lines.push(
      `${e.def.name}: ${all.triangles} tris / ${all.drawCalls} draws (rider ${rider.triangles} / ${rider.drawCalls})${ikTxt}${nan ? '  NaN!' : ''}`,
    );
  }
  window.__stats = stats;
  hud.textContent = lines.join('\n');
}

const _ik = new THREE.Vector3();
/** Max distance of palm -> grip and ball-of-foot -> pedal (humanoids only; -1 otherwise). */
function ikError(e: Entry): { handErr: number; footErr: number } {
  if (!(e.rider instanceof HumanoidRig)) return { handErr: -1, footErr: -1 };
  const S = e.rider.spec;
  const B = e.rider.body;
  const A = e.bike.anchors;
  let handErr = 0;
  let footErr = 0;
  for (let s = 0; s < 2; s++) {
    handErr = Math.max(handErr, B.hand[s].position.distanceTo(s === 0 ? A.gripL : A.gripR));
    _ik.set(0, -(S.ankleHeight + 0.012), -S.ballForward).applyQuaternion(B.foot[s].quaternion).add(B.foot[s].position);
    footErr = Math.max(footErr, _ik.distanceTo(s === 0 ? A.pedalL : A.pedalR));
  }
  return { handErr, footErr };
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (frozen) render();
});

/** Dev hook: average ms per `bike.update + rider.update` for all characters (no rendering). */
(window as unknown as { __bench: (n: number) => Record<string, number> }).__bench = (n: number) => {
  const out: Record<string, number> = {};
  for (const e of entries) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const f = frameAt(poseName, i / 60);
      e.bike.update(f.bike);
      e.rider.update(f.pose, e.bike.anchors, 1 / 60);
    }
    out[e.def.id] = (performance.now() - t0) / n;
  }
  return out;
};

/* ------------------------------------------------------------------ run */

if (frozen) {
  const t1 = parseFloat(tParam ?? '0') || 0;
  const dt = 1 / 60;
  // simulate the lead-in so smoothing / secondary motion settles exactly as in-game
  for (let t = Math.max(0, t1 - 2); t < t1; t += dt) step(t, dt);
  step(t1, dt);
  placeCameras(frameAt(poseName, t1).lift);
  updateHud(t1);
  render();
  requestAnimationFrame(() => {
    window.__ready = true;
  });
} else {
  let t = 0;
  let last = performance.now();
  let first = true;
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    step(t, dt);
    placeCameras(frameAt(poseName, t).lift);
    if (first || Math.floor(t * 2) !== Math.floor((t - dt) * 2)) updateHud(t);
    render();
    if (first) {
      first = false;
      requestAnimationFrame(() => {
        window.__ready = true;
      });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
