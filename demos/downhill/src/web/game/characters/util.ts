import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ------------------------------------------------------------------ math */

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth01 = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  if (!(dt > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-rate * Math.min(dt, 0.25)));
}

/** Smooth pseudo-noise in roughly [-1, 1] (sum of incommensurate sines). */
export function wobble(t: number, seed: number): number {
  return (
    Math.sin(t * 1.0 + seed * 1.71) * 0.5 +
    Math.sin(t * 2.31 + seed * 3.13) * 0.3 +
    Math.sin(t * 4.17 + seed * 5.37) * 0.2
  );
}

/* -------------------------------------------------------------- geometry */

const _col = new THREE.Color();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Give a geometry a constant vertex colour (converted to the linear working space). */
export function tint<T extends THREE.BufferGeometry>(geo: T, color: THREE.ColorRepresentation): T {
  _col.set(color);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _col.r;
    arr[i * 3 + 1] = _col.g;
    arr[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Colour vertices with a callback (position -> colour). */
export function tintBy<T extends THREE.BufferGeometry>(
  geo: T,
  fn: (x: number, y: number, z: number, out: THREE.Color) => void,
): T {
  const pos = geo.getAttribute('position');
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), _col);
    arr[i * 3] = _col.r;
    arr[i * 3 + 1] = _col.g;
    arr[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function prepForMerge(geo: THREE.BufferGeometry, keepUv: boolean): THREE.BufferGeometry {
  if (!geo.index) {
    const n = geo.getAttribute('position').count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  for (const name of Object.keys(geo.attributes)) {
    if (name === 'position' || name === 'normal' || name === 'color') continue;
    if (keepUv && name === 'uv') continue;
    geo.deleteAttribute(name);
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (!geo.getAttribute('color')) tint(geo, 0xffffff);
  geo.morphAttributes = {};
  geo.clearGroups();
  return geo;
}

/**
 * A copy of `geo` with its vertex colours repainted: each vertex whose colour is one of the `swap` pairs' `from` colours
 * takes that pair's `to` colour. Parts are tinted flat (`tint`), so a palette entry matches exactly. The copy shares
 * every other attribute with `geo`.
 */
export function repaint(geo: THREE.BufferGeometry, swap: ReadonlyArray<readonly [from: THREE.ColorRepresentation, to: THREE.ColorRepresentation]>): THREE.BufferGeometry {
  const pairs = swap.map(([from, to]) => [new THREE.Color(from), new THREE.Color(to)] as const);
  const src = geo.getAttribute('color');
  const out = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) {
    let r = src.getX(i);
    let g = src.getY(i);
    let b = src.getZ(i);
    for (const [from, to] of pairs) {
      if (Math.abs(r - from.r) < 1e-5 && Math.abs(g - from.g) < 1e-5 && Math.abs(b - from.b) < 1e-5) {
        r = to.r;
        g = to.g;
        b = to.b;
        break;
      }
    }
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  const copy = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) copy.setAttribute(name, attr);
  copy.setIndex(geo.index);
  for (const group of geo.groups) copy.addGroup(group.start, group.count, group.materialIndex);
  copy.setAttribute('color', new THREE.BufferAttribute(out, 3));
  copy.boundingSphere = geo.boundingSphere?.clone() ?? null;
  copy.boundingBox = geo.boundingBox?.clone() ?? null;
  return copy;
}

/** A character's palette in an outfit: the outfit's colours replace entries of `base` by name (unknown names are ignored). */
export interface Outfit<K extends string> {
  readonly palette: { readonly [P in K]: string };
  /** `[base colour, outfit colour]` for each entry the outfit changes: what `repaint` needs. */
  readonly swap: ReadonlyArray<readonly [string, string]>;
  /** Identifies the outfit, for caching its geometry ('' when it changes nothing). */
  readonly key: string;
}

export function outfit<K extends string>(base: { readonly [P in K]: string }, colors: Readonly<Record<string, string>> = {}): Outfit<K> {
  const palette = { ...base } as { [P in K]: string };
  const swap: Array<readonly [string, string]> = [];
  for (const name of Object.keys(base) as K[]) {
    const color = colors[name];
    if (!color || color.toLowerCase() === base[name].toLowerCase()) continue;
    palette[name] = color;
    swap.push([base[name], color]);
  }
  return { palette, swap, key: swap.map(([from, to]) => `${from}>${to}`).join(',') };
}

/** Merge vertex-coloured parts into a single indexed geometry (one draw call). */
export function merge(parts: THREE.BufferGeometry[], keepUv = false): THREE.BufferGeometry {
  const g = mergeGeometries(
    parts.map((p) => prepForMerge(p, keepUv)),
    false,
  );
  if (!g) throw new Error('[characters] geometry merge failed');
  g.computeBoundingSphere();
  return g;
}

/** Transform a Y-axis-centred geometry so that it spans a -> b. */
export function alignY<T extends THREE.BufferGeometry>(geo: T, a: THREE.Vector3, b: THREE.Vector3): T {
  _a.subVectors(b, a);
  const len = _a.length();
  if (len > 1e-9) _q.setFromUnitVectors(_up, _a.multiplyScalar(1 / len));
  else _q.identity();
  _b.addVectors(a, b).multiplyScalar(0.5);
  _m4.compose(_b, _q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(_m4);
  return geo;
}

/** Cylinder (optionally tapered) between two points. */
export function tube(
  a: THREE.Vector3,
  b: THREE.Vector3,
  r0: number,
  r1: number,
  color: THREE.ColorRepresentation,
  radial = 10,
  openEnded = false,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, Math.max(a.distanceTo(b), 1e-4), radial, 1, openEnded);
  alignY(g, a, b);
  return tint(g, color);
}

/** Capsule between two points. */
export function capsule(
  a: THREE.Vector3,
  b: THREE.Vector3,
  r: number,
  color: THREE.ColorRepresentation,
  radial = 10,
  capSegs = 4,
): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(r, Math.max(a.distanceTo(b), 1e-4), capSegs, radial);
  alignY(g, a, b);
  return tint(g, color);
}

/** Ellipsoid at a position with an optional rotation. */
export function ellipsoid(
  rx: number,
  ry: number,
  rz: number,
  pos: THREE.Vector3,
  color: THREE.ColorRepresentation,
  ws = 16,
  hs = 12,
  rot?: THREE.Euler,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  if (rot) g.applyMatrix4(_m4.makeRotationFromEuler(rot));
  g.translate(pos.x, pos.y, pos.z);
  return tint(g, color);
}

/** Rounded box. */
export function box(
  sx: number,
  sy: number,
  sz: number,
  pos: THREE.Vector3,
  color: THREE.ColorRepresentation,
  rot?: THREE.Euler,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (rot) g.applyMatrix4(_m4.makeRotationFromEuler(rot));
  g.translate(pos.x, pos.y, pos.z);
  return tint(g, color);
}

/**
 * Revolved limb along +Y from 0..len with hemispherical ends.
 * `stations` are [t (0..1 along length), radius] pairs, first & last define the end-cap radii.
 */
export function limb(
  len: number,
  stations: Array<[number, number]>,
  color: THREE.ColorRepresentation,
  radial = 12,
  capSegs = 4,
  caps: { start?: boolean; end?: boolean } = {},
): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const r0 = stations[0][1];
  const rn = stations[stations.length - 1][1];
  const y0 = stations[0][0] * len;
  const yn = stations[stations.length - 1][0] * len;
  if (caps.start !== false) {
    for (let i = 0; i < capSegs; i++) {
      const a = -Math.PI / 2 + (i / capSegs) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * r0), y0 + Math.sin(a) * r0));
    }
  }
  for (const [t, r] of stations) pts.push(new THREE.Vector2(r, t * len));
  if (caps.end !== false) {
    for (let i = 1; i <= capSegs; i++) {
      const a = (i / capSegs) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * rn), yn + Math.sin(a) * rn));
    }
  }
  const g = new THREE.LatheGeometry(pts, radial);
  return tint(g, color);
}

