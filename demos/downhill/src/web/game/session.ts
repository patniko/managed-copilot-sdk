import * as THREE from 'three';
import { clamp } from '../core/math';
import type { IAudio } from '../core/audioTypes';
import type { Input, InputFrame } from '../core/input';
import type { World } from '../world/world';
import type { GateDef } from '../world/trailMesh';
import type { CharacterDef } from './rider/types';
import { Autopilot } from './autopilot';
import { ChaseCamera } from './camera';
import { Player } from './player';
import { SpeedFx } from './speedfx';
import { TrickTracker, type AirReport } from './tricks';
import type { LandingResult } from './bike';

export type SessionState = 'intro' | 'riding' | 'crashed' | 'finished';

export interface RunStats {
  time: number;
  score: number;
  bestTrick: { title: string; points: number } | null;
  airTime: number;
  maxSpeed: number;
  crashes: number;
  tricks: number;
  checkpoints: number;
  totalCheckpoints: number;
  perfects: number;
}

export interface SessionUI {
  trick(report: AirReport, combo: number, gained: number): void;
  live(names: string[]): void;
  message(text: string, kind: 'crash' | 'info' | 'good'): void;
  countdown(n: number): void;
  checkpoint(i: number, total: number): void;
  finish(stats: RunStats): void;
  fade(amount: number): void;
}

const STEP = 1 / 120;
/** Speed at "GO!" (the run starts rolling) and after a respawn, m/s. */
const DROP_IN_SPEED = 7;
const RESPAWN_SPEED = 6;

export class GameSession {
  readonly player: Player;
  readonly cam: ChaseCamera;
  readonly fx: SpeedFx;
  readonly tracker = new TrickTracker();
  state: SessionState = 'intro';
  score = 0;
  combo = 1;
  comboTimer = 0;
  runTime = 0;
  stats: RunStats;
  autopilot: Autopilot | null = null;
  paused = false;
  private introT = 0;
  private introDur = 5.2;
  private lastCount = 4;
  private crashT = 0;
  private safe: Array<{ x: number; z: number; heading: number; t: number }> = [];
  private safeTimer = 0;
  private clock = 0;
  private reached = new Set<number>();
  private checkpoints: GateDef[];
  private finishGate: GateDef;
  private introFrom = new THREE.Vector3();
  private introLook = new THREE.Vector3();
  private spinRate = 0;
  private prevSpin = 0;
  private prevFlip = 0;
  private outOfBoundsT = 0;
  respawnPoint: { x: number; z: number; heading: number };

  constructor(
    readonly world: World,
    readonly character: CharacterDef,
    private input: Input,
    private audio: IAudio | null,
    private ui: SessionUI,
    opts: { autopilot?: boolean; skipIntro?: boolean; aspect?: number } = {},
  ) {
    this.player = new Player(character, world.ground);
    world.scene.add(this.player.root);
    this.cam = new ChaseCamera(opts.aspect ?? 16 / 9);
    this.cam.style = world.env.camera ?? {};
    this.fx = new SpeedFx(world.scene, world.env, world.ground);
    const st = world.start;
    this.respawnPoint = { x: st.x, z: st.z, heading: st.heading };
    this.player.physics.reset(st.x, st.z, st.heading, 0);
    this.checkpoints = world.gates.filter((g) => g.kind === 'checkpoint');
    this.finishGate = world.gates.find((g) => g.kind === 'finish')!;
    this.stats = this.freshStats();
    if (opts.autopilot) this.autopilot = new Autopilot(world.trails, world.features);
    this.wireEvents();
    // establishing shot (like the opening of the video)
    const shot = world.env.introShot ?? { from: [-20, 6, 26], to: [30, 12, -200] };
    const fwd = new THREE.Vector3(Math.sin(st.heading), 0, -Math.cos(st.heading));
    const right = new THREE.Vector3(Math.cos(st.heading), 0, Math.sin(st.heading));
    const at = (o: number[]) => new THREE.Vector3(st.x, st.y, st.z).addScaledVector(right, o[0]).addScaledVector(fwd, -o[2]).add(new THREE.Vector3(0, o[1], 0));
    this.introFrom.copy(at(shot.from));
    this.introFrom.y = Math.max(this.introFrom.y, world.ground.heightAt(this.introFrom.x, this.introFrom.z) + 2);
    this.introLook.copy(at(shot.to));
    this.cam.snap(this.player.physics, world.ground);
    if (opts.skipIntro) this.beginRiding();
    this.player.update(0);
  }

