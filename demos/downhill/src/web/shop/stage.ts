import * as THREE from 'three';
import { defaultRiderPose, type BikeVisual, type CharacterDef, type RiderRig } from '../game/rider/types';
import type { World } from '../world/world';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The shop's live preview: one rider on their bike, standing on the trail just past the start arch and turning slowly
 * in front of the menu camera, the way the select screen shows the riders.
 */
export class ShopStage {
  private figure: { key: string; bike: BikeVisual; rider: RiderRig; root: THREE.Group } | null = null;
  private readonly pose = defaultRiderPose();
  private readonly spot = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly camAt = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private turn = 0;
  private cheer = 0;
  private snap = true;

  constructor(readonly world: World) {
    const st = world.start;
    this.fwd.set(Math.sin(st.heading), 0, -Math.cos(st.heading));
    this.right.set(Math.cos(st.heading), 0, Math.sin(st.heading));
    this.spot.set(st.x, 0, st.z).addScaledVector(this.fwd, 14);
    this.spot.y = world.ground.heightAt(this.spot.x, this.spot.z);
  }

  /** Shows `def` (dressed as the shop wants it); `key` names the look, so the same look isn't rebuilt. */
  show(def: CharacterDef, key: string): void {
    if (this.figure?.key === key) return;
    this.clear();
    const bike = def.createBike();
    const rider = def.createRider();
    const root = new THREE.Group();
    root.add(bike.root);
    bike.root.add(rider.root);
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    root.position.copy(this.spot);
    root.rotation.y = -this.world.start.heading - 0.9 + this.turn;
    this.world.scene.add(root);
    this.figure = { key, bike, rider, root };
    this.cheer = 1.2;
  }

  clear(): void {
    this.figure?.root.removeFromParent();
    this.figure = null;
  }

  dispose(): void {
    this.clear();
    this.snap = true;
  }

  /**
   * Poses and turns the figure, and points `cam` at it so it stands at `screenX` (-1 left … 1 right) of the view.
   * Returns the figure's position (the world's level-of-detail focus).
   */
  update(dt: number, time: number, cam: THREE.PerspectiveCamera, screenX: number): THREE.Vector3 {
    const f = this.figure;
    this.turn += dt * 0.42;
    this.cheer = Math.max(0, this.cheer - dt);
    if (f) {
      f.root.rotation.y = -this.world.start.heading - 0.9 + this.turn;
      const pose = this.pose;
      pose.time = time;
      pose.speed = 0;
      pose.seated = 1;
      pose.celebrate = this.cheer > 0 ? Math.sin(Math.min(1, this.cheer) * Math.PI) : 0;
      f.bike.update({ rearSpin: 0, frontSpin: 0, crank: 0.4, steer: Math.sin(time * 0.8) * 0.1, barspin: 0, tailwhip: 0, suspension: 0 });
      f.rider.update(pose, f.bike.anchors, dt);
    }
    // the camera stands a few metres down the trail, a little to the side, at the rider's height; aiming below the
    // rider's middle keeps the wheels clear of the caption under the stage
    this.focus.copy(this.spot).addScaledVector(UP, 0.72);
    this.camAt.copy(this.spot).addScaledVector(this.fwd, 4.9).addScaledVector(this.right, 1.0);
    this.camAt.y = Math.max(this.world.ground.heightAt(this.camAt.x, this.camAt.z) + 0.7, this.spot.y + 1.2);
    cam.position.lerp(this.camAt, this.snap ? 1 : 1 - Math.exp(-dt * 4));
    this.snap = false;
    cam.fov = 44;
    cam.aspect = window.innerWidth / window.innerHeight;
    cam.updateProjectionMatrix();
    // aim to the side of the figure so it lands at screenX, clear of the shop's panels
    const dist = cam.position.distanceTo(this.focus);
    const half = dist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.aspect;
    this.side.subVectors(this.focus, cam.position).cross(UP).normalize();
    this.look.copy(this.focus).addScaledVector(this.side, -screenX * half);
    cam.lookAt(this.look);
    return this.spot;
  }
}