/** Rounded-rectangle slab (w along X, l along Z, h along Y), centred at the origin. */
export function roundedSlab(w: number, l: number, h: number, r: number, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -l / 2;
  const rr = Math.min(r, w / 2 - 1e-4, l / 2 - 1e-4);
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + l - rr);
  s.quadraticCurveTo(x + w, y + l, x + w - rr, y + l);
  s.lineTo(x + rr, y + l);
  s.quadraticCurveTo(x, y + l, x, y + l - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  const bevel = Math.min(h * 0.35, rr * 0.6);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(h - bevel * 2, 1e-4),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 4,
  });
  g.translate(0, 0, -(h - bevel * 2) / 2);
  g.rotateX(-Math.PI / 2);
  return tint(g, color);
}

/** Apply translation / rotation / scale to a geometry in place. */
export function place<T extends THREE.BufferGeometry>(
  geo: T,
  pos: THREE.Vector3,
  rot?: THREE.Euler | THREE.Quaternion,
  scale?: THREE.Vector3,
): T {
  if (rot instanceof THREE.Euler) _q.setFromEuler(rot);
  else if (rot) _q.copy(rot);
  else _q.identity();
  _m4.compose(pos, _q, scale ?? new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(_m4);
  return geo;
}

/** Mark every mesh under `root` as a shadow caster (and receiver). */
export function enableShadows(root: THREE.Object3D, receive = true): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = receive;
    }
  });
}

/** Shorthand vector constructor. */
export const v3 = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Count triangles / draw calls of everything below `root` (main pass, excluding shadows). */
export function meshStats(root: THREE.Object3D): { triangles: number; drawCalls: number } {
  let triangles = 0;
  let drawCalls = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const g = m.geometry as THREE.BufferGeometry;
    const count = g.index ? g.index.count : g.getAttribute('position').count;
    const drawn = Math.min(count, g.drawRange.count);
    const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
    triangles += (drawn / 3) * inst;
    drawCalls += Array.isArray(m.material) ? m.material.length : 1;
  });
  return { triangles: Math.round(triangles), drawCalls };
}
