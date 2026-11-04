export type ClassValue = string | false | null | undefined | 0;

/** Joins truthy class names. */
export function cx(...values: ClassValue[]): string {
  let out = "";
  for (const value of values) {
    if (!value) continue;
    out = out ? `${out} ${value}` : value;
  }
  return out;
}
