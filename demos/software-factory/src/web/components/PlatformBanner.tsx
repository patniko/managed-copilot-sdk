import { AlertIcon, StopIcon } from "@primer/octicons-react";
import { cx } from "../lib/cx.js";
import { useStore } from "../lib/store.js";
import { InlineCode } from "./ui/Feedback.js";
import { Spinner } from "./ui/Spinner.js";

const DEFAULTS = {
  connecting: "Connecting to Managed Copilot…",
  reconnecting: "Reconnecting to Managed Copilot…",
  unavailable: "Managed Copilot is unavailable right now.",
  misconfigured: "The platform is reachable but isn't set up for the factory.",
} as const;

const VARIANTS = {
  connecting: undefined,
  reconnecting: "flash-warn",
  unavailable: "flash-error",
  misconfigured: "flash-warn",
} as const;

/** Explains a non-connected platform in a full-width banner under the header. */
export function PlatformBanner() {
  const platform = useStore((state) => state.platform);
  if (!platform || platform.state === "connected") return null;
  const state = platform.state;
  const pending = state === "connecting" || state === "reconnecting";
  return (
    <div role="status" className={cx("flash flash-full shrink-0 py-3", VARIANTS[state])}>
      {pending ? (
        <Spinner size={16} className={cx("mt-0.5", state === "reconnecting" ? "text-fg-attention" : "text-fg-accent")} />
      ) : state === "misconfigured" ? (
        <AlertIcon size={16} />
      ) : (
        <StopIcon size={16} />
      )}
      <div className="flash-content">
        <p>
          <InlineCode text={platform.message ?? DEFAULTS[state]} />
        </p>
        {platform.hint ? (
          <p className="text-fg-muted">
            <InlineCode text={platform.hint} />
          </p>
        ) : null}
        {state === "misconfigured" && platform.missingEnvironments.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="text-xs text-fg-muted">Missing environments:</span>
            {platform.missingEnvironments.map((name) => (
              <code key={name} className="inline-code">
                {name}
              </code>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
