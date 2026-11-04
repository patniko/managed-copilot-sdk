/**
 * Primer color roles for statuses, labels, banners, and charts. Every map resolves to the theme's Primer classes, so
 * light and dark follow the active GitHub theme.
 */
export type Tone = "accent" | "success" | "attention" | "severe" | "danger" | "done" | "neutral";

/** Text and icon color. */
export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  accent: "text-fg-accent",
  success: "text-fg-success",
  attention: "text-fg-attention",
  severe: "text-fg-severe",
  danger: "text-fg-danger",
  done: "text-fg-done",
  neutral: "text-fg-muted",
};

/** `Label` modifier (outlined pill). */
export const TONE_LABEL: Readonly<Record<Tone, string>> = {
  accent: "Label--accent",
  success: "Label--success",
  attention: "Label--attention",
  severe: "Label--severe",
  danger: "Label--danger",
  done: "Label--done",
  neutral: "Label--secondary",
};

/** `flash` modifier (banner). */
export const TONE_FLASH: Readonly<Record<Tone, string>> = {
  accent: "",
  success: "flash-success",
  attention: "flash-warn",
  severe: "flash-warn",
  danger: "flash-error",
  done: "",
  neutral: "flash-neutral",
};

/** Emphasis border for boxes that need attention. */
export const TONE_BORDER: Readonly<Record<Tone, string>> = {
  accent: "border-line-accent",
  success: "border-line-success",
  attention: "border-line-attention",
  severe: "border-line-severe",
  danger: "border-line-danger",
  done: "border-line-done",
  neutral: "border-line",
};

/** Chart line color. */
export const TONE_STROKE: Readonly<Record<Tone, string>> = {
  accent: "stroke-fg-accent",
  success: "stroke-fg-success",
  attention: "stroke-fg-attention",
  severe: "stroke-fg-severe",
  danger: "stroke-fg-danger",
  done: "stroke-fg-done",
  neutral: "stroke-fg-muted",
};

/** Chart area fill. */
export const TONE_FILL: Readonly<Record<Tone, string>> = {
  accent: "fill-accent-muted",
  success: "fill-success-muted",
  attention: "fill-attention-muted",
  severe: "fill-severe-muted",
  danger: "fill-danger-muted",
  done: "fill-done-muted",
  neutral: "fill-neutral-muted",
};

const RANK: Readonly<Record<Tone, number>> = { neutral: 0, success: 1, done: 1, accent: 2, attention: 3, severe: 4, danger: 5 };

/** The more severe of two tones (danger > severe > attention > accent > success/done > neutral). */
export function worseTone(a: Tone, b: Tone): Tone {
  return RANK[b] > RANK[a] ? b : a;
}
