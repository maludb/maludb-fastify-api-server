/**
 * DELETE /v1/tokens/:id  — revoke (delete) a token row.
 *
 * MaluDB concept: token revocation against the local config store.
 * SQL objects: none — operates on the local SQLite `users` table.
 * Teaches:
 *   - Same authorization as /v1/tokens: prove the Postgres login (pg_dbname/pg_user/pg_password).
 *   - You can only revoke a token that belongs to the connection whose password you can prove.
 *   - Does NOT call requireAuth.
 */
import type { FastifyInstance } from 'fastify';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import { testCredentials } from '../../db/tenant.js';
import { getToken, deleteToken } from '../../local-db/local-db.js';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['DELETE'],
    url: '/v1/tokens/:id',
    handler: async (request, reply) => {
      const id = pathId(request);
      const body = bodyObject(request);

      const db = String(body.pg_dbname ?? '').trim();
      const user = String(body.pg_user ?? '').trim();
      const pass = 'pg_password' in body ? String(body.pg_password ?? '') : '';
      if (db === '' || user === '' || pass === '') {
        jsonError('missing_field', 'pg_dbname, pg_user and pg_password are required.', 400);
      }
      if (!(await testCredentials({ dbname: db, user, password: pass }))) {
        jsonError('pg_auth_failed', 'Could not connect to Postgres with the supplied credentials.', 403);
      }

      const found = getToken(id);
      if (found === null) {
        jsonError('not_found', 'Token not found.', 404);
      }
      // Only allow revoking a token that belongs to the connection the caller authenticated with.
      if (found.pg_dbname !== db || found.pg_user !== user) {
        jsonError('forbidden', 'This token does not belong to the supplied Postgres connection.', 403);
      }

      deleteToken(id);
      jsonResponse(reply, { deleted: true, id });
    },
  });
}
