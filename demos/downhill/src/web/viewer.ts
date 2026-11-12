import * as THREE from 'three';
import { createRenderer, QUALITY, type QualityLevel } from './render/renderer';
import { PainterlyPipeline } from './post/painterly';
import { World } from './world/world';
import { loadEnvironments } from './world/envs';
import type { EnvironmentDef } from './world/types';

/** Debug viewer: renders an environment from a scripted camera for visual validation. */
export async function runViewer(params: URLSearchParams) {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = createRenderer(canvas);
  const q = QUALITY[(params.get('q') as QualityLevel) ?? 'high'] ?? QUALITY.high;
  renderer.setPixelRatio(1);
  const post = new PainterlyPipeline(renderer);
  const all = await loadEnvironments();
  const env: EnvironmentDef = all.find((e) => e.id === (params.get('env') ?? 'citadel')) ?? all[0];
  applyPost(post, env, q.radius);
  post.settings.renderScale = q.renderScale;
  if (params.get('painterly') === '0') post.settings.painterly = false;
  const camera = new THREE.PerspectiveCamera(Number(params.get('fov') ?? 62), 1, 0.2, 30000);
  const resize = () => {
    const w = window.innerWidth,
      h = window.innerHeight;
    renderer.setSize(w, h, false);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    post.setSize(w, h);
  };
  resize();
  window.addEventListener('resize', resize);
  const t0 = performance.now();
  const world = await World.build(env, { grass: { near: q.grassNear, far: q.grassFar }, shadowMap: q.shadowMap }, (p, l) => console.log(`[load] ${Math.round(p * 100)}% ${l}`));
  console.log(`[load] world built in ${Math.round(performance.now() - t0)} ms`);
  if (params.get('noshadow') === '1') renderer.shadowMap.enabled = false;
  if (params.get('nograss') === '1' && world.grass) world.grass.group.visible = false;
  if (params.get('noscatter') === '1' && world.scatter) world.scatter.group.visible = false;
  (window as unknown as { __world: unknown }).__world = world;
  const st = world.start;
  const s = Number(params.get('s') ?? 2);
  const trail = world.trails.trails[Number(params.get('trail') ?? 0)];
  const smp = world.trails.sample(trail, s);
  const base = new THREE.Vector3(smp.x, world.ground.heightAt(smp.x, smp.z), smp.z);
  const heading = smp.heading;
  const fwd = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading));
  const right = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
  const parse = (k: string, d: number[]) => (params.get(k) ?? d.join(',')).split(',').map(Number);
  const [cb, cu, cr] = parse('cam', [-3.2, 1.5, 0]); // back, up, right
  const [lf, lu, lr] = parse('look', [30, -1.5, 0]); // forward, up, right
  const camPos = base.clone().addScaledVector(fwd, cb).addScaledVector(right, cr);
  camPos.y = world.ground.heightAt(camPos.x, camPos.z) + cu;
  const look = base.clone().addScaledVector(fwd, lf).addScaledVector(right, lr);
  look.y = base.y + lu;
  camera.position.copy(camPos);
  camera.lookAt(look);
  void st;
  // rider (optional while characters are being built)
  if (params.get('rider') !== '0') {
    const loader = import.meta.glob('./game/characters/index.ts')['./game/characters/index.ts'];
    const mod = loader ? ((await loader().catch(() => null)) as { getCharacter?: (id: string) => import('./game/rider/types').CharacterDef } | null) : null;
    const getCharacter = mod?.getCharacter;
    if (getCharacter) {
      const def = getCharacter(params.get('char') ?? 'rider');
      const bike = def.createBike();
      const rider = def.createRider();
      bike.root.add(rider.root);
      bike.root.position.copy(base);
      bike.root.rotation.y = -heading;
      world.scene.add(bike.root);
      const { defaultRiderPose } = await import('./game/rider/types');
      const pose = defaultRiderPose();
      pose.speed = 8;
      bike.update({ rearSpin: 0, frontSpin: 0, crank: 1.2, steer: 0, barspin: 0, tailwhip: 0, suspension: 0 });
      rider.update(pose, bike.anchors, 0.016);
    }
  }
  const speed = Number(params.get('speed') ?? 0);
  const time = Number(params.get('t') ?? 10);
  let frames = 0;
  const motion = { forwardSpeed: speed, foe: new THREE.Vector2(0.5, 0.5) };
  const loop = () => {
    world.update(1 / 60, time, camera, base);
    const p = camera.position.clone().add(fwd.clone().multiplyScalar(100)).project(camera);
    motion.foe.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    post.render(world.scene, camera, time, motion);
    frames++;
    if (frames === 30) {
      (window as unknown as { __ready: boolean }).__ready = true;
      const info = renderer.info;
      console.log(`[stats] calls=${info.render.calls} tris=${info.render.triangles} reversed=${renderer.capabilities.reversedDepthBuffer}`);
    }
    requestAnimationFrame(loop);
  };
  loop();
}

export function applyPost(post: PainterlyPipeline, env: EnvironmentDef, radius: number) {
  const p = env.post ?? {};
  const st = post.settings;
  st.radius = radius;
  if (p.saturation !== undefined) st.saturation = p.saturation;
  if (p.vibrance !== undefined) st.vibrance = p.vibrance;
  if (p.contrast !== undefined) st.contrast = p.contrast;
  if (p.exposure !== undefined) st.exposure = p.exposure;
  if (p.bloom !== undefined) st.bloom = p.bloom;
  if (p.bloomThreshold !== undefined) st.bloomThreshold = p.bloomThreshold;
  if (p.vignette !== undefined) st.vignette = p.vignette;
  if (p.lift !== undefined) st.lift = p.lift;
  if (p.shadowTint) st.shadowTint.setRGB(...p.shadowTint);
  if (p.highlightTint) st.highlightTint.setRGB(...p.highlightTint);
}
