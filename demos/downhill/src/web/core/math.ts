export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => clamp01((v - a) / (b - a));
export const remap = (a: number, b: number, c: number, d: number, v: number) => lerp(c, d, invLerp(a, b, v));
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/** Frame-rate independent exponential approach. `rate` = 1/seconds. */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-rate * dt));
/** Wrap angle to (-PI, PI]. */
export const wrapAngle = (a: number) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
export const dampAngle = (current: number, target: number, rate: number, dt: number) =>
  current + wrapAngle(target - current) * (1 - Math.exp(-rate * dt));
export const sign = (v: number) => (v < 0 ? -1 : 1);
export const approach = (current: number, target: number, maxDelta: number) =>
  current < target ? Math.min(current + maxDelta, target) : Math.max(current - maxDelta, target);
