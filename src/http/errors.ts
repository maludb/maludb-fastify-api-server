/**
 * The stable client error model (brief §13). `jsonError()` throws an `ApiError`, which the Fastify
 * error handler renders as `{ error: { code, message } }` with the right status. Throwing (instead
 * of writing + returning) lets a deep helper abort a request mid-flight exactly like the PHP
 * `json_error(...); exit;` did.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Abort the request with a stable JSON error (mirrors PHP `json_error`). */
export function jsonError(code: string, message: string, status: number): never {
  throw new ApiError(code, message, status);
}
