/**
 * Apps that vouch for their own users (spec section 2, "Your app's own users").
 *
 * The AppHost declares each app (`apps`) and issues it an app key. A request carrying the key acts for one of three
 * callers: one of the app's own users (`APP_USER_HEADER`, never a GitHub account; model calls go to Foundry), a GitHub
 * user who signed in to the app (`Authorization: ******`), or the app itself (deployment information only).
 * Header values are percent-encoded UTF-8 (`encodeHeaderValue`); the key travels only in `APP_KEY_HEADER`.
 */
import { z } from "zod";

/** The variable an app reads its key from (`ManagedCopilot.connect()` picks it up). */
export const APP_KEY_ENV = "MANAGED_COPILOT_APP_KEY";
/** The app key. A server-side secret: the gateway takes the app's word for who its users are. */
export const APP_KEY_HEADER = "x-managed-copilot-app-key";
/** The app user a request acts for: the ID the app's own sign-in gave them (percent-encoded). */
export const APP_USER_HEADER = "x-managed-copilot-app-user";
/** The app user's display name (percent-encoded); informational, never used for ownership. */
export const APP_USER_NAME_HEADER = "x-managed-copilot-app-user-name";

/** Longest app user ID or name the platform accepts. */
export const APP_USER_MAX_LENGTH = 256;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const printable = (what: string) =>
  z
    .string()
    .min(1, `${what} must not be empty`)
    .max(APP_USER_MAX_LENGTH, `${what} must be at most ${APP_USER_MAX_LENGTH} characters`)
    .refine((value) => !CONTROL.test(value), `${what} must not contain control characters`)
    .refine((value) => value.trim() === value, `${what} must not start or end with whitespace`);

/** One of your app's users, as your app's own sign-in identifies them. */
export const AppUserSchema = z
  .object({
    /** Stable ID from your identity provider (a subject, object ID, or account number). Ownership binds to it. */
    id: printable("An app user ID"),
    /** Display name for consoles and logs. */
    name: printable("An app user name").optional(),
  })
  .strict();
export type AppUser = z.infer<typeof AppUserSchema>;

/** Validates an app user, reporting problems as one readable message. */
export function parseAppUser(value: unknown): AppUser {
  const parsed = AppUserSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new TypeError(parsed.error.issues.map((issue) => issue.message).join("; "));
}

/** Percent-encodes a header value (UTF-8), so any app user ID or name travels as plain ASCII. */
export function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value);
}

/** Reverses `encodeHeaderValue`; undefined for malformed encoding. */
export function decodeHeaderValue(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** The login an app user shows as: `<app>/<id>`, which no GitHub login can be (GitHub logins have no `/`). */
export function appUserLogin(app: string, userId: string): string {
  return `${app}/${userId}`;
}
