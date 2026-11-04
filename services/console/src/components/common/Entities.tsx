import type { EnvironmentType, NetworkPolicy, Placement } from "@managed-copilot/protocol";
import { ArrowUpRightIcon, CheckIcon, CloudOfflineIcon, GlobeIcon, SandboxIcon, ServerIcon, ShieldLockIcon, WorkflowIcon, XIcon, type Icon } from "@primer/octicons-react";
import { summarizeNetwork } from "../../lib/format.js";
import type { Tone } from "../../lib/tone.js";
import { Chip } from "../ui/Chip.js";
import { None } from "../ui/Feedback.js";
import { Tooltip } from "../ui/Tooltip.js";

export const ENVIRONMENT_TYPES: Readonly<Record<EnvironmentType, { readonly label: string; readonly icon: Icon; readonly tone: Tone; readonly description: string }>> = {
  shared: { label: "Shared", icon: ServerIcon, tone: "neutral", description: "Sessions run on the shared runtime." },
  isolated: { label: "Isolated", icon: SandboxIcon, tone: "accent", description: "Every session gets its own sandbox." },
  promotable: { label: "Promotable", icon: ArrowUpRightIcon, tone: "done", description: "Sessions start shared and can be promoted into a sandbox." },
  orchestrator: { label: "Orchestrator", icon: WorkflowIcon, tone: "attention", description: "A coordinator on the shared runtime starts workers, each in its own sandbox." },
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

const PLACEMENTS: Readonly<Record<Placement, { readonly label: string; readonly icon: Icon; readonly description: string }>> = {
  shared: { label: "Shared runtime", icon: ServerIcon, description: "Runs on the gateway's shared runtime." },
  sandbox: { label: "Sandbox", icon: SandboxIcon, description: "Runs in its own sandbox." },
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

const NETWORK_ICONS: Readonly<Record<"enabled" | "restricted" | "disabled", Icon>> = { enabled: GlobeIcon, restricted: ShieldLockIcon, disabled: CloudOfflineIcon };
const NETWORK_TONES = { enabled: "plain", restricted: "accent", disabled: "attention" } as const;

/** "Enabled" / "Restricted to N hosts" / "Disabled" with the host list in a tooltip. */
export function NetworkChip({ policy }: { readonly policy: NetworkPolicy | undefined }) {
  const summary = summarizeNetwork(policy);
  if (!summary) return <None />;
  return (
    <Tooltip
      content={
        <div>
          <p className={summary.hosts.length > 0 ? "mb-1" : undefined}>{summary.description}</p>
          {summary.hosts.length > 0 ? (
            <ul className="font-mono">
              {summary.hosts.map((host) => (
                <li key={host}>{host}</li>
              ))}
            </ul>
          ) : null}
        </div>
      }
    >
      <span tabIndex={0} className="inline-flex rounded-full">
        <Chip icon={NETWORK_ICONS[summary.kind]} tone={NETWORK_TONES[summary.kind]}>
          {summary.label}
        </Chip>
      </span>
    </Tooltip>
  );
}

/** The full policy: summary plus every allowed host. */
export function NetworkPolicyView({ policy }: { readonly policy: NetworkPolicy | undefined }) {
  const summary = summarizeNetwork(policy);
  if (!summary) return <None />;
  const PolicyIcon = NETWORK_ICONS[summary.kind];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <PolicyIcon size={16} className="text-fg-muted" />
          {summary.label}
        </span>
        <span className="text-fg-muted">{summary.description}</span>
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
  if (!items || items.length === 0) return empty ? <span className="text-fg-muted">{empty}</span> : <None />;
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

/** Yes/no with an Octicon so it reads without color. */
export function YesNo({ value, yes = "Yes", no = "No" }: { readonly value: boolean | undefined; readonly yes?: string; readonly no?: string }) {
  if (value === undefined) return <None />;
  return value ? (
    <span className="inline-flex items-center gap-1">
      <CheckIcon size={16} className="text-fg-success" />
      {yes}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-fg-muted">
      <XIcon size={16} />
      {no}
    </span>
  );
}
