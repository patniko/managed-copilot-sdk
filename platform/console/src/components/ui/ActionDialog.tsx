import { CircleAlert, ShieldAlert, TriangleAlert } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toApiError } from "../../lib/errors.js";
import { closeGuardedAction, useGuardedAction } from "../../lib/guarded.js";
import { refreshActive } from "../../lib/poll.js";
import { toast } from "../../lib/toast.js";
import { Button } from "./Button.js";

/**
 * Host for guarded operator actions. Confirming runs the action; success closes the dialog with the gateway's message
 * in a toast; a failure shows the gateway's message in a toast and keeps the dialog (and any typed reason) open.
 */
export function ActionDialog() {
  const request = useGuardedAction();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setReason("");
    setBusy(false);
    setError(undefined);
  }, [request?.id]);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (request && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    }
    if (!request && element.open) {
      element.close();
      const target = opener.current;
      opener.current = null;
      if (target?.isConnected) target.focus();
    }
  }, [request]);

  const cancel = (): void => {
    if (!busy && request) closeGuardedAction(request.id);
  };

  const confirm = async (): Promise<void> => {
    if (!request || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await request.run(request.reason ? reason.trim() || undefined : undefined);
      toast.success(request.successTitle, result?.message ?? request.fallbackMessage);
      closeGuardedAction(request.id);
      request.onDone?.();
      refreshActive();
    } catch (caught) {
      const failure = toApiError(caught);
      toast.error(request.failureTitle, failure.message);
      setError(failure.message);
      setBusy(false);
    }
  };

  const danger = request?.tone === "danger";
  const Icon = danger ? TriangleAlert : ShieldAlert;
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
      className="m-auto w-[min(480px,calc(100vw-2rem))] animate-rise-in rounded-2xl border border-zinc-700/70 bg-zinc-900 p-0 text-zinc-200 shadow-2xl shadow-black/60 backdrop:animate-fade-in"
    >
      {request ? (
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <div className="flex gap-3.5">
            <div
              className={
                danger
                  ? "grid size-9 shrink-0 place-items-center rounded-xl bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-400/25"
                  : "grid size-9 shrink-0 place-items-center rounded-xl bg-amber-400/10 text-amber-300 ring-1 ring-inset ring-amber-400/25"
              }
            >
              <Icon className="size-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold text-zinc-100">
                {request.title}
              </h2>
              <div id={descriptionId} className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
                {request.description}
              </div>
            </div>
          </div>
          {request.reason ? (
            <div className="mt-4">
              <label htmlFor={reasonId} className="text-[12px] font-medium text-zinc-300">
                {request.reason.label} <span className="font-normal text-zinc-500">(optional)</span>
              </label>
              <textarea
                id={reasonId}
                value={reason}
                autoFocus
                rows={3}
                maxLength={request.reason.maxLength ?? 500}
                placeholder={request.reason.placeholder}
                onChange={(event) => setReason(event.target.value)}
                className="mt-1.5 block w-full resize-y rounded-lg bg-zinc-950 px-3 py-2 text-[13px] text-zinc-200 ring-1 ring-inset ring-white/10 placeholder:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70"
              />
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="mt-4 flex gap-2 rounded-lg border border-rose-400/30 bg-rose-400/[0.07] px-3 py-2 text-[13px] text-rose-100">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-300" aria-hidden />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={cancel} disabled={busy} autoFocus={!request.reason}>
              Cancel
            </Button>
            <Button type="submit" variant={danger ? "danger-solid" : "primary"} loading={busy}>
              {error ? "Try again" : request.confirmLabel}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
