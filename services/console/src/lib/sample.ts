/**
 * Dev-only sample data flag. `import.meta.env.DEV` is false in production builds, so this is constant `false` there and
 * the "Sample data" UI is compiled out; the fixture server itself is only ever loaded by a dev-only dynamic import.
 */
let active = false;

export function setSampleData(value: boolean): void {
  if (import.meta.env.DEV) active = value;
}

export function isSampleData(): boolean {
  return import.meta.env.DEV && active;
}
