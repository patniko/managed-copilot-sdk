/**
 * Email accounts for people without GitHub. Front Desk is their identity provider: it keeps a scrypt hash of each
 * password, never the password, and vouches for the person to Managed Copilot.
 */
import { timingSafeEqual } from "node:crypto";
import { LIMITS, type SignInRequest, type SignUpRequest } from "../../shared/types.js";
import { AppError } from "../errors.js";
import { log } from "../log.js";
import { decoyHash, hashPassword, verifyPassword } from "../passwords.js";
import type { Store, UserRecord } from "../store.js";
import { retryAfterText, type RateLimiter } from "./ratelimit.js";

const EMAIL = /^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[^\s@<>"',;:()[\]\\]{2,}$/;
const SIGN_IN_FAILURES = { perEmail: 8, perAddress: 30, windowMs: 15 * 60_000 } as const;
const SIGN_UPS = { perAddress: 10, windowMs: 60 * 60_000 } as const;

export function normalizeName(value: unknown): string {
  const name = String(value ?? "")
    // Control characters (including line breaks) never belong in a name, and keep it out of the agent's instructions.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) throw new AppError("invalid_name", "Enter your name.");
  if (name.length > LIMITS.name) throw new AppError("invalid_name", `Keep your name under ${LIMITS.name} characters.`);
  return name;
}

export function normalizeEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || email.length > LIMITS.email || !EMAIL.test(email)) throw new AppError("invalid_email", "Enter a valid email address.");
  return email;
}

function checkPassword(value: unknown): string {
  const password = String(value ?? "");
  if (password.length < LIMITS.passwordMin) throw new AppError("weak_password", `Use at least ${LIMITS.passwordMin} characters for your password.`);
  if (password.length > LIMITS.passwordMax) throw new AppError("invalid_password", `Keep your password under ${LIMITS.passwordMax} characters.`);
  return password;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class EmailAccounts {
  readonly #store: Store;
  readonly #limiter: RateLimiter;
  readonly #inviteCode: string | undefined;

  constructor(store: Store, limiter: RateLimiter, inviteCode: string | undefined) {
    this.#store = store;
    this.#limiter = limiter;
    this.#inviteCode = inviteCode;
  }

  get inviteRequired(): boolean {
    return this.#inviteCode !== undefined;
  }

  async signUp(request: Partial<SignUpRequest>, address: string): Promise<UserRecord> {
    const name = normalizeName(request.name);
    const email = normalizeEmail(request.email);
    const password = checkPassword(request.password);
    if (this.#inviteCode !== undefined && !sameText(String(request.invite ?? "").trim(), this.#inviteCode)) {
      throw new AppError("invalid_invite", "That invitation code isn't right. Ask whoever runs this Front Desk for the current one.", 403);
    }
    const attempt = this.#limiter.take(`signup:${address}`, SIGN_UPS.perAddress, SIGN_UPS.windowMs);
    if (!attempt.allowed) throw new AppError("rate_limited", `Too many new accounts from your network. Try again ${retryAfterText(attempt.retryAfterMs)}.`, 429);
    if (this.#store.findByEmail(email)) throw new AppError("email_taken", "There's already an account with that email. Sign in instead.", 409);
    try {
      const user = this.#store.createEmailUser({ name, email, passwordHash: await hashPassword(password) });
      log.info("Created an email account", { user: user.id });
      return user;
    } catch (error) {
      if ((error as { code?: unknown }).code === "email_taken") throw new AppError("email_taken", "There's already an account with that email. Sign in instead.", 409);
      throw error;
    }
  }

  async signIn(request: Partial<SignInRequest>, address: string): Promise<UserRecord> {
    const email = String(request.email ?? "").trim().toLowerCase();
    const password = String(request.password ?? "");
    const emailKey = `signin:email:${email}`;
    const addressKey = `signin:address:${address}`;
    for (const [key, limit] of [[emailKey, SIGN_IN_FAILURES.perEmail], [addressKey, SIGN_IN_FAILURES.perAddress]] as const) {
      const state = this.#limiter.blocked(key, limit);
      if (state.blocked) throw new AppError("rate_limited", `Too many sign-in attempts. Try again ${retryAfterText(state.retryAfterMs)}.`, 429);
    }
    const user = email ? this.#store.findByEmail(email) : undefined;
    // Unknown addresses cost the same as wrong passwords, so the answer time doesn't reveal who has an account.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await decoyHash()));
    if (!user || !ok || password.length === 0) {
      this.#limiter.take(emailKey, SIGN_IN_FAILURES.perEmail, SIGN_IN_FAILURES.windowMs);
      this.#limiter.take(addressKey, SIGN_IN_FAILURES.perAddress, SIGN_IN_FAILURES.windowMs);
      throw new AppError("invalid_credentials", "That email and password don't match an account.", 401);
    }
    this.#limiter.reset(emailKey);
    this.#store.touchUser(user.id);
    return user;
  }
}
