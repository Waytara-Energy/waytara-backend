/**
 * An error whose message is safe to show to the caller. Anything that is not an AppError is treated as a bug: it is logged in full
 * and the caller only ever sees a generic message.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "invalid_request", message, details);
export const unauthorized = (message = "Sign in required") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "Not allowed") => new AppError(403, "forbidden", message);
export const notFound = (message = "Not found") => new AppError(404, "not_found", message);

export interface ErrorBody {
  error: { code: string; message: string; request_id?: string; details?: unknown };
}
