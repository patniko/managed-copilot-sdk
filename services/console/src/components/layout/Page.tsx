import { SyncIcon } from "@primer/octicons-react";
import { Fragment, useEffect, type ReactNode } from "react";
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
  /** Parent pages, shown before the title like "Environments / production" on a GitHub settings page. */
  readonly breadcrumbs?: readonly Crumb[];
  readonly actions?: ReactNode;
  readonly poll?: PollStatus;
  /** Content between the header and the body (tabs). */
  readonly headerExtra?: ReactNode;
  readonly children: ReactNode;
  /** Fill the viewport height (live feeds scroll inside). */
  readonly fill?: boolean;
  /** A wider page for data-dense tables, so wide screens show every column. */
  readonly wide?: boolean;
}

/** Sets the browser tab title the way github.com does: "Page · App · Product". */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Console · Managed Copilot`;
  }, [title]);
}

/** A console page: a Primer `Subhead` (24px title, description, right-aligned actions), then its content. */
export function Page({ title, documentTitle, description, breadcrumbs, actions, poll, headerExtra, children, fill = false, wide = false }: PageProps) {
  useDocumentTitle(documentTitle);
  const parents = breadcrumbs && breadcrumbs.length > 1 ? breadcrumbs.slice(0, -1) : [];

  return (
    <div className={cx("mx-auto w-full px-4 md:px-6 lg:px-8", wide ? "max-w-[1600px]" : "max-w-[1280px]", fill ? "flex h-full min-h-0 flex-col py-6" : "py-6 md:py-8")}>
      <header className="shrink-0">
        <div className={cx("Subhead", headerExtra ? "mb-0 border-b-0 pb-0" : undefined)}>
          <h1 className="Subhead-heading min-w-0 break-words">
            {parents.length > 0 ? (
              <span>
                {parents.map((crumb, index) => (
                  <Fragment key={`${crumb.label}-${index}`}>
                    {crumb.href ? (
                      <Link href={crumb.href} className="Link">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span>{crumb.label}</span>
                    )}
                    <span className="mx-1.5 text-fg-muted" aria-hidden>
                      /
                    </span>
                  </Fragment>
                ))}
              </span>
            ) : null}
            {title}
          </h1>
          {poll || actions ? (
            <div className="Subhead-actions items-center">
              {poll ? <RefreshStatus poll={poll} /> : null}
              {actions}
            </div>
          ) : null}
          {description ? <div className="Subhead-description">{description}</div> : null}
        </div>
        {headerExtra ? <div className="mt-3">{headerExtra}</div> : null}
      </header>
      {poll ? <StaleBanner poll={poll} className={headerExtra ? "mt-4" : "mb-4"} /> : null}
      <div className={cx(fill ? "flex min-h-0 flex-1 flex-col" : undefined, headerExtra && !fill ? "pt-6" : undefined, headerExtra && fill ? "pt-4" : undefined)}>{children}</div>
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
      <span className="text-xs whitespace-nowrap text-fg-muted tabular-nums" title={poll.updatedAt !== undefined ? formatIso(poll.updatedAt) : undefined} aria-live="off">
        {poll.loading && poll.updatedAt === undefined ? "Loading…" : updated ? `${paused ? "Paused · updated" : "Updated"} ${updated}` : null}
      </span>
      <IconButton icon={SyncIcon} label="Refresh now" size="sm" spin={poll.loading} disabled={poll.loading} onClick={() => void poll.refresh()} />
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
      tone="attention"
      role="status"
      className={className}
      actions={
        <Button size="sm" icon={SyncIcon} loading={poll.loading} onClick={() => void poll.refresh()}>
          Retry
        </Button>
      }
    >
      Couldn&apos;t refresh: {sentence(poll.error.message)}
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
  /** Draw a Box around the error state (when the content isn't inside a Box already). */
  readonly boxed?: boolean;
  readonly children: (data: T) => ReactNode;
}

/** Loading skeleton → data, or a full error state with retry when nothing has loaded yet. */
export function PollContent<T>({ poll, skeleton, errorTitle, notFound, boxed = false, children }: PollContentProps<T>) {
  if (poll.data !== undefined) return <>{children(poll.data)}</>;
  if (poll.error) {
    if (notFound && (poll.error.status === 404 || poll.error.code === "not_found" || poll.error.code === "environment_not_found")) return <>{notFound(poll.error)}</>;
    return <ErrorState title={errorTitle} message={poll.error.message} onRetry={() => void poll.refresh()} retrying={poll.loading} boxed={boxed} />;
  }
  return <>{skeleton}</>;
}
