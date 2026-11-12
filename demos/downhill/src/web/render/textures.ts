import * as THREE from 'three';
import { Rng } from '../core/rng';

/** Tileable value-noise fBm (period = size) packed into RGBA channels at different frequencies. */
export function makeDetailTexture(size = 256, seed = 7): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const channels = [
    { cells: 8, oct: 4 },
    { cells: 16, oct: 3 },
    { cells: 4, oct: 2, stretch: 6 },
    { cells: 32, oct: 2 },
  ];
  channels.forEach((ch, ci) => {
    const rng = new Rng(seed * 31 + ci * 7);
    const field = new Float32Array(size * size);
    let amp = 1,
      norm = 0;
    for (let o = 0; o < ch.oct; o++) {
      const cx = ch.cells << o;
      const cz = ch.stretch ? Math.max(1, Math.round((ch.cells << o) / ch.stretch)) * 1 : cx;
      const lat = new Float32Array(cx * cz);
      for (let i = 0; i < lat.length; i++) lat[i] = rng.next();
      for (let y = 0; y < size; y++) {
        const gy = (y / size) * cz;
        const j0 = Math.floor(gy);
        const ty = gy - j0;
        const sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < size; x++) {
          const gx = (x / size) * cx;
          const i0 = Math.floor(gx);
          const tx = gx - i0;
          const sx = tx * tx * (3 - 2 * tx);
          const a = lat[(j0 % cz) * cx + (i0 % cx)];
          const b = lat[(j0 % cz) * cx + ((i0 + 1) % cx)];
          const c = lat[((j0 + 1) % cz) * cx + (i0 % cx)];
          const d = lat[((j0 + 1) % cz) * cx + ((i0 + 1) % cx)];
          field[y * size + x] += amp * (a + (b - a) * sx + (c - a + (a - b - c + d) * sx) * sy);
        }
      }
      norm += amp;
      amp *= 0.5;
    }
    for (let i = 0; i < size * size; i++) data[i * 4 + ci] = Math.round(Math.min(1, Math.max(0, field[i] / norm)) * 255);
  });
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

let detailTex: THREE.DataTexture | null = null;
export function sharedDetailTexture() {
  if (!detailTex) detailTex = makeDetailTexture();
  return detailTex;
}

/** Convert an sRGB hex colour to linear RGB triple. */
export function hexToLinear(hex: string | number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Display colour (sRGB) → scene-linear radiance that survives the 1-exp(-x) tone map (for unlit/emissive surfaces). */
export function displayToScene(hex: string, exposure = 1): THREE.Color {
  const c = new THREE.Color(hex);
  const f = (v: number) => -Math.log(1 - Math.min(v, 0.985)) / exposure;
  return new THREE.Color(f(c.r), f(c.g), f(c.b));
}
