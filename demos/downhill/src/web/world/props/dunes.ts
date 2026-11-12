import * as THREE from 'three';
import { Noise } from '../../core/noise';
import { Rng } from '../../core/rng';
import { ATMOSPHERE_GLSL, atmoUniforms, paintMaterial } from '../../render/globals';
import type { SetPieceHandle, WorldContext } from '../types';
import { dunesGuide, shoreZ } from '../envs/dunes';
import { ellipseOutline, mergeIndexed, mesaGeometry, type MesaOpts } from './desertRocks';
import { lighthouseGeometry, postGeometry, sailboatGeometry, slatGeometry, wakeGeometry, wreckGeometry } from './dunesProps';

const noise = new Noise(4711);

// ------------------------------------------------------------------------------------------
// Granite headland
// ------------------------------------------------------------------------------------------

const GV0 = -20;
const GV1 = 92;
const graniteV = (y: number) => Math.min(0.985, (y - GV0) / (GV1 - GV0));

let graniteCache: THREE.CanvasTexture | null = null;
/** Warm granite: sheet joints, vertical cracks, blotches, a dark wet band and algae line at the waterline. Top strip is white (flat-colour caps). */
function graniteTexture(): THREE.CanvasTexture {
  if (graniteCache) return graniteCache;
  const W = 512;
  const H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  const rng = new Rng(2207);
  const py = (y: number) => H * (1 - graniteV(y));
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#d6a888');
  g.addColorStop(0.45, '#c08e7a');
  g.addColorStop(0.8, '#a07c72');
  g.addColorStop(1, '#5e5054');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const blot = ['#d89a74', '#b87a70', '#e6c09a', '#8f7270', '#b08070', '#f0d2b0', '#9a8090'];
  for (let i = 0; i < 700; i++) {
    ctx.globalAlpha = 0.12 + rng.next() * 0.22;
    ctx.fillStyle = rng.pick(blot);
    const x = rng.next() * W;
    const y = rng.next() * H;
    const w = 20 + rng.next() * 120;
    const h = 10 + rng.next() * 70;
    for (const ox of [0, -W, W]) ctx.fillRect(x + ox, y, w, h);
  }
  // sheet joints (gently curved horizontal cracks)
  ctx.globalAlpha = 1;
  for (let i = 0; i < 26; i++) {
    const y0 = py(rng.range(4, 70));
    ctx.strokeStyle = `rgba(70,58,54,${0.25 + rng.next() * 0.3})`;
    ctx.lineWidth = 2 + rng.next() * 3;
    ctx.beginPath();
    const x0 = rng.next() * W;
    const len = 120 + rng.next() * 380;
    for (let k = 0; k <= 12; k++) {
      const x = x0 + (k / 12) * len;
      const y = y0 + Math.sin(k * 0.7 + i) * 6;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // vertical cracks with shadowed edges
  for (let i = 0; i < 120; i++) {
    let x = rng.next() * W;
    let y = py(rng.range(-6, 70));
    const len = 40 + rng.next() * 320;
    ctx.strokeStyle = `rgba(60,50,48,${0.3 + rng.next() * 0.35})`;
    ctx.lineWidth = 1.5 + rng.next() * 3.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < len; k += 16) {
      x += (rng.next() - 0.5) * 6;
      y += 16;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // waterline: wet dark rock, green algae band, pale salt crust above
  ctx.fillStyle = 'rgba(52,56,60,0.75)';
  ctx.fillRect(0, py(0.6), W, H - py(0.6));
  ctx.fillStyle = 'rgba(70,120,72,0.85)';
  ctx.fillRect(0, py(1.6), W, py(0.4) - py(1.6));
  ctx.fillStyle = 'rgba(240,236,224,0.45)';
  ctx.fillRect(0, py(3.0), W, py(1.8) - py(3.0));
  // white strip for flat-coloured caps
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, Math.ceil(H * 0.012));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  graniteCache = tex;
  return tex;
}

interface Blob {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  top: number;
  talusTop: number;
}

function headlandBlobs(): Blob[] {
  return [
    { cx: 452, cz: -2330, rx: 140, rz: 200, top: 96, talusTop: 8 },
    { cx: 362, cz: -2635, rx: 130, rz: 190, top: 84, talusTop: 5 },
    { cx: 274, cz: -2920, rx: 110, rz: 150, top: 72, talusTop: 3 },
  ];
}

// ------------------------------------------------------------------------------------------
// Lighthouse beam + halo
// ------------------------------------------------------------------------------------------

const BEAM_VERT = /* glsl */ `
varying float vAlong;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vAlong = uv.y;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
${ATMOSPHERE_GLSL}
varying float vAlong;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float facing = abs(dot(normalize(vNormal), V));
  float a = uOpacity * pow(vAlong, 1.6) * facing * facing;
  vec3 col = mix(uColor, applyAtmosphere(uColor, vWorld), 0.5);
  gl_FragColor = vec4(col * a, a);
}
`;

function haloTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,250,220,1)');
  g.addColorStop(0.25, 'rgba(255,236,170,0.55)');
  g.addColorStop(1, 'rgba(255,220,150,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// ------------------------------------------------------------------------------------------
// Boats
// ------------------------------------------------------------------------------------------

const WAKE_VERT = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
varying vec3 vWorld;
void main() {
  vAlpha = aAlpha;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WAKE_FRAG = /* glsl */ `
${ATMOSPHERE_GLSL}
varying float vAlpha;
varying vec3 vWorld;
void main() {
  vec3 col = applyAtmosphere(vec3(0.97, 0.99, 1.0), vWorld);
  gl_FragColor = vec4(col, vAlpha * 0.8);
}
`;

interface BoatPath {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  speed: number;
  ph: number;
  dir: number;
  scale: number;
}

const BOATS: BoatPath[] = [
  { cx: -330, cz: -2860, rx: 330, rz: 150, speed: 5.2, ph: 0.4, dir: 1, scale: 2.0 },
  { cx: -1050, cz: -2880, rx: 360, rz: 200, speed: 4.6, ph: 2.6, dir: -1, scale: 1.9 },
  { cx: -380, cz: -3250, rx: 300, rz: 110, speed: 4.2, ph: 4.4, dir: 1, scale: 1.8 },
  { cx: -160, cz: -2700, rx: 200, rz: 70, speed: 3.8, ph: 1.4, dir: -1, scale: 1.7 },
  { cx: -700, cz: -4250, rx: 900, rz: 320, speed: 6.5, ph: 3.3, dir: 1, scale: 2.4 },
  { cx: 1000, cz: -4300, rx: 700, rz: 260, speed: 6.0, ph: 0.9, dir: -1, scale: 2.4 },
  { cx: 900, cz: -3350, rx: 330, rz: 220, speed: 5.5, ph: 5.1, dir: 1, scale: 2.2 },
  { cx: 40, cz: -2760, rx: 150, rz: 90, speed: 3.4, ph: 3.0, dir: 1, scale: 1.6 },
  { cx: -620, cz: -2700, rx: 260, rz: 90, speed: 4.0, ph: 5.6, dir: -1, scale: 1.7 },
  { cx: -1500, cz: -3150, rx: 420, rz: 160, speed: 5.0, ph: 0.2, dir: 1, scale: 2.0 },
];

// ------------------------------------------------------------------------------------------

export function buildDuneSetPieces(ctx: WorldContext): SetPieceHandle {
  const root = new THREE.Group();
  root.name = 'dunes';
  ctx.scene.add(root);
  const groundH = (x: number, z: number) => ctx.terrain.heightAt(x, z);
  const guide = dunesGuide();
  const rng = new Rng(1312);

  // --- granite headland + sea stacks (one draw call) ---
  const grass = new THREE.Color('#6cae3c');
  const gopts = (o: MesaOpts): MesaOpts => ({ ...o, vMap: graniteV, uScale: 1 / 210, capColor: grass, rimDepth: 2.2 });
  const rocks: THREE.BufferGeometry[] = [];
  const blobs = headlandBlobs();
  blobs.forEach((b, i) => {
    const pts = ellipseOutline(b.cx, b.cz, b.rx, b.rz, -0.29, i * 2.3 + 1, 14, 0.14);
    rocks.push(mesaGeometry(gopts({ pts, top: b.top, talusTop: b.talusTop, spacing: 7, rowStep: 6, rough: 0.9, relief: 9, flute: 3.5, seed: 70 + i }), groundH));
    // the riders can reach the headland foot: ring it with solid colliders
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      const lx = Math.cos(a) * (b.rx + 4);
      const lz = Math.sin(a) * (b.rz + 4);
      const x = b.cx + lx * Math.cos(-0.29) - lz * Math.sin(-0.29);
      const z = b.cz + lx * Math.sin(-0.29) + lz * Math.cos(-0.29);
      if (x < 470 && z > -2780) ctx.addCollider(x, z, 9, b.top, 'solid');
    }
  });
  const stacks: Array<[number, number, number, number]> = [
    [185, -3085, 24, 46],
    [300, -3110, 17, 32],
    [130, -3010, 14, 24],
    [235, -3170, 11, 18],
  ];
  stacks.forEach(([x, z, r, h], i) => {
    rocks.push(mesaGeometry(gopts({ pts: ellipseOutline(x, z, r, r * 0.85, i, i * 4.1, 9, 0.12), top: h, talusTop: 2, spacing: 4, rowStep: 4, rough: 0.6, relief: 3, flute: 1.5, seed: 90 + i }), groundH));
  });
  const rockMesh = new THREE.Mesh(mergeIndexed(rocks), paintMaterial({ map: graniteTexture(), vertexColors: true }));
  rockMesh.frustumCulled = false;
  rockMesh.receiveShadow = true;
  root.add(rockMesh);

  // --- lighthouse on the tip ---
  const tip = blobs[2];
  const lhx = tip.cx - 22;
  const lhz = tip.cz - 52;
  const lh = lighthouseGeometry();
  const lhGroup = new THREE.Group();
  lhGroup.position.set(lhx, tip.top - 0.3, lhz);
  lhGroup.rotation.y = 2.2;
  lhGroup.scale.setScalar(1.7);
  const body = new THREE.Mesh(lh.body, paintMaterial({ vertexColors: true, saturation: 1.12 }));
  body.castShadow = true;
  const glass = new THREE.Mesh(lh.glass, paintMaterial({ vertexColors: true, emissive: '#ffd77a', emissiveIntensity: 1.3, side: THREE.DoubleSide }));
  lhGroup.add(body, glass);
  // slowly sweeping twin beam + halo around the lamp
  const beamGeo = new THREE.ConeGeometry(7, 150, 16, 1, true);
  beamGeo.translate(0, -75, 0);
  beamGeo.rotateZ(Math.PI / 2);
  const beamMat = new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color('#fff2c4') }, uOpacity: { value: 0.32 }, ...atmoUniforms() },
  });
  const beamPivot = new THREE.Group();
  beamPivot.position.y = lh.lampY;
  for (const sgn of [1, -1]) {
    const b = new THREE.Mesh(beamGeo, beamMat);
    b.rotation.y = sgn > 0 ? 0 : Math.PI;
    b.frustumCulled = false;
    beamPivot.add(b);
  }
  lhGroup.add(beamPivot);
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 22),
    new THREE.MeshBasicMaterial({ map: haloTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 0.8 }),
  );
  halo.position.set(lhGroup.position.x, lhGroup.position.y + lh.lampY * 1.7, lhGroup.position.z);
  halo.renderOrder = 4;
  root.add(lhGroup, halo);

  // --- sailboats (3 colour variants, instanced) + wakes ---
  const variants = [
    sailboatGeometry('#f7f4ee', '#2b55c8', '#fbfaf6', '#e8463a'),
    sailboatGeometry('#1f3f8f', '#f4f0e6', '#fbfaf6', null),
    sailboatGeometry('#d8402f', '#f6f0e2', '#fbfaf6', '#2b6ad8'),
  ];
  const sailMat = paintMaterial({ vertexColors: true, side: THREE.DoubleSide, saturation: 1.1 });
  const boatMeshes = variants.map((g, v) => {
    const count = BOATS.filter((_, i) => i % 3 === v).length;
    const im = new THREE.InstancedMesh(g, sailMat, count);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.castShadow = false;
    root.add(im);
    return im;
  });
  const wakes = new THREE.InstancedMesh(
    wakeGeometry(),
    new THREE.ShaderMaterial({ vertexShader: WAKE_VERT, fragmentShader: WAKE_FRAG, transparent: true, depthWrite: false, uniforms: { ...atmoUniforms() } }),
    BOATS.length,
  );
  wakes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wakes.frustumCulled = false;
  wakes.renderOrder = 1;
  root.add(wakes);

  // --- weathered sand fences, half buried along the main trail ---
  const main = ctx.trails.main;
  const slatM: THREE.Matrix4[] = [];
  const slatC: THREE.Color[] = [];
  const postM: THREE.Matrix4[] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const one = new THREE.Vector3(1, 1, 1);
  const v3 = new THREE.Vector3();
  const wood = ['#d6c4a6', '#c4ae8c', '#e2d4ba', '#b89e7e', '#cdbb9c'];
  let s = 70;
  let seg = 0;
  while (s < main.length - 110) {
    const len = 10 + rng.next() * 24;
    const side = rng.chance(0.5) ? 1 : -1;
    const off0 = 6.4 + rng.next() * 3.2;
    const tilt = (rng.next() - 0.5) * 0.24;
    let lastCol = -10;
    let lastPost = -10;
    for (let d = 0; d < len; d += 0.23) {
      const p = guide.at(main, s + d);
      const rx = Math.cos(p.heading);
      const rz = Math.sin(p.heading);
      const off = off0 + 0.7 * Math.sin(d / 6 + seg);
      const x = p.x + rx * off * side;
      const z = p.z + rz * off * side;
      if (guide.sideDist(x, z) < 6) continue;
      const g = groundH(x, z);
      const bury = 0.5 + 0.5 * noise.noise2(d / 5 + seg * 3.7, seg);
      const vis = 0.22 + 0.78 * bury;
      e.set(tilt + (rng.next() - 0.5) * 0.12, Math.PI / 2 - p.heading, (rng.next() - 0.5) * 0.1);
      q.setFromEuler(e);
      if (d - lastPost > 2.4) {
        lastPost = d;
        m4.compose(v3.set(x, g + vis + 0.18, z), q, one);
        postM.push(m4.clone());
      }
      if (rng.chance(0.09)) continue;
      const broken = rng.chance(0.12) ? 0.55 : 1;
      m4.compose(v3.set(x, g + vis * broken, z), q, one);
      slatM.push(m4.clone());
      slatC.push(new THREE.Color(rng.pick(wood)));
      if (d - lastCol > 1.6) {
        lastCol = d;
        ctx.addCollider(x, z, 0.65, g + vis, 'soft');
      }
    }
    s += len + 30 + rng.next() * 80;
    seg++;
  }
  const slats = new THREE.InstancedMesh(slatGeometry(), paintMaterial({ color: '#ffffff' }), Math.max(1, slatM.length));
  slatM.forEach((mm, i) => {
    slats.setMatrixAt(i, mm);
    slats.setColorAt(i, slatC[i]);
  });
  slats.count = slatM.length;
  slats.castShadow = true;
  slats.receiveShadow = true;
  const posts = new THREE.InstancedMesh(postGeometry(), paintMaterial({ color: '#9a8466' }), Math.max(1, postM.length));
  postM.forEach((mm, i) => posts.setMatrixAt(i, mm));
  posts.count = postM.length;
  posts.castShadow = true;
  root.add(slats, posts);

  // --- shipwreck on the beach beyond the finish ---
  {
    const f = guide.at(main, main.length - 45);
    const wx = f.x - 70;
    const wz = shoreZ(wx) + 34;
    const wreck = new THREE.Mesh(wreckGeometry(5), paintMaterial({ vertexColors: true }));
    wreck.position.set(wx, groundH(wx, wz) - 1.1, wz);
    wreck.rotation.set(0, 0.75, 0.22);
    wreck.castShadow = true;
    wreck.receiveShadow = true;
    root.add(wreck);
    const fx = Math.sin(0.75);
    const fz = Math.cos(0.75);
    for (let k = -2; k <= 2; k++) ctx.addCollider(wx + fx * k * 6, wz + fz * k * 6, 3.6, groundH(wx, wz) + 5, 'solid');
  }

  const mtx = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const eul = new THREE.Euler(0, 0, 0, 'YXZ');
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const counters = [0, 0, 0];
  return {
    update(_dt, time, camera) {
      beamPivot.rotation.y = time * 0.5;
      halo.quaternion.copy(camera.quaternion);
      counters[0] = counters[1] = counters[2] = 0;
      for (let i = 0; i < BOATS.length; i++) {
        const b = BOATS[i];
        const R = (b.rx + b.rz) / 2;
        const a = b.ph + (b.dir * time * b.speed) / R;
        const x = b.cx + Math.cos(a) * b.rx;
        const z = b.cz + Math.sin(a) * b.rz;
        // tangent of travel
        const tx = -Math.sin(a) * b.rx * b.dir;
        const tz = Math.cos(a) * b.rz * b.dir;
        const yaw = Math.atan2(tx, tz);
        eul.set(0.02 * Math.sin(time * 1.1 + i), yaw, -b.dir * (0.16 + 0.04 * Math.sin(time * 0.7 + i * 2)));
        quat.setFromEuler(eul);
        pos.set(x, 0.12 * Math.sin(time * 1.3 + i * 1.7), z);
        scl.setScalar(b.scale);
        mtx.compose(pos, quat, scl);
        const v = i % 3;
        boatMeshes[v].setMatrixAt(counters[v]++, mtx);
        eul.set(0, yaw, 0);
        quat.setFromEuler(eul);
        pos.set(x - (tx / Math.hypot(tx, tz)) * 5 * b.scale, 0.02, z - (tz / Math.hypot(tx, tz)) * 5 * b.scale);
        mtx.compose(pos, quat, scl);
        wakes.setMatrixAt(i, mtx);
      }
      for (let v = 0; v < boatMeshes.length; v++) boatMeshes[v].instanceMatrix.needsUpdate = true;
      wakes.instanceMatrix.needsUpdate = true;
    },
  };
}
