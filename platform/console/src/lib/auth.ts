import type { OperatorIdentity } from "@managed-copilot/protocol/operator";
import { useSyncExternalStore } from "react";
import { endConsoleSession, getIdentity, redeemTicket, setAuthHandlers } from "./api.js";
import { ApiError, toApiError } from "./errors.js";
import { closeGuardedAction } from "./guarded.js";
import { clearPollCache } from "./poll.js";
import { navigate, syncLocation } from "./router.js";
import { hrefs, matchRoute } from "./routes.js";
import { hasTicket, readTicket } from "./signin.js";
import { stopStream } from "./stream.js";
import { toast } from "./toast.js";

export type SignedOutReason =
  /** No console session yet. */
  | "required"
  /** A console session ended (expired, revoked, or the gateway restarted with new keys). */
  | "ended"
  /** The operator signed out. */
  | "signed-out";

export type AuthState =
  | { readonly status: "checking" }
  | { readonly status: "signing-in" }
  | { readonly status: "signed-in"; readonly identity: OperatorIdentity }
  | { readonly status: "signed-out"; readonly reason: SignedOutReason; readonly message?: string }
  | { readonly status: "ticket-failed"; readonly message?: string }
  | { readonly status: "forbidden"; readonly message: string; readonly login?: string }
  | { readonly status: "github-unavailable"; readonly message: string; readonly retryAt?: number; readonly retrying?: boolean }
  | { readonly status: "unreachable"; readonly error: ApiError; readonly retrying?: boolean };

let state: AuthState = { status: "checking" };
const listeners = new Set<() => void>();
let started = false;
let generation = 0;
/** A sign-in ticket taken from the URL fragment, waiting for `startAuth` (used once, then forgotten). */
let capturedTicket: string | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function set(next: AuthState): void {
  const previousAccount = state.status === "signed-in" ? state.identity.account.id : undefined;
  state = next;
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  // Leaving a session (signed out, or another account signed in elsewhere): drop everything the previous operator saw
  // before anything can refetch it. Clear the cache first so resuming paused polling has nothing left to run.
  if (previousAccount !== undefined && (next.status !== "signed-in" || next.identity.account.id !== previousAccount)) {
    clearPollCache();
    stopStream();
    closeGuardedAction();
  }
  if (next.status === "signed-in") scheduleExpiryCheck(next.identity);
  for (const listener of listeners) listener();
}

/** Re-checks the identity just after the console session ends, so an expired session drops to the sign-in screen. */
function scheduleExpiryCheck(identity: OperatorIdentity): void {
  const expiresAt = identity.sessionExpiresAt ? Date.parse(identity.sessionExpiresAt) : Number.NaN;
  if (Number.isNaN(expiresAt)) return;
  const delay = Math.min(2_147_000_000, Math.max(1000, expiresAt - Date.now() + 1000));
  expiryTimer = setTimeout(() => void checkIdentity(), delay);
}

function retryAtOf(error: ApiError): number | undefined {
  return error.retryAfterSeconds !== undefined ? Date.now() + error.retryAfterSeconds * 1000 : undefined;
}

function forbiddenLogin(error: ApiError): string | undefined {
  const login = error.details?.["login"];
  return typeof login === "string" && login ? login : undefined;
}

/** After signing in at `/console/signin`, continue at the console home. */
function leaveSignInPage(): void {
  if (matchRoute(window.location.pathname).kind === "signin") navigate(hrefs.overview(), { replace: true });
}

function signedIn(identity: OperatorIdentity): void {
  leaveSignInPage();
  set({ status: "signed-in", identity });
}

/** While retrying from an error screen, keep that screen (with a busy button) instead of flashing the loading view. */
function showProgress(fallback: AuthState): void {
  if (state.status === "github-unavailable" || state.status === "unreachable") set({ ...state, retrying: true });
  else set(fallback);
}

