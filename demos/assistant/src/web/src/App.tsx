import { CloudOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Banner, Header, statusOf } from "./components/Header";
import { EmptyState, LoadingState } from "./components/EmptyState";
import { Composer } from "./components/Composer";
import { Rail } from "./components/Rail";
import { SettingsDialog } from "./components/Settings";
import { Timeline } from "./components/Timeline";
import { Toasts } from "./components/Toasts";
import { isUnread, useAssistant } from "./useAssistant";

const GOOGLE_RESULTS: Record<string, { tone: "success" | "error" | "info"; text: string }> = {
  connected: { tone: "success", text: "Google connected. Your assistant now uses your Gmail and Calendar." },
  partial: { tone: "info", text: "Google connected, but some access wasn't granted. Reconnect to allow mail and calendar." },
  denied: { tone: "info", text: "Google wasn't connected. You can keep using the demo workspace." },
  expired: { tone: "error", text: "That Google sign-in link expired. Try connecting again." },
  not_configured: { tone: "error", text: "Google sign-in isn't configured on this server." },
  failed: { tone: "error", text: "Google sign-in didn't complete. Check the server log and try again." },
};

export function App() {
  const { state, actions } = useAssistant();
  const { snapshot, items, pending, stream } = state;
  const timeZone = snapshot?.settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [highlight, setHighlight] = useState<string>();
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    if (!result) return;
    const message = GOOGLE_RESULTS[result] ?? GOOGLE_RESULTS.failed!;
    actions.toast(message.tone, message.text);
    window.history.replaceState(null, "", "/");
  }, [actions]);

  const lastReadAt = snapshot?.lastReadAt;
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // Messages are read once the tab is visible and scrolled to the latest one. (Focus is unreliable in embedded
  // browsers, and a visible tab is one the person can see; notifications still require focus.)
  const seeing = visible && atBottom;
  const pendingUnread = items.filter((item) => isUnread(item, lastReadAt)).length;
  const unread = seeing ? 0 : pendingUnread;
  const markedAt = useRef<string | undefined>(undefined);

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) Assistant` : "Assistant";
  }, [unread]);

  useEffect(() => {
    const latest = items[items.length - 1];
    if (!seeing || pendingUnread === 0 || !latest || markedAt.current === latest.at) return;
    markedAt.current = latest.at;
    actions.markRead(latest.at);
  }, [seeing, pendingUnread, items, actions]);

  const openSchedule = useCallback((id: string) => {
    setHighlight(id);
    if (!window.matchMedia("(min-width: 1280px)").matches) setPanelOpen(true);
    setTimeout(() => document.getElementById(`schedule-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    setTimeout(() => setHighlight(undefined), 2600);
  }, []);

  const platform = snapshot?.platform;
  const conversation = snapshot?.conversation;
  const status = statusOf(stream, platform, conversation);
  const live = stream === "open" && platform?.state === "ready" && conversation?.attach === "live";
  const platformDown = platform !== undefined && platform.state !== "ready" && platform.state !== "connecting";
  const loading = !snapshot || (!platformDown && items.length === 0 && pending.length === 0 && conversation?.attach !== "live" && conversation?.attach !== "error");
  const disabledReason = platformDown ? "Managed Copilot isn't reachable" : conversation?.attach === "error" ? "Couldn't open the conversation" : "Connecting to your assistant…";
  const demo = snapshot?.connections.provider !== "google";

  const rail = (
    <Rail
      agenda={snapshot?.agenda}
      schedules={snapshot?.schedules ?? []}
      schedulesError={snapshot?.schedulesError}
      offline={snapshot?.offline}
      platform={platform}
      connections={snapshot?.connections}
      timeZone={timeZone}
      highlightSchedule={highlight}
      actions={actions}
    />
  );

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col">
        <Header status={status} account={snapshot?.account} unread={unread} onOpenPanel={() => setPanelOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
        <Banner
          stream={stream}
          platform={platform}
          conversation={conversation}
          googleNeedsReconnect={snapshot?.connections.google.status === "needs_reconnect"}
          onRetry={() => void actions.retry()}
          onReconnectGoogle={() => void actions.connectGoogle()}
        />
        {platformDown && items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-zinc-500 dark:text-zinc-400">
            <CloudOff className="size-10 text-zinc-300 dark:text-zinc-700" aria-hidden />
            <p className="mt-3 max-w-sm text-sm">Your conversation lives on Managed Copilot. It will appear here as soon as the platform is reachable again.</p>
          </div>
        ) : loading ? (
          <div className="flex-1">
            <LoadingState />
          </div>
        ) : (
          <Timeline
            items={items}
            pending={pending}
            timeZone={timeZone}
            busy={conversation?.busy ?? false}
            unreadAnchor={state.unreadAnchor}
            empty={<EmptyState name={snapshot?.account?.name} login={snapshot?.account?.login} timeZone={timeZone} demo={demo} onPick={(text) => void actions.send(text)} />}
            onDecide={(id, decision, feedback) => actions.decide(id, decision, feedback)}
            onRetry={(message) => void actions.retrySend(message)}
            onDiscard={actions.discard}
            onOpenSchedule={openSchedule}
            onAtBottomChange={setAtBottom}
          />
        )}
        <Composer disabled={!live} disabledReason={disabledReason} busy={conversation?.busy ?? false} onSend={(text) => void actions.send(text)} onStop={() => void actions.abort()} />
      </main>

      <aside className="hidden w-[360px] shrink-0 overflow-y-auto border-l border-zinc-200/80 bg-zinc-50/60 p-4 scrollbar-thin xl:block dark:border-zinc-800 dark:bg-zinc-950">{rail}</aside>

      {panelOpen && (
        <div className="fixed inset-0 z-40 flex justify-end bg-zinc-950/40 backdrop-blur-sm xl:hidden" onMouseDown={() => setPanelOpen(false)} role="presentation">
          <div
            className="h-full w-[min(380px,92vw)] animate-rise overflow-y-auto bg-zinc-50 p-4 shadow-xl scrollbar-thin dark:bg-zinc-950"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-label="Today, automations, and connections"
          >
            <div className="mb-3 flex items-center">
              <h2 className="font-display text-base font-semibold">Your day</h2>
              <button type="button" className="btn-ghost ml-auto px-2" onClick={() => setPanelOpen(false)} aria-label="Close panel">
                <X className="size-4.5" aria-hidden />
              </button>
            </div>
            {rail}
          </div>
        </div>
      )}

      {settingsOpen && <SettingsDialog snapshot={snapshot} onClose={() => setSettingsOpen(false)} actions={actions} />}
      <Toasts toasts={state.toasts} />
    </div>
  );
}
