import { ContainerIcon, CopilotIcon, CpuIcon, type Icon } from "@primer/octicons-react";
import { useState } from "react";
import type { EnvironmentView, PlatformStatus } from "../../shared/types.js";
import { formatSandboxSize, initials, summarizeNetwork } from "../lib/format.js";
import { deploymentLabel, platformPill } from "../lib/platform.js";
import { ROLE_LABELS } from "../lib/stations.js";
import { Dot } from "./ui/Chip.js";
import { CopyButton } from "./ui/CopyButton.js";
import { InlineCode, SectionLabel } from "./ui/Feedback.js";

/**
 * Deployment details for the platform pill, in the order every demo uses: the status, the deployment, its URL, and
 * the account; then the factory's environments, and the runtime versions last.
 */
export function PlatformPopover({ platform }: { readonly platform: PlatformStatus }) {
  const pill = platformPill(platform);
  const where = deploymentLabel(platform);
  const deployment = platform.deployment;
  const account = platform.account;
  return (
    <>
      <div className="space-y-2 border-b border-line px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Dot tone={pill.tone} pulse={pill.pulse} className="shrink-0" />
          <span>
            {pill.status}
            {where ? <span className="font-normal text-fg-muted"> · {where}</span> : null}
          </span>
        </p>
        {platform.state !== "connected" && (platform.message || platform.hint) ? (
          <p className="text-xs">
            <InlineCode text={platform.message ?? platform.hint ?? ""} />
          </p>
        ) : null}
        {deployment ? (
          <p className="truncate text-xs">
            <span className="text-fg-muted">Deployment </span>
            <span className="font-semibold">{deployment.name}</span>
          </p>
        ) : null}
        {platform.url ? (
          <p className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 truncate font-mono text-xs" title={platform.url}>
              {platform.url}
            </span>
            <CopyButton text={platform.url} label="Copy gateway URL" />
          </p>
        ) : null}
        {account ? <Account account={account} /> : null}
      </div>

      <div className="px-4 py-3">
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

      {deployment ? (
        <p
          className="truncate border-t border-line-muted px-4 py-2 font-mono text-xs text-fg-muted"
          title={`Managed Copilot ${deployment.version} · @github/copilot ${deployment.copilotRuntime} · @github/copilot-sdk ${deployment.copilotSdk}`}
        >
          {deployment.version} · copilot {deployment.copilotRuntime} · sdk {deployment.copilotSdk}
        </p>
      ) : null}
    </>
  );
}

function Account({ account }: { readonly account: NonNullable<PlatformStatus["account"]> }) {
  const [imageFailed, setImageFailed] = useState(false);
  const name = account.name ?? account.login;
  return (
    <p className="flex min-w-0 items-center gap-2 text-xs">
      {account.avatarUrl && !imageFailed ? (
        <img src={account.avatarUrl} alt="" className="avatar size-5 shrink-0" onError={() => setImageFailed(true)} />
      ) : (
        <span className="avatar avatar-initials size-5 shrink-0 text-[9px]" aria-hidden>
          {initials(name)}
        </span>
      )}
      {account.name ? <span className="truncate font-semibold">{account.name}</span> : null}
      <span className="truncate text-fg-muted">@{account.login}</span>
    </p>
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
