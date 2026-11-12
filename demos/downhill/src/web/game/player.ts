import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { Surface } from '../core/audioTypes';
import { BikePhysics } from './bike';
import { defaultRiderPose, type BikeVisual, type CharacterDef, type RiderPose, type RiderRig } from './rider/types';
import type { Ground } from '../world/ground';

/** How much each surface shakes the bike and rider at speed (0..1). */
export const ROUGHNESS: Record<Surface, number> = { dirt: 0.5, grass: 0.62, sand: 0.35, rock: 0.95, snow: 0.3, wood: 0.4 };

interface Tumbler {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  ang: THREE.Vector3;
  radius: number;
}

/** Mark materials so the motion-blur pass leaves the rider crisp (alpha = 0 in the scene buffer). */
function excludeFromMotionBlur(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      // materials are shared between riders: patch each one once (re-wrapping would recompile on every restart)
      if (mat.userData.noBlur || mat.transparent) continue;
      mat.userData.noBlur = true;
      const prev = mat.onBeforeCompile;
      mat.onBeforeCompile = (s, r) => {
        prev?.call(mat, s, r);
        const i = s.fragmentShader.lastIndexOf('}');
        s.fragmentShader = s.fragmentShader.slice(0, i) + '\n gl_FragColor.a = 0.0;\n}';
      };
      const key = mat.customProgramCacheKey?.bind(mat);
      mat.customProgramCacheKey = () => (key ? key() : '') + '|noblur';
      mat.needsUpdate = true;
    }
  });
}

export class Player {
  readonly physics: BikePhysics;
  readonly root = new THREE.Group();
  readonly bike: BikeVisual;
  readonly rider: RiderRig;
  readonly pose: RiderPose = defaultRiderPose();
  private euler = new THREE.Euler();
  private tumblers: Tumbler[] = [];
  private seated = 1;
  celebrate = 0;
  private time = 0;
  private readonly velocity = new THREE.Vector3();

