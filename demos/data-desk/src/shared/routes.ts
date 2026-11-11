// Data Desk's hash routes: the UI's router reads them, and the server builds links back to an analysis with them (for
// example the one Software Factory shows on a work order Data Desk sent).

export type Route = { readonly kind: "home" } | { readonly kind: "analysis"; readonly id: string };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const [first, id] = path.split("/").filter(Boolean).map(safeDecode);
  return first === "a" && id ? { kind: "analysis", id } : { kind: "home" };
}

export const homeHref = (): string => "#/";
export const analysisHref = (id: string): string => `#/a/${encodeURIComponent(id)}`;
