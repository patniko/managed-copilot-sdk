/** An error a person sees: a stable code, plain words, and the HTTP status the API answers with. */
export class RaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "RaceError";
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
