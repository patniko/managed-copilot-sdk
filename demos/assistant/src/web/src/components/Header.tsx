import {
  AlertIcon,
  DeviceDesktopIcon,
  DotFillIcon,
  GearIcon,
  KeyIcon,
  MarkGithubIcon,
  MoonIcon,
  PlugIcon,
  StopIcon,
  SunIcon,
  SyncIcon,
  ThreeBarsIcon,
  XCircleFillIcon,
  type Icon,
} from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { AccountView, ConversationStatus, PlatformStatus } from "../../../shared/protocol";
import { relativeTime } from "../format";
import { setTheme, useTheme, type Theme } from "../theme";
import type { AssistantState } from "../useAssistant";
import { cx, Menu, Spinner } from "./ui";

type Tone = "ok" | "busy" | "warn" | "error";

export function statusOf(stream: AssistantState["stream"], platform: PlatformStatus | undefined, conversation: ConversationStatus | undefined): { tone: Tone; text: string } {
  if (stream !== "open") return { tone: "warn", text: "Reconnecting to the assistant server…" };
  if (!platform || platform.state === "connecting") return { tone: "warn", text: "Connecting to Managed Copilot…" };
  if (platform.state !== "ready") return { tone: "error", text: platform.state === "unauthenticated" ? "Sign-in required" : platform.state === "misconfigured" ? "Setup needed" : "Managed Copilot is unreachable" };
  if (!conversation || conversation.attach === "attaching" || conversation.attach === "detached") return { tone: "warn", text: "Opening your conversation…" };
  if (conversation.attach === "reconnecting") return { tone: "warn", text: "Reconnecting…" };
  if (conversation.attach === "error") return { tone: "error", text: "Couldn't open the conversation" };
  if (conversation.busy) return { tone: "busy", text: "Working on it…" };
  const where = platform.deployment?.mode === "azure" ? "Azure" : "local";
  return { tone: "ok", text: `Online · Managed Copilot (${where})` };
}

export const THEMES: readonly { value: Theme; label: string; icon: Icon }[] = [
  { value: "system", label: "System", icon: DeviceDesktopIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** Connection status, the GitHub way: an icon and text (the text is for screen readers and tooltips on phones). */
function Status({ status }: { status: { tone: Tone; text: string } }) {
  const icon =
    status.tone === "ok" ? (
      <DotFillIcon className="text-fg-success" />
    ) : status.tone === "busy" ? (
      <Spinner className="text-fg-attention" />
    ) : status.tone === "warn" ? (
      <DotFillIcon className="text-fg-attention" />
    ) : (
      <XCircleFillIcon className="text-fg-danger" />
    );
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted" data-testid="status" data-status={status.tone} title={status.text}>
      {icon}
      <span className="hidden truncate md:inline">{status.text}</span>
      <span className="sr-only md:hidden">{status.text}</span>
    </span>
  );
}

function ThemeMenu() {
  const theme = useTheme();
  const current = THEMES.find((option) => option.value === theme) ?? THEMES[0]!;
  return (
    <Menu
      label="Theme"
      heading="Theme"
      width="w-44"
      items={THEMES.map((option) => ({ key: option.value, label: option.label, icon: option.icon, checked: option.value === theme, onSelect: () => setTheme(option.value) }))}
      renderTrigger={(trigger) => (
        // Phones keep the header for the conversation; the theme is also in Settings.
        <button type="button" className="AppHeader-button hidden sm:inline-grid" aria-label={`Theme: ${current.label}`} title="Theme" {...trigger}>
          <current.icon />
        </button>
      )}
    />
  );
}

/** github.com's global header: menu, GitHub mark, "Managed Copilot / Assistant", then status and account actions. */
export function Header(props: {
  status: { tone: Tone; text: string };
  account?: AccountView;
  unread: number;
  /** Something in the side panel needs the person (shown as a dot on the menu button on narrow screens). */
  panelAttention?: string;
  panelOpen: boolean;
  /** Development only: the fixture preview's label and switcher. */
  preview?: ReactNode;
  onOpenPanel(): void;
  onOpenSettings(): void;
}) {
  const { status, account } = props;
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
          <Status status={status} />
          <span className="AppHeader-divider hidden sm:block" aria-hidden />
          <ThemeMenu />
          <button type="button" className="AppHeader-button" onClick={props.onOpenSettings} aria-label="Settings" title="Settings">
            <GearIcon />
          </button>
          {account &&
            (account.avatarUrl ? (
              <img src={account.avatarUrl} alt={`@${account.login}`} title={`Signed in to Managed Copilot as @${account.login}`} className="avatar size-8" />
            ) : (
              <span className="avatar avatar-initials size-8 text-xs" title={`Signed in to Managed Copilot as @${account.login}`}>
                {account.login.slice(0, 2).toUpperCase()}
              </span>
            ))}
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
