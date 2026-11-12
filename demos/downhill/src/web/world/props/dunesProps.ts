import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../../core/rng';

const UP = new THREE.Vector3(0, 1, 0);

/** Flat vertex colour (with optional vertical shading ramp) on a non-indexed copy without UVs. */
export function paint(g: THREE.BufferGeometry, hex: string, top = 1, bottom = 1): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const p = ng.getAttribute('position');
  ng.computeBoundingBox();
  const bb = ng.boundingBox!;
  const c = new THREE.Color(hex);
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    const k = bottom + (top - bottom) * t;
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!ng.getAttribute('normal')) ng.computeVertexNormals();
  return ng;
}

function beam(a: THREE.Vector3, b: THREE.Vector3, th: number, hex: string): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.BoxGeometry(th, d.length(), th);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return paint(g, hex);
}

// ------------------------------------------------------------------------------------------
// Lighthouse
// ------------------------------------------------------------------------------------------

export interface LighthouseParts {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  /** Height of the lamp above the base. */
  lampY: number;
}

/** Red-and-white banded tower with gallery, lantern room, cap and a keeper's cottage. Origin = base centre. */
export function lighthouseGeometry(): LighthouseParts {
  const H = 40;
  const r0 = 5.6;
  const r1 = 3.9;
  const parts: THREE.BufferGeometry[] = [];
  const plinth = new THREE.CylinderGeometry(7.4, 8, 3.2, 10);
  plinth.translate(0, 1.0, 0);
  parts.push(paint(plinth, '#e9e4da', 1.05, 0.8));
  const bands = 7;
  for (let i = 0; i < bands; i++) {
    const y0 = 2.6 + (i * (H - 2.6)) / bands;
    const y1 = 2.6 + ((i + 1) * (H - 2.6)) / bands;
    const ra = r0 + (r1 - r0) * ((y0 - 2.6) / (H - 2.6));
    const rb = r0 + (r1 - r0) * ((y1 - 2.6) / (H - 2.6));
    const c = new THREE.CylinderGeometry(rb, ra, y1 - y0, 24);
    c.translate(0, (y0 + y1) / 2, 0);
    parts.push(paint(c, i % 2 === 0 ? '#e8392e' : '#fbf7ef', 1.04, 0.92));
  }
  // windows
  for (let i = 0; i < 4; i++) {
    const y = 9 + i * 8;
    const r = r0 + (r1 - r0) * ((y - 2.6) / (H - 2.6));
    const w = new THREE.BoxGeometry(0.9, 1.6, 0.5);
    const a = i * 1.7 + 0.4;
    w.translate(0, 0, r - 0.05);
    w.rotateY(a);
    w.translate(0, y, 0);
    parts.push(paint(w, '#2b3550'));
  }
  // gallery deck + railing
  const deck = new THREE.CylinderGeometry(5.6, 4.6, 1.0, 24);
  deck.translate(0, H + 0.5, 0);
  parts.push(paint(deck, '#2a2c34'));
  const rail = new THREE.CylinderGeometry(5.45, 5.45, 1.4, 24, 1, true);
  rail.translate(0, H + 1.7, 0);
  parts.push(paint(rail, '#20222a'));
  // lantern room frame + roof
  const base = new THREE.CylinderGeometry(3.3, 3.3, 1.4, 16);
  base.translate(0, H + 1.7, 0);
  parts.push(paint(base, '#fbf7ef'));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    parts.push(beam(new THREE.Vector3(Math.cos(a) * 3.0, H + 2.4, Math.sin(a) * 3.0), new THREE.Vector3(Math.cos(a) * 3.0, H + 6.6, Math.sin(a) * 3.0), 0.28, '#1f2028'));
  }
  const roof = new THREE.ConeGeometry(3.9, 3.4, 16);
  roof.translate(0, H + 8.3, 0);
  parts.push(paint(roof, '#d8322a', 1.1, 0.8));
  const vent = new THREE.SphereGeometry(0.75, 10, 8);
  vent.translate(0, H + 10.2, 0);
  parts.push(paint(vent, '#20222a'));
  const rod = new THREE.CylinderGeometry(0.08, 0.08, 2.2, 5);
  rod.translate(0, H + 11.6, 0);
  parts.push(paint(rod, '#20222a'));
  // keeper's cottage
  const house = new THREE.BoxGeometry(12, 5.5, 8);
  house.translate(-12.5, 2.75, 3);
  parts.push(paint(house, '#f4efe4', 1.04, 0.86));
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-4.8, 0);
  roofShape.lineTo(4.8, 0);
  roofShape.lineTo(0, 3.6);
  roofShape.lineTo(-4.8, 0);
  const hr = new THREE.ExtrudeGeometry(roofShape, { depth: 13, bevelEnabled: false });
  hr.translate(0, 0, -6.5);
  hr.rotateY(Math.PI / 2);
  hr.translate(-12.5, 5.5, 3);
  parts.push(paint(hr, '#d8452e', 1.08, 0.86));
  const chimney = new THREE.BoxGeometry(1.2, 2.6, 1.2);
  chimney.translate(-16, 8, 4);
  parts.push(paint(chimney, '#b8483a'));
  for (const dx of [-15.5, -12.5, -9.5]) {
    const w = new THREE.BoxGeometry(1.4, 1.6, 0.3);
    w.translate(dx, 3.2, 7.05);
    parts.push(paint(w, '#2f4a7a'));
  }
  const door = new THREE.BoxGeometry(1.5, 2.6, 0.3);
  door.translate(-7.0, 1.3, 7.05);
  parts.push(paint(door, '#2a6aa8'));
  const glass = paint(new THREE.CylinderGeometry(2.9, 2.9, 4.2, 16, 1, true), '#fff1b8');
  glass.translate(0, H + 4.6, 0);
  return { body: mergeGeometries(parts), glass, lampY: H + 4.6 };
}

