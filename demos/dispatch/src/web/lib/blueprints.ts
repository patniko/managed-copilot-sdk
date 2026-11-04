import { BeakerIcon, CodeIcon, GlobeIcon, type Icon, PackageIcon, PencilIcon } from "@primer/octicons-react";
import type { Blueprint, BlueprintKind, NetworkView } from "../../shared/types.js";

/** Each kind of sandbox gets its own icon and lane color, so a worker's blueprint is recognizable at a glance. */
export const KIND_ICON: Readonly<Record<BlueprintKind, Icon>> = {
  python: BeakerIcon,
  node: CodeIcon,
  web: GlobeIcon,
  writer: PencilIcon,
  other: PackageIcon,
};

/** The lane color (a Primer display color): `--lane` drives the row border and icon. */
export const KIND_LANE: Readonly<Record<BlueprintKind, string>> = {
  python: "var(--display-blue-fgColor, var(--fgColor-accent))",
  node: "var(--display-green-fgColor, var(--fgColor-success))",
  web: "var(--display-purple-fgColor, var(--fgColor-done))",
  writer: "var(--display-orange-fgColor, var(--fgColor-severe))",
  other: "var(--fgColor-muted)",
};

export function networkSummary(network: NetworkView, kind?: BlueprintKind): string {
  if (network.access === "disabled") return "Network off";
  if (network.access === "enabled") return "Full network";
  const [first] = network.hosts;
  // The Node blueprint's one host is the npm registry the deployment uses (possibly a proxy).
  if (network.hosts.length === 1 && first) return kind === "node" || /npmjs|npm\.|registry/.test(first) ? "npm registry only" : `${first} only`;
  if (network.hosts.length > 0 && network.hosts.every((host) => /npm|registry|pypi|pythonhosted/.test(host))) return "Package registries only";
  return `${network.hosts.length} allowed hosts`;
}

export function sizeSummary(blueprint: Pick<Blueprint, "size" | "cpus" | "memoryGiB">): string {
  const parts = [blueprint.size];
  if (blueprint.cpus !== undefined) parts.push(`${blueprint.cpus} vCPU`);
  if (blueprint.memoryGiB !== undefined) parts.push(`${blueprint.memoryGiB} GiB`);
  return parts.join(" · ");
}
