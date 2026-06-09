/**
 * Query helpers (brief §9). The ONLY way endpoints touch Postgres. Each call prepares + executes
 * the literal SQL, binds positional params, measures duration, counts rows, logs to sql.log +
 * the debug trace, and normalizes tenant connection failures. It does NOT build SQL, know any
 * domain concept, or do generic CRUD — the SQL lives in the route file.
 *
 * Runs on `ctx.client` when inside a transaction (set by dbTx/dbTxCore), else on the tenant pool —
 * so every query in a `dbTxCore` callback shares the connection and its `SET LOCAL search_path`.
 */
import type { QueryResult } from 'pg';
import { sqlLog } from '../logging/sql-log.js';
import { tenantErrorFromConnFailure } from './postgres.js';
import type { RequestCtx, Row } from '../types/db.js';

async function run(ctx: RequestCtx, sql: string, params: unknown[]): Promise<QueryResult> {
  const runner = ctx.client ?? ctx.pool;
  const t0 = performance.now();
  let res: QueryResult;
  try {
    res = await runner.query(sql, params as unknown[]);
  } catch (err) {
    const tenantErr = tenantErrorFromConnFailure(err);
    throw tenantErr ?? err;
  }
  const rows = res.rowCount ?? res.rows.length;
  sqlLog(ctx, sql, params, rows, performance.now() - t0);
  return res;
}

/** Execute and return all rows. */
export async function dbMany<T = Row>(
  ctx: RequestCtx,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await run(ctx, sql, params)).rows as T[];
}

/** Execute and return the first row, or null. */
export async function dbOne<T = Row>(
  ctx: RequestCtx,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  return ((await run(ctx, sql, params)).rows[0] as T | undefined) ?? null;
}

/** Execute and return the affected row count. */
export async function dbExec(ctx: RequestCtx, sql: string, params: unknown[] = []): Promise<number> {
  return (await run(ctx, sql, params)).rowCount ?? 0;
}
