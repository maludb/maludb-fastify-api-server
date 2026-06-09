/**
 * GET  /v1/pools
 * POST /v1/pools
 *
 * MaluDB concept: Memory pools (requirements.md §4.7).
 * SQL objects: maludb_memory_pool (direct-INSERT view; pool_id from sequence).
 * Teaches:
 *   - Live-schema mapping: pool_id -> id, pool_name -> name, task_objective -> description.
 *   - GET excludes tombstoned pools (lifecycle_state IS DISTINCT FROM 'tombstoned').
 *   - POST sets creation_kind 'api'; lifecycle_state defaults to 'active'.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr, bodyObject } from '../../http/request.js';

const FILE = 'pools.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/pools',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      if (request.method === 'GET') {
        const q = queryStr(request, 'q', null, 200);
        const limit = queryInt(request, 'limit', 50, 200) ?? 50;

        let where = "WHERE (lifecycle_state IS DISTINCT FROM 'tombstoned')";
        const params: unknown[] = [];
        if (q !== null && q !== '') {
          where += ' AND (pool_name ILIKE $1 OR task_objective ILIKE $1)';
          params.push(`%${q}%`);
        }
        params.push(limit);
        const limitIdx = params.length;

        const sql = `
          SELECT pool_id        AS id,
                 pool_name      AS name,
                 task_objective AS description,
                 lifecycle_state,
                 archived_at,
                 created_at
            FROM maludb_memory_pool
            ${where}
           ORDER BY pool_name
           LIMIT $${limitIdx}`;

        const rows = await dbMany(ctx, sql, params);
        for (const r of rows) {
          r.id = Number(r.id);
        }

        jsonResponse(reply, { pools: rows }, 200, ctx);
        return;
      }

      // POST
      const body = bodyObject(request);
      const name = String(body.name ?? '').trim();
      if (name === '') {
        jsonError('missing_field', 'Field "name" is required.', 400);
      }
      const description = body.description !== undefined ? String(body.description) : null;

      // pool_id is sequence-assigned; creation_kind must be one of prompt|api|mcp|sql.
      const created = await dbOne(
        ctx,
        `INSERT INTO maludb_memory_pool (pool_name, task_objective, creation_kind, created_at)
         VALUES ($1, $2, 'api', now())
         RETURNING pool_id AS id, pool_name AS name, task_objective AS description,
                   lifecycle_state, archived_at, created_at`,
        [name, description],
      );
      if (created === null) jsonError('internal_error', 'Pool creation returned no row.', 500);
      created.id = Number(created.id);

      jsonResponse(reply, { pool: created }, 201, ctx);
    },
  });
}
