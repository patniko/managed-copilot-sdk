import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Noise } from '../../core/noise';
import { Rng } from '../../core/rng';
import { paintMaterial } from '../../render/globals';
import type { SetPieceHandle, WorldContext } from '../types';
import { bankDx, brinkDx, citadelCoast, ridgeX, ridgeY, viaductX, wallEastX, wallNorthZ } from '../envs/citadel';

const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

const noise = new Noise(77);

/** Paint the cliff-city wall: dark violet stone, carved buildings with glowing windows, cascading ivy. */
function paintWall(seed: number) {
  const W = 1024,
    H = 2048;
  const rng = new Rng(seed);
  const a = document.createElement('canvas');
  a.width = W;
  a.height = H;
  const e = document.createElement('canvas');
  e.width = W;
  e.height = H;
  const ctx = a.getContext('2d')!;
  const ex = e.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#5a5c86');
  g.addColorStop(0.35, '#4a4a68');
  g.addColorStop(0.7, '#3e4052');
  g.addColorStop(1, '#353d34');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ex.fillStyle = '#000';
  ex.fillRect(0, 0, W, H);
  // blotchy stone variation
  for (let i = 0; i < 900; i++) {
    const x = rng.next() * W,
      y = rng.next() * H;
    const w = 20 + rng.next() * 120,
      h = 30 + rng.next() * 220;
    const hue = rng.pick(['#5a5470', '#3e3c52', '#6a5a6e', '#4a5248', '#585a78', '#6e6272']);
    ctx.globalAlpha = 0.18 + rng.next() * 0.25;
    ctx.fillStyle = hue;
    ctx.fillRect(x, y, w, h);
  }
  // vertical striations
  for (let i = 0; i < 900; i++) {
    const x = rng.next() * W;
    ctx.globalAlpha = 0.15 + rng.next() * 0.25;
    ctx.fillStyle = rng.chance(0.5) ? '#16203a' : '#6a6aa8';
    ctx.fillRect(x, rng.next() * H, 1 + rng.next() * 3, 60 + rng.next() * 500);
  }
  ctx.globalAlpha = 1;
  // carved buildings with windows
  for (let i = 0; i < 150; i++) {
    const bw = 22 + rng.next() * 70;
    const bh = 40 + rng.next() * 200;
    const bx = rng.next() * (W - bw);
    const by = H * 0.08 + rng.next() * (H * 0.86 - bh);
    ctx.fillStyle = rng.pick(['#5e5a78', '#6a6480', '#4c4a62', '#76708a', '#545068']);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(bx, by, bw, bh);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#2a2838';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);
    const cols = Math.max(1, Math.floor(bw / 17));
    const rows = Math.max(1, Math.floor(bh / 26));
    // windows are kept big enough (2-4 m) to survive the Kuwahara brush; many blocks glow like the painting
    const lit = rng.chance(0.35) ? 0.04 : 0.16 + rng.next() * 0.32;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (rng.chance(0.25)) continue;
        const wx = bx + 4 + c * (bw / cols);
        const wy = by + 5 + r * (bh / rows);
        const ww = Math.max(6, bw / cols - 7);
        const wh = Math.max(9, bh / rows - 9);
        if (rng.next() < lit) {
          const col = rng.pick(['#ff7a1e', '#ff6a18', '#ff8c2c', '#ff7f26', '#ffa040']);
          ctx.fillStyle = col;
          ctx.fillRect(wx, wy, ww, wh);
          ex.fillStyle = col;
          ex.fillRect(wx, wy, ww, wh);
        } else {
          ctx.fillStyle = '#1e1c2a';
          ctx.fillRect(wx, wy, ww, wh);
        }
      }
    // balcony ledge
    ctx.fillStyle = '#7a78b0';
    ctx.fillRect(bx - 2, by + bh - 3, bw + 4, 3);
  }
  // glowing archways and arcades: the warm orange openings that dot the painted cliff city
  const arch = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
    c.beginPath();
    c.moveTo(x, y + h);
    c.lineTo(x, y + w / 2);
    c.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0);
    c.lineTo(x + w, y + h);
    c.closePath();
    c.fill();
  };
  for (let i = 0; i < 70; i++) {
    const aw = 8 + rng.next() * 13;
    const ah = aw * (1.5 + rng.next() * 0.9);
    const ay = H * 0.1 + rng.next() * H * 0.8;
    const n = rng.chance(0.45) ? 2 + Math.floor(rng.next() * 3) : 1;
    const ax = rng.next() * (W - aw * 1.4 * n);
    const glow = rng.pick(['#f2661a', '#ff7a1e', '#e8561a', '#ff6a18']);
    const emit = rng.pick(['#b8460c', '#c44e10', '#a83c0a']);
    for (let k = 0; k < n; k++) {
      const x = ax + k * aw * 1.4;
      ctx.fillStyle = '#221e2e';
      arch(ctx, x - 3, ay - 3, aw + 6, ah + 5);
      ctx.fillStyle = glow;
      arch(ctx, x, ay, aw, ah);
      ex.fillStyle = emit;
      arch(ex, x, ay, aw, ah);
    }
  }
  // cascading ivy: broad hanging curtains from the top plus scattered tendrils
  for (let i = 0; i < 22; i++) {
    let x = rng.next() * W;
    const len = 400 + rng.next() * 1200;
    const w = 40 + rng.next() * 70;
    const col = rng.pick(['#2c6a33', '#3f8a3c', '#24572e', '#4f9a44', '#2e5f3a', '#5aa24a']);
    for (let k = 0; k < len; k += 5) {
      const ww = w * (0.55 + 0.5 * rng.next()) * Math.pow(1 - k / len, 0.6);
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = col;
      ctx.fillRect(x - ww / 2, k, ww, 7);
      if (rng.chance(0.15)) {
        ctx.fillStyle = '#7cc25a';
        ctx.fillRect(x - ww / 2 + rng.next() * ww * 0.5, k, ww * 0.25, 6);
      }
      x += (rng.next() - 0.5) * 6;
    }
  }
  for (let i = 0; i < 120; i++) {
    let x = rng.next() * W;
    const y = rng.next() * H * 0.7;
    const len = 120 + rng.next() * 600;
    const w = 6 + rng.next() * 16;
    const col = rng.pick(['#2c6a33', '#3f8a3c', '#24572e', '#4f9a44', '#2e5f3a']);
    ctx.fillStyle = col;
    for (let k = 0; k < len; k += 6) {
      ctx.globalAlpha = 0.55 + 0.4 * rng.next();
      const ww = w * (0.6 + 0.6 * rng.next()) * (1 - (k / len) * 0.6);
      ctx.fillRect(x - ww / 2, y + k, ww, 8);
      x += (rng.next() - 0.5) * 4;
    }
  }
  ctx.globalAlpha = 1;
  const albedo = new THREE.CanvasTexture(a);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.anisotropy = 8;
  const emissive = new THREE.CanvasTexture(e);
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.wrapS = THREE.RepeatWrapping;
  return { albedo, emissive };
}