// ------------------------------------------------------------------------------------------
// Sailboats
// ------------------------------------------------------------------------------------------

/** Hull (pointed bow toward +Z) + mast + curved mainsail + jib. Origin at the waterline centre. */
export function sailboatGeometry(hull: string, stripe: string, sail: string, sailStripe: string | null): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // hull: lofted cross-sections, sharp bow, transom stern
  const L = 11;
  const secs = 8;
  const pos: number[] = [];
  const col: number[] = [];
  const hc = new THREE.Color(hull);
  const sc = new THREE.Color(stripe);
  const ring: THREE.Vector3[][] = [];
  for (let i = 0; i <= secs; i++) {
    const t = i / secs;
    const z = -L / 2 + t * L;
    const w = 1.6 * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, t - 0.45) / 0.55, 2))) * (0.8 + 0.2 * (1 - t));
    const d = 1.0 * (0.7 + 0.3 * Math.sin(t * Math.PI));
    const sheer = 1.0 + 0.35 * t * t;
    ring.push([new THREE.Vector3(-w, sheer, z), new THREE.Vector3(-w * 0.85, 0.15, z), new THREE.Vector3(0, -d, z), new THREE.Vector3(w * 0.85, 0.15, z), new THREE.Vector3(w, sheer, z)]);
  }
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, cc: THREE.Color) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let k = 0; k < 3; k++) col.push(cc.r, cc.g, cc.b);
  };
  for (let i = 0; i < secs; i++)
    for (let j = 0; j < 4; j++) {
      const a = ring[i][j];
      const b = ring[i][j + 1];
      const c = ring[i + 1][j];
      const d = ring[i + 1][j + 1];
      const cc = j === 0 || j === 3 ? sc : hc;
      tri(a, c, b, cc);
      tri(b, c, d, cc);
    }
  // deck + transom
  const deckC = new THREE.Color('#d9b68a');
  for (let i = 0; i < secs; i++) {
    tri(ring[i][0], ring[i][4], ring[i + 1][0], deckC);
    tri(ring[i][4], ring[i + 1][4], ring[i + 1][0], deckC);
  }
  for (let j = 0; j < 4; j++) tri(ring[0][j], ring[0][j + 1], new THREE.Vector3(0, 0.6, -L / 2), hc);
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  hg.computeVertexNormals();
  parts.push(hg);
  // cabin
  const cabin = new THREE.BoxGeometry(1.8, 0.7, 3);
  cabin.translate(0, 1.4, -0.8);
  parts.push(paint(cabin, '#f6f2ea', 1.05, 0.85));
  // mast + boom
  const mast = new THREE.CylinderGeometry(0.09, 0.12, 15, 6);
  mast.translate(0, 8.5, 1.2);
  parts.push(paint(mast, '#cfc8bc'));
  const boom = new THREE.CylinderGeometry(0.07, 0.07, 5.2, 5);
  boom.rotateX(Math.PI / 2);
  boom.translate(0, 2.4, -1.4);
  parts.push(paint(boom, '#cfc8bc'));
  // sails: curved triangles (double sided material)
  const sailTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, belly: number, base: string, stripeC: string | null) => {
    const segs = 6;
    const sp: number[] = [];
    const scol: number[] = [];
    const ca = new THREE.Color(base);
    const cb = stripeC ? new THREE.Color(stripeC) : ca;
    const at = (u: number, v: number) => {
      // u along luff (a→b), v from luff toward the clew (c)
      const p = new THREE.Vector3().copy(a).lerp(b, u);
      const q = new THREE.Vector3().copy(c).lerp(b, u);
      const r = p.lerp(q, v);
      r.x += belly * Math.sin(Math.PI * v) * (1 - u) * 1.0;
      return r;
    };
    for (let i = 0; i < segs; i++)
      for (let j = 0; j < segs; j++) {
        const u0 = i / segs;
        const u1 = (i + 1) / segs;
        const v0 = j / segs;
        const v1 = (j + 1) / segs;
        const p00 = at(u0, v0);
        const p01 = at(u0, v1);
        const p10 = at(u1, v0);
        const p11 = at(u1, v1);
        const band = stripeC && i === 1 ? cb : ca;
        for (const p of [p00, p10, p01, p01, p10, p11]) {
          sp.push(p.x, p.y, p.z);
          scol.push(band.r, band.g, band.b);
        }
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(scol, 3));
    g.computeVertexNormals();
    return g;
  };
  parts.push(sailTri(new THREE.Vector3(0, 2.6, 1.1), new THREE.Vector3(0, 15.6, 1.1), new THREE.Vector3(0, 2.6, -3.9), 0.9, sail, sailStripe));
  parts.push(sailTri(new THREE.Vector3(0, 1.4, 5.3), new THREE.Vector3(0, 13.2, 1.3), new THREE.Vector3(0, 2.2, 1.6), 0.6, sail, null));
  return mergeGeometries(parts);
}

