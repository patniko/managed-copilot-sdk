import { CopilotIcon, DotFillIcon, MarkGithubIcon, ThreeBarsIcon, TriangleDownIcon } from "@primer/octicons-react";
import { useState, type ReactNode } from "react";
import type { PlatformStatus } from "../../shared/types.js";
import { networkSummary, sizeSummary } from "../lib/blueprints.js";
import { cx } from "../lib/cx.js";
import { initials } from "../lib/format.js";
import { homeHref } from "../lib/router.js";
import { useStore, type Connection } from "../lib/store.js";
import { STYLE_META } from "../lib/styles.js";
import { usePopover } from "../lib/usePopover.js";
import { BlueprintIcon } from "./BlueprintIcon.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

/**
 * github.com's global header: the GitHub mark (home), the `Managed Copilot / Dispatch` breadcrumb, and on the right
 * the app's own icon buttons (none here), one platform pill, a divider, and the account avatar.
 */
export function AppHeaderBar({ onOpenMenu, actions }: { readonly onOpenMenu?: () => void; readonly actions?: ReactNode }) {
  return (
    <header className="AppHeader relative z-30 shrink-0">
      <div className="AppHeader-globalBar gap-2 sm:gap-3">
        {onOpenMenu ? (
          <button type="button" className="AppHeader-button lg:hidden" aria-label="Show conversations" onClick={onOpenMenu}>
            <ThreeBarsIcon size={16} />
          </button>
        ) : null}
        <a href={homeHref()} className="AppHeader-logo" aria-label="Dispatch home">
          <MarkGithubIcon size={32} />
        </a>
        <nav className="AppHeader-context" aria-label="Breadcrumb">
          <a href={homeHref()} className="AppHeader-context-item max-sm:hidden">
            Managed Copilot
          </a>
          <span className="AppHeader-context-divider max-sm:hidden" aria-hidden>
            /
          </span>
          <a href={homeHref()} className="AppHeader-context-item AppHeader-context-item--current">
            <span className="truncate">Dispatch</span>
          </a>
        </nav>
        {actions ? <div className="AppHeader-actions min-w-0">{actions}</div> : null}
      </div>
    </header>
  );
}

export function TopBar({ onOpenMenu }: { readonly onOpenMenu: () => void }) {
  return (
    <AppHeaderBar
      onOpenMenu={onOpenMenu}
      actions={
        <>
          <PlatformPill />
          <AccountAvatar />
        </>
      }
    />
  );
}

export interface PillStatus {
  readonly tone: "success" | "busy" | "danger";
  /** The pill's label: `Local` or `Azure`, else the deployment's name. */
  readonly label: string;
  /** The popover's first line. */
  readonly headline: string;
}

/** The platform pill: where the app runs, and whether it's connected (Dispatch's own event stream included). */
export function pillStatus(platform: PlatformStatus | undefined, connection: Connection): PillStatus {
  const label = platform?.mode === "azure" ? "Azure" : platform?.mode === "local" ? "Local" : (platform?.deployment ?? "Managed Copilot");
  if (!platform || platform.state === "connecting") return { tone: "busy", label, headline: "Connecting to Managed Copilot…" };
  if (platform.state === "reconnecting") return { tone: "busy", label, headline: "Reconnecting to Managed Copilot…" };
  if (platform.state === "unavailable") return { tone: "danger", label, headline: "Managed Copilot isn't available" };
  if (connection === "reconnecting") return { tone: "busy", label, headline: "Reconnecting to Dispatch's server…" };
  return { tone: "success", label, headline: `Connected · ${label}` };
}

function StatusDot({ tone }: { readonly tone: PillStatus["tone"] }) {
  if (tone === "busy") return <Spinner size={14} className="text-fg-attention" />;
  return <DotFillIcon size={16} className={tone === "success" ? "text-fg-success" : "text-fg-danger"} />;
}

