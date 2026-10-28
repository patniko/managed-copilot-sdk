/**
 * Status tones on Primer's roles: `active` is something running (GitHub Actions yellow), `accent` is informational
 * blue, `warning` needs attention, `danger` failed, and `neutral` is idle or muted.
 */
export type Tone = "active" | "accent" | "success" | "warning" | "danger" | "neutral";

/** Icon and text color. */
export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  active: "text-fg-attention",
  accent: "text-fg-accent",
  success: "text-fg-success",
  warning: "text-fg-attention",
  danger: "text-fg-danger",
  neutral: "text-fg-muted",
};

/** Primer `Label` modifier. */
export const TONE_LABEL: Readonly<Record<Tone, string>> = {
  active: "Label--attention",
  accent: "Label--accent",
  success: "Label--success",
  warning: "Label--attention",
  danger: "Label--danger",
  neutral: "Label--secondary",
};

/** Primer `flash` modifier (the default flash is the accent one). */
export const TONE_FLASH: Readonly<Record<Tone, string>> = {
  active: "",
  accent: "",
  success: "flash-success",
  warning: "flash-warn",
  danger: "flash-error",
  neutral: "flash-neutral",
};
