/** An error a person sees: a stable code, plain words, and the HTTP status the API answers with. */
export class DoctorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "DoctorError";
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
