import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Noise } from '../../core/noise';
import { Rng } from '../../core/rng';
import { ATMOSPHERE_GLSL, G, atmoUniforms, paintMaterial } from '../../render/globals';
import { displayToScene } from '../../render/textures';
import type { SetPieceHandle, WorldContext } from '../types';
import { RIVER_LEVEL, riverHalfW, riverZ, southRimZ, trailDistance } from '../envs/desert';
import { archGeometry, ellipseOutline, hoodooGeometries, mergeIndexed, mesaGeometry, strataMaterial, type MesaOpts, type WallProbe } from './desertRocks';
import { Steam, buildRailway, buildTrain, planRailway, railY } from './desertRail';

const noise = new Noise(31337);

/** Rail tunnel locations: through the big East butte (north end) and into the South Rim (south end). */
const RAIL_X = 1160;
const BUTTE_PORTAL: [number, number] = [2180, 360];
const RAIL_DECK = { start: 40, end: 42 };
/** The train is drawn larger than life so it reads from the trail ~1 km away. */
const TRAIN_SCALE = 1.7;

interface Landform {
  o: MesaOpts;
  probes?: WallProbe[];
}

const probe = (x: number, z: number, y: number): WallProbe => ({ x, z, y, pos: new THREE.Vector3(), normal: new THREE.Vector3() });

/** The colossal landforms: Sunset Mesa massif, South Rim, East Mesa and the Monument-Valley buttes. */
function landforms(groundH: (x: number, z: number) => number, rimProbe: WallProbe, butteProbe: WallProbe): Landform[] {
  const L: Landform[] = [];
  // Sunset Mesa: the west massif, curling behind the start into a horseshoe amphitheatre
  L.push({
    o: {
      pts: [
        [-1180, -3020], [-1110, -2700], [-1250, -2380], [-1050, -2060], [-1160, -1720], [-1270, -1380], [-1030, -1020],
        [-1130, -660], [-1210, -260], [-1070, 160], [-1160, 600], [-1010, 1000], [-880, 1480], [-640, 1930],
        [-260, 2200], [200, 2290], [640, 2170], [950, 1960], [1120, 1700], [1330, 1880], [1450, 2600],
        [800, 3700], [-1500, 4300], [-4600, 3600], [-5200, 0], [-4900, -2600], [-3600, -3080], [-2300, -3150],
      ],
      top: 860,
      talus: 0.24,
      benches: [[640, 26], [760, 14]],
      spacing: 14,
      rowStep: 14,
      seed: 1,
      coarse: (x, z) => (x < -1900 || z > 2750 ? 8 : 1),
    },
  });
  // South Rim: the great wall beyond the river (with side-canyon notches)
  const south: Array<[number, number]> = [];
  for (let x = -7600; x <= 8000; x += 160) {
    let z = southRimZ(x);
    for (const cx of [-2600, 600, 3900]) {
      const d = Math.abs(x - cx);
      if (d < 280) z -= 380 * Math.pow(1 - d / 280, 2);
    }
    south.push([x, z]);
  }
  south.push([8600, -6000], [6000, -9800], [-6000, -9800], [-8200, -6000]);
  L.push({
    o: {
      pts: south,
      top: 640,
      talusTop: RIVER_LEVEL + 75,
      benches: [[400, 60], [530, 24]],
      spacing: 16,
      rowStep: 15,
      seed: 2,
      coarse: (x, z) => (z < southRimZ(x) - 700 ? 10 : Math.abs(x - 600) > 5500 ? 3 : Math.abs(x - 600) > 2600 ? 1.6 : 1),
      pins: [[rimProbe.x, rimProbe.z, 170]],
    },
    probes: [rimProbe],
  });
  // East Mesa: north wall of the east canyon
  const east: Array<[number, number]> = [];
  for (let x = 1950; x <= 7400; x += 180) east.push([x, riverZ(x) + riverHalfW(x) + 175 + 40 * Math.sin(x / 300)]);
  for (let x = 7400; x >= 2000; x -= 300) east.push([x, -2240 - 70 * Math.sin(x / 380 + 1)]);
  east.push([1880, -2480], [1870, -2860]);
  L.push({ o: { pts: east, top: 560, talusTop: RIVER_LEVEL + 70, benches: [[400, 30]], spacing: 16, rowStep: 15, seed: 3, coarse: (x) => (x > 4800 ? 6 : 1) } });
  // free-standing buttes: [cx, cz, rx, rz, rot, height above ground]
  const buttes: Array<[number, number, number, number, number, number]> = [
    [720, -650, 140, 92, 0.3, 270],
    [838, -560, 24, 21, 0, 205],
    [1850, -1100, 130, 88, -0.2, 255],
    [1735, -1015, 21, 19, 0, 190],
    [1920, -1920, 200, 125, 0.5, 230],
    [850, -2060, 220, 100, 0.1, 165],
    [1040, -1350, 25, 23, 0, 185],
    [2600, -520, 380, 230, 0.2, 320],
    [2350, 560, 300, 190, -0.4, 340],
    [-760, -1600, 95, 70, 0.6, 215],
    [-700, -400, 50, 44, 0, 160],
    [-820, 640, 110, 72, -0.3, 185],
    [-3000, -4300, 260, 170, 0.4, 0],
    [-1400, -4700, 320, 180, -0.3, 0],
  ];
  buttes.forEach(([cx, cz, rx, rz, rot, h], i) => {
    const ground = groundH(cx, cz);
    const slender = rx < 60;
    const tunnel = cx === 2350;
    // the last two stand on the South Rim plateau as an upper tier
    const top = h > 0 ? ground + h : 900 + i * 15;
    L.push({
      o: {
        pts: ellipseOutline(cx, cz, rx, rz, rot, i * 3.7, slender ? 9 : 12, slender ? 0.1 : 0.18),
        top,
        talus: h > 0 ? (slender ? 0.18 : 0.33) : 0.05,
        talusTop: tunnel ? ground + 3 : undefined,
        benches: slender ? [] : [[ground + h * 0.62, 10]],
        spacing: slender ? 5 : 9,
        rowStep: slender ? 8 : 11,
        rough: slender ? 0.25 : 0.7,
        seed: 10 + i,
        pins: tunnel ? [[butteProbe.x, butteProbe.z, 140]] : undefined,
      },
      probes: tunnel ? [butteProbe] : undefined,
    });
  });
  return L;
}

