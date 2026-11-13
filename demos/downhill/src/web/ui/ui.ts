import './ui.css';
import type { CharacterDef } from '../game/rider/types';
import type { EnvironmentDef } from '../world/types';
import type { AirReport } from '../game/tricks';
import type { RunStats, SessionUI } from '../game/session';
import type { Input } from '../core/input';
import { CHAT_ICON } from '../support/icon';

export interface Settings {
  quality: 'auto' | 'low' | 'medium' | 'high' | 'ultra';
  painterly: boolean;
  motionBlur: boolean;
  assist: boolean;
  music: number;
  sfx: number;
  showFps: boolean;
}

export const DEFAULT_SETTINGS: Settings = { quality: 'auto', painterly: true, motionBlur: true, assist: true, music: 0.6, sfx: 0.9, showFps: false };

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('downhill.settings') ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function saveSettings(s: Settings) {
  localStorage.setItem('downhill.settings', JSON.stringify(s));
}

type Best = Record<string, { score: number; time: number }>;
export function loadBest(): Best {
  try {
    return JSON.parse(localStorage.getItem('downhill.best') ?? '{}');
  } catch {
    return {};
  }
}
export function saveBest(b: Best) {
  localStorage.setItem('downhill.best', JSON.stringify(b));
}

export interface UIHandlers {
  ride(): void;
  start(charId: string, envId: string): void;
  previewChar(charId: string): void;
  resume(): void;
  restart(): void;
  toSelect(): void;
  toTitle(): void;
  /** Open the Downhill Shop (ends a run in progress). */
  shop(): void;
  /** Open support: Contoso Outdoors' AI agent, in a panel over the game. */
  support(): void;
  settings(s: Settings): void;
  click(): void;
  hover(): void;
}

const h = (tag: string, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export const fmtTime = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};
const scoreFmt = new Intl.NumberFormat('en-US');
const fmtScore = (n: number) => scoreFmt.format(Math.round(n));

const TIPS = [
  'Hold SPACE to preload, release at the lip for a bigger pop.',
  'Land with the bike lined up with your direction of travel — the assist helps a little.',
  'Chain tricks within 5 seconds to grow your combo multiplier (up to ×5).',
  'Side lines branch off the main trail: the Pro line has the biggest gaps.',
  'Mix rotations and grabs in one air: a 360 Tailwhip scores far more than either alone.',
  'Let go of a grab before you land, or you will bail!',
  'Off-trail grass is slower than packed dirt. Bushes slow you down; rocks and trees do not forgive.',
  'Press C to change camera. R respawns at your last safe spot.',
];

export class UI implements SessionUI {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private select: HTMLElement;
  private loading: HTMLElement;
  private hud: HTMLElement;
  private pause: HTMLElement;
  private results: HTMLElement;
  private settingsEl: HTMLElement;
  private controls: HTMLElement;
  private touch: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  selChar = 'rider';
  selEnv = 'citadel';
  settings: Settings;
  private hintTimer = 0;

  constructor(
    private chars: CharacterDef[],
    private envs: EnvironmentDef[],
    private on: UIHandlers,
    private input: Input,
  ) {
    this.root = document.getElementById('ui')!;
    this.settings = loadSettings();
    this.title = this.buildTitle();
    this.select = this.buildSelect();
    this.loading = this.buildLoading();
    this.hud = this.buildHud();
    this.pause = this.buildPause();
    this.results = h('div', 'screen dim hidden');
    this.settingsEl = this.buildSettings();
    this.controls = this.buildControls();
    this.touch = this.buildTouch();
    this.root.append(this.hud, this.touch, this.title, this.select, this.loading, this.pause, this.results, this.settingsEl, this.controls);
    this.root.addEventListener('mouseover', (e) => {
      if ((e.target as HTMLElement).closest('.btn, .card, .shop-item')) this.on.hover();
    });
  }

  private show(el: HTMLElement, on: boolean) {
    if (on) {
      el.classList.remove('hidden');
      requestAnimationFrame(() => el.classList.add('show'));
    } else {
      el.classList.remove('show');
      el.classList.add('hidden');
    }
  }

  screen(name: 'title' | 'select' | 'loading' | 'play' | 'shop' | 'none') {
    this.show(this.title, name === 'title');
    this.show(this.select, name === 'select');
    this.show(this.loading, name === 'loading');
    this.hud.classList.toggle('hidden', name !== 'play');
    const touch = name === 'play' && (matchMedia('(pointer: coarse)').matches || this.input.lastDevice === 'touch');
    this.touch.classList.toggle('hidden', !touch);
    if (name !== 'play') {
      this.show(this.pause, false);
      this.show(this.results, false);
    }
    if (name === 'select') this.refreshSelect();
  }

