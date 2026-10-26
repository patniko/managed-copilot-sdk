import { CheckIcon, InfoIcon, StopIcon, XIcon } from "@primer/octicons-react";
import { cx } from "../../lib/cx.js";
import { dismissToast, holdToast, releaseToast, useToasts, type ToastTone } from "../../lib/toast.js";

const ICONS = { info: InfoIcon, success: CheckIcon, error: StopIcon } as const;

const VARIANTS: Readonly<Record<ToastTone, string>> = {
  info: "",
  success: "Toast--success",
  error: "Toast--error",
};

/** Primer toasts, stacked in the bottom-left corner like github.com's. */
export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-50 flex flex-col gap-2" aria-live="polite">
      {toasts.map((item) => {
        const ToastIcon = ICONS[item.tone];
        return (
          <div
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
            onMouseEnter={() => holdToast(item.id)}
            onMouseLeave={() => releaseToast(item.id)}
            onFocus={() => holdToast(item.id)}
            onBlur={() => releaseToast(item.id)}
            className={cx("Toast pointer-events-auto animate-slide-up", VARIANTS[item.tone])}
          >
            <span className="Toast-icon">
              <ToastIcon size={16} />
            </span>
            <div className="Toast-content">
              <p className="font-semibold">{item.title}</p>
              {item.message ? <p className="mt-1 break-words text-fg-muted">{item.message}</p> : null}
            </div>
            <button type="button" onClick={() => dismissToast(item.id)} aria-label="Dismiss notification" className="Toast-dismissButton">
              <XIcon size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