/** Points along the citadel wall face (x,z), from far south, up the east side, across the north. */
function wallPath(): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let z = 1600; z >= -2950; z -= 150) pts.push(new THREE.Vector2(wallEastX(z), z));
  const xEnd = wallEastX(-2950);
  // round the corner into the north wall
  pts.push(new THREE.Vector2(xEnd - 120, -3190));
  for (let x = xEnd - 320; x >= -300; x -= 150) pts.push(new THREE.Vector2(x, wallNorthZ(x)));
  return pts;
}

function buildWall(seed: number, farH: (x: number, z: number) => number) {
  const path = new THREE.SplineCurve(wallPath());
  const len = path.getLength();
  const segs = Math.ceil(len / 9);
  const rows = 40;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const topY = 830;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = path.getPointAt(t);
    const tan = path.getTangentAt(t);
    // outward normal faces the playable side (left of travel)
    const nx = tan.y;
    const nz = -tan.x;
    const s = t * len;
    const base = farH(p.x + nx * 45, p.y + nz * 45) - 30;
    const buttress = Math.pow(Math.max(0, Math.sin((s / 95) * Math.PI)), 6) * 22;
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      const y = base + (topY + 25 * noise.noise2(s / 300, 3) - base) * v;
      // tall vertical rock ribs + recessed bays (the cliff city is carved into fluted rock)
      const ribs = 18 * noise.fbm(s / 38, y / 420, 3) + 10 * Math.abs(noise.noise2(s / 16, y / 260));
      const relief = ribs + 10 * noise.fbm(s / 120, y / 90, 2) + buttress * (1 - v * 0.3) + 14 * Math.pow(1 - v, 3);
      pos.push(p.x + nx * relief, y, p.y + nz * relief);
      uv.push(s / 300, y / 900);
    }
  }
  for (let i = 0; i < segs; i++)
    for (let j = 0; j < rows; j++) {
      const a = i * (rows + 1) + j;
      const b = a + rows + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const tex = paintWall(seed);
  const mat = paintMaterial({ color: 0xc8c4dc, map: tex.albedo, emissiveMap: tex.emissive, emissive: 0xffffff, emissiveIntensity: 2.4, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  return { mesh, path, len, topY };
}

function coloredGeo(g: THREE.BufferGeometry, c: THREE.Color, shadeBottom = 0.75, height = 1) {
  const p = g.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - bb.min.y) / Math.max(1e-3, (bb.max.y - bb.min.y) * height);
    const k = shadeBottom + (1 - shadeBottom) * Math.min(1, t);
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Pale gothic facade: lancet windows (some glowing), string courses, pilasters. Bottom-left corner is plain stone. */
let facadeCache: { albedo: THREE.CanvasTexture; emissive: THREE.CanvasTexture } | null = null;
function paintFacade() {
  if (facadeCache) return facadeCache;
  const W = 512,
    H = 1024;
  const rng = new Rng(31);
  const a = document.createElement('canvas');
  a.width = W;
  a.height = H;
  const e = document.createElement('canvas');
  e.width = W;
  e.height = H;
  const ctx = a.getContext('2d')!;
  const ex = e.getContext('2d')!;
  ctx.fillStyle = '#f4f2f8';
  ctx.fillRect(0, 0, W, H);
  ex.fillStyle = '#000';
  ex.fillRect(0, 0, W, H);
  for (let i = 0; i < 300; i++) {
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = rng.chance(0.5) ? '#c9c6d8' : '#ffffff';
    ctx.fillRect(rng.next() * W, rng.next() * H, 10 + rng.next() * 60, 10 + rng.next() * 90);
  }
  ctx.globalAlpha = 1;
  const cols = 4,
    rows = 10;
  const mx = 40,
    my = 40;
  const cw = (W - mx * 2) / cols;
  const rh = (H - my * 2) / rows;
  for (let r = 0; r < rows; r++) {
    ctx.fillStyle = '#b9b6cc';
    ctx.fillRect(mx - 10, my + r * rh - 4, W - 2 * mx + 20, 6);
    for (let c = 0; c < cols; c++) {
      const x = mx + c * cw + cw * 0.22;
      const y = my + r * rh + rh * 0.16;
      const w = cw * 0.56;
      const h = rh * 0.7;
      const glow = rng.chance(0.14);
      const path = new Path2D();
      path.moveTo(x, y + h);
      path.lineTo(x, y + w * 0.6);
      path.quadraticCurveTo(x, y, x + w / 2, y - w * 0.15);
      path.quadraticCurveTo(x + w, y, x + w, y + w * 0.6);
      path.lineTo(x + w, y + h);
      path.closePath();
      ctx.fillStyle = glow ? '#ffab4a' : '#3c4470';
      ctx.fill(path);
      ctx.strokeStyle = '#d6d3e4';
      ctx.lineWidth = 4;
      ctx.stroke(path);
      if (glow) {
        ex.fillStyle = '#ffab4a';
        ex.fill(path);
      }
    }
  }
  for (let c = 0; c <= cols; c++) {
    ctx.fillStyle = '#d2cfe0';
    ctx.fillRect(mx + c * cw - 5, my - 10, 10, H - 2 * my + 20);
  }
  // plain corner for decorative parts
  ctx.fillStyle = '#f4f2f8';
  ctx.fillRect(0, H - 30, 30, 30);
  const albedo = new THREE.CanvasTexture(a);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.anisotropy = 8;
  const emissive = new THREE.CanvasTexture(e);
  emissive.colorSpace = THREE.SRGBColorSpace;
  facadeCache = { albedo, emissive };
  return facadeCache;
}

function plainUV(g: THREE.BufferGeometry) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.02, 0.02);
  return g;
}