// ------------------------------------------------------------------------------------------
// River
// ------------------------------------------------------------------------------------------

const RIVER_VERT = /* glsl */ `
attribute vec2 aRiv;
varying vec2 vRiv;
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vRiv = aRiv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RIVER_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uSunColor;
${ATMOSPHERE_GLSL}
varying vec2 vRiv;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float a = abs(vRiv.x);
  vec3 col = mix(uDeep, uShallow, smoothstep(0.15, 1.2, a));
  float flow = vRiv.y * 0.022 - uTime * 0.35;
  float n1 = vnoise(vec2(flow, vRiv.x * 3.0));
  float n2 = vnoise(vec2(flow * 2.3 + 7.0, vRiv.x * 7.0 - uTime * 0.1));
  float streak = smoothstep(0.55, 0.9, n1 * 0.65 + n2 * 0.45);
  col = mix(col, uShallow * 1.35, streak * 0.45);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vec3((n1 - 0.5) * 0.5, 1.0, (n2 - 0.5) * 0.5));
  float sp = pow(max(dot(reflect(-V, N), uSunDir), 0.0), 90.0);
  col += uSunColor * sp * 1.6;
  col = mix(col, uFoam, smoothstep(1.15, 1.42, a) * 0.55);
  col = mix(col, applyAtmosphere(col, vWorld), 0.9);
  gl_FragColor = vec4(col, 1.0);
}
`;

