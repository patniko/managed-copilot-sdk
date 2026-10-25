import { X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { IconButton } from "./Button.js";

export interface DrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}

/** A modal side panel (native `<dialog>`: focus is trapped, Escape closes, focus returns to the opener). */
export function Drawer({ open, onClose, title, description, children, actions, className }: DrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (open) return;
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) target.focus();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cx(
        "fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-[min(44rem,100vw)] max-w-none animate-slide-in-right border-l border-zinc-800 bg-zinc-950 p-0 text-zinc-300 shadow-2xl shadow-black/60 backdrop:animate-fade-in",
        className,
      )}
    >
      {open ? (
        <div className="flex h-full flex-col">
          <header className="flex items-start gap-3 border-b border-zinc-800 px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold text-zinc-50">
                {title}
              </h2>
              {description ? <div className="mt-1 text-[13px] text-zinc-400">{description}</div> : null}
            </div>
            {actions}
            <IconButton icon={X} label="Close" onClick={onClose} />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}