  // ---------- title ----------
  private buildTitle() {
    const s = h('div', 'screen hidden');
    const wrap = h('div', 'title-wrap');
    wrap.append(
      h('div', 'logo', 'DOWNHILL<small>A PAINTED RIDE</small>'),
      h('div', 'tagline', 'Bomb painted mountainsides, launch off kickers and stomp flips &amp; tailwhips — as Mona, Copilot or the original rider.'),
    );
    const act = h('div', 'title-actions');
    const ride = h('button', 'btn', 'RIDE') as HTMLButtonElement;
    ride.onclick = () => {
      this.on.click();
      this.on.ride();
    };
    const shop = h('button', 'btn lime small shop-entry', 'Shop');
    shop.onclick = () => {
      this.on.click();
      this.on.shop();
    };
    const support = h('button', 'btn ghost small', `${CHAT_ICON}Support`);
    support.title = 'Chat with Contoso Outdoors support';
    support.onclick = () => {
      this.on.click();
      this.on.support();
    };
    const ctl = h('button', 'btn ghost small', 'Controls');
    ctl.onclick = () => {
      this.on.click();
      this.show(this.controls, true);
    };
    const set = h('button', 'btn ghost small', 'Settings');
    set.onclick = () => {
      this.on.click();
      this.openSettings();
    };
    act.append(ride, shop, support, ctl, set, h('span', 'press', 'press ENTER'));
    s.append(wrap, act);
    return s;
  }

  // ---------- select ----------
  private buildSelect() {
    const s = h('div', 'screen select hidden');
    const riders = h('div', 'riders');
    riders.append(h('h2', '', 'CHOOSE YOUR RIDER'));
    const cr = h('div', 'col');
    for (const c of this.chars) {
      const card = h('div', 'card');
      card.dataset.id = c.id;
      card.append(h('div', 'swatch'), h('div', 'name', c.name), h('div', 'sub', c.tagline));
      (card.firstChild as HTMLElement).style.background = c.accent;
      card.onclick = () => {
        this.on.click();
        this.selChar = c.id;
        this.on.previewChar(c.id);
        this.refreshSelect();
      };
      cr.append(card);
    }
    riders.append(cr);
    s.append(riders);
    const bottom = h('div', 'worlds');
    bottom.append(h('h2', '', 'CHOOSE YOUR WORLD'));
    const wr = h('div', 'row');
    for (const e of this.envs) {
      const card = h('div', 'card world');
      card.dataset.id = e.id;
      const th = h('div', 'thumb');
      th.style.backgroundImage = `url(thumbs/${e.id}.jpg), linear-gradient(160deg, ${e.cardColors[1]} 0%, ${e.cardColors[2]} 55%, ${e.cardColors[0]} 100%)`;
      card.append(th, h('div', 'name', e.name), h('div', 'sub', e.subtitle), h('div', 'best'));
      card.onclick = () => {
        this.on.click();
        this.selEnv = e.id;
        this.refreshSelect();
      };
      wr.append(card);
    }
    bottom.append(wr);
    const desc = h('div', 'desc');
    this.els.desc = desc;
    bottom.append(desc);
    s.append(bottom);
    const act = h('div', 'select-actions');
    const back = h('button', 'btn ghost small', '◀ Back');
    back.onclick = () => {
      this.on.click();
      this.on.toTitle();
    };
    const go = h('button', 'btn lime', 'DROP IN ▶');
    go.onclick = () => {
      this.on.click();
      this.on.start(this.selChar, this.selEnv);
    };
    act.append(back, go);
    s.append(act);
    return s;
  }

  refreshSelect() {
    const best = loadBest();
    this.select.querySelectorAll<HTMLElement>('.card').forEach((c) => {
      const isWorld = c.classList.contains('world');
      c.classList.toggle('sel', isWorld ? c.dataset.id === this.selEnv : c.dataset.id === this.selChar);
      if (isWorld) {
        const b = best[`${c.dataset.id}:${this.selChar}`];
        const el = c.querySelector('.best') as HTMLElement;
        el.textContent = b ? `BEST ${fmtScore(b.score)}` : '';
        el.style.display = b ? 'block' : 'none';
      }
    });
    const env = this.envs.find((e) => e.id === this.selEnv);
    this.els.desc.textContent = env?.description ?? '';
  }

