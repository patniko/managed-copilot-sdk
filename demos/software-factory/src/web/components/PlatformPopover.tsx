import { Box, Globe, GlobeLock, Server, WifiOff } from "lucide-react";
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

export function PlatformPopover({ platform }: { readonly platform: PlatformStatus }) {
  const now = useNow(15_000);
  const pill = platformPill(platform);
  const deployment = platform.deployment;
  return (
    <div
      role="dialog"
      aria-label="Platform details"
      className="z-40 max-h-[calc(100dvh-5rem)] origin-top-right animate-rise-in overflow-y-auto rounded-2xl border border-zinc-700/70 bg-zinc-900/95 text-left shadow-2xl shadow-black/60 backdrop-blur max-sm:fixed max-sm:inset-x-3 max-sm:top-16 sm:absolute sm:top-full sm:right-0 sm:mt-2 sm:w-[420px]"
    >
      <div className="border-b border-zinc-800 p-4">
        <div className="flex items-center gap-2">
          <Dot tone={pill.tone} pulse={pill.pulse} />
          <span className="text-sm font-semibold text-zinc-100">{STATE_TITLES[platform.state]}</span>
          {deployment ? <Chip mono>{deployment.mode}</Chip> : null}
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Managed Copilot deployment{deployment ? <span className="text-zinc-400"> · {deployment.name}</span> : null}
        </p>
        {platform.state !== "connected" && platform.message ? (
          <p className="mt-2.5 text-[13px] leading-relaxed text-zinc-300">
            <InlineCode text={platform.message} />
          </p>
        ) : null}
        {platform.state !== "connected" && platform.hint ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
            <InlineCode text={platform.hint} />
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 px-4 py-3 text-[13px]">
        <dt className="text-zinc-500">Gateway</dt>
        <dd className="flex min-w-0 items-center gap-1">
          {platform.url ? (
            <>
              <span className="truncate font-mono text-xs text-zinc-200" title={platform.url}>
                {platform.url}
              </span>
              <CopyButton text={platform.url} label="Copy gateway URL" />
            </>
          ) : (
            <span className="text-zinc-500">Not known yet</span>
          )}
        </dd>
        {deployment ? (
          <>
            <dt className="text-zinc-500">Version</dt>
            <dd className="font-mono text-xs text-zinc-200">{deployment.version}</dd>
            <dt className="text-zinc-500">Copilot SDK</dt>
            <dd className="font-mono text-xs text-zinc-200">{deployment.copilotSdk}</dd>
            <dt className="text-zinc-500">Runtime</dt>
            <dd className="font-mono text-xs text-zinc-200">{deployment.copilotRuntime}</dd>
          </>
        ) : null}
      </dl>

      {deployment && deployment.capabilities.length > 0 ? (
        <div className="border-t border-zinc-800 px-4 py-3">
          <SectionLabel>Capabilities</SectionLabel>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {deployment.capabilities.map((capability) => (
              <Chip key={capability} mono>
                {capability}
              </Chip>
            ))}
          </div>
        </div>
      ) : null}

      <div className="border-t border-zinc-800 px-4 py-3">
        <SectionLabel>Factory environments</SectionLabel>
        {platform.environments.length === 0 ? (
          <p className="mt-2 text-xs text-zinc-500">No environments reported yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {platform.environments.map((environment) => (
              <EnvironmentItem key={environment.name} environment={environment} />
            ))}
          </ul>
        )}
        {platform.missingEnvironments.length > 0 ? (
          <div className="mt-3 rounded-lg border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-200">
            Missing: {platform.missingEnvironments.map((name) => (
              <code key={name} className="mr-1 font-mono">
                {name}
              </code>
            ))}
          </div>
        ) : null}
      </div>

      <p className="border-t border-zinc-800 px-4 py-2.5 text-[11px] text-zinc-500">Checked {formatRelative(platform.checkedAt, now)}</p>
    </div>
  );
}

const TYPE_LABELS: Readonly<Record<EnvironmentView["type"], string>> = {
  shared: "Shared",
  isolated: "Isolated sandbox",
  promotable: "Promotable",
};

function EnvironmentItem({ environment }: { readonly environment: EnvironmentView }) {
  const network = summarizeNetwork(environment.network);
  const NetworkIcon = network?.kind === "off" ? WifiOff : network?.kind === "restricted" ? GlobeLock : Globe;
  const TypeIcon = environment.type === "shared" ? Server : Box;
  return (
    <li className="rounded-xl bg-zinc-950/60 p-3 ring-1 ring-inset ring-white/5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-100">{environment.name}</span>
        <Chip icon={TypeIcon} tone={environment.type === "shared" ? "plain" : "active"}>
          {TYPE_LABELS[environment.type] ?? environment.type}
        </Chip>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
                <div>
                  <p className="mb-1 text-zinc-400">{network.description}</p>
                  <ul className="font-mono text-[11px]">
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
      {environment.description ? <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{environment.description}</p> : null}
    </li>
  );
}
