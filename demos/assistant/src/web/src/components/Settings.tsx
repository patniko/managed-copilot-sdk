import { AlertIcon, BellIcon, CheckCircleFillIcon, CheckIcon, CopyIcon, XIcon } from "@primer/octicons-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import type { Snapshot } from "../../../shared/protocol";
import { setTheme, useTheme } from "../theme";
import type { AssistantActions } from "../useAssistant";
import { THEMES } from "./Header";
import { Spinner, useModal } from "./ui";

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

/** A settings row: label and caption, with its control beside them (below them on phones). */
function SettingRow({ label, labelId, caption, children }: { label: string; labelId?: string; caption?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div id={labelId} className="FormControl-label">
          {label}
        </div>
        {caption && <div className="FormControl-caption">{caption}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="Box-row flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3">
      <dt className="w-28 shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

export function SettingsDialog({ snapshot, onClose, onOpenBackground, actions }: { snapshot?: Snapshot; onClose(): void; onOpenBackground(): void; actions: AssistantActions }) {
  const timeZone = snapshot?.settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = useMemo(() => timeZones(timeZone), [timeZone]);
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const [copied, setCopied] = useState(false);
  const theme = useTheme();
  const [confirming, setConfirming] = useState<"armed" | "busy" | undefined>();
  const [turningOff, setTurningOff] = useState<"armed" | "busy" | undefined>();
  const background = snapshot?.background;
  const ready = snapshot?.platform.state === "ready";
  const dialog = useModal<HTMLDialogElement>(true, onClose);
  const ids = { theme: useId(), zone: useId(), background: useId(), backgroundCaption: useId() };
  const sessionId = snapshot?.conversation.sessionId;
  const backgroundOn = background?.state === "on";

  const backgroundCaption =
    background?.state === "on"
      ? `On${background.login ? `, runs as @${background.login}` : ""}. Reminders and automations keep running while this tab is closed.`
      : background?.state === "off"
        ? "Off. Reminders and automations can't run while this tab is closed."
        : background?.state === "unavailable"
          ? "Not available on this deployment."
          : background?.state === "error"
            ? "Couldn't check whether it's on."
            : "Checking…";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 animate-fade-in bg-backdrop" onMouseDown={onClose} aria-hidden />
      <dialog
        open
        ref={dialog}
        aria-modal="true"
        aria-labelledby="settings-title"
        className="Dialog relative animate-scale-in max-sm:mb-0 max-sm:max-h-[90dvh] max-sm:w-full max-sm:rounded-b-none"
      >
        <div className="Dialog-header">
          <div className="Dialog-headerContent">
            <h2 id="settings-title" className="Dialog-title">
              Settings
            </h2>
          </div>
          <button type="button" className="btn btn-invisible btn-icon" onClick={onClose} aria-label="Close settings">
            <XIcon />
          </button>
        </div>
        <div className="Dialog-body space-y-5">
          <div className="FormControl">
            <span id={ids.theme} className="FormControl-label">
              Theme
            </span>
            <div className="SegmentedControl self-start" role="radiogroup" aria-labelledby={ids.theme}>
              {THEMES.map(({ value, label, icon: Icon }) => (
                <button key={value} type="button" role="radio" aria-checked={theme === value} className="SegmentedControl-item" onClick={() => setTheme(value)}>
                  <Icon />
                  {label}
                </button>
              ))}
            </div>
            <span className="FormControl-caption">System matches your operating system's light or dark setting.</span>
          </div>

          <div className="FormControl">
            <label htmlFor={ids.zone} className="FormControl-label">
              Time zone
            </label>
            <select id={ids.zone} className="form-select input-block" value={timeZone} onChange={(event) => void actions.setTimeZone(event.target.value)}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <span className="FormControl-caption">Your calendar, reminders, and the times in this chat use it.</span>
          </div>

          <div className="border-t border-line-muted pt-5">
            <SettingRow label="Notifications" caption="A browser notification when your assistant has something for you and this tab is in the background.">
              {permission === "granted" ? (
                <span className="inline-flex items-center gap-1.5 text-fg-success">
                  <CheckCircleFillIcon /> On for this browser
                </span>
              ) : permission === "unsupported" ? (
                <span className="text-fg-muted">Not supported in this browser</span>
              ) : permission === "denied" ? (
                <span className="text-fg-muted">Blocked in your browser's site settings</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    const result = await Notification.requestPermission();
                    setPermission(result);
                    if (result === "granted") actions.toast("success", "You'll be notified when your assistant has something for you");
                  }}
                >
                  <BellIcon /> Notify me about reminders
                </button>
              )}
            </SettingRow>
          </div>

          <div data-testid="settings-background" data-state={background?.state ?? "unknown"}>
            <SettingRow label="Background work" labelId={ids.background} caption={<span id={ids.backgroundCaption}>{backgroundCaption}</span>}>
              {turningOff === "busy" && <Spinner size={16} className="text-fg-muted" />}
              <span className="text-xs font-semibold text-fg-muted" aria-hidden>
                {backgroundOn ? "On" : "Off"}
              </span>
              <button
                type="button"
                role="switch"
                className="ToggleSwitch"
                aria-checked={backgroundOn}
                aria-labelledby={ids.background}
                aria-describedby={ids.backgroundCaption}
                disabled={!ready || turningOff === "busy" || !(background?.state === "on" || background?.state === "off")}
                title={background?.state === "error" ? background.error : undefined}
                onClick={() => {
                  // Turning it on shows what it means first (the consent card in the side panel); turning it off asks to confirm.
                  if (backgroundOn) setTurningOff("armed");
                  else onOpenBackground();
                }}
              />
            </SettingRow>
            {turningOff === "armed" && (
              <div className="flash flash-sm flash-warn mt-3 flex-wrap">
                <AlertIcon />
                <div className="flash-content">Your reminders and automations on this deployment pause until you turn it back on.</div>
                <div className="flash-actions">
                  <button type="button" className="btn btn-sm" autoFocus onClick={() => setTurningOff(undefined)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      setTurningOff("busy");
                      await actions.disableBackground();
                      setTurningOff(undefined);
                    }}
                  >
                    Turn off
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-line-muted pt-5">
            <dl className="Box text-sm">
              <Detail label="Signed in as">
                {snapshot?.account ? (
                  <span className="inline-flex items-center gap-2">
                    {snapshot.account.avatarUrl && <img src={snapshot.account.avatarUrl} alt="" className="avatar size-5" />}
                    <span className="font-semibold">@{snapshot.account.login}</span>
                    <span className="text-fg-muted">on GitHub</span>
                  </span>
                ) : (
                  "—"
                )}
              </Detail>
              <Detail label="Platform">
                <span className="block truncate">{snapshot?.platform.url ?? "Not connected"}</span>
                <span className="text-xs text-fg-muted">
                  Environment <code className="font-mono">{snapshot?.platform.environment}</code>
                  {snapshot?.platform.deployment ? ` · ${snapshot.platform.deployment.mode} · v${snapshot.platform.deployment.version}` : ""}
                </span>
              </Detail>
              <Detail label="Model">
                <code className="font-mono text-xs">{snapshot?.conversation.model}</code>
              </Detail>
              <Detail label="Conversation">
                {sessionId ? (
                  <button
                    type="button"
                    className="btn btn-sm max-w-full justify-start font-mono text-xs"
                    title="Copy the session ID (attach with: npx managed-copilot attach <id>)"
                    onClick={() => {
                      void navigator.clipboard.writeText(sessionId).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      });
                    }}
                  >
                    {copied ? <CheckIcon className="text-fg-success" /> : <CopyIcon />}
                    <span className="truncate">{sessionId}</span>
                  </button>
                ) : (
                  <span className="text-fg-muted">Starts with your first message</span>
                )}
              </Detail>
            </dl>
            <p className="mt-2 text-xs text-fg-muted">
              Your conversation lives on Managed Copilot and survives restarts of this app and the platform. Open it in a terminal with{" "}
              <code className="rounded-md bg-neutral-muted px-1 py-0.5 font-mono">npx managed-copilot attach</code>.
            </p>
          </div>

          <div>
            <h3 className="mb-2 font-semibold">Danger zone</h3>
            <div className="Box Box--danger flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="font-semibold">Start a new conversation</div>
                <div className="text-xs text-fg-muted">Your assistant forgets this chat, and its reminders and automations are deleted.</div>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-danger shrink-0 self-start sm:self-auto"
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
                {confirming === "busy" && <Spinner />}
                {confirming === "armed" ? "Confirm" : confirming === "busy" ? "Starting…" : "Start over"}
              </button>
            </div>
          </div>
        </div>
      </dialog>
    </div>
  );
}
