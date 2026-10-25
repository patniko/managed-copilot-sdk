import type { AccountInfo } from "@managed-copilot/protocol";
import { useState } from "react";
import { cx } from "../../lib/cx.js";
import { formatIso, formatRelative, initials, safeAvatarUrl, shortId } from "../../lib/format.js";
import { hrefs } from "../../lib/routes.js";
import { useNow } from "../../lib/time.js";
import { CopyButton } from "../ui/CopyButton.js";
import { None } from "../ui/Feedback.js";
import { Link } from "../ui/Link.js";

const AVATAR_SIZES = { xs: "size-4 text-[8px]", sm: "size-5 text-[9px]", md: "size-7 text-[11px]", lg: "size-10 text-sm" } as const;

/** A GitHub avatar, falling back to initials when it is missing, not a GitHub avatar URL, or fails to load. */
export function Avatar({ account, size = "sm", className }: { readonly account: Pick<AccountInfo, "login" | "name" | "avatarUrl">; readonly size?: keyof typeof AVATAR_SIZES; readonly className?: string }) {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const url = safeAvatarUrl(account.avatarUrl);
  const classes = cx("shrink-0 rounded-full bg-zinc-800 ring-1 ring-white/10", AVATAR_SIZES[size], className);
  if (url && failed !== url) {
    return <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className={classes} onError={() => setFailed(url)} />;
  }
  return (
    <span className={cx(classes, "grid place-items-center font-semibold text-zinc-300")} aria-hidden>
      {initials(account.name || account.login)}
    </span>
  );
}

/** Avatar and login, linking to the owner's sessions. */
export function AccountLabel({
  account,
  link = true,
  showName = false,
  size = "sm",
}: {
  readonly account: AccountInfo | undefined;
  readonly link?: boolean;
  readonly showName?: boolean;
  readonly size?: "xs" | "sm" | "md";
}) {
  if (!account) return <None />;
  const title = account.name ? `${account.name} (@${account.login}, ID ${account.id})` : `@${account.login} (ID ${account.id})`;
  const content = (
    <>
      <Avatar account={account} size={size} />
      <span className="min-w-0 truncate">
        <span className="text-zinc-200">{account.login}</span>
        {showName && account.name ? <span className="ml-1.5 text-zinc-500">{account.name}</span> : null}
      </span>
    </>
  );
  return link ? (
    <Link href={hrefs.view("sessions", { owner: account.login })} title={`${title}. Show their sessions`} className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded hover:underline hover:decoration-zinc-500 hover:underline-offset-2">
      {content}
    </Link>
  ) : (
    <span title={title} className="inline-flex max-w-full min-w-0 items-center gap-1.5">
      {content}
    </span>
  );
}

/** Relative time with the exact ISO timestamp in the title. Re-renders every few seconds. */
export function RelativeTime({ value, className, fallback }: { readonly value: string | number | undefined | null; readonly className?: string; readonly fallback?: string }) {
  const now = useNow(5000);
  const iso = formatIso(value);
  if (!iso) return fallback ? <span className="text-zinc-500">{fallback}</span> : <None />;
  return (
    <time dateTime={iso} title={iso} className={cx("whitespace-nowrap tabular", className)}>
      {formatRelative(value, now)}
    </time>
  );
}

/** A shortened ID with the full value in the title and a copy button. */
export function IdText({ id, label = "ID", href, className, length }: { readonly id: string | undefined; readonly label?: string; readonly href?: string; readonly className?: string; readonly length?: number }) {
  if (!id) return <None />;
  const text = shortId(id, length);
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-0.5", className)}>
      {href ? (
        <Link href={href} title={id} className="truncate font-mono text-[12px] text-sky-300 hover:text-sky-200 hover:underline hover:underline-offset-2">
          {text}
        </Link>
      ) : (
        <span title={id} className="truncate font-mono text-[12px] text-zinc-200">
          {text}
        </span>
      )}
      <CopyButton text={id} label={`Copy ${label} ${id}`} />
    </span>
  );
}

/** Link to a session's detail page by short ID. */
export function SessionLink({ id, copy = false }: { readonly id: string | undefined; readonly copy?: boolean }) {
  if (!id) return <None />;
  if (copy) return <IdText id={id} label="session ID" href={hrefs.session(id)} />;
  return (
    <Link href={hrefs.session(id)} title={id} className="font-mono text-[12px] text-sky-300 hover:text-sky-200 hover:underline hover:underline-offset-2">
      {shortId(id)}
    </Link>
  );
}

export function EnvironmentLink({ name }: { readonly name: string | undefined }) {
  if (!name) return <None />;
  return (
    <Link href={hrefs.environment(name)} className="font-mono text-[12px] text-zinc-200 hover:text-sky-200 hover:underline hover:underline-offset-2">
      {name}
    </Link>
  );
}
