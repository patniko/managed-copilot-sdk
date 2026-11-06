import { ContainerIcon, CopyIcon, CpuIcon, DotFillIcon, MarkGithubIcon, TerminalIcon, TriangleDownIcon, XIcon } from "@primer/octicons-react";
import { useCallback, useRef, useState } from "react";
import type { AttachResponse, EnvironmentView, PlatformStatus } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { initials } from "../lib/format.js";
import { useDismiss } from "../lib/hooks.js";
import { homeHref } from "../lib/router.js";
import { openInCli, useStore } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

/** github.com's global header: the GitHub mark, `Managed Copilot / Data Desk`, and actions on the right. */
export function Header({ analysisId }: { readonly analysisId?: string }) {
  return (
    <header className="AppHeader relative z-30 shrink-0">
      <div className="AppHeader-globalBar gap-2 sm:gap-3">
        <a href={homeHref()} className="AppHeader-logo" aria-label="Data Desk home">
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
            <span className="truncate">Data Desk</span>
          </a>
        </nav>
        <div className="AppHeader-actions min-w-0">
          <ConnectionIndicator />
          {analysisId ? <CliButton id={analysisId} /> : null}
          <PlatformButton />
          <AccountAvatar />
        </div>
      </div>
    </header>
  );
}

function ConnectionIndicator() {
  const connection = useStore((state) => state.connection);
  if (connection !== "reconnecting") return null;
  return (
    <span role="status" className="inline-flex shrink-0 animate-fade-in items-center gap-1.5 text-xs text-fg-muted">
      <Spinner size={16} className="text-fg-attention" />
      <span className="max-md:hidden">Reconnecting…</span>
    </span>
  );
}

/** Opens the analysis's session in Copilot CLI; the CLI follows it when it moves into its sandbox. */
function CliButton({ id }: { readonly id: string }) {
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<AttachResponse | undefined>();
  const template = useStore((state) => state.attachCommand);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setCommand(undefined), []);
  useDismiss(container, command !== undefined, close);
  const open = async () => {
    setBusy(true);
    const result = await openInCli(id);
    setBusy(false);
    setCommand(result && !result.launched ? result : undefined);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(template.replace("{sessionId}", id));
      toast.success("Copied the Copilot CLI command", "Paste it in a terminal at the repository root.");
    } catch {
      toast.error("Couldn't copy", "Select the command and copy it yourself.");
    }
  };
  return (
    <div ref={container} className="relative flex items-center">
      <Tooltip content="Open in Copilot CLI">
        <button type="button" className="AppHeader-button" aria-label="Open in Copilot CLI" aria-expanded={command !== undefined} disabled={busy} onClick={() => void open()}>
          {busy ? <Spinner size={16} /> : <TerminalIcon size={16} />}
        </button>
      </Tooltip>
      {template ? (
        <Tooltip content="Copy Copilot CLI command">
          <button type="button" className="btn-octicon" aria-label="Copy Copilot CLI command" onClick={() => void copy()}>
            <CopyIcon size={16} />
          </button>
        </Tooltip>
      ) : null}
      {command ? <CommandPopover result={command} onClose={close} /> : null}
    </div>
  );
}

function CommandPopover({ result, onClose }: { readonly result: AttachResponse; readonly onClose: () => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.command);
      toast.success("Copied", "Paste it in a terminal at the repository root.");
      onClose();
    } catch {
      toast.error("Couldn't copy", "Select the command and copy it yourself.");
    }
  };
  return (
    <div role="dialog" aria-label="Open in Copilot CLI" className="Overlay absolute top-full right-0 z-40 mt-2 w-[26rem] max-w-[calc(100vw-2rem)] animate-scale-in">
      <div className="Overlay-body flex flex-col gap-2 p-3 text-sm">
        <div className="flex items-start gap-2">
          <TerminalIcon size={16} className="mt-0.5 shrink-0 text-fg-muted" />
          <p className="min-w-0 flex-1">{result.message}</p>
          <button type="button" className="btn-octicon -m-1" aria-label="Close" onClick={onClose}>
            <XIcon size={16} />
          </button>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-line bg-canvas-inset py-1 pr-1 pl-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs" title={result.command}>
            {result.command}
          </code>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void copy()}>
            <CopyIcon size={16} />
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

