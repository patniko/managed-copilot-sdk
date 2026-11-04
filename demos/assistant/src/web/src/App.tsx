import { CloudOfflineIcon, XIcon } from "@primer/octicons-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Banner, Header, statusOf } from "./components/Header";
import { EmptyState, LoadingState } from "./components/EmptyState";
import { Composer } from "./components/Composer";
import { Rail, RailSkeleton } from "./components/Rail";
import { SettingsDialog } from "./components/Settings";
import { Timeline } from "./components/Timeline";
import { Toasts } from "./components/Toasts";
import { useModal } from "./components/ui";
import { isUnread, useAssistant } from "./useAssistant";

const GOOGLE_RESULTS: Record<string, { tone: "success" | "error" | "info"; text: string }> = {
  connected: { tone: "success", text: "Google connected. Your assistant now uses your Gmail and Calendar." },
  partial: { tone: "info", text: "Google connected, but some access wasn't granted. Reconnect to allow mail and calendar." },
  denied: { tone: "info", text: "Google wasn't connected. You can keep using the demo workspace." },
  expired: { tone: "error", text: "That Google sign-in link expired. Try connecting again." },
  not_configured: { tone: "error", text: "Google sign-in isn't configured on this server." },
  failed: { tone: "error", text: "Google sign-in didn't complete. Check the server log and try again." },
};

/** The side panel sits beside the chat from this width; below it, it opens as a drawer from the header's menu button. */
const WIDE = "(min-width: 1024px)";
const TITLE = "Assistant · Managed Copilot";

