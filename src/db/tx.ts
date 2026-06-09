/**
 * Transaction helpers. `dbTx` runs a callback in a plain transaction; `dbTxCore` additionally sets
 * the search path the maludb_core facade functions need:
 *
 *   SET LOCAL search_path TO public, maludb_core
 *
 * Why: the maludb_* facade views/functions reference their `malu$*` base tables + RLS grant tables
 * unqualified, so they only resolve with `maludb_core` on the path. `public` stays first so
 * `current_schema()` = the tenant schema (owner_schema resolution / RLS). `SET LOCAL` scopes it to
 * the transaction. The callback receives the pooled client; `dbMany/dbOne/dbExec` use that same
 * connection (via `ctx.client`), so they join the transaction and its search path. Mirrors the PHP
 * `db_tx_core`.
 */
import type { PoolClient } from 'pg';
import { tenantErrorFromConnFailure } from './postgres.js';
import type { RequestCtx } from '../types/db.js';

async function connect(ctx: RequestCtx): Promise<PoolClient> {
  try {
    return await ctx.pool.connect();
  } catch (err) {
    throw tenantErrorFromConnFailure(err) ?? err;
  }
}

async function withTx<T>(
  ctx: RequestCtx,
  setup: ((client: PoolClient) => Promise<void>) | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await connect(ctx);
  const previous = ctx.client;
  ctx.client = client;
  try {
    await client.query('BEGIN');
    if (setup) await setup(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure; surface the original error
    }
    throw tenantErrorFromConnFailure(err) ?? err;
  } finally {
    ctx.client = previous;
    client.release();
  }
}

/** Run `fn` inside a plain transaction. */
export function dbTx<T>(ctx: RequestCtx, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTx(ctx, null, fn);
}

/** Run `fn` inside a transaction with `search_path = public, maludb_core` (maludb_core facades). */
export function dbTxCore<T>(ctx: RequestCtx, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTx(
    ctx,
    (client) => client.query('SET LOCAL search_path TO public, maludb_core').then(() => undefined),
    fn,
  );
}
