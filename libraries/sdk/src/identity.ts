// Who the SDK's requests act for: a GitHub user (their token), an app (its key), one of the app's own users, or a
// GitHub user who signed in to the app. Credentials travel only in request headers, never in URLs or logs.
import { createHash } from "node:crypto";
import {
  APP_KEY_HEADER,
  APP_USER_HEADER,
  APP_USER_NAME_HEADER,
  encodeHeaderValue,
  ManagedCopilotError,
  parseAppUser,
  type AppUser,
} from "@managed-copilot/protocol";

export interface Identity {
  /** A GitHub token: the GitHub user the request acts for (directly, or through the app). */
  readonly token?: string;
  /** The app key: the request comes through this app. */
  readonly appKey?: string;
  /** One of the app's own users (with `appKey`). */
  readonly appUser?: AppUser;
}

/** The headers that carry an identity. */
export function identityHeaders(identity: Identity): Record<string, string> {
  const headers: Record<string, string> = {};
  if (identity.token) headers["authorization"] = `Bearer ${identity.token}`;
  if (identity.appKey) headers[APP_KEY_HEADER] = identity.appKey;
  if (identity.appUser) {
    headers[APP_USER_HEADER] = encodeHeaderValue(identity.appUser.id);
    if (identity.appUser.name) headers[APP_USER_NAME_HEADER] = encodeHeaderValue(identity.appUser.name);
  }
  return headers;
}

/** A stable key for caching clients per identity: a digest, so no credential is kept as a map key in clear. */
export function identityKey(identity: Identity): string {
  return createHash("sha256")
    .update(JSON.stringify([identity.token ?? null, identity.appKey ?? null, identity.appUser?.id ?? null]))
    .digest("base64url")
    .slice(0, 22);
}

/** Whether the identity names someone who can own sessions (not an app acting for itself). */
export function actsForSomeone(identity: Identity): boolean {
  return Boolean(identity.token || identity.appUser);
}

/** Fails like the gateway would, before anything is sent, when an app connection names nobody to act for. */
export function requireActor(identity: Identity, what: string): void {
  if (actsForSomeone(identity)) return;
  throw new ManagedCopilotError(
    "invalid_request",
    `${what} needs a person to act for: this connection is your app itself. Use managed.as({ appUser }) for one of your app's users, or managed.as({ gitHubToken }) for someone who signed in with GitHub.`,
  );
}

/**
 * The identity for acting as `user` from a context identity. An app connection keeps its key on every request; a
 * GitHub connection can act for another GitHub user, never for an app user.
 */
export function actingIdentity(base: Identity, user: { readonly appUser?: AppUser | undefined; readonly gitHubToken?: string | undefined }): Identity {
  if (user.appUser !== undefined && user.gitHubToken !== undefined) {
    throw new ManagedCopilotError("invalid_request", "Act for one person at a time: pass appUser or gitHubToken, not both.");
  }
  if (user.appUser !== undefined) {
    if (!base.appKey) {
      throw new ManagedCopilotError(
        "invalid_request",
        "appUser needs an app connection: connect with your app's key (MANAGED_COPILOT_APP_KEY, issued by the AppHost with copilot.appKey(name)).",
      );
    }
    let appUser: AppUser;
    try {
      appUser = parseAppUser(user.appUser);
    } catch (error) {
      throw new ManagedCopilotError("invalid_request", `Invalid appUser: ${(error as Error).message}`);
    }
    return { appKey: base.appKey, appUser };
  }
  if (user.gitHubToken !== undefined) {
    if (!user.gitHubToken) throw new ManagedCopilotError("authentication_required", "gitHubToken is empty; pass the user's GitHub token.");
    return { ...(base.appKey ? { appKey: base.appKey } : {}), token: user.gitHubToken };
  }
  return base;
}
