import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";

/** A modal question with one confirming action. */
export function ConfirmDialog({
  title,
  children,
  confirm,
  danger = false,
  onConfirm,
  onCancel,
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly confirm: string;
  readonly danger?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="Dialog Dialog--medium animate-scale-in backdrop:bg-backdrop"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="Dialog-header">
        <div className="Dialog-headerContent">
          <h2 id="confirm-title" className="Dialog-title">
            {title}
          </h2>
        </div>
      </div>
      {children ? <div className="Dialog-body text-sm text-fg-muted">{children}</div> : null}
      <div className="Dialog-footer">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={cx("btn", danger ? "btn-danger" : "btn-primary")} onClick={onConfirm} autoFocus>
          {confirm}
        </button>
      </div>
    </dialog>
  );
}