function buildRiver(): THREE.Mesh {
  const x0 = -8200;
  const x1 = 8800;
  const step = 20;
  const across = [-1.5, -1.0, -0.4, 0, 0.4, 1.0, 1.5];
  const ns = Math.floor((x1 - x0) / step) + 1;
  const k = across.length;
  const pos = new Float32Array(ns * k * 3);
  const riv = new Float32Array(ns * k * 2);
  let along = 0;
  let px = x0;
  let pz = riverZ(x0);
  for (let i = 0; i < ns; i++) {
    const x = x0 + i * step;
    const z = riverZ(x);
    along += Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
    const dz = (riverZ(x + 1) - riverZ(x - 1)) / 2;
    const l = Math.hypot(1, dz);
    const nx = -dz / l;
    const nz = 1 / l;
    const hw = riverHalfW(x) + 22;
    for (let j = 0; j < k; j++) {
      const o = (i * k + j) * 3;
      pos[o] = x + nx * hw * across[j];
      pos[o + 1] = RIVER_LEVEL;
      pos[o + 2] = z + nz * hw * across[j];
      riv[(i * k + j) * 2] = across[j];
      riv[(i * k + j) * 2 + 1] = along;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < ns - 1; i++)
    for (let j = 0; j < k - 1; j++) {
      const a = i * k + j;
      const b = a + k;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRiv', new THREE.BufferAttribute(riv, 2));
  g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    vertexShader: RIVER_VERT,
    fragmentShader: RIVER_FRAG,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: G.uTime,
      uDeep: { value: displayToScene('#138c9c') },
      uShallow: { value: displayToScene('#3fd2c4') },
      uFoam: { value: displayToScene('#e9f6ee') },
      uSunColor: G.uSunColor,
      ...atmoUniforms(),
    },
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}

/** Golden cottonwoods & tamarisk fringing the river. */
function buildRiparian(groundH: (x: number, z: number) => number, rng: Rng): THREE.InstancedMesh {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    let b: THREE.BufferGeometry = new THREE.IcosahedronGeometry(0.5 + rng.next() * 0.2, 0);
    b.deleteAttribute('uv');
    b.deleteAttribute('normal');
    b = mergeVertices(b);
    const p = b.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      const d = 1 + 0.22 * noise.noise3(p.getX(k) * 3 + i, p.getY(k) * 3, p.getZ(k) * 3);
      p.setXYZ(k, p.getX(k) * d, p.getY(k) * d * 0.85, p.getZ(k) * d);
    }
    b.translate((rng.next() - 0.5) * 0.7, 0.75 + rng.next() * 0.35, (rng.next() - 0.5) * 0.7);
    b.computeVertexNormals();
    parts.push(b.toNonIndexed());
  }
  const trunk = new THREE.CylinderGeometry(0.05, 0.08, 0.8, 5);
  trunk.translate(0, 0.4, 0);
  trunk.deleteAttribute('uv');
  parts.push(trunk.toNonIndexed());
  const geo = mergeGeometries(parts);
  const p = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const col = new Float32Array(p.count * 3);
  const leaf = new THREE.Color('#8fb83c');
  const bark = new THREE.Color('#6a5040');
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const c = y < 0.45 && Math.hypot(p.getX(i), p.getZ(i)) < 0.12 ? bark : leaf;
    const k = 0.62 + 0.45 * (y / 1.4) + 0.12 * nrm.getY(i);
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mats: THREE.Matrix4[] = [];
  const cols: THREE.Color[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const v = new THREE.Vector3();
  const tints = ['#ffffff', '#f2e27a', '#c8e070', '#ffd060', '#a8d070'];
  for (let x = -6800; x < 7600; x += 9) {
    for (const side of [-1, 1]) {
      if (rng.next() < 0.35) continue;
      const hw = riverHalfW(x);
      const off = hw + 18 + Math.pow(rng.next(), 1.6) * 110;
      const dz = (riverZ(x + 1) - riverZ(x - 1)) / 2;
      const l = Math.hypot(1, dz);
      const px = x + (-dz / l) * off * side + (rng.next() - 0.5) * 8;
      const pz = riverZ(x) + (1 / l) * off * side;
      const y = groundH(px, pz);
      if (y < RIVER_LEVEL + 0.8 || y > RIVER_LEVEL + 22) continue;
      const sc = 7 + rng.next() * 9;
      q.setFromAxisAngle(v.set(0, 1, 0), rng.next() * 6.28);
      m.compose(v.set(px, y - 0.6, pz), q, s.set(sc * (0.9 + rng.next() * 0.4), sc, sc * (0.9 + rng.next() * 0.4)));
      mats.push(m.clone());
      cols.push(new THREE.Color(rng.pick(tints)));
    }
  }
  const im = new THREE.InstancedMesh(geo, paintMaterial({ vertexColors: true }), mats.length);
  mats.forEach((mm, i) => {
    im.setMatrixAt(i, mm);
    im.setColorAt(i, cols[i]);
  });
  im.frustumCulled = false;
  return im;
}

