import * as THREE from 'three';
import { createRenderer, QUALITY, type QualityLevel } from './render/renderer';
import { PainterlyPipeline } from './post/painterly';
import { Input } from './core/input';
import type { IAudio } from './core/audioTypes';
import { World } from './world/world';
import { loadEnvironments } from './world/envs';
import type { EnvironmentDef } from './world/types';
import { GameSession } from './game/session';
import { standingOn } from './game/bike';
import { defaultRiderPose, dressed, type BikeVisual, type CharacterDef, type CharacterId, type RiderRig } from './game/rider/types';
import { UI, type Settings } from './ui/ui';
import { applyPost } from './viewer';
import { clamp } from './core/math';
import { ShopScreen, type PreviewLook } from './shop/screen';
import { browserStorage } from './shop/shop';
import { ShopStage } from './shop/stage';
import { SupportPanel } from './support/panel';
import type { SessionUI } from './game/session';
import { GameTelemetry, type GameEventInput } from './telemetry';

type AppState = 'boot' | 'title' | 'select' | 'loading' | 'play' | 'shop';

async function loadOptional<T>(glob: Record<string, () => Promise<unknown>>, key: string): Promise<T | null> {
  const l = glob[key];
  if (!l) return null;
  try {
    return (await l()) as T;
  } catch (e) {
    console.error(e);
    return null;
  }
}

/** The HUD, telling telemetry what happens on a ride: the drop-in, checkpoints, tricks, crashes, and the finish. */
function trackedUi(ui: SessionUI, track: (event: GameEventInput) => void, crashKmh: () => number | undefined): SessionUI {
  return {
    trick: (report, combo, gained) => {
      ui.trick(report, combo, gained);
      track({ type: 'trick', title: report.title, points: gained, combo, perfect: report.perfect });
    },
    live: (names) => ui.live(names),
    message: (text, kind) => {
      ui.message(text, kind);
      if (kind === 'crash') track({ type: 'crash', reason: text, kmh: crashKmh() });
    },
    countdown: (n) => {
      ui.countdown(n);
      if (n === 0) track({ type: 'ride_started' });
    },
    checkpoint: (i, total) => {
      ui.checkpoint(i, total);
      track({ type: 'checkpoint', checkpoint: i, total });
    },
    finish: (stats) => {
      ui.finish(stats);
      track({ type: 'ride_finished', seconds: stats.time, score: stats.score, tricks: stats.tricks, crashes: stats.crashes });
    },
    fade: (amount) => ui.fade(amount),
  };
}

