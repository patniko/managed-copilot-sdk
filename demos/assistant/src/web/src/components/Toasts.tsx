import { CheckIcon, InfoIcon, StopIcon, XIcon } from "@primer/octicons-react";
import type { Toast } from "../useAssistant";
import { cx } from "./ui";

const TONES = {
  success: { className: "Toast--success", icon: CheckIcon },
  error: { className: "Toast--error", icon: StopIcon },
  info: { className: "", icon: InfoIcon },
} as const;

/** Primer toasts: bottom-left on desktop like github.com, above the message box on phones. */
export function Toasts({ toasts, onDismiss }: { toasts: readonly Toast[]; onDismiss(id: number): void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex flex-col items-center gap-2 px-4 lg:inset-x-auto lg:bottom-4 lg:left-4 lg:items-start lg:px-0" aria-live="polite">
      {toasts.map((toast) => {
        const tone = TONES[toast.tone];
        return (
          <div key={toast.id} className={cx("Toast pointer-events-auto animate-slide-up", tone.className)}>
            <span className="Toast-icon">
              <tone.icon />
            </span>
            <span className="Toast-content">{toast.text}</span>
            <button type="button" className="Toast-dismissButton" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
              <XIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