function towerMaterial() {
  const f = paintFacade();
  return paintMaterial({ vertexColors: true, map: f.albedo, emissiveMap: f.emissive, emissive: 0xffffff, emissiveIntensity: 1.4 });
}

/** Gothic tower: pale stone shaft, buttress ribs, spire cluster. Returns non-indexed coloured geometry. */
function gothicTower(h: number, w: number, rng: Rng): THREE.BufferGeometry {
  const stone = new THREE.Color('#dcd8e6');
  const parts: THREE.BufferGeometry[] = [];
  const shaft = new THREE.BoxGeometry(w, h, w * 0.8);
  shaft.translate(0, h / 2, 0);
  parts.push(coloredGeo(shaft, stone, 0.7));
  for (const sx of [-1, 1]) {
    const rib = new THREE.BoxGeometry(w * 0.12, h * 1.02, w * 0.95);
    rib.translate((sx * w) / 2, h * 0.51, 0);
    parts.push(plainUV(coloredGeo(rib, stone.clone().multiplyScalar(1.05), 0.7)));
  }
  // spires
  const main = new THREE.ConeGeometry(w * 0.32, h * 0.55, 8);
  main.translate(0, h + h * 0.275, 0);
  parts.push(plainUV(coloredGeo(main, stone, 0.9)));
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const ph = h * (0.22 + rng.next() * 0.08);
    const pin = new THREE.ConeGeometry(w * 0.1, ph, 6);
    pin.translate(sx * w * 0.42, h + ph / 2, sz * w * 0.32);
    parts.push(plainUV(coloredGeo(pin, stone, 0.9)));
    const post = new THREE.BoxGeometry(w * 0.14, h * 0.08, w * 0.14);
    post.translate(sx * w * 0.42, h + h * 0.04 - 0.5, sz * w * 0.32);
    parts.push(plainUV(coloredGeo(post, stone, 0.9)));
  }
  // mid-level gallery
  const gal = new THREE.BoxGeometry(w * 1.15, h * 0.025, w * 0.95);
  gal.translate(0, h * 0.62, 0);
  parts.push(plainUV(coloredGeo(gal, stone.clone().multiplyScalar(1.08), 0.9)));
  return mergeGeometries(parts.map((p) => ni(p)));
}

