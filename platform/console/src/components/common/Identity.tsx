import type { AccountInfo } from "@managed-copilot/protocol";
import { useState } from "react";
import { cx } from "../../lib/cx.js";
import { formatIso, formatRelative, initials, safeAvatarUrl, shortId } from "../../lib/format.js";
import { hrefs } from "../../lib/routes.js";
import { useNow } from "../../lib/time.js";
import { CopyButton } from "../ui/CopyButton.js";
import { None } from "../ui/Feedback.js";
import { Link } from "../ui/Link.js";

const AVATAR_SIZES = { xs: "size-4", sm: "size-5", md: "size-6", lg: "size-8", xl: "size-12" } as const;
type AvatarSize = keyof typeof AVATAR_SIZES;

/** A GitHub avatar (Primer `avatar`), falling back to initials when it is missing, not a GitHub avatar URL, or fails to load. */
export function Avatar({ account, size = "sm", className }: { readonly account: Pick<AccountInfo, "login" | "name" | "avatarUrl">; readonly size?: AvatarSize; readonly className?: string }) {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const url = safeAvatarUrl(account.avatarUrl);
  const classes = cx("avatar", AVATAR_SIZES[size], className);
  if (url && failed !== url) {
    return <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className={classes} onError={() => setFailed(url)} />;
  }
  const text = initials(account.name || account.login);
  return (
    <span className={cx(classes, "avatar-initials", size === "xl" ? "text-base" : "text-xs")} aria-hidden>
      {size === "xs" || size === "sm" ? text.slice(0, 1) : text}
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
  readonly size?: "xs" | "sm" | "md" | "lg";
}) {
  if (!account) return <None />;
  const title = account.name ? `${account.name} (@${account.login}, ID ${account.id})` : `@${account.login} (ID ${account.id})`;
  const content = (
    <>
      <Avatar account={account} size={size} />
      <span className="min-w-0 truncate">
        <span className="font-semibold">{account.login}</span>
        {showName && account.name ? <span className="ml-1.5 font-normal text-fg-muted">{account.name}</span> : null}
      </span>
    </>
  );
  return link ? (
    <Link href={hrefs.view("sessions", { owner: account.login })} title={`${title}. Show their sessions`} className="Link--primary inline-flex max-w-full min-w-0 items-center gap-2">
      {content}
    </Link>
  ) : (
    <span title={title} className="inline-flex max-w-full min-w-0 items-center gap-2">
      {content}
    </span>
  );
}

/** Relative time with the exact ISO timestamp in the title. Re-renders every few seconds. */
export function RelativeTime({ value, className, fallback }: { readonly value: string | number | undefined | null; readonly className?: string; readonly fallback?: string }) {
  const now = useNow(5000);
  const iso = formatIso(value);
  if (!iso) return fallback ? <span className="text-fg-muted">{fallback}</span> : <None />;
  return (
    <time dateTime={iso} title={iso} className={cx("whitespace-nowrap tabular-nums", className)}>
      {formatRelative(value, now)}
    </time>
  );
}

/** A shortened ID in monospace with the full value in the title and a copy button. */
export function IdText({ id, label = "ID", href, className, length }: { readonly id: string | undefined; readonly label?: string; readonly href?: string; readonly className?: string; readonly length?: number }) {
  if (!id) return <None />;
  const text = shortId(id, length);
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-0.5", className)}>
      {href ? (
        <Link href={href} title={id} className="Link truncate font-mono text-xs">
          {text}
        </Link>
      ) : (
        <span title={id} className="truncate font-mono text-xs">
          {text}
        </span>
      )}
      <CopyButton text={id} label={`Copy ${label} ${id}`} className="size-6" />
    </span>
  );
}

/** Link to a session's detail page by short ID. */
export function SessionLink({ id, copy = false }: { readonly id: string | undefined; readonly copy?: boolean }) {
  if (!id) return <None />;
  if (copy) return <IdText id={id} label="session ID" href={hrefs.session(id)} />;
  return (
    <Link href={hrefs.session(id)} title={id} className="Link font-mono text-xs">
      {shortId(id)}
    </Link>
  );
}

export function EnvironmentLink({ name }: { readonly name: string | undefined }) {
  if (!name) return <None />;
  return (
    <Link href={hrefs.environment(name)} className="Link--primary font-mono text-xs whitespace-nowrap">
      {name}
    </Link>
  );
}
