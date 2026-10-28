import { CloudOfflineIcon, ContainerIcon, GlobeIcon, ServerIcon, ShieldLockIcon } from "@primer/octicons-react";
import type { EnvironmentView, PlatformStatus } from "../../shared/types.js";
import { formatRelative, formatSandboxSize, summarizeNetwork } from "../lib/format.js";
import { platformPill } from "../lib/platform.js";
import { ROLE_LABELS } from "../lib/stations.js";
import { useNow } from "../lib/time.js";
import { Chip, Dot } from "./ui/Chip.js";
import { CopyButton } from "./ui/CopyButton.js";
import { InlineCode, SectionLabel } from "./ui/Feedback.js";
import { Tooltip } from "./ui/Tooltip.js";

const STATE_TITLES: Readonly<Record<PlatformStatus["state"], string>> = {
  connected: "Connected",
  connecting: "Connecting to the platform",
  reconnecting: "Reconnecting to the platform",
  unavailable: "Platform unavailable",
  misconfigured: "Platform misconfigured",
};

/** Deployment details, in a Primer overlay anchored under the platform button. */
export function PlatformPopover({ platform }: { readonly platform: PlatformStatus }) {
  const now = useNow(15_000);
  const pill = platformPill(platform);
  const deployment = platform.deployment;
  return (
    <div
      role="dialog"
      aria-label="Platform details"
      className="Overlay z-40 max-h-[calc(100dvh-5rem)] origin-top-right animate-scale-in overflow-y-auto text-left max-sm:fixed max-sm:inset-x-3 max-sm:top-16 sm:absolute sm:top-full sm:right-0 sm:mt-1 sm:w-[26rem]"
    >
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Dot tone={pill.tone} pulse={pill.pulse} />
          <h2 className="text-sm font-semibold">{STATE_TITLES[platform.state]}</h2>
          {deployment ? <Chip mono>{deployment.mode}</Chip> : null}
        </div>
        <p className="mt-0.5 text-xs text-fg-muted">
          Managed Copilot deployment{deployment ? <span> · {deployment.name}</span> : null}
        </p>
        {platform.state !== "connected" && platform.message ? (
          <p className="mt-2">
            <InlineCode text={platform.message} />
          </p>
        ) : null}
        {platform.state !== "connected" && platform.hint ? (
          <p className="mt-1 text-fg-muted">
            <InlineCode text={platform.hint} />
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-4 py-3">
        <dt className="text-fg-muted">Gateway</dt>
        <dd className="flex min-w-0 items-center gap-1">
          {platform.url ? (
            <>
              <span className="truncate font-mono text-xs" title={platform.url}>
                {platform.url}
              </span>
              <CopyButton text={platform.url} label="Copy gateway URL" />
            </>
          ) : (
            <span className="text-fg-muted">Not known yet</span>
          )}
        </dd>
        {deployment ? (
          <>
            <dt className="text-fg-muted">Version</dt>
            <dd className="font-mono text-xs">{deployment.version}</dd>
            <dt className="text-fg-muted">Copilot SDK</dt>
            <dd className="font-mono text-xs">{deployment.copilotSdk}</dd>
            <dt className="text-fg-muted">Runtime</dt>
            <dd className="font-mono text-xs">{deployment.copilotRuntime}</dd>
          </>
        ) : null}
      </dl>

      {deployment && deployment.capabilities.length > 0 ? (
        <div className="border-t border-line-muted px-4 py-3">
          <SectionLabel>Capabilities</SectionLabel>
          <div className="mt-2 flex flex-wrap gap-1">
            {deployment.capabilities.map((capability) => (
              <Chip key={capability} mono>
                {capability}
              </Chip>
            ))}
          </div>
        </div>
      ) : null}

      <div className="border-t border-line-muted px-4 py-3">
        <SectionLabel>Factory environments</SectionLabel>
        {platform.environments.length === 0 ? (
          <p className="mt-2 text-xs text-fg-muted">No environments reported yet.</p>
        ) : (
          <ul className="Box Box--condensed mt-2">
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

      <p className="border-t border-line-muted px-4 py-2 text-xs text-fg-muted">Checked {formatRelative(platform.checkedAt, now)}</p>
    </div>
  );
}

const TYPE_LABELS: Readonly<Record<EnvironmentView["type"], string>> = {
  shared: "Shared",
  isolated: "Isolated sandbox",
  promotable: "Promotable",
  orchestrator: "Orchestrator",
};

function EnvironmentItem({ environment }: { readonly environment: EnvironmentView }) {
  const network = summarizeNetwork(environment.network);
  const NetworkIcon = network?.kind === "off" ? CloudOfflineIcon : network?.kind === "restricted" ? ShieldLockIcon : GlobeIcon;
  const TypeIcon = environment.type === "shared" || environment.type === "orchestrator" ? ServerIcon : ContainerIcon;
  return (
    <li className="Box-row">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">{environment.name}</span>
        <Chip icon={TypeIcon} tone={environment.type === "shared" ? "plain" : "accent"}>
          {TYPE_LABELS[environment.type] ?? environment.type}
        </Chip>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Chip>{ROLE_LABELS[environment.role] ?? environment.role}</Chip>
        {environment.agents.map((agent) => (
          <Chip key={agent}>@{agent}</Chip>
        ))}
        <Chip mono title={environment.model}>
          {environment.model}
        </Chip>
        {environment.size ? <Chip>{formatSandboxSize(environment.size)}</Chip> : null}
        {network ? (
          <Tooltip
            content={
              network.hosts.length > 0 ? (
                <div className="text-left">
                  <p className="mb-1">{network.description}</p>
                  <ul className="font-mono">
                    {network.hosts.map((host) => (
                      <li key={host}>{host}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                network.description
              )
            }
          >
            <Chip icon={NetworkIcon}>{network.label}</Chip>
          </Tooltip>
        ) : null}
      </div>
      {environment.description ? <p className="mt-1.5 text-xs text-fg-muted">{environment.description}</p> : null}
    </li>
  );
}
