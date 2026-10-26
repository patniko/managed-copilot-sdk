import { CloudOfflineIcon, ContainerIcon, CopilotIcon, CpuIcon, GlobeIcon, ServerIcon, ShieldLockIcon, type Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { EnvironmentView, Station } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatClock, formatDuration, formatSandboxSize, shortId, summarizeNetwork, type NetworkSummary } from "../lib/format.js";
import { isStationActive, stationElapsed, stationStatusMeta } from "../lib/stations.js";
import { useStore } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { testChipLabel } from "./TestBar.js";
import { Chip, StatusIcon } from "./ui/Chip.js";
import { Tooltip } from "./ui/Tooltip.js";

export function useEnvironment(name: string | undefined): EnvironmentView | undefined {
  const environments = useStore((state) => state.platform?.environments);
  return name ? environments?.find((environment) => environment.name === name) : undefined;
}

export function networkIcon(network: NetworkSummary): Icon {
  return network.kind === "off" ? CloudOfflineIcon : network.kind === "restricted" ? ShieldLockIcon : GlobeIcon;
}

function NetworkTooltip({ network, children }: { readonly network: NetworkSummary; readonly children: ReactNode }) {
  return (
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
      {children}
    </Tooltip>
  );
}

/** Network policy as a Label, with the allowed hosts in a tooltip. */
export function NetworkChip({ network }: { readonly network: NetworkSummary }) {
  return (
    <NetworkTooltip network={network}>
      <Chip icon={networkIcon(network)}>{network.label}</Chip>
    </NetworkTooltip>
  );
}

/** Card chrome shared by the floor's stations, like a job in the GitHub Actions workflow graph. */
export function stationCardClass(selected: boolean, dashed = false): string {
  return cx(
    "flex w-full flex-col rounded-md border bg-canvas p-3 text-left transition-colors duration-100",
    selected ? "border-line-accent ring-1 ring-line-accent" : "border-line hover:bg-canvas-muted",
    dashed && !selected && "border-dashed",
  );
}

export interface StationCardProps {
  readonly station: Station;
  readonly selected: boolean;
  readonly onSelect: () => void;
  /** Overrides the station title (e.g. "Build" inside a task row that already names the task). */
  readonly heading?: string;
  /** Placeholder for a station the server hasn't created yet. */
  readonly ghost?: boolean;
}

function Meta({ icon: Glyph, children, title }: { readonly icon?: Icon; readonly children: ReactNode; readonly title?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1" title={title}>
      {Glyph ? <Glyph size={12} className="shrink-0" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function StationCard({ station, selected, onSelect, heading, ghost = false }: StationCardProps) {
  const meta = stationStatusMeta(station);
  const active = isStationActive(station.status);
  const now = useNow(1000, active);
  const elapsed = stationElapsed(station, now);
  const environment = useEnvironment(station.environment);
  const network = summarizeNetwork(station.sandbox?.network ?? environment?.network);
  const size = station.sandbox?.size ?? (station.placement === "sandbox" ? environment?.size : undefined);
  const muted = station.status === "waiting" || station.status === "skipped" || station.status === "cancelled";
  const tests = station.tests ? testChipLabel(station.tests) : undefined;
  const model = station.model ?? environment?.model;
  // The server's detail often repeats the status ("Working"); show it only when it adds something.
  const detail = station.detail && !ghost && station.detail !== meta.label ? station.detail : undefined;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={heading && heading !== station.title ? station.title : undefined}
      className={stationCardClass(selected, muted)}
    >
      <div className="flex w-full items-center gap-2">
        <StatusIcon meta={meta} />
        <span className={cx("min-w-0 flex-1 truncate font-semibold", muted && "text-fg-muted")}>{heading ?? station.title}</span>
        {elapsed !== undefined ? (
          <span className="shrink-0 text-xs text-fg-muted tabular-nums" title={active ? "Elapsed" : "Duration"}>
            {active ? formatClock(elapsed) : formatDuration(elapsed)}
          </span>
        ) : null}
      </div>
      <span className="mt-0.5 block w-full truncate pl-6 text-xs text-fg-muted" title={detail}>
        {meta.label}
        {detail ? ` · ${detail}` : ""}
      </span>

      <div className="mt-2 flex w-full flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-fg-muted">
        <Meta icon={CopilotIcon}>@{station.agent}</Meta>
        {model ? <Meta title={model}>{model}</Meta> : null}
        <Meta icon={station.placement === "sandbox" ? ContainerIcon : ServerIcon} title={station.sandbox ? `Isolated sandbox ${station.sandbox.id}` : undefined}>
          {station.placement === "sandbox" ? "Sandbox" : "Shared"}
          {station.sandbox ? <span className="ml-1 font-mono">{shortId(station.sandbox.id, 6)}</span> : null}
        </Meta>
        {size ? <Meta icon={CpuIcon}>{formatSandboxSize(size)}</Meta> : null}
        {network ? (
          <NetworkTooltip network={network}>
            <Meta icon={networkIcon(network)}>{network.label}</Meta>
          </NetworkTooltip>
        ) : null}
        {tests || station.round > 1 ? (
          <span className="inline-flex flex-wrap gap-1">
            {tests ? <Chip tone={tests.tone === "neutral" ? "plain" : tests.tone}>{tests.label}</Chip> : null}
            {station.round > 1 ? <Chip tone="warning">Round {station.round}</Chip> : null}
          </span>
        ) : null}
      </div>
    </button>
  );
}
