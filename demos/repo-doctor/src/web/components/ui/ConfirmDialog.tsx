import { useEffect, useRef, type ReactNode } from "react";

/** A modal confirmation (Primer Dialog on a native <dialog>): Escape or Cancel closes it. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="Dialog Dialog--narrow m-auto p-0" onClose={onClose} aria-labelledby="confirm-title">
      <div className="Dialog-header">
        <div className="Dialog-headerContent">
          <h2 id="confirm-title" className="Dialog-title">
            {title}
          </h2>
        </div>
      </div>
      <div className="Dialog-body text-sm">{children}</div>
      <div className="Dialog-footer">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
