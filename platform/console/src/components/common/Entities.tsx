import type { EnvironmentType, NetworkPolicy, Placement } from "@managed-copilot/protocol";
import { ArrowUpRight, Box, Globe, GlobeLock, Server, WifiOff, type LucideIcon } from "lucide-react";
import { summarizeNetwork } from "../../lib/format.js";
import type { Tone } from "../../lib/tone.js";
import { Chip } from "../ui/Chip.js";
import { None } from "../ui/Feedback.js";
import { Tooltip } from "../ui/Tooltip.js";

export const ENVIRONMENT_TYPES: Readonly<Record<EnvironmentType, { readonly label: string; readonly icon: LucideIcon; readonly tone: Tone; readonly description: string }>> = {
  shared: { label: "Shared", icon: Server, tone: "neutral", description: "Sessions run on the shared runtime." },
  isolated: { label: "Isolated", icon: Box, tone: "active", description: "Every session gets its own sandbox." },
  promotable: { label: "Promotable", icon: ArrowUpRight, tone: "warning", description: "Sessions start shared and can be promoted into a sandbox." },
};

export function EnvironmentTypeChip({ type }: { readonly type: EnvironmentType | string | undefined }) {
  if (!type) return <None />;
  const meta = ENVIRONMENT_TYPES[type as EnvironmentType];
  if (!meta) return <Chip>{type}</Chip>;
  return (
    <Chip icon={meta.icon} tone={meta.tone === "neutral" ? "plain" : meta.tone} title={meta.description}>
      {meta.label}
    </Chip>
  );
}

const PLACEMENTS: Readonly<Record<Placement, { readonly label: string; readonly icon: LucideIcon; readonly description: string }>> = {
  shared: { label: "Shared runtime", icon: Server, description: "Runs on the gateway's shared runtime." },
  sandbox: { label: "Sandbox", icon: Box, description: "Runs in its own sandbox." },
};

export function PlacementChip({ placement }: { readonly placement: Placement | string | undefined }) {
  if (!placement) return <None />;
  const meta = PLACEMENTS[placement as Placement];
  if (!meta) return <Chip>{placement}</Chip>;
  return (
    <Chip icon={meta.icon} title={meta.description}>
      {meta.label}
    </Chip>
  );
}

const NETWORK_ICONS = { enabled: Globe, restricted: GlobeLock, disabled: WifiOff } as const;
const NETWORK_TONES = { enabled: "plain", restricted: "active", disabled: "warning" } as const;

/** "Enabled" / "Restricted to N hosts" / "Disabled" with the host list in a tooltip. */
export function NetworkChip({ policy }: { readonly policy: NetworkPolicy | undefined }) {
  const summary = summarizeNetwork(policy);
  if (!summary) return <None />;
  const chip = (
    <Chip icon={NETWORK_ICONS[summary.kind]} tone={NETWORK_TONES[summary.kind]}>
      {summary.label}
    </Chip>
  );
  return (
    <Tooltip
      content={
        <div>
          <p className={summary.hosts.length > 0 ? "mb-1 text-zinc-400" : undefined}>{summary.description}</p>
          {summary.hosts.length > 0 ? (
            <ul className="font-mono text-[11px]">
              {summary.hosts.map((host) => (
                <li key={host}>{host}</li>
              ))}
            </ul>
          ) : null}
        </div>
      }
    >
      <span tabIndex={0} className="inline-flex rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60">
        {chip}
      </span>
    </Tooltip>
  );
}

/** The full policy: summary plus every allowed host. */
export function NetworkPolicyView({ policy }: { readonly policy: NetworkPolicy | undefined }) {
  const summary = summarizeNetwork(policy);
  if (!summary) return <None />;
  const Icon = NETWORK_ICONS[summary.kind];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-zinc-100">
          <Icon className="size-3.5 text-zinc-400" aria-hidden />
          {summary.label}
        </span>
        <span className="text-[12.5px] text-zinc-500">{summary.description}</span>
      </div>
      {summary.hosts.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Allowed hosts">
          {summary.hosts.map((host) => (
            <li key={host}>
              <Chip mono>{host}</Chip>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A wrapping list of chips, or a dash when empty. */
export function ChipList({ items, mono = false, empty, label }: { readonly items: readonly string[] | undefined; readonly mono?: boolean; readonly empty?: string; readonly label?: string }) {
  if (!items || items.length === 0) return empty ? <span className="text-zinc-500">{empty}</span> : <None />;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={label}>
      {items.map((item) => (
        <li key={item} className="min-w-0">
          <Chip mono={mono}>{item}</Chip>
        </li>
      ))}
    </ul>
  );
}

/** Yes/no with an icon so it reads without color. */
export function YesNo({ value, yes = "Yes", no = "No" }: { readonly value: boolean | undefined; readonly yes?: string; readonly no?: string }) {
  if (value === undefined) return <None />;
  return value ? <span className="text-emerald-300">✓ {yes}</span> : <span className="text-zinc-400">✗ {no}</span>;
}
