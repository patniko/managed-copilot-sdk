import * as THREE from 'three';
import { Rng } from '../../core/rng';

/** Tiny RGBA rectangle painter on a byte array (exact alpha: no canvas premultiplication). */
export class Raster {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h * 4);
  }

  rect(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a = 255) {
    const xa = Math.max(0, Math.floor(x0));
    const ya = Math.max(0, Math.floor(y0));
    const xb = Math.min(this.w, Math.ceil(x1));
    const yb = Math.min(this.h, Math.ceil(y1));
    const d = this.data;
    for (let y = ya; y < yb; y++)
      for (let x = xa; x < xb; x++) {
        const o = (y * this.w + x) * 4;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = a;
      }
  }

  /** Multiply RGB inside a rect (keeps alpha). */
  shade(x0: number, y0: number, x1: number, y1: number, k: number) {
    const d = this.data;
    for (let y = Math.max(0, y0 | 0); y < Math.min(this.h, y1); y++)
      for (let x = Math.max(0, x0 | 0); x < Math.min(this.w, x1); x++) {
        const o = (y * this.w + x) * 4;
        d[o] = Math.min(255, d[o] * k);
        d[o + 1] = Math.min(255, d[o + 1] * k);
        d[o + 2] = Math.min(255, d[o + 2] * k);
      }
  }

  /** Per-pixel brightness grain. */
  grain(rng: Rng, amount: number) {
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      const k = 1 + (rng.next() - 0.5) * amount;
      d[i] = Math.min(255, d[i] * k);
      d[i + 1] = Math.min(255, d[i + 1] * k);
      d[i + 2] = Math.min(255, d[i + 2] * k);
    }
  }

  /** Upload (rows flipped so the painting's top row ends up at v = 1, like a canvas texture). */
  texture(srgb = true): THREE.DataTexture {
    const flipped = new Uint8Array(this.data.length);
    const row = this.w * 4;
    for (let y = 0; y < this.h; y++) flipped.set(this.data.subarray(y * row, (y + 1) * row), (this.h - 1 - y) * row);
    const t = new THREE.DataTexture(flipped, this.w, this.h, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }
}

const WARM = [
  [255, 176, 72],
  [255, 150, 56],
  [255, 196, 96],
  [255, 132, 48],
  [255, 206, 120],
  [250, 160, 90],
];
/** The slab blocks' lit windows read more yellow in the video (albedo); EMIT is the glow (deeper, so the tone curve keeps it saturated). */
const LIT_YELLOW = [
  [255, 214, 120],
  [255, 196, 96],
  [255, 226, 150],
  [255, 176, 80],
  [255, 206, 110],
];
const EMIT = [
  [255, 150, 40],
  [255, 168, 56],
  [255, 128, 32],
  [255, 184, 72],
  [250, 140, 50],
];

export interface FacadeTextures {
  map: THREE.DataTexture;
  emissive: THREE.DataTexture;
}

