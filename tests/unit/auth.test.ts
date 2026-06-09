import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { requireAuth, bearerToken } from '../../src/http/auth.js';
import { ApiError } from '../../src/http/errors.js';
import { insertToken, closeLocalDb } from '../../src/local-db/local-db.js';
import { shutdownPools } from '../../src/db/tenant.js';

afterAll(async () => {
  await shutdownPools();
  closeLocalDb();
});

function req(headers: Record<string, string>, query: Record<string, unknown> = {}): FastifyRequest {
  return {
    headers,
    query,
    method: 'GET',
    url: '/v1/subjects',
  } as unknown as FastifyRequest;
}

function seedAuthToken(body: string): void {
  insertToken({
    tokenHash: createHash('sha256').update(body).digest('hex'),
    tokenPrefix: body.slice(0, 8),
    userId: 99,
    role: 'admin',
    pgDbname: 'auth_tenant_db',
    pgUser: 'auth_tenant_user',
    pgPassword: 'auth_tenant_pass',
    expiresAt: null,
    deviceName: null,
  });
}

describe('bearerToken', () => {
  it('extracts the token from the Authorization header', () => {
    expect(bearerToken(req({ authorization: 'Bearer malu_abc' }))).toBe('malu_abc');
  });
  it('returns null when absent or malformed', () => {
    expect(bearerToken(req({}))).toBeNull();
    expect(bearerToken(req({ authorization: 'Basic xyz' }))).toBeNull();
  });
});

describe('requireAuth', () => {
  it('rejects a missing token with 401 auth_missing', async () => {
    await expect(requireAuth(req({}), 'subjects.ts')).rejects.toMatchObject({
      code: 'auth_missing',
      status: 401,
    });
  });

  it('rejects a non-malu token with 401 auth_invalid', async () => {
    await expect(requireAuth(req({ authorization: 'Bearer nope' }), 'subjects.ts')).rejects.toMatchObject({
      code: 'auth_invalid',
    });
  });

  it('rejects an unknown token with 401 auth_invalid', async () => {
    await expect(
      requireAuth(req({ authorization: 'Bearer malu_unknownbody' }), 'subjects.ts'),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('builds the ctx (user, role, tenant, prefix) for a valid token', async () => {
    const body = 'aBcDeFgH_validbody_1234';
    seedAuthToken(body);
    const ctx = await requireAuth(req({ authorization: `Bearer malu_${body}` }), 'subjects.ts');
    expect(ctx).toMatchObject({
      userId: 99,
      role: 'admin',
      tokenPrefix: body.slice(0, 8),
      endpointFile: 'subjects.ts',
      tenant: { dbname: 'auth_tenant_db', user: 'auth_tenant_user', password: 'auth_tenant_pass' },
    });
    expect(ctx.sqlTrace).toEqual([]);
    expect(ctx.pool).toBeDefined();
  });

  it('sets ctx.debug only when MALUDB_DEBUG=1 and ?debug=1', async () => {
    const body = 'debugbody_5678';
    seedAuthToken(body);
    const headers = { authorization: `Bearer malu_${body}` };
    // server debug off by default → debug false even with ?debug=1
    const ctx = await requireAuth(req(headers, { debug: '1' }), 'subjects.ts');
    expect(ctx.debug).toBe(false);
  });
});
