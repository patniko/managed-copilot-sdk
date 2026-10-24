import { CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react";
import { cx } from "../lib/cx.js";
import { useStore } from "../lib/store.js";
import { InlineCode } from "./ui/Feedback.js";

const DEFAULTS = {
  connecting: "Connecting to Managed Copilot…",
  unavailable: "Managed Copilot is unavailable right now.",
  misconfigured: "The platform is reachable but isn't set up for the factory.",
} as const;

/** Explains a non-connected platform right under the top bar. */
export function PlatformBanner() {
  const platform = useStore((state) => state.platform);
  if (!platform || platform.state === "connected") return null;
  const state = platform.state;
  const Icon = state === "connecting" ? LoaderCircle : state === "misconfigured" ? TriangleAlert : CircleAlert;
  return (
    <div
      role="status"
      className={cx(
        "shrink-0 border-b px-4 py-2.5 sm:px-6",
        state === "connecting" && "border-sky-400/15 bg-sky-400/[0.05]",
        state === "misconfigured" && "border-amber-400/20 bg-amber-400/[0.06]",
        state === "unavailable" && "border-rose-400/20 bg-rose-400/[0.07]",
      )}
    >
      <div className="flex items-start gap-3 text-[13px] leading-relaxed">
        <Icon
          className={cx(
            "mt-0.5 size-4 shrink-0",
            state === "connecting" && "animate-spin text-sky-300",
            state === "misconfigured" && "text-amber-300",
            state === "unavailable" && "text-rose-300",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-zinc-100">
            <InlineCode text={platform.message ?? DEFAULTS[state]} />
          </p>
          {platform.hint ? (
            <p className="text-zinc-400">
              <InlineCode text={platform.hint} />
            </p>
          ) : null}
          {state === "misconfigured" && platform.missingEnvironments.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-zinc-400">Missing environments:</span>
              {platform.missingEnvironments.map((name) => (
                <code
                  key={name}
                  className="rounded-md bg-black/30 px-1.5 py-px font-mono text-[11.5px] text-amber-100 ring-1 ring-inset ring-amber-400/20"
                >
                  {name}
                </code>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