/** Tower facade tile: 16 × 16 cells of 3 m (64 px). Alpha = how much direct sun reaches the pixel. */
export const TOWER_CELL = 2.6;
export const TOWER_TILE = 16 * TOWER_CELL;
export function paintTowerFacade(seed: number): FacadeTextures {
  const N = 16;
  const C = 64;
  const W = N * C;
  const rng = new Rng(seed);
  const a = new Raster(W, W);
  const e = new Raster(W, W);
  e.rect(0, 0, W, W, 0, 0, 0, 255);
  // loggias: short horizontal runs of deep, sky-lit recesses scattered over the grid — the irregular blue
  // "pixel" pattern of the video's facade
  const loggiaCell = new Uint8Array(N * N);
  for (let k = 0; k < 46; k++) {
    const r = rng.int(0, N - 1);
    const c0 = rng.int(0, N - 1);
    const len = rng.chance(0.5) ? 1 : rng.chance(0.6) ? 2 : 3;
    for (let i = 0; i < len; i++) loggiaCell[r * N + ((c0 + i) % N)] = 1;
    // sometimes a short vertical stack
    if (rng.chance(0.3)) for (let i = 1; i < 3; i++) loggiaCell[((r + i) % N) * N + c0] = 1;
  }
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const x = c * C;
      const y = r * C;
      // panel: warm light concrete (the low sun turns it salmon / rose)
      const t = (rng.next() - 0.5) * 16;
      a.rect(x, y, x + C, y + C, 250 + t * 0.3, 196 + t, 196 + t, 255);
      // joints
      a.rect(x, y, x + C, y + 2, 168, 150, 182, 210);
      a.rect(x, y, x + 2, y + C, 176, 158, 190, 210);
      const loggia = loggiaCell[r * N + c] === 1;
      if (loggia) {
        const wide = c < N - 1 && loggiaCell[r * N + c + 1] === 1;
        const lx0 = x + 5;
        const lx1 = wide ? x + C + 2 : x + C - 5;
        // recess in the building's own shadow: lit only by the violet sky
        a.rect(lx0, y + 9, lx1, y + C - 4, 74, 90, 196, 26);
        // sunlit inner side wall (the sun comes from the right-front, so the recess's left wall catches it)
        a.rect(lx0, y + 9, lx0 + 6, y + C - 4, 236, 200, 214, 235);
        // slab soffit above and the balcony front below
        a.rect(lx0 - 2, y + 5, lx1 + 2, y + 10, 244, 236, 246, 255);
        if (rng.chance(0.7)) a.rect(lx0, y + C - 18, lx1, y + C - 6, 228, 218, 232, 255);
        // the window / door at the back of the loggia
        const lit = rng.chance(0.3);
        const col = lit ? rng.pick(WARM) : [44, 52, 124];
        a.rect(lx0 + 14, y + 16, lx0 + 34, y + C - 18, col[0], col[1], col[2], lit ? 255 : 40);
        if (lit) e.rect(lx0 + 14, y + 16, lx0 + 34, y + C - 18, col[0] * 0.75, col[1] * 0.75, col[2] * 0.75, 255);
        continue;
      }
      // window: a dark opening in the panel (a soft reveal, no frame), about a third glowing warm
      const wx0 = x + 14;
      const wx1 = x + 50;
      const wy0 = y + 10;
      const wy1 = y + 50;
      a.rect(wx0 - 2, wy0 - 2, wx1 + 2, wy1 + 3, 206, 164, 184, 255);
      const lit = rng.chance(0.33);
      if (lit) {
        const col = rng.pick(WARM);
        a.rect(wx0, wy0, wx1, wy1, col[0], col[1], col[2], 255);
        e.rect(wx0, wy0, wx1, wy1, col[0], col[1], col[2], 255);
        // warmer lamp glow toward the bottom, curtains on one side
        e.rect(wx0, wy0 + 20, wx1, wy1, Math.min(255, col[0]), col[1] * 0.85, col[2] * 0.7, 255);
        if (rng.chance(0.5)) {
          const cw = 6 + rng.int(0, 8);
          a.rect(wx0, wy0, wx0 + cw, wy1, col[0] * 0.8, col[1] * 0.6, col[2] * 0.5, 255);
          e.rect(wx0, wy0, wx0 + cw, wy1, col[0] * 0.45, col[1] * 0.3, col[2] * 0.2, 255);
        }
      } else {
        const k = 0.8 + rng.next() * 0.4;
        a.rect(wx0, wy0, wx1, wy1, 52 * k, 38 * k, 84 * k, 120);
        // the upper pane mirrors the bright sky a little
        a.rect(wx0, wy0, wx1, wy0 + 10, 110 * k, 64 * k, 128 * k, 120);
      }
    }
  a.grain(rng, 0.06);
  return { map: a.texture(), emissive: e.texture() };
}

/**
 * Slab-block atlas (1024 × 1024, painted top-down; v = 1 - y / 1024):
 *  y   0..255  facade A (16 storeys × 64 bays, 16 px cells; the bottom row is the ground floor)
 *  y 256..511  facade B
 *  y 512..767  facade C (sparser lighting)
 *  y 768..1023 plain swatches (u 0-.25 roof grey, .25-.5 blue roof, .5-.75 white wall, .75-1 dark plinth)
 */
