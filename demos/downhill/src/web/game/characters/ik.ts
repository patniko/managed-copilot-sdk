import * as THREE from 'three';

const _d = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Analytic two-bone IK.
 * Writes the middle joint (elbow / knee) into `outMid` and the reachable end point into `outEnd`.
 * `pole` is a direction hint: the middle joint bends towards it.
 */
export function solveTwoBone(
  root: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  pole: THREE.Vector3,
  outMid: THREE.Vector3,
  outEnd: THREE.Vector3,
  maxReach = 0.999,
): void {
  _d.subVectors(target, root);
  let dist = _d.length();
  if (dist < 1e-6) {
    _d.set(0, -1, 0);
    dist = 1e-6;
  } else {
    _d.multiplyScalar(1 / dist);
  }
  const minD = Math.abs(l1 - l2) + 1e-3;
  const maxD = (l1 + l2) * maxReach;
  dist = dist < minD ? minD : dist > maxD ? maxD : dist;

  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

  _bend.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_bend.lengthSq() < 1e-10) {
    _bend.set(0, 0, -1).addScaledVector(_d, _d.z);
    if (_bend.lengthSq() < 1e-10) _bend.set(1, 0, 0);
  }
  _bend.normalize();

  outMid.copy(root).addScaledVector(_d, a).addScaledVector(_bend, h);
  outEnd.copy(root).addScaledVector(_d, dist);
}

/**
 * Place `obj` at `from` with its local +Y pointing to `to` and local +Z as close as possible to `hint`.
 */
export function orientBone(obj: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, hint: THREE.Vector3): void {
  _y.subVectors(to, from);
  const len = _y.length();
  if (len < 1e-7) _y.set(0, 1, 0);
  else _y.multiplyScalar(1 / len);
  _z.copy(hint).addScaledVector(_y, -hint.dot(_y));
  if (_z.lengthSq() < 1e-10) {
    _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
    if (_z.lengthSq() < 1e-10) _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
  }
  _z.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(from);
}

/** Quaternion whose local +Y = `up` and local -Z is as close as possible to `forward`. */
export function quatFromUpForward(out: THREE.Quaternion, up: THREE.Vector3, forward: THREE.Vector3): THREE.Quaternion {
  _y.copy(up).normalize();
  _z.copy(forward).multiplyScalar(-1).addScaledVector(_y, forward.dot(_y));
  if (_z.lengthSq() < 1e-10) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
  _z.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}
