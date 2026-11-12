import { clamp } from './math';

export type GrabTrick = 'superman' | 'noHander' | 'canCan' | 'tailwhip' | 'barspin';

export interface InputFrame {
  steer: number; // -1..1, + = right
  throttle: number; // 0..1
  brake: number; // 0..1
  jump: boolean; // held
  /** Air control: + = front flip (nose down), - = back flip. */
  flip: number;
  /** Air control: + = spin right (clockwise from above). */
  spin: number;
  /** Air control: tabletop roll. */
  roll: number;
  grabs: Record<GrabTrick, boolean>;
}

type Action =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'jump'
  | 'rollL'
  | 'rollR'
  | GrabTrick
  | 'pause'
  | 'respawn'
  | 'camera'
  | 'mute'
  | 'confirm'
  | 'back';

const KEYMAP: Record<string, Action> = {
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  Space: 'jump',
  KeyQ: 'rollL',
  KeyE: 'rollR',
  KeyJ: 'superman',
  KeyK: 'noHander',
  KeyL: 'canCan',
  KeyU: 'tailwhip',
  KeyI: 'barspin',
  Escape: 'pause',
  KeyP: 'pause',
  KeyR: 'respawn',
  KeyC: 'camera',
  KeyM: 'mute',
  Enter: 'confirm',
  Backspace: 'back',
};

/** Keys typed into a form field belong to the field, not the game. */
function typingIn(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** Unified keyboard / gamepad / touch input with edge detection. */
export class Input {
  private held = new Set<Action>();
  private virtualHeld = new Set<Action>();
  private pressedQueue = new Set<Action>();
  private padPrev = new Set<Action>();
  private padAxes = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
  private padHeld = new Set<Action>();
  private _suspended = false;
  /** Set by the autopilot / tests to override the human input. */
  override: InputFrame | null = null;
  enabled = true;
  lastDevice: 'keyboard' | 'gamepad' | 'touch' = 'keyboard';

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (this._suspended || typingIn(e.target)) return;
      const a = KEYMAP[e.code];
      if (!a) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.held.has(a)) this.pressedQueue.add(a);
      this.held.add(a);
      this.lastDevice = 'keyboard';
    });
    target.addEventListener('keyup', (e) => {
      const a = KEYMAP[e.code];
      if (a) this.held.delete(a);
    });
    target.addEventListener('blur', () => this.held.clear());
  }

  /** While suspended (the shop or support is open), the keyboard belongs to the page: no game key fires. */
  get suspended(): boolean {
    return this._suspended;
  }

  suspend(on: boolean) {
    this._suspended = on;
    this.held.clear();
    this.pressedQueue.clear();
  }

  /** Touch/virtual buttons (on-screen controls). */
  setVirtual(action: Action, down: boolean) {
    if (down) {
      if (!this.virtualHeld.has(action)) this.pressedQueue.add(action);
      this.virtualHeld.add(action);
      this.lastDevice = 'touch';
    } else this.virtualHeld.delete(action);
  }

  /** Poll gamepads; call once per frame before reading. */
  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    this.padHeld.clear();
    const ax = this.padAxes;
    ax.lx = ax.ly = ax.rx = ax.ry = ax.lt = ax.rt = 0;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
      ax.lx = dz(p.axes[0] ?? 0);
      ax.ly = dz(p.axes[1] ?? 0);
      ax.rx = dz(p.axes[2] ?? 0);
      ax.ry = dz(p.axes[3] ?? 0);
      const b = (i: number) => p.buttons[i]?.pressed ?? false;
      const bv = (i: number) => p.buttons[i]?.value ?? 0;
      ax.lt = bv(6);
      ax.rt = bv(7);
      if (b(0)) this.padHeld.add('jump');
      if (b(2)) this.padHeld.add('superman');
      if (b(3)) this.padHeld.add('noHander');
      if (b(1)) this.padHeld.add('canCan');
      if (b(5)) this.padHeld.add('tailwhip');
      if (b(4)) this.padHeld.add('barspin');
      if (b(9)) this.padHeld.add('pause');
      if (b(8)) this.padHeld.add('respawn');
      if (b(12)) this.padHeld.add('up');
      if (b(13)) this.padHeld.add('down');
      if (b(14)) this.padHeld.add('left');
      if (b(15)) this.padHeld.add('right');
      if (b(0)) this.padHeld.add('confirm');
      if (b(1)) this.padHeld.add('back');
      if (b(10) || b(11)) this.padHeld.add('camera');
      const any = p.buttons.some((x) => x.pressed) || p.axes.some((v) => Math.abs(v) > 0.3);
      if (any) this.lastDevice = 'gamepad';
      break;
    }
    for (const a of this.padHeld) if (!this.padPrev.has(a) && !this._suspended) this.pressedQueue.add(a);
    this.padPrev = new Set(this.padHeld);
  }

  private isHeld(a: Action) {
    return this.held.has(a) || this.virtualHeld.has(a) || this.padHeld.has(a);
  }

  /** Edge-triggered: returns true once per press. */
  consume(a: Action): boolean {
    if (this.pressedQueue.has(a)) {
      this.pressedQueue.delete(a);
      return true;
    }
    return false;
  }

  clearPresses() {
    this.pressedQueue.clear();
  }

  read(): InputFrame {
    if (this.override) return this.override;
    if (!this.enabled) return emptyFrame();
    const ax = this.padAxes;
    const kSteer = (this.isHeld('right') ? 1 : 0) - (this.isHeld('left') ? 1 : 0);
    const kUp = this.isHeld('up') ? 1 : 0;
    const kDown = this.isHeld('down') ? 1 : 0;
    const steer = clamp(kSteer + ax.lx, -1, 1);
    const throttle = clamp(kUp + ax.rt + Math.max(0, -ax.ly) * 0, 0, 1);
    const brake = clamp(kDown + ax.lt, 0, 1);
    return {
      steer,
      throttle,
      brake,
      jump: this.isHeld('jump'),
      flip: clamp(kUp - kDown + ax.ly * -1 + ax.ry * -1, -1, 1),
      spin: clamp(kSteer + ax.lx, -1, 1),
      roll: clamp((this.isHeld('rollR') ? 1 : 0) - (this.isHeld('rollL') ? 1 : 0) + ax.rx, -1, 1),
      grabs: {
        superman: this.isHeld('superman'),
        noHander: this.isHeld('noHander'),
        canCan: this.isHeld('canCan'),
        tailwhip: this.isHeld('tailwhip'),
        barspin: this.isHeld('barspin'),
      },
    };
  }
}

export function emptyFrame(): InputFrame {
  return {
    steer: 0,
    throttle: 0,
    brake: 0,
    jump: false,
    flip: 0,
    spin: 0,
    roll: 0,
    grabs: { superman: false, noHander: false, canCan: false, tailwhip: false, barspin: false },
  };
}
