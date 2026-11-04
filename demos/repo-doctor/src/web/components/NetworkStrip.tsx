import { CheckCircleFillIcon, CircleIcon, CopilotIcon, GlobeIcon, ShieldLockIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { AllowedHost, BlockedHost, HostRole, NetworkView, SandboxState } from "../../shared/types.js";
import { Tooltip } from "./ui/Tooltip.js";

const ROLE: Readonly<Record<HostRole, string>> = { github: "GitHub", npm: "npm registry", pip: "pip index", other: "allowed host" };

const REASON: Readonly<Record<string, string>> = {
  host_not_allowed: "Not on the allowlist",
  network_disabled: "Network is off",
  ip_literal_not_allowed: "Bare IP addresses aren't allowed",
  port_not_allowed: "Port not allowed",
  address_not_allowed: "Private or platform address",
  invalid_destination: "Not a valid destination",
};

function reasonText(reason: string): string {
  return REASON[reason] ?? reason.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());
}

function Allowed({ entry }: { readonly entry: AllowedHost }) {
  const roles = entry.roles.map((role) => ROLE[role]).join(" · ");
  const tip = entry.used ? (
    <>
      <div className="font-semibold">Reached by a command that succeeded</div>
      <div className="font-mono">{entry.used.by}</div>
      <div className="mt-1 opacity-80">{roles}</div>
    </>
  ) : (
    <>Allowed, not used yet · {roles}</>
  );
  return (
    <li className="min-w-0">
      <Tooltip content={tip}>
        <span className="rd-chip" data-kind={entry.used ? "used" : "allowed"} tabIndex={0}>
          {entry.used ? <CheckCircleFillIcon size={14} className="shrink-0 text-fg-success" /> : <CircleIcon size={14} className="shrink-0 text-fg-success" />}
          <span className="truncate font-mono">{entry.host}</span>
        </span>
      </Tooltip>
    </li>
  );
}

function Blocked({ entry }: { readonly entry: BlockedHost }) {
  const tip = (
    <>
      <div className="font-semibold">
        Blocked{entry.count > 1 ? ` ${entry.count}×` : ""} · {reasonText(entry.reason)}
      </div>
      {entry.port && entry.port !== 443 ? <div>Port {entry.port}</div> : null}
      {entry.runtime ? <div className="mt-1 opacity-80">The Copilot runtime's own call. Model calls go through the platform, so nothing breaks.</div> : null}
    </>
  );
  return (
    <li className="min-w-0">
      <Tooltip content={tip}>
        <span key={entry.count} className="rd-chip" data-kind="blocked" data-fresh={entry.count > 1 ? "true" : undefined} tabIndex={0}>
          <XCircleFillIcon size={14} className="shrink-0 text-fg-danger" />
          <span className="truncate font-mono">{entry.host}</span>
          {entry.runtime ? <CopilotIcon size={12} className="shrink-0 text-fg-muted" /> : null}
        </span>
      </Tooltip>
    </li>
  );
}

/**
 * Where the sandbox's traffic went: allowed hosts (green once a command reached them) and requests the network rules
 * refused (red). Blocks come from the platform's `network.blocked` events; use is inferred from successful commands.
 */
export function NetworkStrip({ network, sandbox }: { readonly network: NetworkView; readonly sandbox: SandboxState }) {
  const allowed = [...network.allowed].sort((a, b) => Number(Boolean(b.used)) - Number(Boolean(a.used)));
  const blocked = [...network.blocked].sort((a, b) => Number(a.runtime) - Number(b.runtime) || a.firstAt.localeCompare(b.firstAt));
  const waiting = network.access === "unknown" && blocked.length === 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-label="Network">
      <Tooltip content="Every request from the sandbox goes through the egress proxy, which applies the environment's allowlist.">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold" tabIndex={0}>
          <ShieldLockIcon size={16} className="text-fg-muted" />
          Network
        </span>
      </Tooltip>
      {waiting ? (
        sandbox === "failed" ? (
          <span className="text-sm text-fg-muted">No traffic</span>
        ) : (
          <span className="flex items-center gap-2" aria-label="Waiting for the sandbox">
            {[112, 160, 136].map((width) => (
              <span key={width} className="SkeletonBox h-7 rounded-full" style={{ width }} />
            ))}
          </span>
        )
      ) : (
        <>
          <ul className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Allowed hosts">
            {network.access === "enabled" ? (
              <li className="rd-chip" data-kind="allowed">
                <GlobeIcon size={14} /> Any host
              </li>
            ) : network.access === "disabled" ? (
              <li className="rd-chip" data-kind="allowed">
                No network
              </li>
            ) : (
              allowed.map((entry) => <Allowed key={entry.host} entry={entry} />)
            )}
          </ul>
          {blocked.length ? (
            <>
              <span aria-hidden className="hidden h-5 w-px bg-line sm:block" />
              <ul className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Blocked requests">
                {blocked.map((entry) => (
                  <Blocked key={`${entry.host}|${entry.reason}`} entry={entry} />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
