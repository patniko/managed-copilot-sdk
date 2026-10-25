import type { LucideIcon } from "lucide-react";
import { ChevronRight, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import type { ApiError } from "../../lib/errors.js";
import { formatIso, formatRelative } from "../../lib/format.js";
import { usePollingPaused, type PollState } from "../../lib/poll.js";
import { useNow } from "../../lib/time.js";
import { Button, IconButton } from "../ui/Button.js";
import { Callout, ErrorState } from "../ui/Feedback.js";
import { Link } from "../ui/Link.js";

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

/** The poll fields a page header shows. */
export type PollStatus = Pick<PollState<unknown>, "updatedAt" | "loading" | "error" | "refresh"> & { readonly data: unknown };

export interface PageProps {
  readonly title: ReactNode;
  /** The browser tab title. */
  readonly documentTitle: string;
  readonly description?: ReactNode;
  readonly icon?: LucideIcon;
  readonly breadcrumbs?: readonly Crumb[];
  readonly actions?: ReactNode;
  readonly poll?: PollStatus;
  /** Content between the header and the body (tabs, summary badges). */
  readonly headerExtra?: ReactNode;
  readonly children: ReactNode;
  /** Fill the viewport height (live feeds scroll inside). */
  readonly fill?: boolean;
}

export function Page({ title, documentTitle, description, icon: Icon, breadcrumbs, actions, poll, headerExtra, children, fill = false }: PageProps) {
  useEffect(() => {
    document.title = `${documentTitle} · Managed Copilot console`;
  }, [documentTitle]);

  return (
    <div className={cx("mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-8", fill ? "flex h-full min-h-0 flex-col py-5" : "py-6")}>
      <header className={cx("shrink-0", headerExtra ? "border-b border-zinc-800" : "mb-5")}>
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <nav aria-label="Breadcrumb" className="mb-1.5">
            <ol className="flex flex-wrap items-center gap-1 text-[12px] text-zinc-500">
              {breadcrumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {index > 0 ? <ChevronRight className="size-3 text-zinc-700" aria-hidden /> : null}
                  {crumb.href ? (
                    <Link href={crumb.href} className="hover:text-zinc-300 hover:underline hover:underline-offset-2">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current="page">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            {Icon ? (
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-zinc-900 text-zinc-300 ring-1 ring-inset ring-white/10">
                <Icon className="size-[18px]" aria-hidden />
              </span>
            ) : null}
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight break-words text-zinc-50">{title}</h1>
              {description ? <div className="mt-0.5 text-[13px] leading-relaxed text-zinc-400">{description}</div> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {poll ? <RefreshStatus poll={poll} /> : null}
            {actions}
          </div>
        </div>
        {headerExtra ? <div className="mt-4">{headerExtra}</div> : null}
      </header>
      {poll ? <StaleBanner poll={poll} className={headerExtra ? "mt-4" : "mb-4"} /> : null}
      <div className={cx(fill ? "flex min-h-0 flex-1 flex-col" : undefined, headerExtra && !fill ? "pt-5" : undefined, headerExtra && fill ? "pt-4" : undefined)}>{children}</div>
    </div>
  );
}

/** "Updated 3s ago" with a manual refresh button. */
export function RefreshStatus({ poll }: { readonly poll: PollStatus }) {
  const now = useNow(1000);
  const paused = usePollingPaused();
  const updated = poll.updatedAt !== undefined ? formatRelative(poll.updatedAt, now) : undefined;
  return (
    <div className="flex items-center gap-1">
      <span className="text-[12px] whitespace-nowrap text-zinc-500 tabular" title={poll.updatedAt !== undefined ? formatIso(poll.updatedAt) : undefined} aria-live="off">
        {poll.loading && poll.updatedAt === undefined ? "Loading…" : updated ? `${paused ? "Paused · updated" : "Updated"} ${updated}` : null}
      </span>
      <IconButton icon={RefreshCw} label="Refresh now" size="sm" spin={poll.loading} disabled={poll.loading} onClick={() => void poll.refresh()} />
    </div>
  );
}

/** Shown when a refresh failed but earlier data is still on screen. */
export function StaleBanner({ poll, className }: { readonly poll: PollStatus; readonly className?: string }) {
  const now = useNow(5000);
  if (!poll.error || poll.data === undefined) return null;
  const age = poll.updatedAt !== undefined ? formatRelative(poll.updatedAt, now) : undefined;
  return (
    <Callout
      tone="warning"
      role="status"
      className={className}
      actions={
        <Button size="sm" icon={RotateCcw} loading={poll.loading} onClick={() => void poll.refresh()}>
          Retry
        </Button>
      }
    >
      Couldn't refresh: {sentence(poll.error.message)}
      {age ? ` Showing data from ${age === "just now" ? "a moment ago" : age}.` : null}
    </Callout>
  );
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export interface PollContentProps<T> {
  readonly poll: PollState<T>;
  readonly skeleton: ReactNode;
  /** "Couldn't load sessions". */
  readonly errorTitle: string;
  /** Rendered for a 404 instead of the error state. */
  readonly notFound?: (error: ApiError) => ReactNode;
  readonly children: (data: T) => ReactNode;
}

/** Loading skeleton → data, or a full error state with retry when nothing has loaded yet. */
export function PollContent<T>({ poll, skeleton, errorTitle, notFound, children }: PollContentProps<T>) {
  if (poll.data !== undefined) return <>{children(poll.data)}</>;
  if (poll.error) {
    if (notFound && (poll.error.status === 404 || poll.error.code === "not_found" || poll.error.code === "environment_not_found")) return <>{notFound(poll.error)}</>;
    return <ErrorState title={errorTitle} message={poll.error.message} onRetry={() => void poll.refresh()} retrying={poll.loading} />;
  }
  return <>{skeleton}</>;
}