/** Pointed (gothic) arch shape. */
function archShape(w: number, h: number): THREE.Shape {
  const s = new THREE.Shape();
  const r = w * 0.8;
  s.moveTo(-w / 2, 0);
  s.lineTo(-w / 2, h - w * 0.6);
  s.absarc(-w / 2 + r, h - w * 0.6, r, Math.PI, Math.PI - Math.acos((r - w / 2) / r) + 0.0001, true);
  s.lineTo(0, h);
  s.absarc(w / 2 - r, h - w * 0.6, r, Math.acos((r - w / 2) / r), 0, true);
  s.lineTo(w / 2, 0);
  s.lineTo(-w / 2, 0);
  return s;
}

function buildViaduct(farH: (x: number, z: number) => number, rng: Rng, addCollider: (x: number, z: number, r: number, top: number) => void) {
  const ctrl: THREE.Vector3[] = [];
  // hugs the ravine right beside the trail, then curves away into a portal in the citadel wall
  for (let z = 1500; z >= -300; z -= 150) ctrl.push(new THREE.Vector3(viaductX(z), 0, z));
  ctrl.push(new THREE.Vector3(viaductX(-470) + 40, 0, -470));
  ctrl.push(new THREE.Vector3(viaductX(-680) + 96, 0, -680));
  const portalZ = -860;
  ctrl.push(new THREE.Vector3(wallEastX(portalZ) - 36, 0, portalZ));
  ctrl.push(new THREE.Vector3(wallEastX(portalZ) + 30, 0, portalZ - 12));
  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
  const len = curve.getLength();
  const deckY = (t: number) => {
    const p = curve.getPointAt(t);
    const zz = Math.max(p.z, -800);
    return ridgeY(zz) + 9.5;
  };
  const span = 24;
  const n = Math.floor(len / span);
  const stone = new THREE.Color('#cbc2b0');
  const parts: THREE.BufferGeometry[] = [];
  const width = 9;
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const a = curve.getPointAt(t0);
    const b = curve.getPointAt(t1);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const yd = deckY((t0 + t1) / 2);
    const ground = Math.min(farH(a.x, a.z), farH(b.x, b.z), farH(mid.x, mid.z)) - 4;
    const tall = yd - ground;
    if (tall < 3) continue;
    addCollider(a.x, a.z, 4.2, yd);
    const L = a.distanceTo(b) + 0.4;
    const outline = new THREE.Shape();
    outline.moveTo(-L / 2, 0);
    outline.lineTo(L / 2, 0);
    outline.lineTo(L / 2, tall);
    outline.lineTo(-L / 2, tall);
    outline.lineTo(-L / 2, 0);
    const pier = 3.6;
    const archW = L - pier * 2;
    if (tall > 48) {
      const lowerH = tall - 20;
      outline.holes.push(new THREE.Path(archShape(archW, lowerH).getPoints(10)));
      const up = archShape(archW * 0.8, 12).getPoints(8).map((p) => new THREE.Vector2(p.x, p.y + lowerH + 3));
      outline.holes.push(new THREE.Path(up));
    } else if (tall > 9) {
      outline.holes.push(new THREE.Path(archShape(archW, tall - 4.5).getPoints(10)));
    }
    const g = new THREE.ExtrudeGeometry(outline, { depth: width, bevelEnabled: false, curveSegments: 6 });
    g.translate(0, 0, -width / 2);
    const dir = b.clone().sub(a);
    const ang = Math.atan2(-dir.z, dir.x);
    g.rotateY(ang);
    g.translate(mid.x, ground, mid.z);
    parts.push(viaductShade(ni(g), stone, new THREE.Vector3(-dir.z, 0, dir.x).normalize()));
    // parapet
    for (const side of [-1, 1]) {
      const par = new THREE.BoxGeometry(L, 1.3, 0.5);
      par.rotateY(ang);
      const off = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar((side * (width - 0.5)) / 2);
      par.translate(mid.x + off.x, yd + 0.65, mid.z + off.z);
      parts.push(coloredGeo(ni(par), stone.clone().multiplyScalar(1.05), 0.9));
    }
  }
  const geo = mergeGeometries(parts);
  const mesh = new THREE.Mesh(geo, paintMaterial({ vertexColors: true }));
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  void rng;
  return { mesh, curve, deckY, len };
}


