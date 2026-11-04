import { ContainerIcon, CopilotIcon, DotFillIcon, MarkGithubIcon, PlusIcon, TriangleDownIcon } from "@primer/octicons-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import type { PlatformStatus } from "../../shared/types.js";
import { initials } from "../lib/format.js";
import { useDismiss } from "../lib/hooks.js";
import { homeHref } from "../lib/router.js";
import { useStore } from "../lib/store.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

/** github.com's global header: the GitHub mark, `Managed Copilot / Research Swarm`, and the platform and account. */
export function Header({ newResearch = false }: { readonly newResearch?: boolean }) {
  return (
    <header className="AppHeader relative z-30 shrink-0">
      <div className="AppHeader-globalBar gap-2 sm:gap-3">
        <a href={homeHref()} className="AppHeader-logo" aria-label="Research Swarm home">
          <MarkGithubIcon size={32} />
        </a>
        <nav className="AppHeader-context min-w-0" aria-label="Breadcrumb">
          <a href={homeHref()} className="AppHeader-context-item max-sm:hidden">
            Managed Copilot
          </a>
          <span className="AppHeader-context-divider max-sm:hidden" aria-hidden>
            /
          </span>
          <a href={homeHref()} className="AppHeader-context-item AppHeader-context-item--current">
            <span className="truncate">Research Swarm</span>
          </a>
        </nav>
        <div className="AppHeader-actions min-w-0">
          {newResearch ? (
            <Tooltip content="New research">
              <a href={homeHref()} className="AppHeader-button" aria-label="New research">
                <PlusIcon size={16} />
              </a>
            </Tooltip>
          ) : null}
          <PlatformPill />
          <Account />
        </div>
      </div>
    </header>
  );
}

const modeLabel = (platform: PlatformStatus): string => (platform.mode === "azure" ? "Azure" : platform.mode === "local" ? "Local" : (platform.deployment ?? "Managed Copilot"));

function StatusDot({ platform }: { readonly platform: PlatformStatus }) {
  if (platform.state === "connecting" || platform.state === "reconnecting") return <Spinner size={12} className="text-fg-attention" />;
  return <DotFillIcon size={16} className={platform.state === "connected" ? "text-fg-success" : "text-fg-danger"} />;
}

function statusLine(platform: PlatformStatus): string {
  switch (platform.state) {
    case "connected":
      return `Connected · ${modeLabel(platform)}`;
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "unavailable":
      return "Unavailable";
  }
}

function PlatformPill() {
  const platform = useStore((state) => state.app?.platform);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  if (!platform) return null;
  const label = platform.state === "connected" || platform.mode ? modeLabel(platform) : statusLine(platform).replace("…", "");
  return (
    <div ref={container} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${statusLine(platform)}. Show deployment details`}
        onClick={() => setOpen((value) => !value)}
        className="btn btn-sm max-w-full min-w-0"
      >
        <StatusDot platform={platform} />
        <span className="min-w-0 truncate">{label}</span>
        <TriangleDownIcon size={16} />
      </button>
      {open ? <PlatformPopover platform={platform} /> : null}
    </div>
  );
}

function PlatformPopover({ platform }: { readonly platform: PlatformStatus }) {
  const swarm = useStore((state) => state.app?.swarm);
  const account = platform.account;
  return (
    <div role="dialog" aria-label="Deployment details" className="Overlay absolute top-full right-0 z-40 mt-2 w-[21rem] animate-scale-in text-sm">
      <div className="flex flex-col gap-1 p-4">
        <div className="flex items-center gap-2 font-semibold">
          <StatusDot platform={platform} />
          {statusLine(platform)}
        </div>
        {platform.deployment ? (
          <div className="text-fg-muted">
            Deployment <span className="font-semibold text-fg">{platform.deployment}</span>
          </div>
        ) : null}
        {platform.url ? <div className="truncate font-mono text-xs text-fg-muted">{platform.url}</div> : null}
        {platform.message && platform.state !== "connected" ? <p className="mt-1 text-fg-muted">{platform.message}</p> : null}
      </div>
      {account ? (
        <div className="flex items-center gap-2 border-t border-line-muted px-4 py-3">
          <Avatar account={account} size={20} />
          <span className="truncate font-semibold">{account.name ?? account.login}</span>
          {account.name ? <span className="truncate text-fg-muted">@{account.login}</span> : null}
        </div>
      ) : null}
      {swarm ? (
        <div className="border-t border-line-muted px-4 py-3">
          <div className="mb-2 text-xs font-semibold text-fg-muted">Environments</div>
          <ul className="flex flex-col gap-2">
            <EnvironmentRow icon={<CopilotIcon size={16} />} name={swarm.lead.environment} role="Lead" detail={`Shared runtime · ${swarm.lead.model}`} />
            <EnvironmentRow
              icon={<ContainerIcon size={16} />}
              name={swarm.researchers.environment}
              role="Researchers"
              detail={`A ${swarm.researchers.size ?? "small"} sandbox each, up to ${swarm.researchers.max} · ${swarm.researchers.model} · ${swarm.researchers.hosts.length} allowed sites`}
            />
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function EnvironmentRow({ icon, name, role, detail }: { readonly icon: ReactNode; readonly name: string; readonly role: string; readonly detail: string }) {
  return (
    <li className="flex items-center gap-2" title={detail}>
      <span className="shrink-0 text-fg-muted">{icon}</span>
      <span className="min-w-0 truncate font-mono text-xs">{name}</span>
      <span className="ml-auto shrink-0 text-fg-muted">{role}</span>
    </li>
  );
}

function Avatar({ account, size }: { readonly account: NonNullable<PlatformStatus["account"]>; readonly size: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  return account.avatarUrl && !failed ? (
    <img src={account.avatarUrl} alt="" className="avatar shrink-0" style={style} onError={() => setFailed(true)} />
  ) : (
    <span className="avatar avatar-initials shrink-0 text-[10px]" style={style} aria-hidden>
      {initials(account.name ?? account.login)}
    </span>
  );
}

function Account() {
  const account = useStore((state) => state.app?.platform.account);
  if (!account) return null;
  return (
    <>
      <span className="AppHeader-divider max-sm:hidden" aria-hidden />
      <Tooltip content={account.name ? `${account.name} (@${account.login})` : `@${account.login}`}>
        <span className="inline-flex shrink-0">
          <Avatar account={account} size={32} />
          <span className="sr-only">Signed in as {account.login}</span>
        </span>
      </Tooltip>
    </>
  );
}
