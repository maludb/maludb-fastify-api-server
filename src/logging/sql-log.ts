/**
 * SQL tracing (brief §10). Every executed statement is (a) pushed onto the request's `sqlTrace`
 * for the optional `?debug=1` block and (b) appended to `sql.log`. Format mirrors the PHP
 * `sql_log()` block so existing log tooling keeps working.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { sqlLogPath } from '../config/paths.js';
import type { RequestCtx } from '../types/db.js';

/** ISO-8601 UTC timestamp with millisecond precision, e.g. `2026-06-08T12:34:56.789Z`. */
export function isoNowMs(): string {
  return new Date().toISOString();
}

/**
 * A loggable stand-in for one query parameter. bytea params (document bytes, skill bundle
 * files) are summarized — JSON.stringify of a Buffer explodes into `{"type":"Buffer",...}`
 * and megabyte blobs don't belong in sql.log or `?debug=1` responses anyway.
 */
export function jsonSafeParam(p: unknown): unknown {
  if (Buffer.isBuffer(p) || p instanceof Uint8Array) {
    const b = Buffer.isBuffer(p) ? p : Buffer.from(p);
    const sha = createHash('sha256').update(b).digest('hex').slice(0, 12);
    return `<${b.length} bytes sha256:${sha}>`;
  }
  return p;
}

/** Render the multi-line `sql.log` block for one executed statement. */
export function formatSqlLine(o: {
  time: string;
  file: string;
  method: string;
  path: string;
  user: string;
  sql: string;
  params: unknown[];
  rows: number;
  durMs: number;
}): string {
  const sql = o.sql.trim().replace(/\n/g, '\n       ');
  return (
    `${o.time}  ${o.file}  ${o.method}  ${o.path}  user=${o.user}\n` +
    `  SQL: ${sql}\n` +
    `  PARAMS: ${JSON.stringify(o.params)}\n` +
    `  ROWS: ${o.rows}\n` +
    `  DUR:  ${o.durMs.toFixed(1)} ms\n\n`
  );
}

let dirReady = false;
function appendSafe(path: string, line: string): void {
  try {
    if (!dirReady) {
      mkdirSync(dirname(path), { recursive: true });
      dirReady = true;
    }
    appendFileSync(path, line);
  } catch {
    // Logging must never break a request. Swallow filesystem errors.
  }
}

/**
 * Record one executed statement: push onto `ctx.sqlTrace` (for `?debug=1`) and append to `sql.log`.
 * `loggedParams` lets callers pass a redacted copy (token-bearing writes); defaults to `params`.
 */
export function sqlLog(
  ctx: RequestCtx,
  sql: string,
  params: unknown[],
  rows: number,
  durMs: number,
  loggedParams: unknown[] = params,
): void {
  const safeParams = loggedParams.map(jsonSafeParam);
  ctx.sqlTrace.push({
    sql: sql.trim(),
    params: safeParams,
    rows,
    dur_ms: Math.round(durMs * 10) / 10,
  });
  appendSafe(
    sqlLogPath(),
    formatSqlLine({
      time: isoNowMs(),
      file: ctx.endpointFile,
      method: ctx.method,
      path: ctx.path,
      user: String(ctx.userId),
      sql,
      params: safeParams,
      rows,
      durMs,
    }),
  );
}
