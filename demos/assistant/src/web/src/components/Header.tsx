import {
  AlertIcon,
  ContainerIcon,
  CpuIcon,
  DotFillIcon,
  GearIcon,
  KeyIcon,
  MarkGithubIcon,
  PlugIcon,
  StopIcon,
  SyncIcon,
  TerminalIcon,
  ThreeBarsIcon,
  TriangleDownIcon,
  type Icon,
} from "@primer/octicons-react";
import { useEffect, useState, type ReactNode } from "react";
import type { AccountView, ConversationStatus, OfflineView, PlatformStatus, SandboxEnvironmentView, SandboxesView } from "../../../shared/protocol";
import { api } from "../api";
import { relativeTime } from "../format";
import type { AssistantState } from "../useAssistant";
import { capitalize, networkLabel } from "./Sandbox";
import { CopyButton, cx, Popover, Spinner, Tooltip } from "./ui";

type Tone = "ok" | "busy" | "warn" | "error";

export interface StatusView {
  tone: Tone;
  text: string;
}

/**
 * The assistant's connection, for the header's platform pill: `ok` and `busy` (a turn is running) are both connected.
 * Its tone is the pill's `data-status`, which scripts wait on.
 */
export function statusOf(stream: AssistantState["stream"], platform: PlatformStatus | undefined, conversation: ConversationStatus | undefined): StatusView {
  if (stream !== "open") return { tone: "warn", text: "Reconnecting to the assistant server…" };
  if (!platform || platform.state === "connecting") return { tone: "warn", text: "Connecting to Managed Copilot…" };
  if (platform.state !== "ready") return { tone: "error", text: platform.state === "unauthenticated" ? "Sign-in required" : platform.state === "misconfigured" ? "Setup needed" : "Managed Copilot is unreachable" };
  if (!conversation || conversation.attach === "attaching" || conversation.attach === "detached") return { tone: "warn", text: "Opening your conversation…" };
  if (conversation.attach === "reconnecting") return { tone: "warn", text: "Reconnecting…" };
  if (conversation.attach === "error") return { tone: "error", text: "Couldn't open the conversation" };
  if (conversation.busy) return { tone: "busy", text: "Connected · working on a reply" };
  return { tone: "ok", text: "Connected" };
}

type Deployment = NonNullable<PlatformStatus["deployment"]>;

/** Where the platform runs, in one word: "Local" or "Azure" (its mode), else the deployment's name. */
export function platformLabel(deployment: Deployment | undefined): string | undefined {
  if (!deployment) return undefined;
  if (deployment.mode === "local") return "Local";
  if (deployment.mode === "azure") return "Azure";
  return deployment.name || undefined;
}

/** The status dot: green when connected, a spinner while connecting, red when unavailable. */
function StatusDot({ tone }: { tone: Tone }) {
  if (tone === "warn") return <Spinner size={12} className="text-fg-attention" />;
  return <DotFillIcon className={tone === "error" ? "text-fg-danger" : "text-fg-success"} />;
}

/** A row of the platform popover's "Where it runs": the agent's brain, this app's tools, and its sandboxes. */
function Where({ icon: Glyph, title, detail, name }: { icon: Icon; title: string; detail?: string; name?: string }) {
  return (
    <li className="flex items-start gap-2">
      <Glyph className="mt-0.5 shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="font-semibold">{title}</span>
          {name && (
            <code className="ml-auto truncate font-mono text-xs text-fg-muted" title={name}>
              {name}
            </code>
          )}
        </div>
        {detail && <div className="text-xs text-fg-muted">{detail}</div>}
      </div>
    </li>
  );
}

