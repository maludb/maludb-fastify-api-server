/**
 * Database-layer types. The `RequestCtx` is the single piece of per-request state that threads
 * through every DB helper — it replaces the PHP request-scoped globals (`$__auth_user_id`,
 * `$__sql_trace`) and the per-request `Database::configure()` connection. Node serves many requests
 * in one process, so this state MUST live on the request, not on a module global.
 */
import type { Pool, PoolClient } from 'pg';

/** A generic result row. Postgres column names are snake_case; we keep them as-is. */
export type Row = Record<string, any>;

/** The tenant Postgres connection resolved from an API token (host/port are fixed in env). */
export interface TenantConfig {
  dbname: string;
  user: string;
  password: string;
}

/** One executed query, collected for `sql.log` and the `?debug=1` meta block. */
export interface SqlTraceEntry {
  sql: string;
  params: unknown[];
  rows: number;
  dur_ms: number;
}

/**
 * Per-request context. Built by `requireAuth()`; passed to `dbMany/dbOne/dbExec/dbTx*`.
 * Inside `dbTxCore`, `client` is set so all helpers share the transaction's connection
 * (mirroring how the PHP helpers all share the one PDO handle inside `db_tx_core`).
 */
export interface RequestCtx {
  userId: number | 'anon';
  role: string | null;
  tokenPrefix: string | null;
  tenant: TenantConfig;
  pool: Pool;
  client?: PoolClient;
  sqlTrace: SqlTraceEntry[];
  endpointFile: string;
  method: string;
  path: string;
  /** True when `?debug=1` AND the server has MALUDB_DEBUG=1 — gates `meta.debug` (brief §12). */
  debug: boolean;
}