  private freshStats(): RunStats {
    return { time: 0, score: 0, bestTrick: null, airTime: 0, maxSpeed: 0, crashes: 0, tricks: 0, checkpoints: 0, totalCheckpoints: this.checkpoints.length, perfects: 0 };
  }

  private wireEvents() {
    const p = this.player.physics;
    p.events = {
      onLaunch: () => {
        this.tracker.start(p);
        this.prevSpin = 0;
        this.prevFlip = 0;
      },
      onLand: (res: LandingResult, air) => {
        const rep = this.tracker.finish(res, air, p);
        const intensity = res.ok ? clamp(res.impact / 10, 0.1, 1) : 1;
        this.audio?.playLanding(intensity, p.surface);
        this.cam.addShake(clamp(res.impact / 14, 0, 0.6));
        this.cam.punch(clamp(res.impact / 11, 0, 1));
        this.fx.landing(p, clamp(res.impact / 10, 0.2, 1));
        this.stats.airTime += air.time;
        if (res.ok && res.sketchy && !rep) this.ui.message('Sketchy save!', 'info');
        if (rep) {
          const gained = Math.round(rep.total * this.combo);
          this.score += gained;
          this.stats.tricks += rep.tricks.length;
          if (rep.perfect) this.stats.perfects++;
          if (!this.stats.bestTrick || gained > this.stats.bestTrick.points) this.stats.bestTrick = { title: rep.title, points: gained };
          this.ui.trick(rep, this.combo, gained);
          this.audio?.playTrickLanded(gained, this.combo, rep.perfect);
          if (rep.total >= 800) this.player.celebrate = 1;
          if (rep.multiplier > 1 || rep.tricks.length > 1 || rep.total >= 500) {
            this.combo = Math.min(5, this.combo + 1);
            this.comboTimer = 5;
          }
          // clean landings surge the bike forward: bigger tricks and perfect landings give more
          const surge = (0.8 + Math.min(2.7, rep.total / 800)) * (rep.perfect ? 1.25 : 1);
          p.boost(surge);
          this.cam.boostKick(clamp(surge / 3.5, 0.25, 1));
          this.fx.boost(clamp(surge / 3.5, 0.25, 1));
          this.audio?.playWhoosh(clamp(surge / 3.5, 0.3, 1), 0);
        }
        this.ui.live([]);
      },
      onCrash: (reason) => {
        this.crashLog.push({ reason, progress: Math.round(this.progress() * 1000) / 1000, kmh: Math.round(p.speed * 3.6), wasAir: !p.grounded });
        this.state = 'crashed';
        this.crashT = 0;
        this.combo = 1;
        this.comboTimer = 0;
        this.stats.crashes++;
        this.tracker.active = false;
        this.ui.live([]);
        this.ui.message(reason, 'crash');
        this.audio?.playCrash(clamp(p.speed / 15, 0.3, 1));
        this.cam.addShake(0.8);
        this.player.startCrash();
      },
      onPop: (c) => this.audio?.playPop(c),
      onBush: () => {
        if (this.clock - this.lastBush > 0.6) {
          this.audio?.playBushHit();
          this.lastBush = this.clock;
        }
      },
      onTrickStart: () => this.audio?.playTrickStart(),
    };
  }
  private lastBush = -10;
  /** Where and why each crash happened (used by the automated playtests). */
  readonly crashLog: Array<{ reason: string; progress: number; kmh: number; wasAir: boolean }> = [];

