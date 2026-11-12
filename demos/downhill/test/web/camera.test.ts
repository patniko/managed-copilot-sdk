import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ChaseCamera } from '../../src/web/game/camera';
import type { BikePhysics } from '../../src/web/game/bike';
import type { Collider, Ground } from '../../src/web/world/ground';

/** A winding downhill trail lined with bushes just off both edges (like citadel's trailside shrubs). */
function trailWorld() {
  const slope = 0.22;
  const heightAt = (_x: number, z: number) => slope * z;
  const centre = (z: number) => 6 * Math.sin(z / 40);
  const bushes: Collider[] = [];
  for (let z = 20; z > -900; z -= 5.5) {
    const side = Math.round(-z / 5.5) % 2 ? 1 : -1;
    bushes.push({ x: centre(z) + side * (2.3 + (Math.abs(z) % 0.6)), z, r: 0.8, top: heightAt(0, z) + 2.2, kind: 'soft' });
  }
  const ground = {
    heightAt,
    collide(x: number, z: number, y: number, radius: number) {
      for (const c of bushes) if (Math.hypot(c.x - x, c.z - z) < c.r + radius && y < c.top) return c;
      return null;
    },
  } as unknown as Ground;
  const bike = {
    pos: new THREE.Vector3(centre(0), 0, 0),
    vel: new THREE.Vector3(0, -15 * slope, -15),
    heading: 0,
    grounded: true,
    air: { travelHeading: 0, startY: 0, takeoffPitch: 0, flip: 0, takeoffHeading: 0, spin: 0, roll: 0 },
    speed: 15.4,
    forwardSpeed: 15.4,
    lean: 0,
    pitch: Math.atan(slope),
    surface: 'dirt',
    trailDist: 0,
    orientation(out: THREE.Euler) {
      return out.set(-this.pitch, -this.heading, -this.lean, 'YXZ');
    },
  };
  /** Ride the centre line at 15 m/s (heading: forward = (sin h, 0, -cos h)). */
  const ride = (dt: number) => {
    const z = bike.pos.z;
    bike.heading = Math.atan(-0.15 * Math.cos(z / 40));
    bike.lean = Math.sin(z / 40) * 0.25;
    bike.pos.z -= 15 * Math.cos(bike.heading) * dt;
    bike.pos.x = centre(bike.pos.z);
    bike.pos.y = heightAt(bike.pos.x, bike.pos.z);
    bike.vel.set(Math.sin(bike.heading) * 15, -15 * slope, -Math.cos(bike.heading) * 15);
  };
  return { ground, bike, bushes, ride };
}

describe('cinematic chase camera', () => {
  it('moves between framings on both sides, never enters props and keeps the rider in frame', () => {
    const { ground, bike, bushes, ride } = trailWorld();
    const cam = new ChaseCamera(16 / 9);
    const dt = 1 / 60;
    const phys = bike as unknown as BikePhysics;
    cam.snap(phys, ground);
    const shots = new Set<number>();
    let minOrbit = 0;
    let maxOrbit = 0;
    let dodged = false;
    const rider = new THREE.Vector3();
    for (let i = 0; i < 60 * 50; i++) {
      ride(dt);
      cam.update(dt, phys, ground);

      const c = cam.camera.position;
      for (const b of bushes) {
        if (Math.abs(b.z - c.z) > 3) continue;
        if (c.y < b.top) expect(Math.hypot(b.x - c.x, b.z - c.z)).toBeGreaterThan(b.r + 0.2);
      }
      cam.camera.updateMatrixWorld();
      for (const h of [0.1, 0.9, 1.6]) {
        rider.set(bike.pos.x, bike.pos.y + h, bike.pos.z).project(cam.camera);
        expect(Math.abs(rider.x)).toBeLessThan(0.9);
        expect(Math.abs(rider.y)).toBeLessThan(0.98);
        expect(rider.z).toBeLessThan(1);
      }
      const d = cam.debug();
      shots.add(d.shot);
      minOrbit = Math.min(minOrbit, d.orbit);
      maxOrbit = Math.max(maxOrbit, d.orbit);
      if (d.dodge > 0.5) dodged = true;
    }
    expect(shots.size).toBeGreaterThanOrEqual(5);
    expect(dodged).toBe(true);
    // the bushes squeeze the orbit, but the operator still swings to both sides of the rider
    expect(minOrbit).toBeLessThan(-0.1);
    expect(maxOrbit).toBeGreaterThan(0.1);
  });

  it('the steady rig stays locked behind the rider', () => {
    const { ground, bike, ride } = trailWorld();
    const cam = new ChaseCamera(16 / 9);
    const phys = bike as unknown as BikePhysics;
    cam.mode = 'steady';
    cam.snap(phys, ground);
    for (let i = 0; i < 600; i++) {
      ride(1 / 60);
      bike.lean = 0;
      cam.update(1 / 60, phys, ground);
      expect(Math.abs(cam.debug().orbit)).toBeLessThan(1e-6);
      expect(Math.abs(cam.debug().roll)).toBeLessThan(1e-6);
    }
  });
});
