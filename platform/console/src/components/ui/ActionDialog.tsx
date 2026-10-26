import { AlertIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toApiError } from "../../lib/errors.js";
import { closeGuardedAction, useGuardedAction } from "../../lib/guarded.js";
import { refreshActive } from "../../lib/poll.js";
import { toast } from "../../lib/toast.js";
import { Button } from "./Button.js";

/**
 * Host for guarded operator actions, as a Primer `Dialog`. Confirming runs the action; success closes the dialog with
 * the gateway's message in a toast; a failure shows the gateway's message in a toast and keeps the dialog (and any
 * typed reason) open.
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
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

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
      // showModal() focuses the first focusable element (the header's close button); start where the work is instead.
      (request.reason ? reasonField.current : cancelButton.current)?.focus();
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
  const maxLength = request?.reason?.maxLength ?? 500;
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
      className="Dialog Dialog--medium animate-scale-in"
    >
      {request ? (
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <div className="Dialog-header">
            <div className="Dialog-headerContent">
              <h2 id={titleId} className="Dialog-title">
                {request.title}
              </h2>
            </div>
            <button type="button" onClick={cancel} disabled={busy} aria-label="Close" className="btn-octicon m-0.5">
              <XIcon size={16} />
            </button>
          </div>
          <div className="Dialog-body">
            <p id={descriptionId}>{request.description}</p>
            {request.reason ? (
              <div className="FormControl mt-4">
                <label htmlFor={reasonId} className="FormControl-label">
                  {request.reason.label} <span className="font-normal text-fg-muted">(optional)</span>
                </label>
                <textarea
                  ref={reasonField}
                  id={reasonId}
                  value={reason}
                  rows={3}
                  maxLength={maxLength}
                  placeholder={request.reason.placeholder}
                  onChange={(event) => setReason(event.target.value)}
                  className="form-control input-block resize-y"
                />
              </div>
            ) : null}
            {error ? (
              <div role="alert" className="flash flash-error mt-4">
                <AlertIcon size={16} />
                <div className="flash-content break-words">{error}</div>
              </div>
            ) : null}
          </div>
          <div className="Dialog-footer">
            <Button ref={cancelButton} onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant={danger ? "danger" : "primary"} loading={busy}>
              {error ? "Try again" : request.confirmLabel}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
