import { Bell, Check, Copy, Monitor, Moon, ShieldAlert, ShieldCheck, Sun, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "../../../shared/protocol";
import { getTheme, setTheme, type Theme } from "../theme";
import type { AssistantActions } from "../useAssistant";

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  if (!zones.includes(current)) zones = [current, ...zones];
  return zones;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-3 py-2 text-sm">
      <div className="text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function SettingsDialog({ snapshot, onClose, onOpenBackground, actions }: { snapshot?: Snapshot; onClose(): void; onOpenBackground(): void; actions: AssistantActions }) {
  const timeZone = snapshot?.settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = useMemo(() => timeZones(timeZone), [timeZone]);
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const [copied, setCopied] = useState(false);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [confirming, setConfirming] = useState<"armed" | "busy" | undefined>();
  const [turningOff, setTurningOff] = useState<"armed" | "busy" | undefined>();
  const background = snapshot?.background;
  const ready = snapshot?.platform.state === "ready";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sessionId = snapshot?.conversation.sessionId;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-950/40 p-0 backdrop-blur-sm sm:items-center sm:p-6" onMouseDown={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="w-full max-w-lg animate-rise rounded-t-2xl bg-white p-5 shadow-xl ring-1 ring-zinc-200 sm:rounded-2xl dark:bg-zinc-900 dark:ring-zinc-800"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center">
          <h2 id="settings-title" className="font-display text-lg font-semibold">
            Settings
          </h2>
          <button type="button" className="btn-ghost ml-auto px-2" onClick={onClose} aria-label="Close settings">
            <X className="size-4.5" aria-hidden />
          </button>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          <Row label="Appearance">
            <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800" role="radiogroup" aria-label="Appearance">
              {THEMES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={theme === value}
                  onClick={() => {
                    setTheme(value);
                    setThemeState(value);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    theme === value ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50" : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Time zone">
            <select
              className="w-full rounded-lg bg-zinc-50 px-2.5 py-1.5 text-sm ring-1 ring-zinc-200 outline-none focus:ring-violet-400 dark:bg-zinc-800 dark:ring-zinc-700"
              value={timeZone}
              onChange={(event) => void actions.setTimeZone(event.target.value)}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Notifications">
            {permission === "granted" ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <Check className="size-4" aria-hidden /> On for this browser
              </span>
            ) : permission === "unsupported" ? (
              <span className="text-zinc-500">Not supported in this browser</span>
            ) : permission === "denied" ? (
              <span className="text-zinc-500">Blocked in your browser's site settings</span>
            ) : (
              <button
                type="button"
                className="btn-secondary"
                onClick={async () => {
                  const result = await Notification.requestPermission();
                  setPermission(result);
                  if (result === "granted") actions.toast("success", "You'll be notified when your assistant has something for you");
                }}
              >
                <Bell className="size-4" aria-hidden /> Notify me about reminders
              </button>
            )}
          </Row>
          <Row label="Signed in as">
            <span className="font-medium">{snapshot?.account ? `@${snapshot.account.login}` : "—"}</span>
            <span className="text-zinc-500"> (GitHub)</span>
          </Row>
          <Row label="Background work">
            <div data-testid="settings-background" data-state={background?.state ?? "unknown"}>
              {background?.state === "on" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                    <ShieldCheck className="size-4" aria-hidden /> On{background.login ? ` · runs as @${background.login}` : ""}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary ml-auto px-2.5 py-1 text-xs"
                    disabled={!ready || turningOff === "busy"}
                    onClick={async () => {
                      if (turningOff !== "armed") {
                        setTurningOff("armed");
                        return;
                      }
                      setTurningOff("busy");
                      await actions.disableBackground();
                      setTurningOff(undefined);
                    }}
                  >
                    {turningOff === "armed" ? "Confirm turn off" : turningOff === "busy" ? "Turning off…" : "Turn off"}
                  </button>
                  {turningOff === "armed" && (
                    <p className="w-full text-xs text-zinc-500 dark:text-zinc-400">
                      Your reminders and automations on this deployment pause until you turn it back on.
                    </p>
                  )}
                </div>
              ) : background?.state === "off" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                    <ShieldAlert className="size-4" aria-hidden /> Off
                  </span>
                  <button type="button" className="btn-secondary ml-auto px-2.5 py-1 text-xs" onClick={onOpenBackground}>
                    Turn on…
                  </button>
                </div>
              ) : background?.state === "unavailable" ? (
                <span className="text-zinc-500">Not available on this deployment</span>
              ) : background?.state === "error" ? (
                <span className="text-zinc-500" title={background.error}>
                  Couldn't check
                </span>
              ) : (
                <span className="text-zinc-500">Checking…</span>
              )}
            </div>
          </Row>
          <Row label="Platform">
            <span className="block truncate">{snapshot?.platform.url ?? "Not connected"}</span>
            <span className="text-xs text-zinc-500">
              Environment <code>{snapshot?.platform.environment}</code>
              {snapshot?.platform.deployment ? ` · ${snapshot.platform.deployment.mode} · v${snapshot.platform.deployment.version}` : ""}
            </span>
          </Row>
          <Row label="Model">
            <code className="text-[13px]">{snapshot?.conversation.model}</code>
          </Row>
          <Row label="Conversation">
            {sessionId ? (
              <button
                type="button"
                className="inline-flex max-w-full items-center gap-1.5 truncate rounded-md bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700"
                title="Copy the session ID (attach with: npx managed-copilot attach <id>)"
                onClick={() => {
                  void navigator.clipboard.writeText(sessionId).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? <Check className="size-3.5 shrink-0" aria-hidden /> : <Copy className="size-3.5 shrink-0" aria-hidden />}
                <span className="truncate">{sessionId}</span>
              </button>
            ) : (
              <span className="text-zinc-500">Starts with your first message</span>
            )}
          </Row>
        </div>
        <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
          Your conversation lives on Managed Copilot and survives restarts of this app and the platform. Open it in a terminal with{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">npx managed-copilot attach</code>.
        </p>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-zinc-50 px-3 py-2.5 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:ring-zinc-700">
          <div className="text-xs text-zinc-600 dark:text-zinc-400">
            <div className="font-semibold text-zinc-800 dark:text-zinc-200">Start a new conversation</div>
            Your assistant forgets this chat, and its reminders and automations are deleted.
          </div>
          <button
            type="button"
            className="btn-secondary shrink-0 text-red-600 ring-red-200 hover:bg-red-50 dark:text-red-400 dark:ring-red-900 dark:hover:bg-red-950"
            disabled={confirming === "busy"}
            onClick={async () => {
              if (confirming !== "armed") {
                setConfirming("armed");
                return;
              }
              setConfirming("busy");
              await actions.startOver();
              setConfirming(undefined);
              onClose();
            }}
          >
            {confirming === "armed" ? "Confirm" : confirming === "busy" ? "Starting…" : "Start over"}
          </button>
        </div>
      </div>
    </div>
  );
}
