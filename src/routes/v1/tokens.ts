/**
 * GET  /v1/tokens   — list tokens for a Postgres connection (metadata only)
 * POST /v1/tokens   — mint a new API token for a Postgres connection
 *
 * MaluDB concept: token issuance against the local config store (no Postgres tenant query).
 * SQL objects: none — operates on the local SQLite `users` table.
 * Teaches:
 *   - Authorization IS the Postgres login: the caller proves it by supplying working
 *     pg_dbname/pg_user/pg_password, which we verify by connecting (testCredentials).
 *   - The plaintext token is returned ONCE; only sha256(token after `malu_`) is stored.
 *   - Does NOT call requireAuth — it bootstraps the very tokens requireAuth later resolves.
 */
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { bodyObject } from '../../http/request.js';
import { testCredentials } from '../../db/tenant.js';
import { insertToken, listTokens, nextUserId } from '../../local-db/local-db.js';

/** Pull + verify the Postgres connection triple from the body. */
async function tokensAuthorize(
  body: Record<string, unknown>,
): Promise<{ db: string; user: string; pass: string }> {
  const db = String(body.pg_dbname ?? '').trim();
  const user = String(body.pg_user ?? '').trim();
  const pass = 'pg_password' in body ? String(body.pg_password ?? '') : '';
  if (db === '' || user === '' || pass === '') {
    jsonError('missing_field', 'pg_dbname, pg_user and pg_password are required.', 400);
  }
  if (!(await testCredentials({ dbname: db, user, password: pass }))) {
    jsonError('pg_auth_failed', 'Could not connect to Postgres with the supplied credentials.', 403);
  }
  return { db, user, pass };
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/tokens',
    handler: async (request, reply) => {
      const body = bodyObject(request);

      if (request.method === 'POST') {
        const { db, user, pass } = await tokensAuthorize(body);

        const role = body.role !== undefined && String(body.role).trim() !== '' ? String(body.role) : 'executor';
        const deviceName =
          body.device_name !== undefined && String(body.device_name).trim() !== ''
            ? String(body.device_name)
            : null;
        const userId = Number.isInteger(body.user_id) ? (body.user_id as number) : nextUserId();

        let expiresAt: string | null = null;
        if (body.expires_in_days !== undefined && body.expires_in_days !== null) {
          if (!Number.isInteger(body.expires_in_days) || (body.expires_in_days as number) <= 0) {
            jsonError('validation_failed', '"expires_in_days" must be a positive integer.', 422);
          }
          expiresAt = new Date(Date.now() + (body.expires_in_days as number) * 86_400_000).toISOString();
        }

        // malu_<base64url(32 random bytes)>; store only sha256 of the part after the prefix + a short prefix.
        const raw = randomBytes(32).toString('base64url');
        const token = `malu_${raw}`;
        const hash = createHash('sha256').update(raw).digest('hex');
        const prefix = raw.slice(0, 8);

        const id = insertToken({
          tokenHash: hash,
          tokenPrefix: prefix,
          userId,
          role,
          pgDbname: db,
          pgUser: user,
          pgPassword: pass,
          expiresAt,
          deviceName,
        });

        jsonResponse(
          reply,
          {
            token, // shown ONCE — not recoverable later
            id,
            user_id: userId,
            role,
            pg_dbname: db,
            pg_user: user,
            expires_at: expiresAt,
            device_name: deviceName,
          },
          201,
        );
        return;
      }

      // GET
      const { db, user } = await tokensAuthorize(body);
      const rows = listTokens(db, user);
      for (const r of rows) {
        r.id = Number(r.id);
        r.user_id = Number(r.user_id);
      }
      jsonResponse(reply, { tokens: rows });
    },
  });
}