/** Viaduct colouring: darker, cooler arch interiors and piers bases (fake ambient occlusion). */
function viaductShade(g: THREE.BufferGeometry, c: THREE.Color, perp: THREE.Vector3) {
  g.computeVertexNormals();
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const p = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const col = new Float32Array(p.count * 3);
  const shade = new THREE.Color('#8f8fb8');
  for (let i = 0; i < p.count; i++) {
    const face = Math.abs(nrm.getX(i) * perp.x + nrm.getZ(i) * perp.z);
    const inner = face < 0.5 && nrm.getY(i) < 0.5 ? 1 : 0;
    const t = (p.getY(i) - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    const k = 0.55 + 0.45 * Math.min(1, t * 1.4);
    const r = c.r * k,
      gg = c.g * k,
      b = c.b * k;
    const m = inner ? 0.55 : 0;
    col[i * 3] = r + (shade.r * k * 0.7 - r) * m;
    col[i * 3 + 1] = gg + (shade.g * k * 0.7 - gg) * m;
    col[i * 3 + 2] = b + (shade.b * k * 0.7 - b) * m;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function buildTrain(): THREE.Group {
  const g = new THREE.Group();
  const body = paintMaterial({ color: '#2e44c4' });
  const roof = paintMaterial({ color: '#dfe6f7' });
  const glow = paintMaterial({ color: '#2a2f60', emissive: '#bfe0ff', emissiveIntensity: 1.2 });
  for (let i = 0; i < 6; i++) {
    const car = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(3.1, 3.2, 15), body);
    b.position.y = 2.2;
    const r = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 15, 12, 1, false, -Math.PI / 2, Math.PI), roof);
    r.rotation.x = Math.PI / 2;
    r.scale.set(1, 1, 0.45);
    r.position.y = 3.8;
    const w = new THREE.Mesh(new THREE.BoxGeometry(3.15, 0.8, 13.5), glow);
    w.position.y = 2.7;
    car.add(b, r, w);
    car.userData.offset = i * 15.8;
    g.add(car);
  }
  return g;
}

function buildSpireCity(farH: (x: number, z: number) => number, rng: Rng, addCollider: (x: number, z: number, r: number, top: number) => void): THREE.Group {
  const group = new THREE.Group();
  const variants = [0, 1, 2].map((v) => {
    const r = new Rng(900 + v);
    return gothicTower(1, 0.3 + v * 0.08, r);
  });
  const mats = towerMaterial();
  const placements: THREE.Matrix4[][] = [[], [], []];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  // clustered city at the foot of the north wall + a grand cathedral
  for (let i = 0; i < 140; i++) {
    const cx = rng.gauss() * 260 + 60;
    const cz = wallNorthZ(cx) + 70 + Math.abs(rng.gauss()) * 260;
    const h = 40 + Math.pow(rng.next(), 2) * 150;
    const y = farH(cx, cz) - 2;
    q.setFromAxisAngle(up, rng.next() * Math.PI);
    m.compose(new THREE.Vector3(cx, y, cz), q, new THREE.Vector3(h, h, h));
    placements[i % 3].push(m.clone());
  }
  // spire town on the misty terrace just below the brink (seen down-left of the trail, like the painting)
  const region = citadelCoast.terrain.region;
  for (let i = 0; i < 90; i++) {
    const cz = 60 - rng.next() * 2100;
    const cx = ridgeX(cz) + brinkDx(cz) - 165 - rng.next() * 300;
    const h = 26 + Math.pow(rng.next(), 2) * 70;
    const w = 0.3 + (i % 3) * 0.08;
    const y = farH(cx, cz) - 8;
    q.setFromAxisAngle(up, rng.next() * Math.PI);
    m.compose(new THREE.Vector3(cx, y, cz), q, new THREE.Vector3(h, h, h));
    placements[i % 3].push(m.clone());
    if (cx > region.minX && cx < region.maxX) addCollider(cx, cz, h * w * 0.62, y + h * 1.4);
  }
  variants.forEach((geo, v) => {
    const im = new THREE.InstancedMesh(geo, mats, placements[v].length);
    placements[v].forEach((mm, i) => im.setMatrixAt(i, mm));
    im.frustumCulled = false;
    group.add(im);
  });
  // grand cathedral against the north wall
  const cat = gothicTower(260, 70, new Rng(5));
  const cx = 40;
  const cz = wallNorthZ(cx) + 40;
  cat.translate(cx, farH(cx, cz) - 5, cz);
  group.add(new THREE.Mesh(cat, mats));
  return group;
}