export const ATLAS_BAYS = 64;
export const ATLAS_STOREYS = 16;
export function paintBlockAtlas(seed: number): FacadeTextures {
  const W = 1024;
  const H = 1024;
  const P = 16;
  const rng = new Rng(seed);
  const a = new Raster(W, H);
  const e = new Raster(W, H);
  e.rect(0, 0, W, H, 0, 0, 0, 255);
  for (let v = 0; v < 3; v++) {
    const y0 = v * 256;
    const litP = v === 2 ? 0.46 : 0.58;
    // vertical loggia bands (pairs of bays) give each facade its rhythm
    const band: boolean[] = [];
    for (let c = 0; c < ATLAS_BAYS; c++) band.push(c % 8 === 2 || c % 8 === 3 ? rng.chance(0.8) : rng.chance(0.08));
    for (let r = 0; r < ATLAS_STOREYS; r++) {
      // lit windows come in runs (whole apartments): blobs big enough to survive the paint brush
      let run = 0;
      let runLit = false;
      for (let c = 0; c < ATLAS_BAYS; c++) {
        const x = c * P;
        const y = y0 + r * P;
        const t = (rng.next() - 0.5) * 10;
        a.rect(x, y, x + P, y + P, 196 + t, 194 + t, 232 + t, 255);
        // floor-slab line
        a.rect(x, y + P - 2, x + P, y + P, 214, 212, 236, 255);
        const ground = r === ATLAS_STOREYS - 1;
        if (ground) {
          // ground floor: entrances and a few shop windows
          if (rng.chance(0.25)) {
            const lit = rng.chance(0.7);
            a.rect(x + 2, y + 5, x + P - 2, y + P - 3, lit ? 255 : 60, lit ? 214 : 66, lit ? 150 : 120, 255);
            if (lit) e.rect(x + 2, y + 5, x + P - 2, y + P - 3, 255, 170, 90, 255);
          }
          continue;
        }
        if (band[c]) {
          // loggia: recessed, bluer, with a light rail
          a.rect(x, y + 1, x + P, y + P - 2, 176, 182, 228, 255);
          a.rect(x, y + P - 5, x + P, y + P - 3, 236, 236, 250, 255);
        }
        if (run <= 0) {
          runLit = rng.chance(litP);
          run = 1 + Math.floor(rng.next() * (runLit ? 4 : 3));
        }
        run--;
        const wx0 = x + 3;
        const wx1 = x + 14;
        const wy0 = y + 2;
        const wy1 = y + 12;
        if (runLit) {
          const col = rng.pick(LIT_YELLOW);
          const em = rng.pick(EMIT);
          a.rect(wx0, wy0, wx1, wy1, col[0], col[1], col[2], 255);
          e.rect(wx0, wy0, wx1, wy1, em[0], em[1], em[2], 255);
        } else {
          a.rect(wx0, wy0, wx1, wy1, 84, 88, 150, 255);
        }
      }
    }
  }
  // plain swatches
  const sw = W / 4;
  a.rect(0, 768, sw, H, 176, 176, 204, 255);
  a.rect(sw, 768, sw * 2, H, 70, 110, 210, 255);
  a.rect(sw * 2, 768, sw * 3, H, 226, 226, 242, 255);
  a.rect(sw * 3, 768, W, H, 96, 96, 130, 255);
  a.grain(rng, 0.05);
  return { map: a.texture(), emissive: e.texture() };
}

/** UV helpers into the plain swatches of the block atlas. */
export const SWATCH = {
  roof: [0.125, 0.125] as const,
  blueRoof: [0.375, 0.125] as const,
  wall: [0.625, 0.125] as const,
  plinth: [0.875, 0.125] as const,
};
/** v range [bottom, top] of facade variant k (0..2). */
export const facadeV = (k: number): [number, number] => [1 - (k + 1) * 0.25, 1 - k * 0.25];
