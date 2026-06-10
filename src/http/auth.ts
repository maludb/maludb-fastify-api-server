/**
 * Bearer-token auth (brief §7) — resolved against the local SQLite `users` store. The presented
 * token is hashed (sha256 of the part after `malu_`) and looked up; the matching row carries the
 * role and the tenant Postgres connection this request runs against. `requireAuth` builds the
 * per-request `ctx` (tenant pool, role, sql trace) that every DB helper threads through.
 *
 * Never log the full token — only its 8-char prefix, the user id, and the role.
 */
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { jsonError } from './errors.js';
import { resolveToken } from '../local-db/local-db.js';
import { getPool, tenantOf } from '../db/tenant.js';
import { debugEnabled } from '../config/env.js';
import type { RequestCtx } from '../types/db.js';

const PREFIX = 'malu_';

/** Extract the bearer token from an Authorization header value, or null. */
function tokenFromHeader(hdr: string | undefined): string | null {
  if (typeof hdr !== 'string') return null;
  const m = hdr.trim().match(/^Bearer\s+(\S+)$/i);
  return m ? (m[1] ?? null) : null;
}

/** Extract the bearer token from the Authorization header, or null. */
export function bearerToken(request: FastifyRequest): string | null {
  return tokenFromHeader(request.headers.authorization);
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Resolve an `Authorization` header value to a request context: extract the `malu_` token, hash
 * its body, look it up in the local store, and bind the tenant pool. Throws 401 `auth_missing` /
 * `auth_invalid` on failure. Shared by the REST `requireAuth` dependency and the MCP endpoint —
 * request-specific fields (`method`, `path`, `debug`) are left for the caller to fill in.
 */
export function resolveAuthContext(authHeader: string | undefined, endpointFile: string): RequestCtx {
  const token = tokenFromHeader(authHeader);
  if (token === null) {
    jsonError('auth_missing', 'Authorization: Bearer token required.', 401);
  }
  if (!token.startsWith(PREFIX)) {
    jsonError('auth_invalid', 'Malformed API token.', 401);
  }
  const body = token.slice(PREFIX.length);
  const row = resolveToken(sha256Hex(body));
  if (row === null) {
    jsonError('auth_invalid', 'Invalid or expired API token.', 401);
  }

  const tenant = tenantOf(row);
  return {
    userId: row.user_id,
    role: row.role,
    tokenPrefix: body.slice(0, 8),
    tenant,
    pool: getPool(tenant),
    sqlTrace: [],
    endpointFile,
    method: '',
    path: '',
    debug: false,
  };
}

/**
 * Authenticate the request and build its `ctx`. `endpointFile` is the route file's own name (e.g.
 * `'subjects.ts'`) — it labels the SQL log and the `?debug=1` block, so the URL→file→SQL trail
 * stays intact. Aborts with 401 `auth_missing` / `auth_invalid` on failure.
 */
export async function requireAuth(
  request: FastifyRequest,
  endpointFile: string,
): Promise<RequestCtx> {
  const ctx = resolveAuthContext(request.headers.authorization, endpointFile);
  const query = (request.query ?? {}) as Record<string, unknown>;
  ctx.method = request.method;
  ctx.path = request.url;
  ctx.debug = debugEnabled() && query.debug === '1';
  // Stash on the request so the api.log hook can report user_id + token_prefix.
  (request as FastifyRequest & { ctx?: RequestCtx }).ctx = ctx;
  return ctx;
}

/** The role attached to an authenticated request (helper for role-gated endpoints). */
export function currentRole(ctx: RequestCtx): string | null {
  return ctx.role;
}
