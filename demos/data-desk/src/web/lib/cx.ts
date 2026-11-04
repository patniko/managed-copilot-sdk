/** Joins class names, skipping falsy values. */
export function cx(...names: readonly (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
