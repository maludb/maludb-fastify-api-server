/**
 * Transaction helpers. `dbTx` runs a callback in a plain transaction; `dbTxCore` additionally
 * layers the schemas the maludb_core facade functions need onto the session search_path:
 *
 *   SET LOCAL search_path = <login search_path>, maludb_core, public
 *
 * Why: the maludb_* facade views/functions reference their `malu$*` base tables + RLS grant tables
 * unqualified, so they only resolve with `maludb_core` on the path. The login search_path stays
 * first so `current_schema()` = the tenant schema (owner_schema resolution / RLS) — including
 * tenants whose facade schema is NOT `public` but a named schema pinned on the role
 * (`ALTER ROLE <role> SET search_path TO <schema>, maludb_core, public`); hard-coding `public`
 * here would mask such a schema inside every transaction. `SET LOCAL` scopes it to the
 * transaction. The callback receives the pooled client; `dbMany/dbOne/dbExec` use that same
 * connection (via `ctx.client`), so they join the transaction and its search path. Mirrors the
 * Python reference `db_tx_core` (which layers `maludb_core` per-transaction the same way).
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

/** Run `fn` inside a transaction with the maludb_core facades layered onto the search_path. */
export function dbTxCore<T>(ctx: RequestCtx, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTx(
    ctx,
    (client) =>
      client
        .query(
          "SELECT set_config('search_path'," +
            " current_setting('search_path') || ', maludb_core, public', true)",
        )
        .then(() => undefined),
    fn,
  );
}
