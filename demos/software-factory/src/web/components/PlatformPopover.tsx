import { ContainerIcon, CopilotIcon, CpuIcon, type Icon } from "@primer/octicons-react";
import type { EnvironmentView, PlatformStatus } from "../../shared/types.js";
import { formatSandboxSize, summarizeNetwork } from "../lib/format.js";
import { platformPill } from "../lib/platform.js";
import { ROLE_LABELS } from "../lib/stations.js";
import { Dot } from "./ui/Chip.js";
import { CopyButton } from "./ui/CopyButton.js";
import { InlineCode, SectionLabel } from "./ui/Feedback.js";

/** Deployment details for the platform pill: where it runs, the gateway, the account, and the factory's environments. */
export function PlatformPopover({ platform }: { readonly platform: PlatformStatus }) {
  const pill = platformPill(platform);
  const deployment = platform.deployment;
  const account = platform.account;
  return (
    <>
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <Dot tone={pill.tone} pulse={pill.pulse} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            {pill.label} <span className="font-normal text-fg-muted">· {pill.status}</span>
          </h2>
          {deployment ? (
            <p className="truncate text-xs text-fg-muted" title={`${deployment.name} ${deployment.version}`}>
              {deployment.name} · {deployment.version}
            </p>
          ) : null}
          {platform.state !== "connected" && (platform.message || platform.hint) ? (
            <p className="mt-2 text-xs">
              <InlineCode text={platform.message ?? platform.hint ?? ""} />
            </p>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-4 py-3 text-xs">
        <dt className="text-fg-muted">Gateway</dt>
        <dd className="flex min-w-0 items-center gap-1">
          {platform.url ? (
            <>
              <span className="truncate font-mono" title={platform.url}>
                {platform.url}
              </span>
              <CopyButton text={platform.url} label="Copy gateway URL" />
            </>
          ) : (
            <span className="text-fg-muted">Not known yet</span>
          )}
        </dd>
        {account ? (
          <>
            <dt className="text-fg-muted">Account</dt>
            <dd className="truncate">@{account.login}</dd>
          </>
        ) : null}
        {deployment ? (
          <>
            <dt className="text-fg-muted">Runtime</dt>
            <dd className="truncate font-mono" title={`@github/copilot ${deployment.copilotRuntime} · @github/copilot-sdk ${deployment.copilotSdk}`}>
              copilot {deployment.copilotRuntime} · sdk {deployment.copilotSdk}
            </dd>
          </>
        ) : null}
      </dl>

      <div className="border-t border-line-muted px-4 py-3">
        <SectionLabel>Environments</SectionLabel>
        {platform.environments.length === 0 ? (
          <p className="mt-2 text-xs text-fg-muted">None reported yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {platform.environments.map((environment) => (
              <EnvironmentItem key={environment.name} environment={environment} />
            ))}
          </ul>
        )}
        {platform.missingEnvironments.length > 0 ? (
          <div className="flash flash-error flash-sm mt-3 text-xs">
            <div className="flash-content">
              Missing:{" "}
              {platform.missingEnvironments.map((name) => (
                <code key={name} className="inline-code mr-1">
                  {name}
                </code>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** Where an environment's sessions run: the shared runtime (the agents' "brain") or their own sandboxes ("hands"). */
export function environmentPlacement(type: EnvironmentView["type"]): { readonly icon: Icon; readonly label: string } {
  if (type === "orchestrator") return { icon: CopilotIcon, label: "Orchestrator, shared runtime" };
  if (type === "shared") return { icon: CpuIcon, label: "Shared runtime" };
  return { icon: ContainerIcon, label: type === "promotable" ? "Promotable sandbox" : "Sandbox per session" };
}

function EnvironmentItem({ environment }: { readonly environment: EnvironmentView }) {
  const placement = environmentPlacement(environment.type);
  const network = summarizeNetwork(environment.network);
  const details = [
    environment.model,
    environment.size ? formatSandboxSize(environment.size) : undefined,
    network ? (network.hosts.length > 0 ? `${network.description} ${network.hosts.join(", ")}` : network.description) : undefined,
  ].filter(Boolean);
  return (
    <li className="flex items-start gap-2" title={details.join("\n")}>
      <placement.icon size={16} className={environment.type === "orchestrator" ? "mt-0.5 shrink-0 text-fg-done" : "mt-0.5 shrink-0 text-fg-muted"} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs font-semibold">{environment.name}</p>
        <p className="truncate text-xs text-fg-muted">
          {ROLE_LABELS[environment.role] ?? environment.role} · {placement.label} · {environment.model}
        </p>
      </div>
    </li>
  );
}
