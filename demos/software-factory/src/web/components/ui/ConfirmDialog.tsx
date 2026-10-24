import { TriangleAlert } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useConfirmRequest } from "../../lib/confirm.js";
import { Button } from "./Button.js";

/** Host for `confirmAction()`; a native modal dialog (focus trap, Esc to cancel). */
export function ConfirmDialog() {
  const request = useConfirmRequest();
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (request && !element.open) element.showModal();
    if (!request && element.open) element.close();
  }, [request]);

  const danger = request?.tone === "danger";
  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-title"
      aria-describedby={request?.message ? "confirm-message" : undefined}
      onCancel={(event) => {
        event.preventDefault();
        request?.resolve(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) request?.resolve(false);
      }}
      className="m-auto w-[min(440px,calc(100vw-2rem))] animate-rise-in rounded-2xl border border-zinc-700/70 bg-zinc-900 p-0 text-zinc-200 shadow-2xl shadow-black/60 backdrop:animate-fade-in"
    >
      {request ? (
        <div className="p-5">
          <div className="flex gap-3.5">
            {danger ? (
              <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-400/25">
                <TriangleAlert className="size-4" aria-hidden />
              </div>
            ) : null}
            <div className="min-w-0">
              <h2 id="confirm-title" className="text-base font-semibold text-zinc-100">
                {request.title}
              </h2>
              {request.message ? (
                <p id="confirm-message" className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
                  {request.message}
                </p>
              ) : null}
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => request.resolve(false)}>
              {request.cancelLabel ?? "Cancel"}
            </Button>
            <Button variant={danger ? "danger-solid" : "primary"} onClick={() => request.resolve(true)}>
              {request.confirmLabel ?? "Confirm"}
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
