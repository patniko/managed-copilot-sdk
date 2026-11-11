/**
 * Ownership labels on every Docker resource a local gateway creates, so any gateway sharing the engine can tell when
 * the resources of another instance were abandoned: their data directory (on this host) no longer exists, as after a
 * worktree or test directory is deleted, or their expiry (`MANAGED_COPILOT_INSTANCE_TTL_SECONDS`, for test runs) has
 * passed. See `sweepAbandonedInstances`.
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";

export const OWNERSHIP_LABELS = {
  /** The owning gateway's `MANAGED_COPILOT_DATA_DIR`. */
  dataDir: "managed-copilot.data-dir",
  /** Where that path is meaningful: platform, host name, and WSL distribution. */
  host: "managed-copilot.host",
  /** Unix seconds after which the resources may be removed regardless of the data directory. */
  expires: "managed-copilot.expires",
} as const;

/** Identifies the filesystem `data-dir` paths resolve on. WSL distributions share the Windows host name. */
export function dockerOwnerHost(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return [process.platform, hostname().toLowerCase(), env.WSL_DISTRO_NAME].filter(Boolean).join("/");
}

/** Labels for resources owned by the gateway using `dataDir`. Computed once per gateway process. */
export function ownershipLabels(dataDir: string, env: Readonly<Record<string, string | undefined>>, now = Date.now()): Record<string, string> {
  const ttl = Number(env.MANAGED_COPILOT_INSTANCE_TTL_SECONDS);
  return {
    [OWNERSHIP_LABELS.dataDir]: dataDir,
    [OWNERSHIP_LABELS.host]: dockerOwnerHost(env),
    ...(Number.isFinite(ttl) && ttl > 0 ? { [OWNERSHIP_LABELS.expires]: String(Math.floor(now / 1000) + Math.floor(ttl)) } : {}),
  };
}

/**
 * - `abandoned`: expired, or its data directory is on this host and gone.
 * - `live`: its data directory is on this host and exists (and it has not expired).
 * - `foreign`: owned from another host or WSL distribution, which this gateway cannot check.
 * - `unlabeled`: created before ownership labels; says nothing either way.
 */
export type Ownership = "abandoned" | "live" | "foreign" | "unlabeled";

export interface OwnershipContext {
  readonly host: string;
  readonly now: number;
  readonly exists: (path: string) => boolean;
}

export function classifyOwnership(labels: Readonly<Record<string, string>> | null | undefined, context: Partial<OwnershipContext> = {}): Ownership {
  const host = context.host ?? dockerOwnerHost();
  const now = context.now ?? Date.now();
  const exists = context.exists ?? existsSync;
  const expires = Number(labels?.[OWNERSHIP_LABELS.expires]);
  if (Number.isFinite(expires) && expires > 0 && expires * 1000 <= now) return "abandoned";
  const dataDir = labels?.[OWNERSHIP_LABELS.dataDir];
  const owner = labels?.[OWNERSHIP_LABELS.host];
  if (!dataDir || !owner) return Number.isFinite(expires) && expires > 0 ? "live" : "unlabeled";
  if (owner !== host) return "foreign";
  return exists(dataDir) ? "live" : "abandoned";
}