/** Soft white V-shaped wake trailing behind a boat (origin at the stern, pointing -Z). */
export function wakeGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const alpha: number[] = [];
  const quad = (x0: number, z0: number, x1: number, z1: number, w0: number, w1: number, a0: number, a1: number) => {
    const p = [
      [x0 - w0, z0, a0],
      [x0 + w0, z0, a0],
      [x1 - w1, z1, a1],
      [x1 + w1, z1, a1],
    ];
    for (const k of [0, 2, 1, 1, 2, 3]) {
      pos.push(p[k][0], 0.08, p[k][1]);
      alpha.push(p[k][2]);
    }
  };
  for (const side of [-1, 1]) quad(0, 2, side * 9, -26, 0.9, 2.6, 0.75, 0);
  quad(0, 0, 0, -18, 1.2, 0.4, 0.55, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alpha, 1));
  return g;
}

// ------------------------------------------------------------------------------------------
// Shipwreck
// ------------------------------------------------------------------------------------------

/** Skeleton of an old wooden ship half buried in the beach. Origin at keel centre (ground level), bow toward +Z. */
export function wreckGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const L = 30;
  parts.push(beam(new THREE.Vector3(0, -0.4, -L / 2), new THREE.Vector3(0, -0.2, L / 2), 0.9, '#5a4230'));
  // stem post rising at the bow, broken sternpost
  parts.push(beam(new THREE.Vector3(0, -0.3, L / 2), new THREE.Vector3(0, 7.5, L / 2 + 3.2), 0.8, '#5a4230'));
  parts.push(beam(new THREE.Vector3(0, -0.3, -L / 2), new THREE.Vector3(0, 3.6, -L / 2 - 1.2), 0.8, '#5a4230'));
  const ribs = 14;
  for (let i = 0; i < ribs; i++) {
    const t = i / (ribs - 1);
    const z = -L / 2 + 1.5 + t * (L - 3);
    const w = 4.6 * Math.sin(Math.PI * (0.12 + 0.8 * t)) + 0.6;
    const h = 5.2 + 1.6 * t;
    for (const side of [-1, 1]) {
      if (rng.chance(0.12)) continue;
      const broken = rng.chance(0.35) ? 0.45 + rng.next() * 0.35 : 1;
      const segs = 5;
      let prev = new THREE.Vector3(0, -0.2, z);
      for (let k = 1; k <= Math.ceil(segs * broken); k++) {
        const a = (k / segs) * (Math.PI / 2) * 1.1;
        const p = new THREE.Vector3(side * w * Math.sin(a), -0.2 + h * (1 - Math.cos(a)) * 0.95, z);
        parts.push(beam(prev, p, 0.42, rng.chance(0.5) ? '#6a4c34' : '#7d6046'));
        prev = p;
      }
    }
  }
  // a few remaining hull planks on the port side, and a toppled mast
  for (let k = 0; k < 3; k++) {
    const y = 0.6 + k * 1.1;
    const x = -(3.2 + k * 0.6);
    parts.push(beam(new THREE.Vector3(x, y, -L / 2 + 4 + k * 2), new THREE.Vector3(x - 0.2, y + 0.2, L / 2 - 6 - k * 3), 0.35, '#8a6e52'));
  }
  parts.push(beam(new THREE.Vector3(1.0, 0.4, 3), new THREE.Vector3(9.5, 2.2, 15), 0.7, '#5f4532'));
  return mergeGeometries(parts);
}

// ------------------------------------------------------------------------------------------
// Sand fences
// ------------------------------------------------------------------------------------------

export function slatGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.075, 1.25, 0.025);
  g.translate(0, -0.625, 0);
  // pointed top
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) if (p.getY(i) > -0.01) p.setY(i, p.getY(i) + (Math.abs(p.getX(i)) < 0.01 ? 0.06 : 0));
  g.computeVertexNormals();
  return g;
}

export function postGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.07, 0.08, 1.6, 6);
  g.translate(0, -0.8, 0);
  return g;
}