  private beginRiding(announce = false) {
    this.state = 'riding';
    this.introT = this.introDur;
    // drop in: the run starts already rolling, like the video
    this.player.physics.push(DROP_IN_SPEED);
    if (announce) {
      this.ui.countdown(0);
      this.audio?.playCountdown(0);
    }
  }

  restart() {
    this.score = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.runTime = 0;
    this.stats = this.freshStats();
    this.reached.clear();
    this.safe = [];
    const st = this.world.start;
    this.respawnPoint = { x: st.x, z: st.z, heading: st.heading };
    if (this.player.crashed) this.player.endCrash();
    this.player.physics.reset(st.x, st.z, st.heading, 0);
    this.state = 'intro';
    // restarts skip the establishing swoop: just a 3-2-1 countdown from the chase camera
    this.introT = this.introDur - 3.05;
    this.quickIntro = true;
    this.lastCount = 4;
    this.cam.snap(this.player.physics, this.world.ground);
  }
  private quickIntro = false;

  respawn() {
    if (this.player.crashed) this.player.endCrash();
    // last safe point at least 1.5 s old
    let sp = this.respawnPoint;
    for (let i = this.safe.length - 1; i >= 0; i--) {
      if (this.clock - this.safe[i].t > 1.5) {
        sp = this.safe[i];
        break;
      }
    }
    this.player.physics.reset(sp.x, sp.z, sp.heading, RESPAWN_SPEED);
    this.safe = this.safe.filter((s) => s.t < this.clock - 1.5);
    this.state = 'riding';
    this.cam.snap(this.player.physics, this.world.ground);
    this.ui.fade(0);
  }

  /** Called every frame. Returns the input actually used. */
  update(dt: number): void {
    if (this.paused) return;
    dt = Math.min(dt, 1 / 20);
    this.clock += dt;
    const p = this.player.physics;
    const w = this.world;
    switch (this.state) {
      case 'intro': {
        this.introT += dt;
        const t = this.introT / this.introDur;
        // 3-2-1 over the last three seconds; GO! exactly when control is handed over
        const count = Math.ceil(this.introDur - this.introT);
        if (count < this.lastCount && count >= 1 && count <= 3) {
          this.lastCount = count;
          this.ui.countdown(count);
          this.audio?.playCountdown(count);
        }
        this.player.update(dt);
        if (this.quickIntro) this.cam.update(dt, p, w.ground);
        else this.cam.intro(Math.max(0, Math.min(1, (t - 0.28) * 1.6)), this.introFrom, this.introLook, p, w.ground);
        this.fx.update(dt, p, this.cam.camera, null);
        if (t >= 1) {
          this.quickIntro = false;
          this.beginRiding(true);
        }
        break;
      }
      case 'riding':
      case 'finished': {
        const inp = this.readInput(dt);
        const n = Math.max(1, Math.ceil(dt / STEP));
        for (let i = 0; i < n && !p.crashed; i++) p.step(dt / n, inp);
        if (this.state === 'riding') this.runTime += dt;
        this.tracker.update(dt, p);
        if (!p.grounded && this.tracker.active) this.ui.live(this.tracker.live);
        this.spinRate = (Math.abs(p.air.spin - this.prevSpin) + Math.abs(p.air.flip - this.prevFlip)) / Math.max(dt, 1e-4);
        this.prevSpin = p.air.spin;
        this.prevFlip = p.air.flip;
        this.player.update(dt);
        this.cam.update(dt, p, w.ground);
        this.fx.update(dt, p, this.cam.camera, this.audio);
        if (this.state === 'riding') this.checkProgress();
        this.stats.maxSpeed = Math.max(this.stats.maxSpeed, p.speed);
        if (this.comboTimer > 0) {
          this.comboTimer -= dt;
          if (this.comboTimer <= 0) this.combo = 1;
        }
        break;
      }
      case 'crashed': {
        this.crashT += dt;
        this.player.update(dt);
        this.cam.update(dt, this.player.physics, w.ground);
        this.fx.update(dt, this.player.physics, this.cam.camera, null);
        if (this.crashT > 1.9) this.ui.fade(clamp((this.crashT - 1.9) / 0.35, 0, 1));
        if (this.crashT > 2.3) this.respawn();
        break;
      }
    }
    this.audio?.updateRide(
      this.state === 'riding' || this.state === 'finished'
        ? { speed: p.speed, grounded: p.grounded, surface: p.surface, pedaling: p.pedaling, braking: p.braking, skid: p.skid, spinRate: p.grounded ? 0 : this.spinRate, dt }
        : null,
    );
  }

