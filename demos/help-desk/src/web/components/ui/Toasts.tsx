import { AlertIcon, XIcon } from "@primer/octicons-react";
import { dismissToast, useStore } from "../../lib/store.js";

/** Errors from actions on this page: one line, plus what went wrong. */
export function Toasts() {
  const toasts = useStore((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className="Toast Toast--error animate-slide-up">
          <span className="Toast-icon">
            <AlertIcon size={16} />
          </span>
          <div className="Toast-content min-w-0 text-sm">
            <div className="font-semibold">{toast.title}</div>
            {toast.detail ? <div className="mt-0.5 text-fg-muted">{toast.detail}</div> : null}
          </div>
          <button type="button" className="Toast-dismissButton" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
            <XIcon size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