function PlatformPill() {
  const platform = useStore((state) => state.platform);
  const connection = useStore((state) => state.connection);
  const { open, toggle, container } = usePopover();
  const status = pillStatus(platform, connection);
  return (
    <div ref={container} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${status.label}: ${status.headline}. Show deployment details`}
        onClick={toggle}
        className="btn btn-sm"
      >
        <StatusDot tone={status.tone} />
        <span className="max-w-[10rem] truncate">{status.label}</span>
        <TriangleDownIcon size={16} />
      </button>
      {open ? <PlatformPopover platform={platform} status={status} /> : null}
    </div>
  );
}

function PlatformPopover({ platform, status }: { readonly platform: PlatformStatus | undefined; readonly status: PillStatus }) {
  const styles = useStore((state) => state.styles);
  const blueprints = useStore((state) => state.blueprints);
  const coordinators = styles.filter((style) => style.available && style.coordinator);
  const account = platform?.account;
  return (
    <div role="dialog" aria-label="Deployment details" className="Overlay absolute top-full right-0 z-40 mt-2 w-[21rem] animate-scale-in">
      <div className="flex flex-col gap-1 border-b border-line-muted px-4 py-3">
        <div className="flex items-center gap-1.5 font-semibold">
          <StatusDot tone={status.tone} />
          {status.headline}
        </div>
        {platform?.deployment ? (
          <div className="text-sm text-fg-muted">
            Deployment <span className="font-semibold text-fg">{platform.deployment}</span>
          </div>
        ) : null}
        {platform?.url ? (
          <div className="truncate font-mono text-xs text-fg-muted" title={platform.url}>
            {platform.url}
          </div>
        ) : null}
        {platform?.message && platform.state !== "connected" ? <p className="text-sm text-fg-muted">{platform.message}</p> : null}
      </div>
      {account ? (
        <div className="flex items-center gap-2 border-b border-line-muted px-4 py-2.5 text-sm">
          <Avatar account={account} size={20} />
          <span className="min-w-0 truncate">
            {account.name ? <span className="font-semibold">{account.name} </span> : null}
            <span className="text-fg-muted">@{account.login}</span>
          </span>
        </div>
      ) : null}
      {coordinators.length || blueprints.length ? (
        <div className="px-2 py-2">
          <div className="px-2 pb-1 text-xs font-semibold text-fg-muted">Environments</div>
          <ul className="flex flex-col text-sm">
            {coordinators.map((style) => (
              <EnvironmentRow
                key={style.environment}
                icon={<CopilotIcon size={16} className="text-fg-muted" />}
                name={style.environment}
                detail={STYLE_META[style.style].short}
                title={`Coordinator: ${STYLE_META[style.style].label.toLowerCase()} · ${style.coordinator?.model ?? ""} · on the shared runtime`}
              />
            ))}
            {blueprints.map((blueprint) => (
              <EnvironmentRow
                key={blueprint.name}
                icon={<BlueprintIcon kind={blueprint.kind} />}
                name={blueprint.name}
                detail={blueprint.label}
                title={`Sandbox: ${sizeSummary(blueprint)} · ${networkSummary(blueprint.network, blueprint.kind)}`}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function EnvironmentRow({ icon, name, detail, title }: { readonly icon: ReactNode; readonly name: string; readonly detail: string; readonly title: string }) {
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1" title={title}>
      {icon}
      <span className="min-w-0 truncate font-mono text-xs">{name}</span>
      <span className="ml-auto shrink-0 text-xs text-fg-muted">{detail}</span>
    </li>
  );
}

function Avatar({ account, size }: { readonly account: NonNullable<PlatformStatus["account"]>; readonly size: number }) {
  const [imageFailed, setImageFailed] = useState(false);
  const name = account.name ?? account.login;
  if (account.avatarUrl && !imageFailed) return <img src={account.avatarUrl} alt="" width={size} height={size} className="avatar shrink-0" onError={() => setImageFailed(true)} />;
  return (
    <span className={cx("avatar avatar-initials shrink-0", size >= 32 ? "text-xs" : "text-[10px]")} style={{ width: size, height: size }} aria-hidden>
      {initials(name)}
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
          <Avatar account={account} size={32} />
          <span className="sr-only">Signed in as {account.login}</span>
        </span>
      </Tooltip>
    </>
  );
}
