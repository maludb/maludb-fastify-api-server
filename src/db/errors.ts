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

// ---------------------------------------------------------------------------
// SQLSTATE → (HTTP status, error code) mapping — the canonical cross-server
// table (mirrors the Python reference app/errors.py). Exact codes take
// priority; otherwise we fall back to the two-character SQLSTATE *class*.
// The original PHP-mirrored mappings are preserved (23505→409 conflict,
// 42501→403, the validation set→422) so the contract is unchanged.
// ---------------------------------------------------------------------------

/** Exact SQLSTATE overrides. */
const SQLSTATE_EXACT: Record<string, [number, string]> = {
  // Integrity constraint violations
  '23505': [409, 'conflict'], // unique_violation
  '23503': [422, 'validation_failed'], // foreign_key_violation
  '23502': [422, 'validation_failed'], // not_null_violation
  '23514': [422, 'validation_failed'], // check_violation
  // Data exceptions
  '22000': [422, 'validation_failed'], // data_exception (generic)
  '22023': [422, 'validation_failed'], // invalid_parameter_value
  '22P02': [422, 'validation_failed'], // invalid_text_representation
  // PL/pgSQL RAISE (custom business-rule errors from facade functions)
  P0001: [422, 'validation_failed'], // raise_exception
  // Access / privilege
  '42501': [403, 'insufficient_privilege'], // insufficient_privilege
  // Undefined database objects — almost always a schema/search_path/migration
  // mismatch on the server side.
  '42P01': [500, 'schema_error'], // undefined_table
  '42703': [500, 'schema_error'], // undefined_column
  '42883': [500, 'schema_error'], // undefined_function
  '42P02': [500, 'schema_error'], // undefined_parameter
  '3F000': [500, 'schema_error'], // invalid_schema_name
  // Transaction concurrency — retryable by the client.
  '40001': [409, 'serialization_failure'], // serialization_failure
  '40P01': [409, 'deadlock_detected'], // deadlock_detected
  '55P03': [409, 'lock_not_available'], // lock_not_available
  // Resource / operator
  '53300': [503, 'too_many_connections'], // too_many_connections
  '57014': [503, 'query_canceled'], // query_canceled (timeout)
};

/** SQLSTATE class (first two chars) → fallback mapping. */
const SQLSTATE_CLASS: Record<string, [number, string]> = {
  '08': [503, 'database_unavailable'], // connection exception
  '22': [422, 'validation_failed'], // data exception
  '23': [422, 'constraint_violation'], // integrity constraint violation
  '40': [409, 'transaction_conflict'], // transaction rollback
  '42': [500, 'query_error'], // syntax error / access rule violation
  '53': [503, 'insufficient_resources'], // insufficient resources
  '54': [500, 'program_limit_exceeded'], // program limit exceeded
  '57': [503, 'operator_intervention'], // operator intervention
  '58': [503, 'system_error'], // system error (external to PG)
  XX: [500, 'internal_database_error'], // internal error
};

/** node-postgres surfaces the SQLSTATE on `err.code`; require the 5-char shape. */
function sqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * Map a Postgres error to `{status, code, sqlstate}`. Resolution order: exact SQLSTATE, then the
 * two-character class, then a final generic 500. Shared by `mapError` (the Fastify error handler)
 * and the MCP dispatcher's isError payloads.
 */
export function classifyDatabaseError(err: unknown): {
  status: number;
  code: string;
  sqlstate: string | null;
} {
  const sqlstate = sqlstateOf(err);
  const exact = sqlstate !== null ? SQLSTATE_EXACT[sqlstate] : undefined;
  const byClass = sqlstate !== null ? SQLSTATE_CLASS[sqlstate.slice(0, 2)] : undefined;
  const [status, code] = exact ?? byClass ?? [500, 'internal_error'];
  return { status, code, sqlstate };
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

  const { status, code, sqlstate } = classifyDatabaseError(err);
  if (sqlstate !== null) {
    return { status, code, message: pgErrorMessage((err as Error).message ?? '') };
  }

  return { status: 500, code: 'internal_error', message: 'An unexpected error occurred.' };
}
