/**
 * A query helper that logs a redacted form of its params. The standard `dbOne` would write the
 * plaintext bind values to sql.log; memory-pipeline writes that bind a model token use this instead,
 * passing the 1-based positions to mask (mirrors the PHP `db_one_redacted`).
 */
import { sqlLog } from '../logging/sql-log.js';
import { redactParams } from '../logging/redact.js';
import { tenantErrorFromConnFailure } from './postgres.js';
import type { RequestCtx, Row } from '../types/db.js';

/** Like `dbOne`, but the given 1-based param positions are logged as `<redacted>`. */
export async function dbOneRedacted<T = Row>(
  ctx: RequestCtx,
  sql: string,
  params: unknown[],
  redact1Based: number[],
): Promise<T | null> {
  const runner = ctx.client ?? ctx.pool;
  const t0 = performance.now();
  let res;
  try {
    res = await runner.query(sql, params);
  } catch (err) {
    throw tenantErrorFromConnFailure(err) ?? err;
  }
  const rows = res.rowCount ?? res.rows.length;
  sqlLog(ctx, sql, params, rows, performance.now() - t0, redactParams(params, redact1Based));
  return (res.rows[0] as T | undefined) ?? null;
}
