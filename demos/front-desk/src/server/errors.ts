/** An error with a stable code and a message written for the person using Front Desk. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export const notFound = (what = "That conversation") => new AppError("not_found", `${what} doesn't exist, or it isn't yours.`, 404);
export const signInRequired = () => new AppError("sign_in_required", "Sign in to continue.", 401);