  private readInput(dt: number): InputFrame {
    const p = this.player.physics;
    if (this.state === 'finished') {
      const f = this.input.read();
      return { ...f, throttle: 0, brake: 0.6, jump: false, flip: 0, spin: 0 };
    }
    if (this.autopilot) return this.autopilot.read(p, dt);
    return this.input.read();
  }

  private checkProgress() {
    const p = this.player.physics;
    const pos = p.pos;
    // safe points
    this.safeTimer += 1 / 60;
    if (p.grounded && !p.crashed && p.trailDist < 1.5 && p.speed > 2 && !p.feature) {
      if (this.clock - (this.safe[this.safe.length - 1]?.t ?? -10) > 0.5) {
        this.safe.push({ x: pos.x, z: pos.z, heading: p.heading, t: this.clock });
        if (this.safe.length > 60) this.safe.shift();
      }
    }
    // checkpoints
    this.checkpoints.forEach((g, i) => {
      if (this.reached.has(i)) return;
      if (Math.hypot(pos.x - g.x, pos.z - g.z) < g.width / 2 + 3) {
        this.reached.add(i);
        this.stats.checkpoints = this.reached.size;
        this.respawnPoint = { x: g.x, z: g.z, heading: g.heading };
        this.ui.checkpoint(this.reached.size, this.checkpoints.length);
        this.audio?.playCheckpoint();
      }
    });
    // finish
    const f = this.finishGate;
    const fdx = pos.x - f.x;
    const fdz = pos.z - f.z;
    const along = fdx * Math.sin(f.heading) - fdz * Math.cos(f.heading);
    if (Math.hypot(fdx, fdz) < f.width / 2 + 5 && along > 0) {
      this.state = 'finished';
      this.stats.time = this.runTime;
      this.stats.score = this.score;
      this.audio?.playFinish();
      this.ui.finish({ ...this.stats });
      return;
    }
    // out of bounds / sea
    const t = this.world.terrain;
    const sea = this.world.env.terrain.seaLevel;
    const oob = !t.inside(pos.x, pos.z, 12) || (sea !== undefined && pos.y < sea + 0.3);
    this.outOfBoundsT = oob ? this.outOfBoundsT + 1 / 60 : 0;
    if (!t.inside(pos.x, pos.z, 60) && !oob) this.warnT += 1 / 60;
    if (this.outOfBoundsT > 0.4) {
      this.outOfBoundsT = 0;
      p.crash('Out of bounds!');
    }
  }
  private warnT = 0;

  /** Progress along the main trail 0..1 (for the HUD). */
  progress(): number {
    const p = this.player.physics.pos;
    const hit = this.world.trails.nearest(p.x, p.z, 400, (t) => t.kind === 'main');
    if (!hit) return 0;
    return clamp(hit.s / this.finishGate.s, 0, 1);
  }

  get introTime() {
    return this.introT;
  }

  dispose() {
    this.player.root.removeFromParent();
    this.fx.dispose();
  }
}