export async function startApp(params: URLSearchParams) {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = createRenderer(canvas);
  renderer.info.autoReset = false;
  const post = new PainterlyPipeline(renderer);
  const input = new Input();
  const audioMod = await loadOptional<{ audio: IAudio }>(import.meta.glob('./core/audio.ts'), './core/audio.ts');
  const audio: IAudio | null = audioMod?.audio ?? null;
  const charMod = await loadOptional<{ CHARACTERS: CharacterDef[]; preloadCharacters?: () => Promise<void> }>(
    import.meta.glob('./game/characters/index.ts'),
    './game/characters/index.ts',
  );
  const characters = charMod?.CHARACTERS ?? [];
  if (!characters.length) throw new Error('Characters failed to load');
  // sculpt the human rider on a worker while the first world is being built
  const charactersReady = charMod?.preloadCharacters?.() ?? Promise.resolve();
  const envs = await loadEnvironments();
  if (!envs.length) throw new Error('No environments could be loaded');
  const autopilot = params.has('autopilot');
  const timescale = Math.max(0.1, Math.min(8, Number(params.get('timescale') ?? 1)));

  let state: AppState = 'boot';
  let world: World | null = null;
  let session: GameSession | null = null;
  let env: EnvironmentDef = envs.find((e) => e.id === params.get('env')) ?? envs[0];
  let char: CharacterDef = characters.find((c) => c.id === params.get('char')) ?? characters[0];
  let preview: Array<{ def: CharacterDef; bike: BikeVisual; rider: RiderRig; root: THREE.Group }> = [];
  const pose = defaultRiderPose();
  const menuCam = new THREE.PerspectiveCamera(45, 1, 0.2, 30000);
  let quality: QualityLevel = 'high';
  let scale = 1;
  let maxScale = 1;
  let celebrateT = 0;

  const ui = new UI(
    characters,
    envs,
    {
      ride: () => goSelect(),
      start: (c, e) => startRun(c, e),
      previewChar: (id) => {
        char = characters.find((c) => c.id === id) ?? char;
        shop.setRider(char.id);
        celebrateT = 1.2;
      },
      resume: () => {
        if (session) session.paused = false;
      },
      restart: () => {
        if (session) session.paused = false;
        session?.restart();
        ui.showHint(input.lastDevice);
      },
      toSelect: () => goSelect(),
      toTitle: () => goTitle(),
      shop: () => goShop(),
      support: () => support.open(shop.supportRequest('support-button')),
      settings: (s) => applySettings(s),
      click: () => audio?.playUiClick(),
      hover: () => audio?.playUiHover(),
    },
    input,
  );
  // The Downhill Shop, and Contoso Outdoors' support chat (its AI agent, in Help Desk), open from anywhere
  const names = Object.fromEntries(characters.map((c) => [c.id, c.name])) as Record<CharacterId, string>;
  // What the player does streams to Incident Commander (through Downhill's server, as OpenTelemetry logs)
  const telemetry = new GameTelemetry();
  const support = new SupportPanel(ui.root, () => audio?.playUiClick());
  const shop = new ShopScreen(ui.root, browserStorage(), names, {
    back: () => goTitle(),
    ride: () => startRun(shop.state.rider, env.id),
    preview: (look) => showLook(look),
    changed: (s) => {
      char = characters.find((c) => c.id === s.rider) ?? char;
      ui.selChar = char.id;
    },
    support: (request) => support.open(request),
    added: (sku) => telemetry.track(shop.state.rider, { type: 'cart_added', sku }),
    click: () => audio?.playUiClick(),
  });
  let stage: ShopStage | null = null;
  support.onChange = (open) => {
    shop.el.classList.toggle('support-open', open);
    input.suspend(open || shop.isOpen);
  };
  // `?char=` picks the rider you ride as; otherwise it's the one you rode last
  const chosen = characters.find((c) => c.id === params.get('char'));
  if (chosen) shop.setRider(chosen.id);
  char = characters.find((c) => c.id === shop.state.rider) ?? char;
  /** The character as the shop has dressed them: their outfit and the bike paint they wear. */
  const dress = (def: CharacterDef) => {
    const look = shop.lookOf(def.id);
    return dressed(def, look.colors, look.paint);
  };
  ui.onPause = () => {
    if (session) session.paused = true;
  };
  ui.onFade = (a) => (post.fade = a);
  ui.onFinish = (stats) => {
    setTimeout(() => ui.showResults(stats, env, char), 1600);
  };
  ui.selChar = char.id;
  ui.selEnv = env.id;
  const qParam = params.get('q');
  if (qParam && ['auto', 'low', 'medium', 'high', 'ultra'].includes(qParam)) ui.settings.quality = qParam as Settings['quality'];

  function applySettings(s: Settings) {
    post.settings.painterly = s.painterly;
    post.settings.motionBlur = s.motionBlur ? 1 : 0;
    if (session) session.player.physics.assist = s.assist ? 1 : 0;
    audio?.setVolumes({ music: s.music, sfx: s.sfx });
    const lvl: QualityLevel = s.quality === 'auto' ? 'high' : s.quality;
    if (lvl !== quality) {
      quality = lvl;
      maxScale = QUALITY[lvl].renderScale;
      scale = maxScale;
      post.setRenderScale(scale);
      post.settings.radius = QUALITY[lvl].radius;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[lvl].pixelRatioCap));
      resize();
    }
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const pr = renderer.getPixelRatio();
    post.setSize(Math.round(w * pr), Math.round(h * pr));
    for (const cam of [menuCam, session?.cam.camera]) {
      if (!cam) continue;
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }
  window.addEventListener('resize', resize);

  const unlock = () => {
    audio?.unlock().then(() => {
      audio.setMusic(true);
      audio.setAmbience(state === 'play' ? env.ambience : 'menu');
    });
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  async function loadWorld(e: EnvironmentDef) {
    if (world && world.env.id === e.id) return world;
    ui.screen('loading');
    ui.setLoading(e, 0, 'Preparing');
    clearPreview();
    session?.dispose();
    session = null;
    world?.dispose();
    world = null;
    const q = QUALITY[quality];
    const w = await World.build(e, { grass: { near: q.grassNear, far: q.grassFar }, shadowMap: q.shadowMap }, (p, l) => ui.setLoading(e, p, l));
    await charactersReady;
    world = w;
    env = e;
    applyPost(post, e, QUALITY[quality].radius);
    applySettings(ui.settings);
    return w;
  }

  function clearPreview() {
    for (const p of preview) p.root.removeFromParent();
    preview = [];
  }

  function buildPreview() {
    if (!world || preview.length) return;
    const st = world.start;
    const fwd = new THREE.Vector3(Math.sin(st.heading), 0, -Math.cos(st.heading));
    const right = new THREE.Vector3(Math.cos(st.heading), 0, Math.sin(st.heading));
    characters.forEach((def, i) => {
      const look = dress(def);
      const bike = look.createBike();
      const rider = look.createRider();
      const root = new THREE.Group();
      root.add(bike.root);
      bike.root.add(rider.root);
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
      });
      const p = new THREE.Vector3(st.x, 0, st.z).addScaledVector(right, (i - 1) * 2.3).addScaledVector(fwd, 14 - Math.abs(i - 1) * 1.2);
      const heading = st.heading + 0.6;
      const stand = standingOn(world!.ground, p.x, p.z, heading);
      p.y = stand.y;
      root.position.copy(p);
      root.rotation.set(-stand.pitch, -heading, 0, 'YXZ');
      world!.scene.add(root);
      preview.push({ def, bike, rider, root });
    });
  }

  function attractSession() {
    if (!world) return;
    session?.dispose();
    session = new GameSession(world, dress(char), input, null, ui, { autopilot: true, skipIntro: true, aspect: window.innerWidth / window.innerHeight });
    session.autopilot!.targetSpeed = 12.5;
  }

  async function goTitle() {
    leaveShop();
    state = 'title';
    clearPreview();
    if (!world) await loadWorld(env);
    attractSession();
    ui.screen('title');
    audio?.setAmbience('menu');
    post.fade = 0;
  }

  async function goSelect() {
    leaveShop();
    state = 'select';
    if (!world) await loadWorld(env);
    session?.dispose();
    session = null;
    buildPreview();
    ui.selChar = char.id;
    ui.screen('select');
    audio?.setAmbience('menu');
    post.fade = 0;
  }

  /** The Downhill Shop, over the world: a run in progress ends, and the preview stands where the riders line up. */
  async function goShop() {
    if (state === 'shop' || state === 'loading') return;
    state = 'shop';
    if (!world) await loadWorld(env);
    session?.dispose();
    session = null;
    clearPreview();
    if (ui.paused) ui.togglePause(false, true);
    ui.screen('shop');
    if (!stage || stage.world !== world) {
      stage?.dispose();
      stage = new ShopStage(world!);
    }
    input.suspend(true);
    shop.open();
    telemetry.track(shop.state.rider, { type: 'shop_opened' });
    audio?.setAmbience('menu');
    post.fade = 0;
  }

  function leaveShop() {
    if (!shop.isOpen) return;
    support.close();
    shop.close();
    stage?.clear();
    input.suspend(false);
  }

  function showLook(look: PreviewLook) {
    const def = characters.find((c) => c.id === look.rider);
    if (def && stage) stage.show(dressed(def, look.colors, look.paint), look.key);
  }

  async function startRun(charId: string, envId: string) {
    leaveShop();
    char = characters.find((c) => c.id === charId) ?? char;
    shop.setRider(char.id);
    const e = envs.find((x) => x.id === envId) ?? env;
    state = 'loading';
    clearPreview();
    session?.dispose();
    session = null;
    await loadWorld(e);
    const rider = char.id;
    const where = { world: e.id, worldName: e.name, ...(autopilot ? { bot: true } : {}) };
    const track = (event: GameEventInput) => telemetry.track(rider, { ...where, ...event } as GameEventInput);
    session = new GameSession(world!, dress(char), input, audio, trackedUi(ui, track, () => session?.crashLog.at(-1)?.kmh), { autopilot, aspect: window.innerWidth / window.innerHeight });
    session.player.physics.assist = ui.settings.assist ? 1 : 0;
    const main = world!.trails.main;
    ui.setCheckpointMarkers(world!.gates.filter((g) => g.kind === 'checkpoint').map((g) => g.s / (main.length - 45)));
    state = 'play';
    ui.screen('play');
    ui.showHint(input.lastDevice);
    audio?.setAmbience(e.ambience);
    post.fade = 0;
    resize();
  }

  // ----- main loop -----
  const motion = { forwardSpeed: 0, foe: new THREE.Vector2(0.5, 0.5) };
  let last = performance.now();
  let time = 0;
  let fpsAcc = 0,
    fpsN = 0,
    fps = 60,
    perfAcc = 0,
    perfN = 0;
  let selOrbit = 0;
  const v3a = new THREE.Vector3();
  const v3b = new THREE.Vector3();

  function handleKeys() {
    input.poll();
    if (input.consume('mute') && audio) audio.setMuted(!audio.muted);
    if (state === 'title') {
      if (input.consume('confirm') || input.consume('jump')) goSelect();
    } else if (state === 'select') {
      if (input.consume('left')) ui.cycleSelection(-1, 'char');
      if (input.consume('right')) ui.cycleSelection(1, 'char');
      if (input.consume('up')) ui.cycleSelection(-1, 'env');
      if (input.consume('down')) ui.cycleSelection(1, 'env');
      if (input.consume('confirm')) startRun(ui.selChar, ui.selEnv);
      if (input.consume('back') || input.consume('pause')) goTitle();
    } else if (state === 'play' && session) {
      if (input.consume('pause')) {
        if (ui.modalOpen) ui.closeModals();
        else if (!ui.resultsOpen) ui.togglePause(!ui.paused);
      }
      if (!ui.paused) {
        if (input.consume('respawn') && session.state === 'riding') session.player.physics.crash('Respawn');
        if (input.consume('camera')) session.cam.cycleMode();
      }
    }
    input.clearPresses();
  }

  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    handleKeys();
    if (!world) return;
    let cam: THREE.PerspectiveCamera = menuCam;
    if ((state === 'title' || state === 'play') && session) {
      if (state === 'title' && (session.state === 'finished' || session.runTime > 170)) attractSession();
      for (let k = 0; k < Math.ceil(timescale); k++) session.update(dt * (timescale / Math.ceil(timescale)));
      cam = session.cam.camera;
      session.cam.motion(motion);
      if (state === 'play') {
        const p = session.player.physics;
        ui.updateHud(dt, {
          score: session.score,
          combo: session.combo,
          comboT: session.comboTimer,
          time: session.runTime,
          speed: p.speed,
          progress: session.progress(),
          cps: session.stats.totalCheckpoints ? `CHECKPOINTS ${session.stats.checkpoints}/${session.stats.totalCheckpoints}` : '',
          fps,
        });
      }
      world.update(dt, time, cam, session.player.physics.pos);
    } else if (state === 'select') {
      selOrbit += dt;
      const st = world.start;
      const fwd = v3a.set(Math.sin(st.heading), 0, -Math.cos(st.heading));
      const right = v3b.set(Math.cos(st.heading), 0, Math.sin(st.heading));
      const idx = Math.max(0, preview.findIndex((p) => p.def.id === char.id));
      const focus = preview[1]?.root.position ?? new THREE.Vector3(st.x, st.y, st.z);
      const camPos = new THREE.Vector3(st.x, 0, st.z).addScaledVector(fwd, 20.8 + Math.sin(selOrbit * 0.3) * 0.3).addScaledVector(right, -0.6 + (idx - 1) * 0.5);
      camPos.y = world.ground.heightAt(camPos.x, camPos.z) + 1.3;
      menuCam.position.lerp(camPos, 1 - Math.exp(-dt * 4));
      const look = focus.clone().add(new THREE.Vector3(0, 0.15, 0)).addScaledVector(right, 1.3 + (idx - 1) * 0.5);
      menuCam.lookAt(look);
      menuCam.fov = 44;
      menuCam.aspect = window.innerWidth / window.innerHeight;
      menuCam.updateProjectionMatrix();
      celebrateT = Math.max(0, celebrateT - dt);
      preview.forEach((p, i) => {
        const sel = p.def.id === char.id;
        pose.time = time + i;
        pose.speed = 0;
        pose.seated = 1;
        pose.celebrate = sel && celebrateT > 0 ? Math.sin(Math.min(1, celebrateT) * Math.PI) : 0;
        p.bike.update({ rearSpin: 0, frontSpin: 0, crank: 0.4, steer: Math.sin(time * 0.8 + i) * 0.1, barspin: 0, tailwhip: 0, suspension: 0 });
        p.rider.update(pose, p.bike.anchors, dt);
        const s = sel ? 1.06 : 0.9;
        p.root.scale.setScalar(THREE.MathUtils.lerp(p.root.scale.x, s, 1 - Math.exp(-dt * 6)));
      });
      motion.forwardSpeed = 0;
      world.update(dt, time, menuCam, focus);
    } else if (state === 'shop' && stage) {
      const focus = stage.update(dt, time, menuCam, shop.stageCenter());
      motion.forwardSpeed = 0;
      world.update(dt, time, menuCam, focus);
    } else {
      motion.forwardSpeed = 0;
      world.update(dt, time, menuCam, menuCam.position);
    }
    renderer.info.reset();
    post.render(world.scene, cam, time, motion);
    if (state !== 'play' || !session || ui.paused) audio?.updateRide(null);

    fpsAcc += dt;
    fpsN++;
    if (fpsAcc > 0.5) {
      fps = fpsN / fpsAcc;
      fpsAcc = 0;
      fpsN = 0;
    }
    if (ui.settings.quality === 'auto' && state !== 'loading') {
      perfAcc += dt;
      perfN++;
      if (perfAcc > 1.5) {
        const avg = perfAcc / perfN;
        if (avg > 0.0195 && scale > 0.55) scale = Math.max(0.55, scale - 0.08);
        else if (avg < 0.0135 && scale < maxScale) scale = Math.min(maxScale, scale + 0.04);
        post.setRenderScale(clamp(scale, 0.5, 1));
        perfAcc = 0;
        perfN = 0;
      }
    }
    (window as unknown as { __state?: unknown }).__state = { state, session: session?.state, fps, scale };
  }

  quality = ui.settings.quality === 'auto' ? 'high' : ui.settings.quality;
  maxScale = QUALITY[quality].renderScale;
  scale = maxScale;
  post.settings.renderScale = scale;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[quality].pixelRatioCap));
  resize();
  await loadWorld(env);
  if (params.has('play')) await startRun(char.id, env.id);
  else if (params.has('select')) await goSelect();
  else if (params.has('shop')) await goShop();
  else await goTitle();
  requestAnimationFrame(frame);
  setTimeout(() => ((window as unknown as { __ready: boolean }).__ready = true), Number(params.get('readyMs') ?? 2500));
  (window as unknown as Record<string, unknown>).__probe = () => {
    const s = session;
    if (!s) return { state, fps, shop: shop.state };
    const p = s.player.physics;
    return { state, fps, scale, shop: shop.state, session: s.state, time: s.runTime, score: s.score, stats: s.stats, crashLog: s.crashLog, pos: [p.pos.x, p.pos.y, p.pos.z], speed: p.speed, progress: s.progress(), grounded: p.grounded, calls: renderer.info.render.calls, cam: s.cam.debug(), fx: { puffs: s.fx.particles, streaks: Math.round(s.fx.streakIntensity * 100) / 100 } };
  };
  (window as unknown as Record<string, unknown>).__game = {
    get session() {
      return session;
    },
    get world() {
      return world;
    },
    input,
    ui,
    post,
    renderer,
  };
}
