import { describe, it, expect } from 'vitest';
import { tenantErrorFromConnFailure } from '../../src/db/postgres.js';
import { TenantDbError } from '../../src/db/errors.js';
import { dbMany, dbOne, dbExec } from '../../src/db/query.js';
import { dbTxCore } from '../../src/db/tx.js';
import type { RequestCtx } from '../../src/types/db.js';

function ctxWith(overrides: Partial<RequestCtx>): RequestCtx {
  return {
    userId: 1,
    role: 'executor',
    tokenPrefix: 'abc',
    tenant: { dbname: 'd', user: 'u', password: 'p' },
    pool: {} as RequestCtx['pool'],
    sqlTrace: [],
    endpointFile: 'test.ts',
    method: 'GET',
    path: '/v1/x',
    debug: false,
    ...overrides,
  };
}

describe('tenantErrorFromConnFailure', () => {
  it('classifies 28xxx as an auth failure', () => {
    const e = tenantErrorFromConnFailure({ code: '28P01' });
    expect(e).toBeInstanceOf(TenantDbError);
    expect(e?.isAuthFailure).toBe(true);
  });
  it('classifies 08xxx / socket errors as unavailable', () => {
    expect(tenantErrorFromConnFailure({ code: '08006' })?.isAuthFailure).toBe(false);
    expect(tenantErrorFromConnFailure({ code: 'ECONNREFUSED' })?.isAuthFailure).toBe(false);
  });
  it('detects auth failure from the message', () => {
    const e = tenantErrorFromConnFailure({ message: 'password authentication failed for user "u"' });
    expect(e?.isAuthFailure).toBe(true);
  });
  it('returns null for a normal query SQLSTATE (so it maps to 409/422)', () => {
    expect(tenantErrorFromConnFailure({ code: '23505' })).toBeNull();
  });
});

describe('query helpers', () => {
  const fakePool = {
    query: async (_sql: string, _params: unknown[]) => ({ rows: [{ a: 1 }, { a: 2 }], rowCount: 2 }),
  };

  it('dbMany returns rows and records a trace entry', async () => {
    const ctx = ctxWith({ pool: fakePool as unknown as RequestCtx['pool'] });
    const rows = await dbMany(ctx, 'SELECT a FROM t', []);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(ctx.sqlTrace).toHaveLength(1);
    expect(ctx.sqlTrace[0]).toMatchObject({ sql: 'SELECT a FROM t', rows: 2 });
  });

  it('dbOne returns the first row or null', async () => {
    const ctx = ctxWith({ pool: fakePool as unknown as RequestCtx['pool'] });
    expect(await dbOne(ctx, 'SELECT a', [])).toEqual({ a: 1 });
    const empty = ctxWith({
      pool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as RequestCtx['pool'],
    });
    expect(await dbOne(empty, 'SELECT a', [])).toBeNull();
  });

  it('dbExec returns the affected row count', async () => {
    const ctx = ctxWith({
      pool: { query: async () => ({ rows: [], rowCount: 3 }) } as unknown as RequestCtx['pool'],
    });
    expect(await dbExec(ctx, 'UPDATE t SET x=1', [])).toBe(3);
  });

  it('rethrows a tenant connection failure as TenantDbError', async () => {
    const ctx = ctxWith({
      pool: {
        query: async () => {
          throw { code: '28P01' };
        },
      } as unknown as RequestCtx['pool'],
    });
    await expect(dbMany(ctx, 'SELECT 1', [])).rejects.toBeInstanceOf(TenantDbError);
  });

  it('passes through a normal SQLSTATE error unchanged', async () => {
    const ctx = ctxWith({
      pool: {
        query: async () => {
          throw { code: '23505', message: 'ERROR: duplicate key' };
        },
      } as unknown as RequestCtx['pool'],
    });
    await expect(dbMany(ctx, 'INSERT ...', [])).rejects.toMatchObject({ code: '23505' });
  });
});

describe('dbTxCore', () => {
  it('runs BEGIN + SET LOCAL search_path + COMMIT and shares ctx.client', async () => {
    const issued: string[] = [];
    const client = {
      query: async (sql: string) => {
        issued.push(sql);
        return { rows: [{ ok: true }], rowCount: 1 };
      },
      release: () => undefined,
    };
    const ctx = ctxWith({
      pool: { connect: async () => client } as unknown as RequestCtx['pool'],
    });

    const result = await dbTxCore(ctx, async () => {
      // helpers inside the tx should hit ctx.client (the tx connection)
      expect(ctx.client).toBe(client);
      return dbOne(ctx, 'SELECT 1', []);
    });

    expect(result).toEqual({ ok: true });
    expect(issued[0]).toBe('BEGIN');
    // Layers maludb_core onto the LOGIN search_path (keeps a role-pinned tenant schema first).
    expect(issued[1]).toBe(
      "SELECT set_config('search_path', current_setting('search_path') || ', maludb_core, public', true)",
    );
    expect(issued).toContain('COMMIT');
    expect(ctx.client).toBeUndefined(); // restored after the tx
  });

  it('rolls back on error', async () => {
    const issued: string[] = [];
    const client = {
      query: async (sql: string) => {
        issued.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const ctx = ctxWith({ pool: { connect: async () => client } as unknown as RequestCtx['pool'] });

    await expect(
      dbTxCore(ctx, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(issued).toContain('ROLLBACK');
  });
});