function buildVillages(farH: (x: number, z: number) => number, rng: Rng): THREE.Group {
  const group = new THREE.Group();
  const house = new THREE.BoxGeometry(1, 0.8, 1.3);
  house.translate(0, 0.4, 0);
  const roof = new THREE.ConeGeometry(0.85, 0.6, 4);
  roof.rotateY(Math.PI / 4);
  roof.scale(1, 1, 1.35);
  roof.translate(0, 1.1, 0);
  const wallMat = paintMaterial({ color: '#efe4cf' });
  const roofMat = paintMaterial({ color: '#d4673a', saturation: 1.15 });
  const mats: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const clusters = [
    [ridgeX(-250) - 330, -250],
    [ridgeX(-700) - 380, -700],
    [ridgeX(-1150) - 400, -1150],
    [-760, -2500],
    [-980, -1900],
    [-880, -900],
    [-300, -3000],
    [250, -3050],
    [-1150, -2900],
    [-1000, -350],
  ];
  for (const [ccx, ccz] of clusters) {
    const count = 30 + rng.int(0, 40);
    for (let i = 0; i < count; i++) {
      const x = ccx + rng.gauss() * 90;
      const z = ccz + rng.gauss() * 90;
      const y = farH(x, z);
      if (y < 3) continue;
      const s = 6 + rng.next() * 7;
      q.setFromAxisAngle(up, rng.next() * Math.PI);
      m.compose(new THREE.Vector3(x, y - 0.5, z), q, new THREE.Vector3(s, s, s));
      mats.push(m.clone());
    }
  }
  const w = new THREE.InstancedMesh(house, wallMat, mats.length);
  const r = new THREE.InstancedMesh(roof, roofMat, mats.length);
  mats.forEach((mm, i) => {
    w.setMatrixAt(i, mm);
    r.setMatrixAt(i, mm);
    r.setColorAt(i, new THREE.Color().setHSL(0.03 + rng.next() * 0.04, 0.65, 0.5 + rng.next() * 0.12));
  });
  w.frustumCulled = r.frustumCulled = false;
  group.add(w, r);
  return group;
}

function mistTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 150, 10, 128, 140, 128);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  return t;
}

function buildMist(farH: (x: number, z: number) => number, rng: Rng): THREE.Group {
  const group = new THREE.Group();
  const tex = mistTexture();
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color('#b4a8ff').multiplyScalar(1.1), transparent: true, opacity: 0.3, depthWrite: false, fog: false });
  const geo = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < 26; i++) {
    const x = -200 + rng.gauss() * 450;
    const z = -2900 + rng.gauss() * 380;
    const w = 500 + rng.next() * 700;
    const h = 120 + rng.next() * 160;
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(w, h, 1);
    m.position.set(x, farH(x, z) + h * 0.3, z);
    m.userData.billboard = true;
    m.renderOrder = 2;
    group.add(m);
  }
  return group;
}

