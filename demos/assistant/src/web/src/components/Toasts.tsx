import { Check, CircleAlert, Info } from "lucide-react";
import type { Toast } from "../useAssistant";

export function Toasts({ toasts }: { toasts: readonly Toast[] }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = toast.tone === "error" ? CircleAlert : toast.tone === "success" ? Check : Info;
        const tone =
          toast.tone === "error"
            ? "bg-red-600 text-white"
            : toast.tone === "success"
              ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
              : "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900";
        return (
          <div key={toast.id} className={`pointer-events-auto flex max-w-md animate-rise items-start gap-2 rounded-xl px-3.5 py-2.5 text-sm shadow-lg ${tone}`}>
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{toast.text}</span>
          </div>
        );
      })}
    </div>
  );
}
