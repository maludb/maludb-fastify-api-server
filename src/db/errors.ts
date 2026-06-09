/**
 * PostgreSQL error normalization (mirrors the PHP `handle_uncaught`). A raw pg/tenant error is
 * mapped to the stable client envelope: known SQLSTATEs become 409/403/422 instead of an opaque
 * 500, and a failed tenant connection becomes 502/503. The human-readable "ERROR: …" line is
 * extracted so the client sees the DB's own message (e.g. a trigger RAISE) without the stack.
 */
import { ApiError } from '../http/errors.js';

/**
 * Raised when the tenant Postgres connection itself fails — a rejected stored credential
 * (`isAuthFailure`) vs an unreachable database. Carries the SQLSTATE for diagnostics.
 */
export class TenantDbError extends Error {
  readonly sqlstate: string;
  readonly isAuthFailure: boolean;
  constructor(message: string, sqlstate: string, isAuthFailure: boolean) {
    super(message);
    this.name = 'TenantDbError';
    this.sqlstate = sqlstate;
    this.isAuthFailure = isAuthFailure;
  }
}

/** Pull the "ERROR: …" line out of a Postgres message; fall back to the whole message. */
export function pgErrorMessage(message: string): string {
  const m = message.match(/ERROR:\s*(.+?)(\n|$)/s);
  return m && m[1] ? m[1].trim() : message;
}

export interface MappedError {
  status: number;
  code: string;
  message: string;
}

/** Map any thrown error to `{status, code, message}` for the response envelope + api.log. */
export function mapError(err: unknown): MappedError {
  if (err instanceof ApiError) {
    return { status: err.status, code: err.code, message: err.message };
  }

  if (err instanceof TenantDbError) {
    return err.isAuthFailure
      ? {
          status: 502,
          code: 'tenant_db_auth_failed',
          message: 'The database credentials stored for this API token were rejected by Postgres.',
        }
      : {
          status: 503,
          code: 'tenant_db_unavailable',
          message: 'The tenant database is currently unavailable.',
        };
  }

  // node-postgres surfaces the SQLSTATE on `err.code`.
  const sqlstate = (err as { code?: unknown } | null)?.code;
  if (typeof sqlstate === 'string') {
    const message = pgErrorMessage((err as Error).message ?? '');
    switch (sqlstate) {
      case '23505': // unique_violation
        return { status: 409, code: 'conflict', message };
      case '42501': // insufficient_privilege
        return { status: 403, code: 'insufficient_privilege', message };
      case '23502': // not_null_violation
      case '23503': // foreign_key_violation
      case '23514': // check_violation
      case '22000': // data_exception
      case '22023': // invalid_parameter_value
      case '22P02': // invalid_text_representation (bad cast)
      case 'P0001': // raise_exception (trigger RAISE)
        return { status: 422, code: 'validation_failed', message };
    }
  }

  return { status: 500, code: 'internal_error', message: 'An unexpected error occurred.' };
}
