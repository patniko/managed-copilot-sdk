/**
 * The kinds of sandbox the assistant can start: the worker environments of its orchestrator environment (spec section
 * 17), described for the chat, the side panel, approval cards, and the agent's instructions.
 */
import type { DeploymentInfo, EnvironmentInfo } from "@managed-copilot/sdk";
import type { SandboxEnvironmentView, SandboxKind } from "../shared/protocol.js";

type NetworkPolicy = EnvironmentInfo["network"];

const LABELS: Record<SandboxKind, string> = {
  python: "Python sandbox",
  web: "web research sandbox",
  general: "sandbox",
};

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What a sandbox can reach, in a few words: "network off", "can reach github.com and api.github.com only", .... */
export function networkSummary(network: NetworkPolicy | undefined): string {
  if (!network || network.access === "disabled") return "network off";
  if (network.access === "enabled") return "full network access";
  const hosts = network.allowedDomains;
  if (hosts.length === 0) return "network off";
  return hosts.length <= 3 ? `can reach ${joinAnd(hosts)} only` : `can reach ${hosts.length} hosts only`;
}

/** Python for calculations and charts, web for research (it needs some network), or a general-purpose sandbox. */
export function sandboxKind(environment: Pick<EnvironmentInfo, "name" | "description" | "network">): SandboxKind {
  const words = `${environment.name} ${environment.description ?? ""}`.toLowerCase();
  if (words.includes("python")) return "python";
  if (environment.network.access !== "disabled" && /\bweb\b|research|brows/.test(words)) return "web";
  return "general";
}

/** The worker environments of `coordinator`, an orchestrator environment of this deployment. The first is the default. */
export function sandboxEnvironments(info: Pick<DeploymentInfo, "environments">, coordinator: Pick<EnvironmentInfo, "workers">): SandboxEnvironmentView[] {
  return (coordinator.workers ?? []).map((name, index) => {
    const environment = info.environments.find((candidate) => candidate.name === name);
    const kind = environment ? sandboxKind(environment) : "general";
    return {
      name,
      kind,
      label: LABELS[kind],
      description: environment?.description,
      size: environment?.size,
      network: networkSummary(environment?.network),
      default: index === 0,
    };
  });
}

/** "Python sandbox" → "a Python sandbox". */
export function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}