function PlatformDetails({
  status,
  platform,
  deployment,
  conversation,
  account,
  environments,
  offline,
}: {
  status: StatusView;
  platform?: PlatformStatus;
  deployment?: Deployment;
  conversation?: ConversationStatus;
  account?: AccountView;
  environments: readonly SandboxEnvironmentView[];
  offline?: OfflineView;
}) {
  const connected = status.tone === "ok" || status.tone === "busy";
  const label = platformLabel(deployment);
  return (
    <div className="text-sm">
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <span className="flex shrink-0">
            <StatusDot tone={status.tone} />
          </span>
          <span className="min-w-0">{connected ? `Connected${label ? ` · ${label}` : ""}` : status.text}</span>
        </div>
        {!connected && platform?.message && <p className="mt-1 line-clamp-2 text-xs text-fg-muted">{platform.message}</p>}
        {deployment && (
          <div className="mt-2 truncate text-fg-muted" title={`v${deployment.version}`}>
            Deployment <span className="font-semibold text-fg">{deployment.name}</span>
          </div>
        )}
        {platform?.url && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-xs text-fg-muted" title={platform.url}>
              {platform.url}
            </span>
            <CopyButton text={platform.url} label="Copy URL" />
          </div>
        )}
        {account && (
          <div className="mt-2 flex min-w-0 items-center gap-2">
            {account.avatarUrl ? (
              <img src={account.avatarUrl} alt="" className="avatar size-5 shrink-0" />
            ) : (
              <span className="avatar avatar-initials size-5 shrink-0 text-[10px]" aria-hidden>
                {account.login.slice(0, 2).toUpperCase()}
              </span>
            )}
            {account.name && <span className="truncate font-semibold">{account.name}</span>}
            <span className="truncate text-fg-muted">@{account.login}</span>
          </div>
        )}
      </div>
      <div className="px-4 py-3">
        <h3 className="text-xs font-semibold text-fg-muted">Where it runs</h3>
        <ul className="mt-2 space-y-2">
          <Where icon={CpuIcon} title="Your assistant" detail="Shared runtime" name={platform?.environment} />
          <Where icon={PlugIcon} title="Mail and calendar tools" detail="In this app, so your mail never leaves it" />
          {environments.map((environment) => (
            <Where
              key={environment.name}
              icon={ContainerIcon}
              title={capitalize(environment.label)}
              detail={["Sandbox on demand", environment.size, networkLabel(environment.network)].filter(Boolean).join(" · ")}
              name={environment.name}
            />
          ))}
        </ul>
      </div>
      {(conversation?.model || offline) && (
        <div className="space-y-0.5 border-t border-line-muted px-4 py-2.5 text-xs text-fg-muted">
          {conversation?.model && (
            <div className="truncate">
              Model <span className="font-mono">{conversation.model}</span>
            </div>
          )}
          {offline && <div>Webhook {offline.webhookConfigured ? "on" : "off · polling only"}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * The platform pill: a status dot and where the platform runs ("Local" or "Azure"), opening the details. It carries
 * `data-testid="status"` with `data-status` ok, busy, warn, or error.
 */
function PlatformPill(props: {
  status: StatusView;
  platform?: PlatformStatus;
  conversation?: ConversationStatus;
  account?: AccountView;
  sandboxes?: SandboxesView;
  offline?: OfflineView;
}) {
  const { status, platform } = props;
  // A dropped connection keeps the last deployment's name.
  const [known, setKnown] = useState(platform?.deployment);
  useEffect(() => {
    if (platform?.deployment) setKnown(platform.deployment);
  }, [platform?.deployment]);
  const deployment = platform?.deployment ?? known;
  const label = platformLabel(deployment) ?? (status.tone === "error" ? "Unavailable" : "Connecting");
  return (
    <Popover
      label="Managed Copilot"
      width="w-80"
      renderTrigger={(trigger) => (
        <Tooltip content={status.text} describe={false}>
          <button
            type="button"
            className="btn btn-sm min-w-0 shrink-0"
            data-testid="status"
            data-status={status.tone}
            aria-label={`Managed Copilot ${label}: ${status.text}`}
            {...trigger}
          >
            <StatusDot tone={status.tone} />
            <span className="truncate max-sm:hidden">{label}</span>
            <TriangleDownIcon />
          </button>
        </Tooltip>
      )}
    >
      <PlatformDetails
        status={status}
        platform={platform}
        deployment={deployment}
        conversation={props.conversation}
        account={props.account}
        environments={props.sandboxes?.environments ?? []}
        offline={props.offline}
      />
    </Popover>
  );
}

/** Copilot CLI: opens this same conversation in a terminal, with the command a click away to copy. */
function CliButton({ sessionId, platform, canLaunch }: { sessionId?: string; platform?: PlatformStatus; canLaunch: boolean }) {
  // A local platform's URL works from this machine; naming it keeps the command right when discovery is off.
  const url = platform?.deployment?.mode === "local" ? platform.url : undefined;
  const command = sessionId ? `npx managed-copilot attach ${sessionId}${url ? ` --url ${url}` : ""}` : undefined;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  if (canLaunch) {
    const open = async () => {
      setBusy(true);
      setNote(undefined);
      try {
        const result = await api.openCli();
        setNote(result.launched ? undefined : result.message);
      } catch (error) {
        setNote(error instanceof Error ? error.message : "Couldn't open Copilot CLI.");
      } finally {
        setBusy(false);
      }
    };
    const tip = !command ? "Open in Copilot CLI (available after your first message)" : (note ?? "Open in Copilot CLI");
    return (
      <span className="hidden items-center sm:inline-flex">
        <Tooltip content={tip} describe={false}>
          <button type="button" className="AppHeader-button" aria-label="Open in Copilot CLI" aria-disabled={!command || busy} onClick={() => command && !busy && void open()}>
            {busy ? <Spinner /> : <TerminalIcon className={note ? "text-fg-attention" : undefined} />}
          </button>
        </Tooltip>
        {command && <CopyButton text={command} label="Copy Copilot CLI command" />}
      </span>
    );
  }
  return (
    <Popover
      label="Open in Copilot CLI"
      width="w-[22rem]"
      renderTrigger={(trigger) => (
        <Tooltip content="Open in Copilot CLI" describe={false}>
          {/* Phones have no terminal; the button starts at the small breakpoint. */}
          <button type="button" className="AppHeader-button hidden sm:inline-grid" aria-label="Open in Copilot CLI" {...trigger}>
            <TerminalIcon />
          </button>
        </Tooltip>
      )}
    >
      <div className="p-4 text-sm">
        <div className="flex items-center gap-2 font-semibold">
          <TerminalIcon className="text-fg-muted" />
          Open in Copilot CLI
        </div>
        <p className="mt-1 text-fg-muted">Continue this conversation in your terminal.</p>
        {command ? (
          <div className="mt-3 flex items-center gap-1 rounded-md border border-line bg-canvas-inset py-1 pr-1 pl-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
              {command}
            </code>
            <CopyButton text={command} label="Copy command" />
          </div>
        ) : (
          <p className="mt-3 text-xs text-fg-muted">Available after your first message.</p>
        )}
      </div>
    </Popover>
  );
}

function Avatar({ account }: { account: AccountView }) {
  const label = `Signed in as @${account.login}`;
  return (
    <Tooltip content={label} describe={false}>
      {account.avatarUrl ? (
        <img src={account.avatarUrl} alt={label} className="avatar size-8" />
      ) : (
        <span className="avatar avatar-initials size-8 text-xs" role="img" aria-label={label}>
          {account.login.slice(0, 2).toUpperCase()}
        </span>
      )}
    </Tooltip>
  );
}

/** github.com's global header: menu, GitHub mark, "Managed Copilot / Assistant", then app buttons, the platform pill, and the account. */
export function Header(props: {
  status: StatusView;
  platform?: PlatformStatus;
  conversation?: ConversationStatus;
  account?: AccountView;
  sandboxes?: SandboxesView;
  offline?: OfflineView;
  canLaunchCli?: boolean;
  unread: number;
  /** Something in the side panel needs the person (shown as a dot on the menu button on narrow screens). */
  panelAttention?: string;
  panelOpen: boolean;
  /** Development only: the fixture preview's label and switcher. */
  preview?: ReactNode;
  onOpenPanel(): void;
  onOpenSettings(): void;
}) {
  const { account } = props;
  return (
    <header className="AppHeader shrink-0">
      <div className="AppHeader-globalBar gap-2 px-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          className="AppHeader-button lg:hidden"
          onClick={props.onOpenPanel}
          aria-label={props.panelAttention ? `Today, automations, and connections (${props.panelAttention})` : "Today, automations, and connections"}
          aria-expanded={props.panelOpen}
          title={props.panelAttention}
        >
          <ThreeBarsIcon />
          {props.panelAttention && <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-attention-emphasis ring-2 ring-canvas-inset" aria-hidden />}
        </button>
        <a href="/" className="AppHeader-logo" aria-label="Assistant home">
          <MarkGithubIcon size={32} />
        </a>
        <nav className="AppHeader-context min-w-0" aria-label="Breadcrumb">
          <a href="/" className="AppHeader-context-item hidden sm:inline-flex">
            Managed Copilot
          </a>
          <span className="AppHeader-context-divider hidden sm:inline" aria-hidden>
            /
          </span>
          <span className="AppHeader-context-item truncate" aria-current="page">
            Assistant
          </span>
        </nav>
        {props.unread > 0 && (
          <span className="Label Label--accent shrink-0" title={`${props.unread} new since you last looked`}>
            {props.unread}
            <span className="hidden sm:inline">new</span>
            <span className="sr-only sm:hidden">new</span>
          </span>
        )}
        {props.preview}
        <div className="AppHeader-actions min-w-0">
          <CliButton sessionId={props.conversation?.sessionId} platform={props.platform} canLaunch={props.canLaunchCli === true} />
          <Tooltip content="Settings" describe={false}>
            <button type="button" className="AppHeader-button" onClick={props.onOpenSettings} aria-label="Settings">
              <GearIcon />
            </button>
          </Tooltip>
          <PlatformPill
            status={props.status}
            platform={props.platform}
            conversation={props.conversation}
            account={account}
            sandboxes={props.sandboxes}
            offline={props.offline}
          />
          {account && (
            <>
              <span className="AppHeader-divider hidden sm:block" aria-hidden />
              <Avatar account={account} />
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function Banner(props: {
  stream: AssistantState["stream"];
  platform?: PlatformStatus;
  conversation?: ConversationStatus;
  googleNeedsReconnect: boolean;
  onRetry(): void;
  onReconnectGoogle(): void;
}) {
  const { platform, conversation } = props;
  let content: { tone: "error" | "warn"; icon: Icon; title: string; body?: string; action?: { label: string; run(): void } } | undefined;

  if (props.stream === "reconnecting") {
    content = { tone: "warn", icon: PlugIcon, title: "Lost the connection to the assistant server", body: "Retrying automatically. If it doesn't come back, check that the assistant is still running." };
  } else if (platform && platform.state !== "ready" && platform.state !== "connecting") {
    const retry = platform.retryAt ? ` Retrying ${relativeTime(platform.retryAt)}.` : "";
    if (platform.state === "unauthenticated") {
      content = { tone: "error", icon: KeyIcon, title: "Sign in to GitHub", body: `${platform.message ?? "The assistant needs your GitHub sign-in."} Run \`gh auth login\`, then retry.${retry}`, action: { label: "Retry", run: props.onRetry } };
    } else if (platform.state === "misconfigured") {
      content = { tone: "error", icon: AlertIcon, title: "This deployment isn't set up for the assistant", body: platform.message, action: { label: "Retry", run: props.onRetry } };
    } else {
      content = {
        tone: "error",
        icon: StopIcon,
        title: "Can't reach Managed Copilot",
        body: `${platform.message ?? "The platform isn't responding."} Start it with \`aspire run\`.${retry}`,
        action: { label: "Retry now", run: props.onRetry },
      };
    }
  } else if (conversation?.attach === "error") {
    content = { tone: "error", icon: StopIcon, title: "Couldn't open your conversation", body: conversation.error, action: { label: "Try again", run: props.onRetry } };
  } else if (platform?.state === "ready" && platform.message) {
    content = { tone: "warn", icon: AlertIcon, title: "Limited functionality", body: platform.message };
  } else if (props.googleNeedsReconnect) {
    content = { tone: "warn", icon: KeyIcon, title: "Google access expired", body: "Reconnect Google so your assistant can read mail and manage your calendar.", action: { label: "Reconnect", run: props.onReconnectGoogle } };
  }
  if (!content) return null;
  const BannerIcon = content.icon;
  return (
    <div className={cx("flash flash-full flash-sm border-t-0 px-4 md:px-6", content.tone === "error" ? "flash-error" : "flash-warn")} role="status">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-3">
        <BannerIcon className="flash-icon" />
        <div className="flash-content">
          <div className="flash-title">{content.title}</div>
          {content.body && <div className="mt-0.5 break-words">{renderInlineCode(content.body)}</div>}
        </div>
        {content.action && (
          <div className="flash-actions">
            <button type="button" className="btn btn-sm" onClick={content.action.run}>
              <SyncIcon />
              {content.action.label}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Renders `code` spans in short status messages. */
export function renderInlineCode(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={index} className="rounded-md bg-neutral-muted px-1 py-0.5 font-mono text-xs">
        {part.slice(1, -1)}
      </code>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}
