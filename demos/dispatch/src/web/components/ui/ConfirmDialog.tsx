import { XIcon } from "@primer/octicons-react";
import { useLayoutEffect, useRef } from "react";
import { useConfirmRequest } from "../../lib/confirm.js";
import { Button } from "./Button.js";

/** Host for `confirmAction()`: a Primer dialog on the native modal `<dialog>` (focus trap, Esc to cancel). */
export function ConfirmDialog() {
  const request = useConfirmRequest();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (request && !element.open) {
      element.showModal();
      // Start on the safe choice, like GitHub's confirmation dialogs.
      cancel.current?.focus();
    }
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
      className="Dialog Dialog--medium animate-scale-in backdrop:animate-fade-in"
    >
      {request ? (
        <>
          <div className="Dialog-header">
            <div className="Dialog-headerContent">
              <h2 id="confirm-title" className="Dialog-title">
                {request.title}
              </h2>
            </div>
            <button type="button" className="btn btn-invisible btn-icon" aria-label="Close" onClick={() => request.resolve(false)}>
              <XIcon size={16} />
            </button>
          </div>
          {request.message ? (
            <div className="Dialog-body">
              <p id="confirm-message">{request.message}</p>
            </div>
          ) : null}
          <div className="Dialog-footer">
            <Button ref={cancel} onClick={() => request.resolve(false)}>
              {request.cancelLabel ?? "Cancel"}
            </Button>
            <Button variant={danger ? "danger" : "primary"} onClick={() => request.resolve(true)}>
              {request.confirmLabel ?? "Confirm"}
            </Button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