const DOT: Readonly<Record<PlatformStatus["state"], string>> = {
  connected: "text-fg-success",
  connecting: "text-fg-attention",
  reconnecting: "text-fg-attention",
  unavailable: "text-fg-danger",
};

/** `Local` or `Azure` from the deployment's mode, falling back to its name. */
export function platformLabel(platform: PlatformStatus): string {
  if (platform.mode === "local") return "Local";
  if (platform.mode === "azure") return "Azure";
  return platform.deployment ?? "Managed Copilot";
}

function statusLine(platform: PlatformStatus): string {
  switch (platform.state) {
    case "connected":
      return `Connected · ${platformLabel(platform)}`;
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "unavailable":
      return "Unavailable";
  }
}

function Dot({ platform, size = 16 }: { readonly platform: PlatformStatus; readonly size?: number }) {
  return platform.state === "connecting" || platform.state === "reconnecting" ? (
    <Spinner size={12} className={DOT[platform.state]} />
  ) : (
    <DotFillIcon size={size} className={DOT[platform.state]} />
  );
}

function PlatformButton() {
  const platform = useStore((state) => state.platform);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  if (!platform) return null;
  const label = platform.state === "unavailable" ? "Unavailable" : platform.mode || platform.state === "connected" ? platformLabel(platform) : "Connecting";
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
        <Dot platform={platform} />
        <span className="max-w-[10rem] min-w-0 truncate">{label}</span>
        <TriangleDownIcon size={16} />
      </button>
      {open ? <PlatformPopover platform={platform} /> : null}
    </div>
  );
}

const ENVIRONMENT_ICON = { promotable: CpuIcon, isolated: ContainerIcon } as const;

function environmentLabel(environment: EnvironmentView): string {
  if (environment.type === "promotable") return "Starts here";
  if (environment.type === "isolated") return environment.network === "disabled" ? "Python sandbox, no network" : "Python sandbox";
  return environment.type;
}

function PlatformPopover({ platform }: { readonly platform: PlatformStatus }) {
  const environments = useStore((state) => state.environments);
  const account = platform.account;
  return (
    <div role="dialog" aria-label="Deployment details" className="Overlay absolute top-full right-0 z-40 mt-2 w-[21rem] max-w-[calc(100vw-2rem)] animate-scale-in">
      <div className="Overlay-body p-0 text-sm">
        <div className="flex flex-col gap-1 p-4">
          <div className="flex items-center gap-1.5 font-semibold">
            <Dot platform={platform} />
            {statusLine(platform)}
          </div>
          {platform.deployment ? (
            <div className="text-fg-muted">
              Deployment <span className="font-semibold text-fg">{platform.deployment}</span>
            </div>
          ) : null}
          {platform.url ? <div className="truncate font-mono text-xs text-fg-muted">{platform.url}</div> : null}
          {platform.message ? <p className="mt-1 text-fg-muted">{platform.message}</p> : null}
        </div>
        {account ? (
          <div className="flex items-center gap-2 border-t border-line px-4 py-3">
            <Avatar size={20} account={account} />
            <span className="truncate">
              {account.name ? <span className="font-semibold">{account.name} </span> : null}
              <span className="text-fg-muted">@{account.login}</span>
            </span>
          </div>
        ) : null}
        {environments.length ? (
          <div className="border-t border-line px-4 py-3">
            <div className="mb-1 text-xs font-semibold text-fg-muted">Environments</div>
            <ul className="flex flex-col gap-1">
              {environments.map((environment) => {
                const Glyph = ENVIRONMENT_ICON[environment.type as keyof typeof ENVIRONMENT_ICON] ?? CpuIcon;
                return (
                  <li key={environment.name} className="flex items-center gap-2">
                    <Glyph size={16} className={cx("shrink-0", environment.type === "isolated" ? "text-fg-done" : "text-fg-accent")} />
                    <span className="min-w-0 truncate font-mono text-xs">{environment.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-fg-muted">{environmentLabel(environment)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Avatar({ account, size }: { readonly account: NonNullable<PlatformStatus["account"]>; readonly size: number }) {
  const [failed, setFailed] = useState(false);
  const name = account.name ?? account.login;
  return account.avatarUrl && !failed ? (
    <img src={account.avatarUrl} alt="" width={size} height={size} className="avatar shrink-0" style={{ width: size, height: size }} onError={() => setFailed(true)} />
  ) : (
    <span className="avatar avatar-initials shrink-0 text-xs" style={{ width: size, height: size }} aria-hidden>
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
