/**
 * POST /v1/pools/:id/archive
 *
 * MaluDB concept: Archive a memory pool (requirements.md §4.7).
 * SQL objects: maludb_memory_pool.
 * Teaches:
 *   - Sets lifecycle_state='archived' + archived_at=now().
 *   - 409 already_archived if already archived/sealed/tombstoned (archived_at set or
 *     lifecycle_state already 'archived').
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne, dbExec } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId } from '../../http/request.js';

const FILE = 'pools_id_archive.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST'],
    url: '/v1/pools/:id/archive',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      const pool = await dbOne(
        ctx,
        'SELECT lifecycle_state, archived_at FROM maludb_memory_pool WHERE pool_id = $1',
        [id],
      );
      if (pool === null) {
        jsonError('not_found', 'Pool not found.', 404);
      }
      if (pool.archived_at !== null || pool.lifecycle_state === 'archived') {
        jsonError('already_archived', 'Pool is already archived.', 409);
      }

      await dbExec(
        ctx,
        `UPDATE maludb_memory_pool
            SET lifecycle_state = 'archived', archived_at = now(), updated_at = now()
          WHERE pool_id = $1`,
        [id],
      );

      const updated = await dbOne(
        ctx,
        `SELECT pool_id AS id, pool_name AS name, task_objective AS description,
                lifecycle_state, archived_at, created_at
           FROM maludb_memory_pool WHERE pool_id = $1`,
        [id],
      );
      if (updated === null) jsonError('internal_error', 'Pool archive returned no row.', 500);
      updated.id = Number(updated.id);

      jsonResponse(reply, { pool: updated }, 200, ctx);
    },
  });
}
