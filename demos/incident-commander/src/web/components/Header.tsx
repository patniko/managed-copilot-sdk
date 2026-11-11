import { BellIcon, ContainerIcon, CopilotIcon, DotFillIcon, MarkGithubIcon, TriangleDownIcon } from "@primer/octicons-react";
import { useState } from "react";
import type { EnvironmentSummary, PlatformStatus } from "../../shared/types.js";
import { ago, cx, initials } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
import { boardHref } from "../lib/router.js";
import { useStore } from "../lib/store.js";
import { CopyButton, Popover, Spinner, Tooltip } from "./ui.js";

/** github.com's global header: the GitHub mark, `Managed Copilot / Incident Commander`, and actions on the right. */
export function Header() {
  return (
    <header className="AppHeader relative z-30 shrink-0">
      <div className="AppHeader-globalBar gap-2 sm:gap-3">
        <a href={boardHref()} className="AppHeader-logo" aria-label="Incident Commander home">
          <MarkGithubIcon size={32} />
        </a>
        <nav className="AppHeader-context min-w-0" aria-label="Breadcrumb">
          <a href={boardHref()} className="AppHeader-context-item max-sm:hidden">
            Managed Copilot
          </a>
          <span className="AppHeader-context-divider max-sm:hidden" aria-hidden>
            /
          </span>
          <a href={boardHref()} className="AppHeader-context-item AppHeader-context-item--current min-w-0">
            <span className="truncate">Incident Commander</span>
          </a>
        </nav>
        <div className="AppHeader-actions min-w-0">
          <AlertsButton />
          <PlatformButton />
          <AccountAvatar />
        </div>
      </div>
    </header>
  );
}

function platformLabel(platform: PlatformStatus): string {
  if (platform.mode === "azure") return "Azure";
  if (platform.mode === "local") return "Local";
  return platform.deployment ?? "Managed Copilot";
}

function StatusDot({ platform }: { readonly platform: PlatformStatus }) {
  if (platform.state === "connecting" || platform.state === "reconnecting") return <Spinner size={12} className="text-fg-attention" />;
  return <DotFillIcon size={16} className={platform.state === "connected" ? "text-fg-success" : "text-fg-danger"} />;
}

const STATE_WORDS: Record<PlatformStatus["state"], string> = { connected: "Connected", connecting: "Connecting", reconnecting: "Reconnecting", unavailable: "Unavailable" };

const ROLE: Record<EnvironmentSummary["role"], { readonly icon: typeof CopilotIcon; readonly label: string }> = {
  coordinator: { icon: CopilotIcon, label: "Coordinator" },
  own: { icon: ContainerIcon, label: "Its own sandbox" },
  worker: { icon: ContainerIcon, label: "Workers" },
};