// ------------------------------------------------------------------------------------------
// Hot-air balloons
// ------------------------------------------------------------------------------------------

function balloonGeometry(pal: string[], band: string, seed: number): THREE.BufferGeometry {
  const prof = [
    [0.2, 0], [0.27, 0.06], [0.44, 0.19], [0.62, 0.34], [0.77, 0.48], [0.86, 0.6], [0.9, 0.71], [0.87, 0.81], [0.76, 0.9], [0.55, 0.965], [0.28, 0.995], [0.01, 1.0],
  ].map(([r, y]) => new THREE.Vector2(r * 12, y * 30));
  const env = new THREE.LatheGeometry(prof, 24).toNonIndexed();
  env.deleteAttribute('uv');
  const p = env.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  const cs = pal.map((c) => new THREE.Color(c));
  const bandC = new THREE.Color(band);
  for (let t = 0; t < p.count; t += 3) {
    const cx = (p.getX(t) + p.getX(t + 1) + p.getX(t + 2)) / 3;
    const cz = (p.getZ(t) + p.getZ(t + 1) + p.getZ(t + 2)) / 3;
    const cy = (p.getY(t) + p.getY(t + 1) + p.getY(t + 2)) / 3;
    const az = Math.atan2(cx, cz) + Math.PI;
    const gore = Math.floor((az / (Math.PI * 2)) * 24 + seed) % 24;
    let c = cs[gore % cs.length];
    if (cy > 15.5 && cy < 19.5) c = bandC;
    if (cy < 3.5) c = cs[(gore + 1) % cs.length];
    for (let k = 0; k < 3; k++) {
      const y = p.getY(t + k);
      const sh = 0.8 + 0.25 * (y / 30);
      col[(t + k) * 3] = c.r * sh;
      col[(t + k) * 3 + 1] = c.g * sh;
      col[(t + k) * 3 + 2] = c.b * sh;
    }
  }
  env.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const parts: THREE.BufferGeometry[] = [env];
  const basket = new THREE.BoxGeometry(2.4, 1.6, 2.4).toNonIndexed();
  basket.deleteAttribute('uv');
  basket.translate(0, -6.5, 0);
  const bc = new Float32Array(basket.getAttribute('position').count * 3);
  for (let i = 0; i < bc.length; i += 3) {
    bc[i] = 0.42;
    bc[i + 1] = 0.26;
    bc[i + 2] = 0.13;
  }
  basket.setAttribute('color', new THREE.BufferAttribute(bc, 3));
  parts.push(basket);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const a = new THREE.Vector3(sx * 1.1, -5.7, sz * 1.1);
    const b = new THREE.Vector3(sx * 1.7, 0.2, sz * 1.7);
    const d = b.clone().sub(a);
    const r = new THREE.CylinderGeometry(0.07, 0.07, d.length(), 4).toNonIndexed();
    r.deleteAttribute('uv');
    r.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    r.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    const rc = new Float32Array(r.getAttribute('position').count * 3).fill(0.3);
    r.setAttribute('color', new THREE.BufferAttribute(rc, 3));
    parts.push(r);
  }
  return mergeGeometries(parts);
}

interface Balloon {
  mesh: THREE.Mesh;
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  y: number;
  w: number;
  ph: number;
}

// ------------------------------------------------------------------------------------------