/** Loads the operator identity (`GET /v1/operator/me`). */
export async function checkIdentity(): Promise<void> {
  const token = ++generation;
  const previous = state;
  if (previous.status !== "signed-in") showProgress({ status: "checking" });
  try {
    const identity = await getIdentity();
    if (token !== generation) return;
    signedIn(identity);
  } catch (error) {
    if (token !== generation) return;
    const failure = toApiError(error);
    if (failure.status === 401 || failure.code === "authentication_required") {
      set({ status: "signed-out", reason: previous.status === "signed-in" ? "ended" : "required", message: failure.message });
    } else if (failure.status === 403 || failure.code === "forbidden") {
      set({ status: "forbidden", message: failure.message, login: forbiddenLogin(failure) });
    } else if (previous.status === "signed-in") {
      // A transient failure while re-checking: stay signed in; views show their own errors.
      return;
    } else if (failure.code === "upstream_unavailable") {
      set({ status: "github-unavailable", message: failure.message, retryAt: retryAtOf(failure) });
    } else {
      set({ status: "unreachable", error: failure });
    }
  }
}

/**
 * Redeems the sign-in ticket the page was opened with, exactly once: the gateway consumes a ticket before it checks
 * the account with GitHub, so a failed redemption is never retried with the same ticket. Retrying afterwards checks
 * the console session instead (the cookie may have been set even if the answer was lost).
 */
async function redeem(ticket: string): Promise<void> {
  const token = ++generation;
  showProgress({ status: "signing-in" });
  try {
    const identity = await redeemTicket(ticket);
    if (token !== generation) return;
    if (identity) signedIn(identity);
    else await checkIdentity();
  } catch (error) {
    if (token !== generation) return;
    const failure = toApiError(error);
    if (failure.code === "upstream_unavailable") {
      set({ status: "github-unavailable", message: failure.message, retryAt: retryAtOf(failure) });
    } else if (failure.status === 0 || failure.status >= 500) {
      set({ status: "unreachable", error: failure });
    } else if (failure.status === 403 || failure.code === "forbidden") {
      set({ status: "forbidden", message: failure.message, login: forbiddenLogin(failure) });
    } else {
      set({ status: "ticket-failed", message: failure.message });
    }
  }
}

/**
 * Takes a `#ticket=` sign-in fragment out of the address bar at once (it must never stay in the URL or history).
 * Call before anything else runs; `startAuth` then redeems it.
 */
export function captureSignInTicket(): void {
  const hash = window.location.hash;
  if (!hasTicket(hash)) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  syncLocation();
  capturedTicket = readTicket(hash);
}

/** Starts authentication once, before the first render: redeems a captured ticket, or checks the existing session. */
export function startAuth(): void {
  if (started) return;
  started = true;
  setAuthHandlers({
    unauthorized: (error) => {
      if (state.status !== "signed-in") return;
      // Invalidate identity checks in flight so an older answer cannot sign the console back in.
      generation += 1;
      set({ status: "signed-out", reason: "ended", message: error.message });
    },
    // The gateway ends a console session whose account lost operator access, answering 403: show why, directly
    // (re-checking would only see the cleared cookie and report a generic sign-in).
    forbidden: (error) => {
      if (state.status !== "signed-in") return;
      generation += 1;
      set({ status: "forbidden", message: error.message, login: forbiddenLogin(error) });
    },
  });
  captureSignInTicket();
  const ticket = capturedTicket;
  capturedTicket = undefined;
  if (ticket) void redeem(ticket);
  else void checkIdentity();
}

/** Retries after a failure screen by checking the console session (a sign-in ticket is never redeemed twice). */
export function retryAuth(): void {
  void checkIdentity();
}

/** `DELETE /v1/operator/console/session`, then the signed-out screen. */
export async function signOut(): Promise<void> {
  try {
    await endConsoleSession();
  } catch (error) {
    const failure = toApiError(error);
    // 401: the session had already ended. 403: a non-operator leaving; signing in again replaces the cookie.
    if (failure.status !== 401 && failure.status !== 403) {
      toast.error("Couldn't sign out", failure.message);
      return;
    }
  }
  generation += 1;
  set({ status: "signed-out", reason: "signed-out" });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, () => state);
}

export function getAuthState(): AuthState {
  return state;
}