  constructor(
    readonly character: CharacterDef,
    readonly ground: Ground,
  ) {
    this.physics = new BikePhysics(ground);
    this.bike = character.createBike();
    this.rider = character.createRider();
    this.root.add(this.bike.root);
    this.bike.root.add(this.rider.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.frustumCulled = false;
      }
    });
    excludeFromMotionBlur(this.root);
    this.root.name = 'player';
  }

  get crashed() {
    return this.tumblers.length > 0;
  }

  startCrash() {
    const p = this.physics;
    this.root.updateMatrixWorld(true);
    const scene = this.root.parent;
    if (!scene) return;
    const base = p.vel.clone().multiplyScalar(0.75);
    base.y = Math.max(base.y, 0) + 2.2;
    // tumble each part around its own centre of mass (rider body ~1 m up, bike ~0.5 m up)
    const parts: Array<[THREE.Object3D, THREE.Vector3, boolean]> = [
      [this.rider.root, new THREE.Vector3(0, 1.0, 0.32), true],
      [this.bike.root, new THREE.Vector3(0, 0.5, 0), false],
    ];
    for (const [obj, localCentre, isRider] of parts) {
      const pivot = new THREE.Group();
      const wc = obj.localToWorld(localCentre.clone());
      pivot.position.copy(wc);
      scene.add(pivot);
      pivot.updateMatrixWorld(true);
      pivot.attach(obj);
      const v = base.clone().multiplyScalar(isRider ? 1.05 : 0.8);
      v.x += (Math.random() - 0.5) * 2;
      v.z += (Math.random() - 0.5) * 2;
      this.tumblers.push({
        obj: pivot,
        vel: v,
        ang: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 9),
        radius: isRider ? 0.45 : 0.4,
      });
    }
    this.pose.crashed = true;
  }

  endCrash() {
    for (const t of this.tumblers) t.obj.removeFromParent();
    this.root.add(this.bike.root);
    this.bike.root.add(this.rider.root);
    this.bike.root.position.set(0, 0, 0);
    this.bike.root.quaternion.identity();
    this.rider.root.position.set(0, 0, 0);
    this.rider.root.quaternion.identity();
    this.tumblers = [];
    this.pose.crashed = false;
  }

  private updateTumble(dt: number) {
    const q = new THREE.Quaternion();
    for (const t of this.tumblers) {
      t.vel.y -= 9.81 * dt;
      t.obj.position.addScaledVector(t.vel, dt);
      const gh = this.ground.heightAt(t.obj.position.x, t.obj.position.z);
      if (t.obj.position.y < gh + t.radius) {
        t.obj.position.y = gh + t.radius;
        if (t.vel.y < 0) t.vel.y = -t.vel.y * 0.3;
        t.vel.x *= Math.exp(-20 * dt);
        t.vel.z *= Math.exp(-20 * dt);
        t.ang.multiplyScalar(Math.exp(-6 * dt));
      }
      const w = t.ang.length();
      if (w > 1e-4) {
        q.setFromAxisAngle(t.ang.clone().divideScalar(w), w * dt);
        t.obj.quaternion.premultiply(q);
      }
    }
  }

  /** Sync visuals with physics (call every rendered frame). */
  update(dt: number) {
    this.time += dt;
    const p = this.physics;
    const pose = this.pose;
    if (this.tumblers.length) {
      this.updateTumble(dt);
      pose.time = this.time;
      pose.crashed = true;
      pose.velocity = this.velocity.copy(this.tumblers[0].vel);
      pose.roughness = 0;
      this.rider.update(pose, this.bike.anchors, dt);
      return;
    }
    this.root.position.copy(p.pos);
    p.orientation(this.euler);
    this.root.rotation.copy(this.euler);
    const fs = p.forwardSpeed;
    // visual-only frame chatter over rough ground (the camera follows the physics, so this reads as vibration)
    const rough = p.grounded ? ROUGHNESS[p.surface] * clamp(fs / 12, 0, 1.4) * (p.trailDist < 1.5 ? 0.6 : 1) : 0;
    const t = this.time;
    const n1 = Math.sin(t * 41.3) * 0.5 + Math.sin(t * 67.1 + 1.3) * 0.3 + Math.sin(t * 23.7 + 2.1) * 0.2;
    const n2 = Math.sin(t * 37.9 + 0.7) * 0.6 + Math.sin(t * 58.3 + 2.9) * 0.4;
    this.bike.root.position.y = n1 * 0.0045 * rough;
    this.bike.root.rotation.x = n2 * 0.005 * rough;
    pose.velocity = this.velocity.copy(p.vel);
    pose.roughness = rough;
    // seated when pedalling slowly, attack position when descending fast / in the air
    // (riders that coast seated, like the video's, only stand up to load a jump or absorb a landing)
    const seatedRide = this.character.ridesSeated ? fs < 24 && p.compress < 0.55 : p.pedaling || fs < 6;
    const wantSeated = p.grounded && seatedRide && p.preload < 0.2 ? 1 : 0;
    this.seated = damp(this.seated, wantSeated, 3.5, dt);
    pose.time = this.time;
    pose.speed = fs;
    pose.seated = this.seated;
    pose.lean = p.grounded ? clamp(p.lean * 0.35, -0.3, 0.3) : 0;
    pose.steer = p.steer;
    pose.compress = clamp(p.compress * 0.8 + p.preload * 0.5, 0, 1);
    pose.airborne = !p.grounded;
    pose.crashed = false;
    pose.tricks.superman = p.tricks.grabs.superman;
    pose.tricks.noHander = p.tricks.grabs.noHander;
    pose.tricks.canCan = p.tricks.grabs.canCan;
    pose.tricks.tailwhip = p.tricks.tailwhip > 0 ? Math.sin(Math.PI * p.tricks.tailwhip) : 0;
    pose.tricks.barspin = p.tricks.barspin > 0 ? Math.sin(Math.PI * p.tricks.barspin) : 0;
    pose.tricks.tabletop = clamp(Math.abs(p.air.roll) / 0.9, 0, 1) * (p.grounded ? 0 : 1);
    this.celebrate = damp(this.celebrate, 0, 0.9, dt);
    pose.celebrate = this.celebrate > 0.05 ? Math.min(1, this.celebrate * 1.5) : 0;
    this.bike.update({
      rearSpin: p.wheelAngle,
      frontSpin: p.wheelAngle,
      crank: p.crank,
      steer: p.steer * 0.32,
      barspin: p.tricks.barspin * Math.PI * 2,
      tailwhip: p.tricks.tailwhip * Math.PI * 2,
      suspension: clamp(p.compress, 0, 1),
    });
    this.rider.update(pose, this.bike.anchors, dt);
  }
}
