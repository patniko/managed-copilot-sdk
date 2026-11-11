import { CommentDiscussionIcon, FlameIcon, GraphIcon, InboxIcon, type Icon } from "@primer/octicons-react";
import type { WorkOrderOrigin } from "../../shared/types.js";

/** Icons for the apps that route work here; any other app gets the inbox. */
const ORIGIN_ICONS: Readonly<Record<string, Icon>> = {
  "help-desk": CommentDiscussionIcon,
  "incident-commander": FlameIcon,
  "data-desk": GraphIcon,
};

export function originIcon(origin: Pick<WorkOrderOrigin, "app">): Icon {
  return ORIGIN_ICONS[origin.app] ?? InboxIcon;
}

/** "From Help Desk · Promo codes · 2 tickets". */
export function originText(origin: WorkOrderOrigin): string {
  return `From ${origin.name}${origin.label ? ` · ${origin.label}` : ""}`;
}

/** The link back to the origin, when it's one a browser can open. */
export function originHref(origin: WorkOrderOrigin): string | undefined {
  if (!origin.url) return undefined;
  try {
    const url = new URL(origin.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