function PlatformButton() {
  const platform = useStore((state) => state.platform);
  if (!platform) return null;
  const label = platformLabel(platform);
  return (
    <Popover
      label="Deployment details"
      width="w-[21rem]"
      trigger={(open, toggle) => (
        <button type="button" aria-expanded={open} aria-haspopup="dialog" aria-label={`Platform: ${STATE_WORDS[platform.state]}, ${label}. Show details`} onClick={toggle} className="btn btn-sm">
          <StatusDot platform={platform} />
          <span className="max-w-[10rem] truncate">{label}</span>
          <TriangleDownIcon size={16} />
        </button>
      )}
    >
      <div className="flex flex-col gap-1 p-4 text-sm">
        <div className="flex items-center gap-2 font-semibold">
          <StatusDot platform={platform} />
          <span>
            {STATE_WORDS[platform.state]}
            {platform.mode ? ` · ${label}` : ""}
          </span>
        </div>
        {platform.deployment ? (
          <div>
            <span className="text-fg-muted">Deployment </span>
            <span className="font-semibold">{platform.deployment}</span>
          </div>
        ) : null}
        {platform.url ? <div className="truncate font-mono text-xs text-fg-muted">{platform.url}</div> : null}
        {platform.message ? <p className="mt-1 text-fg-muted">{platform.message}</p> : null}
      </div>
      {platform.account ? (
        <div className="flex items-center gap-2 border-t border-line-muted px-4 py-3 text-sm">
          <Avatar account={platform.account} size="size-5" />
          <span className="truncate font-semibold">{platform.account.name ?? platform.account.login}</span>
          <span className="truncate text-fg-muted">@{platform.account.login}</span>
        </div>
      ) : null}
      {platform.environments.length ? (
        <div className="border-t border-line-muted px-4 py-3">
          <div className="mb-2 text-xs font-semibold text-fg-muted">Environments</div>
          <ul className="flex flex-col gap-2">
            {platform.environments.map((env) => {
              const role = ROLE[env.role];
              const Glyph = role.icon;
              return (
                <li key={env.name} className="flex items-center gap-2 text-xs">
                  <Glyph size={16} className={env.role === "coordinator" ? "text-fg-done" : "text-fg-accent"} />
                  <Tooltip content={[env.description, env.size ? `Size: ${env.size}` : undefined, `Network: ${env.network}`].filter(Boolean).join(" · ")}>
                    <span className="truncate font-mono">{env.name}</span>
                  </Tooltip>
                  <span className="ml-auto shrink-0 text-fg-muted">{role.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </Popover>
  );
}

function AlertsButton() {
  const integrations = useStore((state) => state.integrations);
  const now = useNow(30_000);
  if (!integrations) return null;
  const example = `curl -X POST ${integrations.alertsUrl} \\\n  -H "Authorization: Bearer $INCIDENT_ALERT_SECRET" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"Checkout errors","service":"checkout","severity":"major","summary":"5xx rate is 12%"}'`;
  return (
    <Popover
      label="Connect your alerts"
      width="w-[24rem]"
      trigger={(open, toggle) => (
        <Tooltip content="Connect your alerts">
          <button type="button" aria-expanded={open} aria-haspopup="dialog" aria-label="Connect your alerts" onClick={toggle} className="AppHeader-button">
            <BellIcon size={16} />
          </button>
        </Tooltip>
      )}
    >
      <div className="flex flex-col gap-3 p-4 text-sm">
        <div>
          <div className="font-semibold">Connect your alerts</div>
          <div className="text-fg-muted">Alertmanager, Grafana, or any JSON webhook.</div>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-line bg-canvas-inset py-1 pr-1 pl-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs" title={integrations.alertsUrl}>
            POST {integrations.alertsUrl}
          </code>
          <CopyButton text={integrations.alertsUrl} label="Copy the alert URL" />
        </div>
        {integrations.alertsConfigured ? (
          <div className="text-xs text-fg-muted">
            Send <code className="font-mono">Authorization: Bearer</code> with the <code className="font-mono">incident-commander-alert-secret</code> parameter.
          </div>
        ) : (
          <div className="flash flash-warn flash-sm text-xs">Alerts are off. Set INCIDENT_ALERT_SECRET to turn them on.</div>
        )}
        <details className="text-xs">
          <summary className="text-fg-muted">Example</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-canvas-inset p-2 font-mono text-[11px] leading-4">{example}</pre>
        </details>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-line-muted px-4 py-3 text-xs">
        <dt className="text-fg-muted">Platform webhook</dt>
        <dd className="text-right">{integrations.webhookConfigured ? (integrations.lastWebhookAt ? `Last delivery ${ago(integrations.lastWebhookAt, now)}` : "Waiting for a delivery") : "Off"}</dd>
        <dt className="text-fg-muted">Deploys</dt>
        <dd className="text-right">{integrations.deployConfigured ? "Your pipeline" : "Demo service only"}</dd>
        <dt className="text-fg-muted">Software Factory</dt>
        <dd className="min-w-0 truncate text-right">
          {integrations.factory.url ? (
            <a href={integrations.factory.url} target="_blank" rel="noreferrer">
              Connected
            </a>
          ) : (
            <Tooltip content="Start it with `aspire run`, or set SOFTWARE_FACTORY_URL.">
              <span>Not connected</span>
            </Tooltip>
          )}
        </dd>
      </dl>
    </Popover>
  );
}

function Avatar({ account, size }: { readonly account: NonNullable<PlatformStatus["account"]>; readonly size: string }) {
  const [failed, setFailed] = useState(false);
  if (account.avatarUrl && !failed) return <img src={account.avatarUrl} alt="" className={cx("avatar shrink-0", size)} onError={() => setFailed(true)} />;
  return (
    <span className={cx("avatar avatar-initials shrink-0 text-[10px]", size)} aria-hidden>
      {initials(account.name ?? account.login)}
    </span>
  );
}

function AccountAvatar() {
  const account = useStore((state) => state.platform?.account);
  if (!account) return null;
  return (
    <>
      <span className="AppHeader-divider max-sm:hidden" aria-hidden />
      <Tooltip content={account.name ? `${account.name} (@${account.login})` : `@${account.login}`}>
        <span className="inline-flex shrink-0">
          <Avatar account={account} size="size-8" />
          <span className="sr-only">Signed in as {account.login}</span>
        </span>
      </Tooltip>
    </>
  );
}
