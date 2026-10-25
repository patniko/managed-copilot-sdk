export type Tone = "active" | "success" | "warning" | "danger" | "neutral";

export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  active: "text-sky-300",
  success: "text-emerald-300",
  warning: "text-amber-300",
  danger: "text-rose-300",
  neutral: "text-zinc-400",
};

export const TONE_BADGE: Readonly<Record<Tone, string>> = {
  active: "bg-sky-400/10 text-sky-300 ring-sky-400/25",
  success: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/25",
  warning: "bg-amber-400/10 text-amber-300 ring-amber-400/25",
  danger: "bg-rose-400/10 text-rose-300 ring-rose-400/25",
  neutral: "bg-zinc-400/10 text-zinc-400 ring-zinc-400/20",
};

export const TONE_TILE: Readonly<Record<Tone, string>> = {
  active: "bg-sky-400/10 text-sky-300 ring-sky-400/25",
  success: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
  warning: "bg-amber-400/10 text-amber-300 ring-amber-400/25",
  danger: "bg-rose-400/10 text-rose-300 ring-rose-400/25",
  neutral: "bg-zinc-800/80 text-zinc-400 ring-white/5",
};

export const TONE_DOT: Readonly<Record<Tone, string>> = {
  active: "bg-sky-400",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-rose-400",
  neutral: "bg-zinc-500",
};

export const TONE_STROKE: Readonly<Record<Tone, string>> = {
  active: "stroke-sky-400",
  success: "stroke-emerald-400",
  warning: "stroke-amber-400",
  danger: "stroke-rose-400",
  neutral: "stroke-zinc-400",
};

export const TONE_FILL: Readonly<Record<Tone, string>> = {
  active: "fill-sky-400/15",
  success: "fill-emerald-400/15",
  warning: "fill-amber-400/15",
  danger: "fill-rose-400/15",
  neutral: "fill-zinc-400/10",
};

export const TONE_CALLOUT: Readonly<Record<Tone, string>> = {
  active: "border-sky-400/25 bg-sky-400/[0.06] text-sky-100",
  success: "border-emerald-400/25 bg-emerald-400/[0.06] text-emerald-100",
  warning: "border-amber-400/25 bg-amber-400/[0.06] text-amber-100",
  danger: "border-rose-400/30 bg-rose-400/[0.07] text-rose-100",
  neutral: "border-zinc-700/70 bg-zinc-800/40 text-zinc-200",
};

const RANK: Readonly<Record<Tone, number>> = { neutral: 0, success: 1, active: 2, warning: 3, danger: 4 };

/** The more severe of two tones (danger > warning > active > success > neutral). */
export function worseTone(a: Tone, b: Tone): Tone {
  return RANK[b] > RANK[a] ? b : a;
}
