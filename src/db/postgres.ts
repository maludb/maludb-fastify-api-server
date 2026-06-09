/**
 * PostgreSQL connection plumbing. The deployment's host/port are fixed (env); the database
 * name/user/password come from the API token (per request). This module builds pg client/pool
 * configs and classifies *connection* failures — a rejected stored credential vs an unreachable DB
 * — into a `TenantDbError`, so the global handler returns a clear 502/503 instead of an opaque 500
 * (mirrors the PHP `Database` constructor's classification).
 */
import type { PoolConfig } from 'pg';
import { pgHost, pgPort } from '../config/env.js';
import { TenantDbError } from './errors.js';
import type { TenantConfig } from '../types/db.js';

/** Build the pg connection config for a tenant (host/port fixed; sslmode disabled like the PHP). */
export function pgConfig(tenant: TenantConfig): PoolConfig {
  return {
    host: pgHost(),
    port: pgPort(),
    database: tenant.dbname,
    user: tenant.user,
    password: tenant.password,
    ssl: false,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
    max: 10,
  };
}

/**
 * If `err` is a tenant *connection* failure (not a normal query SQLSTATE), return the matching
 * `TenantDbError`; otherwise null (the caller rethrows so `mapError` can classify the SQLSTATE).
 *
 * - SQLSTATE `28xxx` (invalid_authorization / invalid_password) or a "password authentication
 *   failed" message → auth failure (502).
 * - SQLSTATE `08xxx` / `3D000`, or socket errors (ECONNREFUSED/ETIMEDOUT/ENOTFOUND/…) → unavailable (503).
 */
export function tenantErrorFromConnFailure(err: unknown): TenantDbError | null {
  const code = (err as { code?: unknown } | null)?.code;
  const message = String((err as { message?: unknown } | null)?.message ?? '');

  if (typeof code === 'string') {
    if (code.startsWith('28')) return new TenantDbError('Tenant credentials rejected.', code, true);
    if (
      code.startsWith('08') ||
      code === '3D000' ||
      ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EPIPE'].includes(code)
    ) {
      return new TenantDbError('Tenant database unreachable.', code, false);
    }
  }
  if (/password authentication failed/i.test(message)) {
    return new TenantDbError('Tenant credentials rejected.', typeof code === 'string' ? code : '28P01', true);
  }
  return null;
}
