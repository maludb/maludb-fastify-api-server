/**
 * GET   /v1/pools/:id
 * PATCH /v1/pools/:id
 *
 * MaluDB concept: Pool detail (requirements.md §4.7).
 * SQL objects: maludb_memory_pool.
 * Teaches:
 *   - Live-schema mapping: pool_id -> id, pool_name -> name, task_objective -> description.
 *   - No DELETE in v1.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne, dbExec } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'pools_id.ts';

/** Fetch a pool by id, or null. */
async function loadPool(ctx: RequestCtx, id: number): Promise<Record<string, unknown> | null> {
  const pool = await dbOne(
    ctx,
    `SELECT pool_id AS id, pool_name AS name, task_objective AS description,
            lifecycle_state, archived_at, created_at, updated_at
       FROM maludb_memory_pool
      WHERE pool_id = $1`,
    [id],
  );
  if (pool === null) {
    return null;
  }
  pool.id = Number(pool.id);
  return pool;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH'],
    url: '/v1/pools/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const pool = await loadPool(ctx, id);
          if (pool === null) {
            jsonError('not_found', 'Pool not found.', 404);
          }
          jsonResponse(reply, { pool }, 200, ctx);
          return;
        }

        case 'PATCH': {
          if ((await dbOne(ctx, 'SELECT 1 FROM maludb_memory_pool WHERE pool_id = $1', [id])) === null) {
            jsonError('not_found', 'Pool not found.', 404);
          }

          const body = bodyObject(request);
          const fields: string[] = [];
          const params: unknown[] = [];

          if (Object.prototype.hasOwnProperty.call(body, 'name')) {
            const name = String(body.name ?? '').trim();
            if (name === '') {
              jsonError('validation_failed', 'Field "name" cannot be empty.', 422);
            }
            params.push(name);
            fields.push(`pool_name = $${params.length}`);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'description')) {
            params.push(body.description === null ? null : String(body.description));
            fields.push(`task_objective = $${params.length}`);
          }
          if (fields.length === 0) {
            jsonError('bad_request', 'No updatable fields provided (name, description).', 400);
          }

          fields.push('updated_at = now()');
          params.push(id);
          await dbExec(
            ctx,
            `UPDATE maludb_memory_pool SET ${fields.join(', ')} WHERE pool_id = $${params.length}`,
            params,
          );

          jsonResponse(reply, { pool: await loadPool(ctx, id) }, 200, ctx);
          return;
        }
      }
    },
  });
}