export function buildDesertSetPieces(ctx: WorldContext): SetPieceHandle {
  const rng = new Rng(7070);
  const root = new THREE.Group();
  root.name = 'desert';
  ctx.scene.add(root);
  const groundH = (x: number, z: number) => ctx.terrain.heightAt(x, z);
  const rock = strataMaterial();

  // --- colossal landforms (one draw call) ---
  const rimProbe = probe(RAIL_X, southRimZ(RAIL_X), RAIL_DECK.end);
  const butteProbe = probe(BUTTE_PORTAL[0], BUTTE_PORTAL[1], groundH(BUTTE_PORTAL[0], BUTTE_PORTAL[1]) - 1);
  const lf = landforms(groundH, rimProbe, butteProbe).map((l) => mesaGeometry(l.o, groundH, l.probes));
  const lfMesh = new THREE.Mesh(mergeIndexed(lf), rock);
  lfMesh.frustumCulled = false;
  lfMesh.name = 'landforms';
  root.add(lfMesh);

  // --- natural arches ---
  const main = ctx.trails.main;
  const archParts: THREE.BufferGeometry[] = [];
  const hero = ctx.trails.sample(main, 1040);
  {
    const sx = Math.cos(hero.heading);
    const sz = Math.sin(hero.heading);
    const ground = ctx.terrain.heightAt(hero.x, hero.z) - 1.5;
    archParts.push(archGeometry({ x: hero.x, z: hero.z, ground, sx, sz, span: 66, height: 44, thick: 11, depth: 13, seed: 3 }));
    for (const side of [-1, 1]) {
      const lx = hero.x + sx * side * 47;
      const lz = hero.z + sz * side * 47;
      const g = ctx.terrain.heightAt(lx, lz);
      archParts.push(
        mesaGeometry({ pts: ellipseOutline(lx + sx * side * 9, lz + sz * side * 9, 22, 18, hero.heading, side * 5, 10, 0.12), top: g + 14, talus: 0.4, spacing: 4, rowStep: 4, rough: 0.35, seed: 40 + side }, groundH),
      );
      ctx.addCollider(lx, lz, 20, g + 60, 'solid');
      ctx.addCollider(lx + sx * side * 14, lz + sz * side * 14, 22, g + 30, 'solid');
    }
  }
  // a delicate free-standing arch on a slickrock fin, framing the run ahead-left
  {
    const a = ctx.trails.sample(main, 430);
    const fx = Math.sin(a.heading);
    const fz = -Math.cos(a.heading);
    const rx = Math.cos(a.heading);
    const rz = Math.sin(a.heading);
    const cx = a.x - rx * 175;
    const cz = a.z - rz * 175;
    const ground = ctx.terrain.heightAt(cx, cz) + 9;
    archParts.push(archGeometry({ x: cx, z: cz, ground, sx: fx, sz: fz, span: 34, height: 30, thick: 6.5, depth: 7.5, seed: 9 }));
    const fin = ellipseOutline(cx, cz, 48, 20, Math.atan2(fz, fx), 2.2, 10, 0.1);
    archParts.push(mesaGeometry({ pts: fin, top: ground + 2, talus: 0.6, spacing: 5, rowStep: 4, rough: 0.4, seed: 51 }, groundH));
    ctx.addCollider(cx, cz, 30, ground + 40, 'solid');
  }
  const archMesh = new THREE.Mesh(mergeIndexed(archParts), rock);
  archMesh.castShadow = true;
  archMesh.receiveShadow = true;
  archMesh.name = 'arches';
  root.add(archMesh);

  // --- hoodoos ---
  const hoodooGeos = hoodooGeometries();
  const hoodooMats: THREE.Matrix4[][] = hoodooGeos.map(() => []);
  const hm = new THREE.Matrix4();
  const hq = new THREE.Quaternion();
  const hs = new THREE.Vector3();
  const hp = new THREE.Vector3();
  const UPV = new THREE.Vector3(0, 1, 0);
  const placeHoodoo = (x: number, z: number, h: number, w: number, near: boolean) => {
    const ground = groundH(x, z);
    const r = 0.17 * h * w;
    if (near) {
      if (trailDistance(x, z) < 10 + r) return;
      ctx.addCollider(x, z, r * 1.1, ground + h, 'solid');
    }
    hq.setFromAxisAngle(UPV, rng.next() * 6.28);
    hm.compose(hp.set(x, ground - 0.04 * h, z), hq, hs.set(h * w, h, h * w * (0.85 + rng.next() * 0.3)));
    hoodooMats[rng.int(0, hoodooGeos.length - 1)].push(hm.clone());
  };
  const clusters: Array<[number, number, number, number, number, number]> = [
    [150, 72, 7, 26, 12, 26],
    [330, -88, 9, 30, 14, 30],
    [600, 96, 12, 38, 16, 36],
    [770, -118, 10, 38, 14, 30],
    [1290, 112, 14, 44, 16, 40],
    [1500, -158, 12, 42, 18, 38],
    [1900, 122, 10, 34, 12, 28],
    [2150, -112, 10, 34, 12, 26],
    [2380, 92, 8, 28, 10, 24],
  ];
  for (const [s, off, count, spread, h0, h1] of clusters) {
    const c = ctx.trails.sample(main, s);
    const rx = Math.cos(c.heading);
    const rz = Math.sin(c.heading);
    for (let i = 0; i < count; i++) {
      const a = rng.next() * 6.28;
      const d = Math.sqrt(rng.next()) * spread;
      const x = c.x + rx * off + Math.cos(a) * d;
      const z = c.z + rz * off + Math.sin(a) * d;
      placeHoodoo(x, z, h0 + (h1 - h0) * Math.pow(rng.next(), 1.5), 0.8 + rng.next() * 0.5, true);
    }
  }
  // badlands of spires at the foot of the Sunset Mesa and around the east buttes
  for (let i = 0; i < 170; i++) {
    const z = 600 - rng.next() * 3500;
    const x = -620 - rng.next() * 260 + 60 * Math.sin(z / 300);
    placeHoodoo(x, z, 18 + rng.next() * 34, 0.8 + rng.next() * 0.6, false);
  }
  for (let i = 0; i < 60; i++) {
    const z = -300 - rng.next() * 2200;
    const x = 520 + rng.next() * 240;
    placeHoodoo(x, z, 14 + rng.next() * 30, 0.8 + rng.next() * 0.6, false);
  }
  hoodooGeos.forEach((g, v) => {
    const im = new THREE.InstancedMesh(g, paintMaterial({ vertexColors: true }), Math.max(1, hoodooMats[v].length));
    hoodooMats[v].forEach((mm, i) => im.setMatrixAt(i, mm));
    im.count = hoodooMats[v].length;
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    root.add(im);
  });

  // --- river + riparian green ---
  root.add(buildRiver());
  root.add(buildRiparian(groundH, rng));

  // --- railway: out of the East butte tunnel, down the East Valley, over the trestle, into the South Rim ---
  // (the line continues 40 m inside the rock at both ends so cars slide out of / into the dark tunnel mouths)
  const pIn = butteProbe.pos.clone().addScaledVector(butteProbe.normal, -40);
  const pStart = butteProbe.pos.clone().addScaledVector(butteProbe.normal, 3);
  const pEnd = rimProbe.pos.clone().addScaledVector(rimProbe.normal, 3);
  const pOut = rimProbe.pos.clone().addScaledVector(rimProbe.normal, -40);
  const path = planRailway(
    [
      [pIn.x, pIn.z], [pStart.x, pStart.z], [pStart.x + butteProbe.normal.x * 60, pStart.z + butteProbe.normal.z * 60], [1640, -300], [1210, -1150], [RAIL_X - 10, -1900], [RAIL_X, -2700], [RAIL_X + 5, -3200], [pEnd.x, pEnd.z], [pOut.x, pOut.z],
    ],
    groundH,
    RAIL_DECK.start,
    RAIL_DECK.end,
  );
  root.add(
    buildRailway(path, groundH, [
      { pos: butteProbe.pos, out: butteProbe.normal },
      { pos: rimProbe.pos, out: rimProbe.normal },
    ]),
  );
  const train = buildTrain();
  for (const car of train.cars) car.scale.setScalar(TRAIN_SCALE);
  root.add(train.group);
  const steam = new Steam();
  root.add(steam.points);

  // --- hot-air balloons, drifting on slow loops ahead of the run (s = trail arc length they hover beyond) ---
  const balloons: Balloon[] = [];
  const bdefs: Array<{ pal: string[]; band: string; s: number; side: number; rx: number; rz: number; up: number; w: number; ph: number; k: number }> = [
    { pal: ['#e8322a', '#ffd23a'], band: '#2a5ad8', s: 420, side: -90, rx: 70, rz: 50, up: 85, w: 0.02, ph: 0.4, k: 2.4 },
    { pal: ['#2a6ad8', '#ffffff', '#38b6e8'], band: '#ff8a2a', s: 1300, side: 110, rx: 90, rz: 60, up: 110, w: -0.016, ph: 2.2, k: 2.6 },
    { pal: ['#8a3ad0', '#ff7a2a', '#ffd23a', '#2ab07a', '#e8322a'], band: '#ffffff', s: 2380, side: -60, rx: 120, rz: 90, up: 150, w: 0.012, ph: 4.0, k: 3.0 },
  ];
  bdefs.forEach((d, i) => {
    const mesh = new THREE.Mesh(balloonGeometry(d.pal, d.band, i * 5), paintMaterial({ vertexColors: true, saturation: 1.15 }));
    mesh.scale.setScalar(d.k);
    mesh.frustumCulled = false;
    root.add(mesh);
    const p = ctx.trails.sample(main, d.s);
    const cx = p.x + Math.cos(p.heading) * d.side;
    const cz = p.z + Math.sin(p.heading) * d.side;
    balloons.push({ mesh, cx, cz, rx: d.rx, rz: d.rz, y: groundH(cx, cz) + d.up, w: d.w, ph: d.ph });
  });

  const tA = new THREE.Vector3();
  const tB = new THREE.Vector3();
  const tC = new THREE.Vector3();
  const speed = 20;
  const trainLen = (train.offsets[train.offsets.length - 1] + 10) * TRAIN_SCALE;
  const period = path.len + trainLen + 160;
  // phase: the loco crosses the river (≈ 520 m before the rim portal) ~3 minutes into a run, as riders near the rim
  const phase = (((path.len - 520 - 180 * speed) % period) + period) % period;
  return {
    update(dt, time) {
      // train: emerges from the butte tunnel, crosses the trestle, vanishes into the South Rim
      const head = (time * speed + phase) % period;
      let locoVisible = false;
      for (let i = 0; i < train.cars.length; i++) {
        const car = train.cars[i];
        const s = head - train.offsets[i] * TRAIN_SCALE;
        if (s < 1 || s > path.len - 4) {
          car.visible = false;
          continue;
        }
        car.visible = true;
        path.curve.getPointAt(s / path.len, tA);
        path.curve.getPointAt(Math.min(1, (s + 2) / path.len), tB);
        car.position.set(tA.x, railY(path, s) + 0.2, tA.z);
        car.lookAt(tB.x, railY(path, s + 2) + 0.2, tB.z);
        if (i === 0) locoVisible = true;
      }
      const loco = train.cars[0];
      tC.copy(train.chimney).multiplyScalar(TRAIN_SCALE).applyQuaternion(loco.quaternion).add(loco.position);
      steam.update(Math.min(dt, 0.05), locoVisible, tC.x, tC.y, tC.z);
      // balloons drift on slow loops, bobbing gently
      for (let i = 0; i < balloons.length; i++) {
        const b = balloons[i];
        const a = time * b.w + b.ph;
        b.mesh.position.set(b.cx + Math.cos(a) * b.rx, b.y + 9 * Math.sin(time * 0.21 + b.ph * 3), b.cz + Math.sin(a) * b.rz);
        b.mesh.rotation.y = time * 0.03 + b.ph;
      }
    },
  };
}
