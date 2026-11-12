import * as THREE from 'three';
import { Noise } from '../core/noise';
import { Rng } from '../core/rng';
import { G } from '../render/globals';
import { Sky } from '../render/sky';
import { Water } from '../render/water';
import { buildBackdrop } from './backdrop';
import { buildFeatures, planFeatures, prepareTrailsForFeatures, scatterFreeride, type JumpFeature } from './features';
import { GrassField, GroundTextures, type GrassQuality } from './grass';
import { Ground } from './ground';
import { ScatterSystem } from './scatter';
import { TerrainData } from './terrain';
import { TerrainRenderer } from './terrainMesh';
import { buildGates, buildJumpMeshes, buildTrailRibbons, type GateDef } from './trailMesh';
import { TrailNetwork } from './trails';
import type { EnvironmentDef, SetPieceHandle, WorldContext } from './types';

export interface WorldQuality {
  grass: GrassQuality;
  shadowMap: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class World {
  readonly scene = new THREE.Scene();
  terrain!: TerrainData;
  trails!: TrailNetwork;
  features: JumpFeature[] = [];
  ground!: Ground;
  gates: GateDef[] = [];
  sun!: THREE.DirectionalLight;
  hemi!: THREE.HemisphereLight;
  terrainRenderer!: TerrainRenderer;
  sky!: Sky;
  water?: Water;
  grass?: GrassField;
  scatter?: ScatterSystem;
  groundTex?: GroundTextures;
  setPieces: SetPieceHandle[] = [];
  noise!: Noise;
  start = { x: 0, y: 0, z: 0, heading: 0 };
  finish = { x: 0, y: 0, z: 0, s: 0 };
  private shadowFocus = new THREE.Vector3();

  constructor(readonly env: EnvironmentDef) {}

  static async build(env: EnvironmentDef, q: WorldQuality, onProgress?: (p: number, label: string) => void): Promise<World> {
    const w = new World(env);
    const step = async (p: number, label: string) => {
      onProgress?.(p, label);
      await tick();
    };
    await step(0.02, 'Sculpting the mountain');
    w.noise = new Noise(env.seed);
    w.terrain = new TerrainData(env.terrain);
    w.terrain.fill();
    await step(0.25, 'Cutting the trails');
    w.trails = TrailNetwork.generate(env.course, w.terrain, env.seed);
    const plans = planFeatures(w.trails, env.course.jumps, env.seed);
    prepareTrailsForFeatures(w.trails, plans);
    w.terrain.carve(w.trails.trails);
    w.trails.buildIndex();
    await step(0.4, 'Shaping the jumps');
    w.features = buildFeatures(plans, w.trails, w.terrain);
    w.features.push(...scatterFreeride(env.course.freerideKickers, w.terrain, w.features, env.seed));
    w.ground = new Ground(w.terrain, w.trails, w.features, env.terrain);
    w.setupCourse();
    await step(0.5, 'Painting the sky');
    w.setupLights(q.shadowMap);
    w.applyGlobals();
    w.sky = new Sky(env.sky, env.seed);
    w.scene.add(w.sky.group);
    if (env.water && env.terrain.seaLevel !== undefined) {
      const r = env.terrain.region;
      w.water = new Water(env.water, env.terrain, new THREE.Vector2((r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2));
      w.scene.add(w.water.mesh);
    }
    await step(0.58, 'Laying the ground');
    w.terrainRenderer = new TerrainRenderer(w.terrain, env.terrain);
    w.terrainRenderer.buildInitial(new THREE.Vector3(w.start.x, w.start.y, w.start.z));
    w.scene.add(w.terrainRenderer.group);
    w.scene.add(buildBackdrop(env.terrain));
    w.scene.add(buildTrailRibbons(w.trails, w.terrain, env.course));
    w.scene.add(buildJumpMeshes(w.features, w.terrain, env.course.trailColor.map((c) => c * 0.9)));
    w.scene.add(buildGates(w.gates));
    await step(0.72, 'Growing the meadows');
    w.groundTex = new GroundTextures(w.terrain, env.grass, w.features, (x, z) => w.noise.fbm(x * 0.012, z * 0.012, 3));
    w.grass = new GrassField(w.groundTex, env.grass, q.grass, env.seed);
    w.scene.add(w.grass.group);
    const gateAvoid = (x: number, z: number) => w.gates.some((g) => Math.hypot(g.x - x, g.z - z) < 9) || Math.hypot(w.start.x - x, w.start.z - z) < 14;
    w.scatter = new ScatterSystem(env.scatter, w.terrain, env.terrain, w.ground, w.noise, env.seed, gateAvoid);
    w.scene.add(w.scatter.group);
    await step(0.86, 'Raising the landmarks');
    const ctx: WorldContext = {
      scene: w.scene,
      terrain: w.terrain,
      trails: w.trails,
      features: w.features,
      noise: w.noise,
      rng: new Rng(env.seed ^ 0xabc),
      addCollider: (x, z, r, top, kind) => w.ground.addCollider({ x, z, r, top, kind }),
    };
    const sp = env.buildSetPieces?.(ctx);
    if (sp) w.setPieces.push(sp);
    await step(1, 'Ready');
    return w;
  }

  private setupCourse() {
    const main = this.trails.main;
    const s0 = this.trails.sample(main, 2);
    this.start = { x: s0.x, y: this.ground.heightAt(s0.x, s0.z), z: s0.z, heading: s0.heading };
    const fs = main.length - 45;
    const f = this.trails.sample(main, fs);
    this.finish = { x: f.x, y: this.ground.heightAt(f.x, f.z), z: f.z, s: fs };
    const gate = (s: number, kind: GateDef['kind']): GateDef => {
      const p = this.trails.sample(main, s);
      return { s, kind, x: p.x, z: p.z, h: this.terrain.heightAt(p.x, p.z), heading: p.heading, width: p.hw * 2 + 3.2 };
    };
    this.gates.push(gate(9, 'start'));
    const cps = Math.max(2, Math.floor(main.length / 480));
    for (let i = 1; i <= cps; i++) {
      let s = (main.length * i) / (cps + 1);
      // keep gates off jumps
      for (let k = 0; k < 40 && this.features.some((ft) => ft.trailKind === 'main' && Math.hypot(ft.x0 - this.trails.sample(main, s).x, ft.z0 - this.trails.sample(main, s).z) < ft.length + 12); k++) s += 6;
      this.gates.push(gate(s, 'checkpoint'));
    }
    this.gates.push(gate(fs, 'finish'));
  }

  private setupLights(mapSize: number) {
    const sky = this.env.sky;
    this.sun = new THREE.DirectionalLight(new THREE.Color(sky.sunColor), sky.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    const sc = this.sun.shadow.camera;
    sc.left = -38;
    sc.right = 38;
    sc.top = 38;
    sc.bottom = -38;
    sc.near = 1;
    sc.far = 600;
    // three r186's PCF path adds the bias without flipping it for the reversed depth buffer
    // (VSM/basic do flip), so a "negative = toward the light" bias must be positive here.
    this.sun.shadow.bias = 0.00012;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 2;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(new THREE.Color(sky.hemiSky), new THREE.Color(sky.hemiGround), sky.hemiIntensity);
    this.scene.add(this.hemi);
  }

  /** Push environment fog/sun settings into the shared shader uniforms. */
  applyGlobals() {
    const f = this.env.fog;
    const s = this.env.sky;
    G.uSunDir.value.set(...s.sunDir).normalize();
    G.uSunColor.value.set(s.sunColor);
    G.uFogColor.value.set(f.color);
    G.uFogSunColor.value.set(f.sunColor);
    G.uFogDensity.value = f.density;
    G.uFogHeightFalloff.value = f.heightFalloff;
    G.uFogBase.value = f.base;
    G.uFogMax.value = f.max;
    G.uMistColor.value.set(f.mistColor ?? f.color);
    G.uMistTop.value = f.mistTop ?? 0;
    G.uMistBottom.value = f.mistBottom ?? 0;
    G.uMistStrength.value = f.mistStrength ?? 0;
    G.uMistNear.value = f.mistNear ?? 150;
    G.uMistCenter.value.set(f.mistCenter?.[0] ?? 0, f.mistCenter?.[1] ?? 0);
    G.uMistRadius.value = f.mistRadius ?? 1e6;
    G.uMistSlope.value = f.mistSlope ?? 0;
  }

  update(dt: number, time: number, camera: THREE.PerspectiveCamera, focus: THREE.Vector3) {
    G.uTime.value = time;
    G.uPlayerPos.value.copy(focus);
    this.terrainRenderer.update(camera.position, 3);
    this.sky.update(camera);
    this.grass?.update(camera.position);
    // shadow camera follows the focus, snapped to texels to avoid shimmering
    const texel = 76 / this.sun.shadow.mapSize.x;
    this.shadowFocus.set(Math.round(focus.x / texel) * texel, Math.round(focus.y / texel) * texel, Math.round(focus.z / texel) * texel);
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(G.uSunDir.value, 300);
    this.sun.target.updateMatrixWorld();
    this.scatter?.update(camera, this.shadowFocus);
    for (const sp of this.setPieces) sp.update?.(dt, time, camera);
  }

  dispose() {
    this.terrainRenderer?.dispose();
    this.sky?.dispose();
    this.water?.dispose();
    this.grass?.dispose();
    this.scatter?.dispose();
    this.groundTex?.dispose();
    for (const sp of this.setPieces) sp.dispose?.();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
      }
    });
  }
}
