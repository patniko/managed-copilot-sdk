/** Dev-only: whether `?fixtures` (remembered for the tab's session) asks for sample data. Never loaded in production. */
const KEY = "managed-copilot-console:fixtures";

export function fixturesRequested(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  if (params.has("fixtures")) {
    const value = params.get("fixtures") || "default";
    if (value === "off") {
      sessionStorage.removeItem(KEY);
      return undefined;
    }
    sessionStorage.setItem(KEY, value);
    return value;
  }
  return sessionStorage.getItem(KEY) ?? undefined;
}
