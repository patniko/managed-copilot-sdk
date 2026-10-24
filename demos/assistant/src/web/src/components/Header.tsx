import { CircleAlert, KeyRound, PanelRight, RefreshCw, Settings, TriangleAlert, Unplug } from "lucide-react";
import type { AccountView, ConversationStatus, PlatformStatus } from "../../../shared/protocol";
import { relativeTime } from "../format";
import type { AssistantState } from "../useAssistant";
import { AssistantAvatar } from "./Items";

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

const DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  busy: "bg-violet-500 animate-pulse",
  warn: "bg-amber-500 animate-pulse",
  error: "bg-red-500",
};

export function Header(props: {
  status: { tone: Tone; text: string };
  account?: AccountView;
  unread: number;
  onOpenPanel(): void;
  onOpenSettings(): void;
}) {
  const { status, account } = props;
  return (
    <header className="flex items-center gap-3 border-b border-zinc-200/80 bg-white/80 px-4 py-2.5 backdrop-blur sm:px-6 dark:border-zinc-800 dark:bg-zinc-950/80">
      <AssistantAvatar />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="font-display text-[15px] font-semibold tracking-tight">Assistant</h1>
          {props.unread > 0 && <span className="chip bg-violet-600 text-white">{props.unread} new</span>}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <span className={`size-1.5 rounded-full ${DOT[status.tone]}`} aria-hidden />
          <span className="truncate">{status.text}</span>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <button type="button" className="btn-ghost px-2 xl:hidden" onClick={props.onOpenPanel} aria-label="Today, automations, and connections">
          <PanelRight className="size-4.5" aria-hidden />
        </button>
        <button type="button" className="btn-ghost px-2" onClick={props.onOpenSettings} aria-label="Settings">
          <Settings className="size-4.5" aria-hidden />
        </button>
        {account && (
          <div className="ml-1 flex items-center gap-2" title={`Signed in to Managed Copilot as @${account.login}`}>
            {account.avatarUrl ? (
              <img src={account.avatarUrl} alt="" className="size-8 rounded-full ring-1 ring-zinc-200 dark:ring-zinc-700" />
            ) : (
              <div className="grid size-8 place-items-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {account.login.slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>
        )}
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
  let content: { tone: "error" | "warn"; icon: typeof CircleAlert; title: string; body?: string; action?: { label: string; run(): void } } | undefined;

  if (props.stream === "reconnecting") {
    content = { tone: "warn", icon: Unplug, title: "Lost the connection to the assistant server", body: "Retrying automatically. If it doesn't come back, check that the assistant is still running." };
  } else if (platform && platform.state !== "ready" && platform.state !== "connecting") {
    const retry = platform.retryAt ? ` Retrying ${relativeTime(platform.retryAt)}.` : "";
    if (platform.state === "unauthenticated") {
      content = { tone: "error", icon: KeyRound, title: "Sign in to GitHub", body: `${platform.message ?? "The assistant needs your GitHub sign-in."} Run \`gh auth login\`, then retry.${retry}`, action: { label: "Retry", run: props.onRetry } };
    } else if (platform.state === "misconfigured") {
      content = { tone: "error", icon: TriangleAlert, title: "This deployment isn't set up for the assistant", body: platform.message, action: { label: "Retry", run: props.onRetry } };
    } else {
      content = {
        tone: "error",
        icon: CircleAlert,
        title: "Can't reach Managed Copilot",
        body: `${platform.message ?? "The platform isn't responding."} Start it with \`aspire run\`.${retry}`,
        action: { label: "Retry now", run: props.onRetry },
      };
    }
  } else if (conversation?.attach === "error") {
    content = { tone: "error", icon: CircleAlert, title: "Couldn't open your conversation", body: conversation.error, action: { label: "Try again", run: props.onRetry } };
  } else if (platform?.state === "ready" && platform.message) {
    content = { tone: "warn", icon: TriangleAlert, title: "Limited functionality", body: platform.message };
  } else if (props.googleNeedsReconnect) {
    content = { tone: "warn", icon: KeyRound, title: "Google access expired", body: "Reconnect Google so your assistant can read mail and manage your calendar.", action: { label: "Reconnect", run: props.onReconnectGoogle } };
  }
  if (!content) return null;
  const Icon = content.icon;
  const tone =
    content.tone === "error"
      ? "bg-red-50 text-red-900 ring-red-200 dark:bg-red-500/10 dark:text-red-100 dark:ring-red-500/25"
      : "bg-amber-50 text-amber-950 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-100 dark:ring-amber-500/25";
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-3 sm:px-6">
      <div className={`flex items-start gap-3 rounded-xl px-3.5 py-2.5 text-sm ring-1 ${tone}`} role="status">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{content.title}</div>
          {content.body && <div className="mt-0.5 break-words opacity-90">{renderInlineCode(content.body)}</div>}
        </div>
        {content.action && (
          <button type="button" className="btn-secondary shrink-0 py-1 text-xs" onClick={content.action.run}>
            <RefreshCw className="size-3.5" aria-hidden />
            {content.action.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** Renders `code` spans in short status messages. */
export function renderInlineCode(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={index} className="rounded bg-black/5 px-1 py-px font-mono text-[12px] dark:bg-white/10">
        {part.slice(1, -1)}
      </code>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}