/** Whether a media query matches, kept current as the window changes. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** The side panel on narrow screens: a drawer from the left with a scrim, like github.com's mobile navigation. */
function Drawer({ onClose, children }: { onClose(): void; children: ReactNode }) {
  const panel = useModal<HTMLDivElement>(true, onClose);
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="absolute inset-0 animate-fade-in bg-backdrop" onMouseDown={onClose} aria-hidden />
      <div
        ref={panel}
        id="side-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="side-panel-title"
        className="absolute inset-y-0 left-0 flex w-[min(20rem,calc(100vw-3rem))] animate-slide-in-left flex-col rounded-r-lg bg-canvas-inset shadow-xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line py-2 pr-2 pl-4">
          <h2 id="side-panel-title" className="flex-1 font-semibold">
            Your day
          </h2>
          <button type="button" className="btn btn-invisible btn-icon" onClick={onClose} aria-label="Close panel">
            <XIcon />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export function App({ preview }: { preview?: ReactNode }) {
  const { state, actions } = useAssistant();
  const { snapshot, items, pending, stream } = state;
  const timeZone = snapshot?.settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The side panel is mounted once: beside the chat on wide screens, or in the drawer, so its element IDs are unique.
  const wide = useMediaQuery(WIDE);
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
    params.delete("google");
    const rest = params.toString();
    window.history.replaceState(null, "", rest ? `/?${rest}` : "/");
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
  const conversationLive = snapshot?.conversation.attach === "live";

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${TITLE}` : TITLE;
  }, [unread]);

  useEffect(() => {
    const latest = items[items.length - 1];
    // Only the live conversation counts (a reopened tab first shows the cached one), and only after a moment in view,
    // so jumping to "New since you were away" doesn't mark everything below it read.
    if (!seeing || !conversationLive || pendingUnread === 0 || !latest || markedAt.current === latest.at) return;
    const timer = setTimeout(() => {
      markedAt.current = latest.at;
      actions.markRead(latest.at);
    }, 800);
    return () => clearTimeout(timer);
  }, [seeing, conversationLive, pendingUnread, items, actions]);

  const openSchedule = useCallback((id: string) => {
    setHighlight(id);
    if (!window.matchMedia(WIDE).matches) setPanelOpen(true);
    setTimeout(() => document.getElementById(`schedule-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    setTimeout(() => setHighlight(undefined), 2600);
  }, []);

  const backgroundOff = snapshot?.background?.state === "off";
  /** Shows the background-work card (with its consent copy), the one place it can be turned on. */
  const openBackground = useCallback(() => {
    setHighlight("background");
    if (!window.matchMedia(WIDE).matches) setPanelOpen(true);
    setTimeout(() => document.getElementById("background-work")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    setTimeout(() => setHighlight(undefined), 2600);
  }, []);

  const sandboxes = snapshot?.sandboxes;
  const [highlightCard, setHighlightCard] = useState<string>();
  /** Shows a sandbox's latest card in the chat (from the side panel). */
  const openSandbox = useCallback(
    (workerId: string) => {
      const runs = Object.entries(sandboxes?.runs ?? {}).filter(([, run]) => run.workerId === workerId);
      const latest = runs.sort(([, a], [, b]) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).pop()?.[0];
      if (!latest) return;
      setPanelOpen(false);
      setHighlightCard(latest);
      setTimeout(() => document.getElementById(`sandbox-card-${latest}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
      setTimeout(() => setHighlightCard(undefined), 2600);
    },
    [sandboxes],
  );

  const platform = snapshot?.platform;
  const conversation = snapshot?.conversation;
  const status = statusOf(stream, platform, conversation);
  const live = stream === "open" && platform?.state === "ready" && conversation?.attach === "live";
  const platformDown = platform !== undefined && platform.state !== "ready" && platform.state !== "connecting";
  const loading = !snapshot || (!platformDown && items.length === 0 && pending.length === 0 && conversation?.attach !== "live" && conversation?.attach !== "error");
  const disabledReason = platformDown ? "Managed Copilot isn't reachable" : conversation?.attach === "error" ? "Couldn't open the conversation" : "Connecting to your assistant…";
  const demo = snapshot?.connections.provider !== "google";

  const rail = !snapshot ? (
    <RailSkeleton />
  ) : (
    <Rail
      agenda={snapshot?.agenda}
      schedules={snapshot?.schedules ?? []}
      schedulesError={snapshot?.schedulesError}
      offline={snapshot?.offline}
      background={snapshot?.background}
      account={snapshot?.account}
      platform={platform}
      connections={snapshot?.connections}
      sandboxes={sandboxes}
      timeZone={timeZone}
      highlightSchedule={highlight}
      actions={actions}
      onOpenSandbox={openSandbox}
      onOpenSettings={() => {
        setPanelOpen(false);
        setSettingsOpen(true);
      }}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <Header
        status={status}
        platform={platform}
        conversation={conversation}
        account={snapshot?.account}
        sandboxes={sandboxes}
        offline={snapshot?.offline}
        unread={unread}
        panelAttention={backgroundOff ? "Background work is off" : undefined}
        panelOpen={panelOpen && !wide}
        preview={preview}
        onOpenPanel={() => (backgroundOff ? openBackground() : setPanelOpen(true))}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        {wide && (
          <aside className="w-80 shrink-0 overflow-y-auto border-r border-line bg-canvas-inset p-4" aria-label="Today, automations, and connections">
            {rail}
          </aside>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <Banner
            stream={stream}
            platform={platform}
            conversation={conversation}
            googleNeedsReconnect={snapshot?.connections.google.status === "needs_reconnect"}
            onRetry={() => void actions.retry()}
            onReconnectGoogle={() => void actions.connectGoogle()}
          />
          {platformDown && items.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-4">
              <div className="blankslate blankslate--narrow">
                <CloudOfflineIcon size={24} className="blankslate-icon" />
                <h2 className="blankslate-heading">Waiting for Managed Copilot</h2>
                <p className="blankslate-description">Your conversation appears once the platform is reachable.</p>
              </div>
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
              sandboxes={sandboxes}
              highlightCard={highlightCard}
              empty={
                <EmptyState
                  name={snapshot?.account?.name}
                  login={snapshot?.account?.login}
                  timeZone={timeZone}
                  demo={demo}
                  background={snapshot?.background}
                  sandboxes={sandboxes?.enabled ?? false}
                  onPick={(text) => void actions.send(text)}
                  onNeedBackground={() => {
                    openBackground();
                    actions.toast("info", "Turn on background work first, so reminders can run while you're away.");
                  }}
                />
              }
              onDecide={(id, decision, feedback) => actions.decide(id, decision, feedback)}
              onRetry={(message) => void actions.retrySend(message)}
              onDiscard={actions.discard}
              onOpenSchedule={openSchedule}
              onOpenBackground={backgroundOff ? openBackground : undefined}
              onAtBottomChange={setAtBottom}
            />
          )}
          <Composer
            disabled={!live}
            disabledReason={disabledReason}
            busy={conversation?.busy ?? false}
            hint={sandboxes?.enabled ? "Asks before sending, booking, or starting sandboxes" : undefined}
            onSend={(text) => void actions.send(text)}
            onStop={() => void actions.abort()}
          />
        </main>
      </div>

      {panelOpen && !wide && <Drawer onClose={() => setPanelOpen(false)}>{rail}</Drawer>}

      {settingsOpen && (
        <SettingsDialog
          snapshot={snapshot}
          onClose={() => setSettingsOpen(false)}
          onOpenBackground={() => {
            setSettingsOpen(false);
            openBackground();
          }}
          actions={actions}
        />
      )}
      <Toasts toasts={state.toasts} onDismiss={actions.dismissToast} />
    </div>
  );
}