  cycleSelection(dx: number, row: 'char' | 'env') {
    if (row === 'char') {
      const i = this.chars.findIndex((c) => c.id === this.selChar);
      this.selChar = this.chars[(i + dx + this.chars.length) % this.chars.length].id;
      this.on.previewChar(this.selChar);
    } else {
      const i = this.envs.findIndex((e) => e.id === this.selEnv);
      this.selEnv = this.envs[(i + dx + this.envs.length) % this.envs.length].id;
    }
    this.refreshSelect();
  }

  // ---------- loading ----------
  private buildLoading() {
    const s = h('div', 'screen loading hidden');
    const name = h('div', 'wname');
    const sub = h('div', 'wsub');
    const bar = h('div', 'bar');
    const fill = h('div');
    bar.append(fill);
    const label = h('div', 'label');
    const tip = h('div', 'tip');
    s.append(name, sub, bar, label, tip);
    Object.assign(this.els, { lname: name, lsub: sub, lfill: fill, llabel: label, ltip: tip });
    return s;
  }

  setLoading(env: EnvironmentDef, p: number, label: string) {
    this.els.lname.textContent = env.name;
    this.els.lsub.textContent = env.subtitle;
    this.els.lfill.style.width = `${Math.round(p * 100)}%`;
    this.els.llabel.textContent = label + '…';
    if (p < 0.05) this.els.ltip.textContent = 'TIP: ' + TIPS[Math.floor(Math.random() * TIPS.length)];
  }