function buildOutcrops(ctx: WorldContext, rng: Rng): THREE.Group {
  const group = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [];
  const sand = new THREE.Color('#bcae80');
  const moss = new THREE.Color('#5d8a35');
  const spots: Array<[number, number, number]> = [];
  for (let z = -420; z > -2300; z -= 150 + rng.next() * 170) {
    // layered rocks on the ledge near the right bank and at the left brink (kept clear of the opening view)
    spots.push([ridgeX(z) + bankDx(z) - 7 - rng.next() * 8, z, 5 + rng.next() * 6]);
    if (rng.chance(0.5)) spots.push([ridgeX(z - 60) + brinkDx(z - 60) + 5 + rng.next() * 4, z - 60, 4 + rng.next() * 4]);
  }
  for (const [x, z, s] of spots) {
    const h = ctx.terrain.heightAt(x, z);
    const layers = 3 + rng.int(0, 3);
    let y = h - s * 0.3;
    for (let k = 0; k < layers; k++) {
      const lw = s * (1.4 - k * 0.18) * (0.8 + rng.next() * 0.4);
      const lh = s * (0.32 + rng.next() * 0.2);
      const b = new THREE.BoxGeometry(lw, lh, lw * (0.7 + rng.next() * 0.4), 3, 2, 3);
      const p = b.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const d = 1 + 0.12 * noise.noise3(p.getX(i) * 0.4 + x, p.getY(i) * 0.4, p.getZ(i) * 0.4 + z);
        p.setXYZ(i, p.getX(i) * d, p.getY(i), p.getZ(i) * d);
      }
      b.rotateY(rng.next() * Math.PI);
      b.translate(x + (rng.next() - 0.5) * s * 0.3, y + lh / 2, z + (rng.next() - 0.5) * s * 0.3);
      const nb = ni(b);
      nb.computeVertexNormals();
      const nrm = nb.getAttribute('normal');
      const pp = nb.getAttribute('position');
      const col = new Float32Array(pp.count * 3);
      for (let i = 0; i < pp.count; i++) {
        const top = nrm.getY(i) > 0.6;
        const c = top ? moss : sand;
        const k2 = 0.8 + 0.25 * Math.max(0, nrm.getY(i)) + 0.08 * noise.noise2(pp.getX(i), pp.getY(i));
        col[i * 3] = c.r * k2;
        col[i * 3 + 1] = c.g * k2;
        col[i * 3 + 2] = c.b * k2;
      }
      nb.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(nb);
      y += lh * 0.92;
    }
    ctx.addCollider(x, z, s * 0.7, h + s * 2, 'solid');
  }
  const mesh = new THREE.Mesh(mergeGeometries(parts), paintMaterial({ vertexColors: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

function buildColonnade(path: THREE.SplineCurve, len: number, topY: number): THREE.Group {
  const group = new THREE.Group();
  const marble = paintMaterial({ color: '#f1ede4' });
  const colGeo = new THREE.CylinderGeometry(3.2, 3.6, 70, 12);
  colGeo.translate(0, 35, 0);
  const mats: THREE.Matrix4[] = [];
  const beams: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  // stretch along the east wall near the start (in view from the meadow)
  const s0 = len * 0.08;
  const s1 = len * 0.42;
  const step = 15;
  for (let s = s0; s < s1; s += step) {
    const t = s / len;
    const p = path.getPointAt(t);
    const tan = path.getTangentAt(t);
    const nx = tan.y,
      nz = -tan.x;
    const x = p.x - nx * 22;
    const z = p.y - nz * 22;
    m.makeTranslation(x, topY + 4, z);
    mats.push(m.clone());
  }
  const segs = 40;
  for (let k = 0; k < segs; k++) {
    const ta = (s0 + ((s1 - s0) * k) / segs) / len;
    const tb = (s0 + ((s1 - s0) * (k + 1)) / segs) / len;
    const a = path.getPointAt(ta);
    const b = path.getPointAt(tb);
    const tan = path.getTangentAt(ta);
    const nx = tan.y,
      nz = -tan.x;
    const L = a.distanceTo(b) + 0.5;
    const ang = Math.atan2(-(b.y - a.y), b.x - a.x);
    for (const [yOff, hh, dd] of [
      [topY + 76, 9, 14],
      [topY + 2, 5, 18],
    ]) {
      const beam = new THREE.BoxGeometry(L, hh, dd);
      beam.rotateY(ang);
      beam.translate((a.x + b.x) / 2 - nx * 22, yOff, (a.y + b.y) / 2 - nz * 22);
      beams.push(ni(beam));
    }
  }
  const im = new THREE.InstancedMesh(colGeo, marble, mats.length);
  mats.forEach((mm, i) => im.setMatrixAt(i, mm));
  im.frustumCulled = false;
  group.add(im);
  group.add(new THREE.Mesh(mergeGeometries(beams), marble));
  return group;
}

export function buildCitadelSetPieces(ctx: WorldContext): SetPieceHandle {
  const farH = citadelCoast.terrain.farHeight;
  const rng = new Rng(4040);
  const root = new THREE.Group();
  root.name = 'citadel';
  ctx.scene.add(root);

  const wall = buildWall(11, farH);
  root.add(wall.mesh);
  root.add(buildColonnade(wall.path, wall.len, wall.topY));

  // gothic towers against the wall face
  const towerMat = towerMaterial();
  const glowMat = paintMaterial({ color: '#2a1606', emissive: '#ffa040', emissiveIntensity: 2.4 });
  const towers: THREE.BufferGeometry[] = [];
  const glows: THREE.BufferGeometry[] = [];
  const towerSpots = [0.16, 0.235, 0.33, 0.45, 0.58, 0.7, 0.8, 0.9];
  for (const t of towerSpots) {
    const p = wall.path.getPointAt(t);
    const tan = wall.path.getTangentAt(t);
    const nx = tan.y,
      nz = -tan.x;
    const base = farH(p.x + nx * 60, p.y + nz * 60) - 10;
    const h = wall.topY - base + 40 + rng.next() * 120;
    const w = 38 + rng.next() * 18;
    const g = gothicTower(h, w, rng);
    const ang = Math.atan2(nx, nz);
    g.rotateY(ang);
    g.translate(p.x + nx * 20, base, p.y + nz * 20);
    towers.push(g);
    // glowing pointed portals at a few heights
    for (const fy of [0.25, 0.52, 0.74]) {
      if (rng.chance(0.35)) continue;
      const aw = w * 0.42;
      const ah = aw * 1.9;
      const sg = new THREE.ShapeGeometry(archShape(aw, ah), 6);
      sg.rotateY(ang);
      const yy = base + h * fy;
      sg.translate(p.x + nx * (20 + w * 0.41), yy, p.y + nz * (20 + w * 0.41));
      glows.push(sg);
    }
  }
  const towerMesh = new THREE.Mesh(mergeGeometries(towers), towerMat);
  towerMesh.frustumCulled = false;
  root.add(towerMesh);
  const glowMesh = new THREE.Mesh(mergeGeometries(glows), glowMat);
  glowMesh.material.side = THREE.DoubleSide;
  glowMesh.frustumCulled = false;
  root.add(glowMesh);

  const via = buildViaduct(farH, rng, (x, z, r, top) => ctx.addCollider(x, z, r, top, 'solid'));
  root.add(via.mesh);
  // railway portal tower where the viaduct enters the wall
  {
    const t = 0.995;
    const p = via.curve.getPointAt(t);
    const g = gothicTower(380, 60, new Rng(3));
    g.translate(p.x + 20, via.deckY(t) - 180, p.z);
    root.add(new THREE.Mesh(g, towerMat));
    const portal = new THREE.Mesh(new THREE.ShapeGeometry(archShape(16, 22), 6), glowMat);
    portal.position.set(p.x - 11, via.deckY(t) - 1, p.z);
    portal.rotation.y = -Math.PI / 2;
    root.add(portal);
  }
  const train = buildTrain();
  root.add(train);

  root.add(buildSpireCity(farH, rng, (x, z, r, top) => ctx.addCollider(x, z, r, top, 'solid')));
  root.add(buildVillages(farH, rng));
  const mist = buildMist(farH, rng);
  root.add(mist);
  root.add(buildOutcrops(ctx, rng));

  let trainS = 0.15;
  const tmp = new THREE.Vector3();
  const look = new THREE.Vector3();
  // sampled viaduct curve for nearest-point queries (the train runs alongside the rider, like the painting)
  const SAMPLES = 600;
  const curvePts: THREE.Vector3[] = [];
  for (let i = 0; i <= SAMPLES; i++) curvePts.push(via.curve.getPointAt(i / SAMPLES));
  let syncT = 0;
  return {
    update(dt, _time, camera) {
      syncT -= dt;
      if (syncT <= 0) {
        syncT = 0.5;
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i <= SAMPLES; i++) {
          const p = curvePts[i];
          const d = (p.x - camera.position.x) ** 2 + (p.z - camera.position.z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i / SAMPLES;
          }
        }
        // keep the train within sight of the camera: respawn it just behind when it drifts far away
        if (bestD < 400 * 400 && best < 0.9 && (trainS - best) * via.len < -40) trainS = best + 75 / via.len;
      }
      trainS += (dt * 10.5) / via.len;
      if (trainS > 1.02) trainS = 0;
      for (const car of train.children) {
        const t = trainS - car.userData.offset / via.len;
        if (t < 0 || t > 0.985) {
          car.visible = false;
          continue;
        }
        car.visible = true;
        via.curve.getPointAt(t, tmp);
        car.position.set(tmp.x, via.deckY(t) + 0.2, tmp.z);
        via.curve.getPointAt(Math.min(1, t + 0.002), look);
        car.lookAt(look.x, via.deckY(Math.min(1, t + 0.002)) + 0.2, look.z);
      }
      for (const m of mist.children) {
        const dx = camera.position.x - m.position.x;
        const dz = camera.position.z - m.position.z;
        m.rotation.y = Math.atan2(dx, dz);
      }
    },
  };
}
