import { Box, Globe, GlobeLock, Server, WifiOff } from "lucide-react";
import type { EnvironmentView, Station } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatClock, formatSandboxSize, shortId, summarizeNetwork, type NetworkSummary } from "../lib/format.js";
import { isStationActive, KIND_ICONS, stationElapsed, stationStatusMeta } from "../lib/stations.js";
import { useStore } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { TONE_TILE, type Tone } from "../lib/tone.js";
import { testChipLabel } from "./TestBar.js";
import { Chip, StatusText } from "./ui/Chip.js";
import { Tooltip } from "./ui/Tooltip.js";

const CARD_BORDERS: Readonly<Record<Tone, string>> = {
  active: "border-sky-400/40",
  success: "border-zinc-700/80",
  warning: "border-amber-400/40",
  danger: "border-rose-400/45",
  neutral: "border-zinc-800",
};

export function useEnvironment(name: string | undefined): EnvironmentView | undefined {
  const environments = useStore((state) => state.platform?.environments);
  return name ? environments?.find((environment) => environment.name === name) : undefined;
}

export function NetworkChip({ network }: { readonly network: NetworkSummary }) {
  const Icon = network.kind === "off" ? WifiOff : network.kind === "restricted" ? GlobeLock : Globe;
  return (
    <Tooltip
      content={
        network.hosts.length > 0 ? (
          <div>
            <p className="mb-1 text-zinc-400">{network.description}</p>
            <ul className="space-y-0.5 font-mono text-[11px] text-zinc-200">
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
      <Chip icon={Icon}>{network.label}</Chip>
    </Tooltip>
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

export function StationCard({ station, selected, onSelect, heading, ghost = false }: StationCardProps) {
  const meta = stationStatusMeta(station);
  const active = isStationActive(station.status);
  const now = useNow(1000, active);
  const elapsed = stationElapsed(station, now);
  const environment = useEnvironment(station.environment);
  const KindIcon = KIND_ICONS[station.kind];
  const network = summarizeNetwork(station.sandbox?.network ?? environment?.network);
  const size = station.sandbox?.size ?? (station.placement === "sandbox" ? environment?.size : undefined);
  const muted = station.status === "waiting" || station.status === "skipped" || station.status === "cancelled";
  const tests = station.tests ? testChipLabel(station.tests) : undefined;
  const model = station.model ?? environment?.model;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={heading && heading !== station.title ? station.title : undefined}
      className={cx(
        "group relative flex w-full flex-col rounded-xl border p-3 text-left transition-[border-color,background-color,opacity] duration-200",
        CARD_BORDERS[meta.tone],
        muted ? "border-dashed bg-zinc-900/45" : "bg-zinc-900/90 shadow-lg shadow-black/20",
        active && "animate-glow",
        selected ? "bg-zinc-800/80 outline-2 outline-offset-2 outline-zinc-300/60" : "hover:border-zinc-600 hover:bg-zinc-900",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cx(
            "grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset transition-colors",
            TONE_TILE[meta.tone],
            muted && "opacity-70",
          )}
        >
          <KindIcon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cx("truncate text-[13px] font-semibold", muted ? "text-zinc-300" : "text-zinc-50")}>
              {heading ?? station.title}
            </span>
            {elapsed !== undefined ? (
              <span className="ml-auto shrink-0 font-mono text-[11px] text-zinc-500 tabular" aria-label="Elapsed">
                {formatClock(elapsed)}
              </span>
            ) : null}
          </div>
          <StatusText meta={meta} className="mt-0.5 text-xs" />
        </div>
      </div>

      {station.detail && !ghost ? (
        <p className="mt-2 truncate text-xs text-zinc-400" title={station.detail}>
          {station.detail}
        </p>
      ) : null}

      <div className={cx("mt-2.5 flex flex-wrap gap-1", muted && "opacity-75")}>
        <Chip>@{station.agent}</Chip>
        {model ? (
          <Chip mono title={model}>
            {model}
          </Chip>
        ) : null}
        <Chip icon={station.placement === "sandbox" ? Box : Server} title={station.sandbox ? `Isolated sandbox ${station.sandbox.id}` : undefined}>
          {station.placement === "sandbox" ? "Sandbox" : "Shared"}
          {station.sandbox ? <span className="ml-1 font-mono text-[10.5px] text-zinc-300">{shortId(station.sandbox.id, 6)}</span> : null}
        </Chip>
        {size ? <Chip>{formatSandboxSize(size)}</Chip> : null}
        {network ? <NetworkChip network={network} /> : null}
        {tests ? <Chip tone={tests.tone === "neutral" ? "plain" : tests.tone}>{tests.label}</Chip> : null}
        {station.round > 1 ? <Chip tone="warning">Round {station.round}</Chip> : null}
      </div>
    </button>
  );
}
