import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cx } from "../../lib/cx.js";
import { dismissToast, holdToast, releaseToast, useToasts, type ToastTone } from "../../lib/toast.js";

const ICONS = { info: Info, success: CircleCheck, error: CircleAlert } as const;

const ICON_COLORS: Readonly<Record<ToastTone, string>> = {
  info: "text-sky-300",
  success: "text-emerald-300",
  error: "text-rose-300",
};

const ACCENTS: Readonly<Record<ToastTone, string>> = {
  info: "before:bg-sky-400/70",
  success: "before:bg-emerald-400/70",
  error: "before:bg-rose-400/80",
};

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[80] flex w-[min(400px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((item) => {
        const Icon = ICONS[item.tone];
        return (
          <div
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
            onMouseEnter={() => holdToast(item.id)}
            onMouseLeave={() => releaseToast(item.id)}
            onFocus={() => holdToast(item.id)}
            onBlur={() => releaseToast(item.id)}
            className={cx(
              "pointer-events-auto relative flex animate-rise-in gap-3 overflow-hidden rounded-xl border border-zinc-700/70 bg-zinc-900/95 py-3 pr-2 pl-4 shadow-2xl shadow-black/50 backdrop-blur",
              "before:absolute before:inset-y-0 before:left-0 before:w-0.5",
              ACCENTS[item.tone],
            )}
          >
            <Icon className={cx("mt-0.5 size-4 shrink-0", ICON_COLORS[item.tone])} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-zinc-100">{item.title}</p>
              {item.message ? <p className="mt-0.5 text-[13px] leading-relaxed break-words text-zinc-400">{item.message}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(item.id)}
              aria-label="Dismiss notification"
              className="grid size-6 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