  // ---------- HUD ----------
  private buildHud() {
    const d = h('div', 'hud hidden');
    d.innerHTML = `
      <div class="score"><small>SCORE</small><span data-k="score">0</span></div>
      <div class="combo" data-k="comboWrap"><span data-k="combo"></span><div class="cbar"><div data-k="cbar"></div></div></div>
      <div class="timer"><small>TIME</small><span data-k="time">0:00.00</span></div>
      <div class="cps" data-k="cps"></div>
      <div class="speed">
        <svg viewBox="0 0 150 92"><path d="M15 85 A60 60 0 0 1 135 85" fill="none" stroke="rgba(20,32,74,.5)" stroke-width="12" stroke-linecap="round"/>
        <path data-k="arc" d="M15 85 A60 60 0 0 1 135 85" fill="none" stroke="#d9ec6a" stroke-width="12" stroke-linecap="round" pathLength="100" stroke-dasharray="0 100"/></svg>
        <div class="val" data-k="speed">0</div><div class="unit">KM/H</div>
      </div>
      <div class="progress" data-k="prog"><div class="fill" data-k="pfill"></div><div class="dot" data-k="pdot"></div></div>
      <div class="live" data-k="live"></div>
      <div class="hint" data-k="hint"></div>
      <div class="fps" data-k="fps"></div>
      <div data-k="fx"></div>`;
    d.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.els[e.dataset.k!] = e));
    const corner = h('div', 'corner-btns');
    const pb = h('button', 'btn ghost small', 'II');
    pb.onclick = () => this.togglePause(true);
    corner.append(pb);
    d.append(corner);
    return d;
  }

  setCheckpointMarkers(fracs: number[]) {
    const prog = this.els.prog;
    prog.querySelectorAll('.cp').forEach((e) => e.remove());
    for (const f of fracs) {
      const m = h('div', 'cp');
      m.style.left = `${f * 100}%`;
      prog.append(m);
    }
  }

  showHint(device: string) {
    const kb = `<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> ride &nbsp; <kbd>SPACE</kbd> hold+release to pop<br/>
      In the air: <kbd>W</kbd>/<kbd>S</kbd> flips &nbsp; <kbd>A</kbd>/<kbd>D</kbd> spins &nbsp; <kbd>Q</kbd>/<kbd>E</kbd> tabletop<br/>
      Tricks: <kbd>J</kbd> Superman <kbd>K</kbd> No-Hander <kbd>L</kbd> Can-Can <kbd>U</kbd> Tailwhip <kbd>I</kbd> Barspin<br/>
      <kbd>R</kbd> respawn &nbsp; <kbd>C</kbd> camera &nbsp; <kbd>Esc</kbd> pause`;
    const pad = `🎮 Left stick steer/spin/flip · RT pedal · LT brake · A pop<br/>X Superman · Y No-Hander · B Can-Can · RB Tailwhip · LB Barspin · Start pause`;
    this.els.hint.innerHTML = device === 'gamepad' ? pad : kb;
    this.els.hint.style.opacity = '1';
    this.hintTimer = 14;
  }

  private hudCache = new Map<string, string>();

  /** Write a HUD text/style value only when it changed (avoids per-frame style/layout work). */
  private hudSet(key: string, v: string, apply: (v: string) => void) {
    if (this.hudCache.get(key) === v) return;
    this.hudCache.set(key, v);
    apply(v);
  }

  updateHud(dt: number, d: { score: number; combo: number; comboT: number; time: number; speed: number; progress: number; cps: string; fps: number }) {
    const els = this.els;
    this.hudSet('score', fmtScore(d.score), (v) => (els.score.textContent = v));
    this.hudSet('combo', d.combo > 1 ? `×${d.combo} COMBO` : '', (v) => (els.combo.textContent = v));
    this.hudSet('comboOp', d.combo > 1 ? '1' : '0', (v) => (els.comboWrap.style.opacity = v));
    this.hudSet('cbar', `${(Math.max(0, Math.min(1, d.comboT / 5)) * 100).toFixed(1)}%`, (v) => (els.cbar.style.width = v));
    this.hudSet('time', fmtTime(d.time), (v) => (els.time.textContent = v));
    const kmh = d.speed * 3.6;
    this.hudSet('speed', String(Math.round(kmh)), (v) => (els.speed.textContent = v));
    this.hudSet('arc', `${Math.min(100, (kmh / 80) * 100).toFixed(1)} 100`, (v) => els.arc.setAttribute('stroke-dasharray', v));
    this.hudSet('prog', `${(d.progress * 100).toFixed(2)}%`, (v) => {
      els.pfill.style.width = v;
      els.pdot.style.left = v;
    });
    this.hudSet('cps', d.cps, (v) => (els.cps.textContent = v));
    this.hudSet('fps', this.settings.showFps ? `${Math.round(d.fps)} fps` : '', (v) => (els.fps.textContent = v));
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.els.hint.style.opacity = '0';
    }
  }

  private fx(el: HTMLElement, ms: number) {
    this.els.fx.append(el);
    setTimeout(() => el.remove(), ms);
  }

  // SessionUI
  trick(r: AirReport, combo: number, gained: number) {
    const el = h('div', 'popup');
    el.append(h('div', 't', r.title.toUpperCase()), h('div', 'p', `+${fmtScore(gained)}`));
    if (combo > 1 || r.multiplier > 1) el.append(h('div', 'x', `${r.multiplier > 1 ? `trick ×${r.multiplier}` : ''}${combo > 1 ? `  combo ×${combo}` : ''}`));
    if (r.perfect) el.append(h('div', 'perfect', 'PERFECT LANDING'));
    this.els.fx.querySelectorAll('.popup').forEach((p) => p.remove());
    this.fx(el, 2400);
  }
  live(names: string[]) {
    this.els.live.textContent = names.join(' + ');
  }
  message(text: string, kind: 'crash' | 'info' | 'good') {
    const el = h('div', `msg ${kind}`, text);
    this.els.fx.querySelectorAll('.msg').forEach((p) => p.remove());
    this.fx(el, 2000);
  }
  countdown(n: number) {
    const el = h('div', 'countdown', n === 0 ? 'GO!' : String(n));
    this.els.fx.querySelectorAll('.countdown').forEach((p) => p.remove());
    this.fx(el, 950);
  }
  checkpoint(i: number, total: number) {
    this.message(`CHECKPOINT ${i}/${total}`, 'good');
  }
  finish(stats: RunStats) {
    this.onFinish?.(stats);
  }
  fade(_a: number) {
    this.onFade?.(_a);
  }
  onFinish?: (s: RunStats) => void;
  onFade?: (a: number) => void;

  // ---------- pause ----------
  private buildPause() {
    const s = h('div', 'screen dim hidden');
    const p = h('div', 'panel');
    p.append(h('h1', '', 'Paused'), h('h3', '', 'Take a breather.'));
    const st = h('div', 'stack');
    const mk = (label: string, fn: () => void, cls = 'btn') => {
      const b = h('button', cls, label);
      b.onclick = () => {
        this.on.click();
        fn();
      };
      st.append(b);
    };
    mk('Resume', () => this.togglePause(false), 'btn lime');
    mk('Restart run', () => {
      this.togglePause(false, true);
      this.on.restart();
    });
    mk('Change rider / world', () => {
      this.togglePause(false, true);
      this.on.toSelect();
    }, 'btn ghost');
    mk('Shop', () => {
      this.togglePause(false, true);
      this.on.shop();
    }, 'btn ghost shop-entry');
    // Support opens over the pause menu: the run stays paused until the player resumes it.
    mk(`${CHAT_ICON}Support`, () => this.on.support(), 'btn ghost');
    mk('Settings', () => this.openSettings(), 'btn ghost');
    mk('Controls', () => this.show(this.controls, true), 'btn ghost');
    p.append(st);
    s.append(p);
    return s;
  }

  paused = false;
  togglePause(on: boolean, silent = false) {
    this.paused = on;
    this.show(this.pause, on);
    if (!on && !silent) this.on.resume();
    if (on) this.onPause?.();
    return true;
  }
  onPause?: () => void;

  // ---------- results ----------
  showResults(stats: RunStats, env: EnvironmentDef, char: CharacterDef) {
    const best = loadBest();
    const key = `${env.id}:${char.id}`;
    const prev = best[key];
    const isBest = !prev || stats.score > prev.score;
    if (isBest) {
      best[key] = { score: stats.score, time: stats.time };
      saveBest(best);
    }
    const el = this.results;
    el.innerHTML = '';
    const p = h('div', 'panel');
    p.append(h('h1', '', 'Run complete!'), h('h3', '', `${char.name} · ${env.name}`));
    const big = h('div', 'big', fmtScore(stats.score));
    if (isBest) big.append(h('span', 'newbest', 'NEW BEST'));
    p.append(big);
    const grid = h('div', 'grid');
    const stat = (k: string, v: string) => {
      const d = h('div', 'stat');
      d.append(h('div', 'k', k), h('div', 'v', v));
      grid.append(d);
    };
    stat('TIME', fmtTime(stats.time));
    stat('TOP SPEED', `${Math.round(stats.maxSpeed * 3.6)} km/h`);
    stat('AIRTIME', `${stats.airTime.toFixed(1)} s`);
    stat('TRICKS', String(stats.tricks));
    stat('PERFECT LANDINGS', String(stats.perfects));
    stat('CRASHES', String(stats.crashes));
    p.append(grid);
    if (stats.bestTrick) {
      const d = h('div', 'stat');
      d.append(h('div', 'k', 'BEST TRICK'), h('div', 'v', `${stats.bestTrick.title} · ${fmtScore(stats.bestTrick.points)}`));
      p.append(d);
    }
    const row = h('div', 'row2');
    const again = h('button', 'btn lime', 'Ride again');
    again.onclick = () => {
      this.on.click();
      this.show(this.results, false);
      this.on.restart();
    };
    const shop = h('button', 'btn ghost shop-entry', 'Shop');
    shop.onclick = () => {
      this.on.click();
      this.show(this.results, false);
      this.on.shop();
    };
    const sel = h('button', 'btn ghost', 'Change rider / world');
    sel.onclick = () => {
      this.on.click();
      this.show(this.results, false);
      this.on.toSelect();
    };
    row.append(again, shop, sel);
    p.append(row);
    el.append(p);
    this.show(el, true);
  }

  get resultsOpen() {
    return !this.results.classList.contains('hidden');
  }

  // ---------- settings ----------
  private buildSettings() {
    const s = h('div', 'screen dim hidden');
    return s;
  }

  openSettings() {
    const s = this.settingsEl;
    s.innerHTML = '';
    const p = h('div', 'panel');
    p.append(h('h1', '', 'Settings'));
    const st = this.settings;
    const opt = (label: string, ctrl: HTMLElement) => {
      const r = h('div', 'opt');
      r.append(h('span', '', label), ctrl);
      p.append(r);
    };
    const sel = h('select') as HTMLSelectElement;
    for (const q of ['auto', 'low', 'medium', 'high', 'ultra']) sel.append(new Option(q[0].toUpperCase() + q.slice(1), q, false, st.quality === q));
    sel.onchange = () => this.apply({ quality: sel.value as Settings['quality'] });
    opt('Graphics quality', sel);
    const chk = (k: 'painterly' | 'motionBlur' | 'assist' | 'showFps') => {
      const c = h('input') as HTMLInputElement;
      c.type = 'checkbox';
      c.checked = st[k];
      c.onchange = () => this.apply({ [k]: c.checked } as Partial<Settings>);
      return c;
    };
    opt('Painterly filter', chk('painterly'));
    opt('Speed blur', chk('motionBlur'));
    opt('Landing assist', chk('assist'));
    opt('Show FPS', chk('showFps'));
    const rng = (k: 'music' | 'sfx') => {
      const r = h('input') as HTMLInputElement;
      r.type = 'range';
      r.min = '0';
      r.max = '1';
      r.step = '0.05';
      r.value = String(st[k]);
      r.oninput = () => this.apply({ [k]: Number(r.value) } as Partial<Settings>);
      return r;
    };
    opt('Music', rng('music'));
    opt('Sound effects', rng('sfx'));
    const row = h('div', 'row2');
    const close = h('button', 'btn lime', 'Done');
    close.onclick = () => {
      this.on.click();
      this.show(s, false);
    };
    row.append(close);
    p.append(row);
    s.append(p);
    this.show(s, true);
  }

  private apply(patch: Partial<Settings>) {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    this.on.settings(this.settings);
  }

  // ---------- controls ----------
  private buildControls() {
    const s = h('div', 'screen dim hidden');
    const p = h('div', 'panel');
    p.innerHTML = `<h1>Controls</h1><h3>Keyboard · Gamepad · Touch</h3>
      <table>
      <tr><td><kbd>W</kbd> / <kbd>↑</kbd></td><td>Pedal · in the air: front flip</td></tr>
      <tr><td><kbd>S</kbd> / <kbd>↓</kbd></td><td>Brake · in the air: back flip</td></tr>
      <tr><td><kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd></td><td>Steer · in the air: spin</td></tr>
      <tr><td><kbd>Space</kbd></td><td>Hold to preload, release to pop (bigger off kicker lips)</td></tr>
      <tr><td><kbd>Q</kbd> <kbd>E</kbd></td><td>Tabletop (air)</td></tr>
      <tr><td><kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd></td><td>Hold: Superman · No-Hander · Can-Can</td></tr>
      <tr><td><kbd>U</kbd> <kbd>I</kbd></td><td>Tap: Tailwhip · Barspin</td></tr>
      <tr><td><kbd>R</kbd></td><td>Respawn at last safe spot</td></tr>
      <tr><td><kbd>C</kbd></td><td>Cycle camera</td></tr>
      <tr><td><kbd>M</kbd></td><td>Mute</td></tr>
      <tr><td><kbd>Esc</kbd> / <kbd>P</kbd></td><td>Pause</td></tr>
      <tr><td>🎮</td><td>Left stick steer/spin/flip · RT pedal · LT brake · A pop · X/Y/B grabs · RB tailwhip · LB barspin</td></tr>
      </table>`;
    const row = h('div', 'row2');
    const close = h('button', 'btn lime', 'Got it');
    close.onclick = () => {
      this.on.click();
      this.show(s, false);
    };
    row.append(close);
    p.append(row);
    s.append(p);
    return s;
  }

  // ---------- touch ----------
  private buildTouch() {
    const t = h('div', 'touch hidden');
    const btn = (label: string, action: Parameters<Input['setVirtual']>[0], css: Partial<CSSStyleDeclaration>) => {
      const b = h('div', 'tb', label);
      Object.assign(b.style, css);
      const down = (e: Event) => {
        e.preventDefault();
        b.classList.add('on');
        this.input.setVirtual(action, true);
      };
      const up = (e: Event) => {
        e.preventDefault();
        b.classList.remove('on');
        this.input.setVirtual(action, false);
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
      t.append(b);
    };
    btn('◀', 'left', { left: '22px', bottom: '130px' });
    btn('▶', 'right', { left: '112px', bottom: '130px' });
    btn('▲', 'up', { right: '112px', bottom: '170px' });
    btn('▼', 'down', { right: '112px', bottom: '80px' });
    btn('⤒', 'jump', { right: '22px', bottom: '125px', width: '84px', height: '84px' });
    btn('S', 'superman', { right: '210px', bottom: '170px', width: '56px', height: '56px', fontSize: '18px' });
    btn('N', 'noHander', { right: '210px', bottom: '100px', width: '56px', height: '56px', fontSize: '18px' });
    btn('W', 'tailwhip', { right: '275px', bottom: '135px', width: '56px', height: '56px', fontSize: '18px' });
    return t;
  }

  get modalOpen() {
    return !this.settingsEl.classList.contains('hidden') || !this.controls.classList.contains('hidden');
  }
  closeModals() {
    this.show(this.settingsEl, false);
    this.show(this.controls, false);
  }
}
