import { isManagedCopilotError, type ErrorCode } from "@managed-copilot/protocol";

/** A user error the CLI reports without a stack trace (bad arguments, ambiguous IDs). */
export class UsageError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A failed command with its own hint (exit code 1, unlike usage errors). */
export class CommandError extends Error {
  readonly code: ErrorCode | undefined;
  readonly hint: string | undefined;
  constructor(message: string, options: { readonly code?: ErrorCode; readonly hint?: string } = {}) {
    super(message);
    this.name = "CommandError";
    this.code = options.code;
    this.hint = options.hint;
  }
}

export interface DescribedError {
  readonly message: string;
  readonly hint?: string;
  readonly code?: ErrorCode;
}

const HINTS: Partial<Record<ErrorCode, string>> = {
  authentication_required: "Sign in with GitHub: run `gh auth login`, or set GH_TOKEN for this terminal.",
  forbidden: "Your GitHub account is not allowed here, or the item belongs to someone else.",
  not_found: "Check the ID with `npx managed-copilot sessions` or `npx managed-copilot schedules`.",
  environment_not_found: "Use an environment declared in the AppHost; `npx managed-copilot status` lists them.",
  capability_unavailable: "This deployment does not offer that yet.",
  session_busy: "Wait for the current turn to finish, then try again.",
  promotion_busy: "The session is finishing other work. Try again shortly.",
  inference_unavailable: "Check your Copilot entitlement, then run `npx managed-copilot login` again.",
  timeout: "The deployment took too long to answer. Try again.",
  internal: "Check the gateway logs in the Aspire dashboard.",
};

/** Turns any thrown value into a one-line message plus an actionable hint, never a stack trace. */
export function describeError(error: unknown): DescribedError {
  if (error instanceof UsageError) return { message: error.message, ...(error.hint ? { hint: error.hint } : {}) };
  if (error instanceof CommandError) return { message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.hint ? { hint: error.hint } : {}) };
  if (isManagedCopilotError(error)) {
    if (error.code === "not_found" && /^No route for /.test(error.message)) {
      return {
        message: `This deployment does not offer that yet (${error.message.replace(/^No route for /, "")} is missing).`,
        code: "capability_unavailable",
        hint: "Update the platform, or check the gateway version with `npx managed-copilot status`.",
      };
    }
    let hint = HINTS[error.code];
    if (/No Managed Copilot deployment found/.test(error.message)) hint = "Start the platform from the repository root with `aspire run`, or pass --url.";
    else if (/Cannot reach the Managed Copilot deployment/.test(error.message)) hint = "Is `aspire run` still running? Check the gateway in the Aspire dashboard.";
    else if (/not available in this build|is not available on this gateway/.test(error.message)) hint = "That feature has not landed on this deployment yet.";
    // About Copilot CLI on this machine, not the deployment; those messages say what to do.
    else if (error.code === "capability_unavailable" && /Copilot CLI/.test(error.message)) hint = undefined;
    return { message: error.message, code: error.code, ...(hint ? { hint } : {}) };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}
