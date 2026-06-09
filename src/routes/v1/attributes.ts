/**
 * GET  /v1/attributes
 * POST /v1/attributes
 *
 * MaluDB concept: typed attributes on nodes AND edges (maludb_core 0.83.0+).
 * SQL objects: maludb_svpor_attribute, maludb_svpor_attribute_create (facade).
 * Teaches:
 *   - An attribute is a typed property of (target_kind, target_id). target_kind is any node kind OR
 *     'svpor_statement' (edge attributes).
 *   - The review queue is just ?provenance=suggested (LLM-derived attrs awaiting accept/reject).
 *   - POST creates/upserts (idempotent on target_kind+target_id+attr_name); body shape lives in
 *     svporCreateAttribute(). Runs in dbTxCore() because the facade references its malu$* base tables
 *     unqualified.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { svporCreateAttribute, shapeAttribute, svporAttributeCols } from '../../db/attributes.js';
import { jsonResponse } from '../../http/response.js';
import { queryInt, queryStr, bodyObject } from '../../http/request.js';

const FILE = 'attributes.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/attributes',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      switch (request.method) {
        case 'GET': {
          const targetKind = queryStr(request, 'target_kind', null, 40);
          const attrName = queryStr(request, 'attr_name', null, 200);
          const provenance = queryStr(request, 'provenance', null, 40);
          const targetId = queryInt(request, 'target_id', null);
          const limit = queryInt(request, 'limit', 50, 200) ?? 50;

          const clauses: string[] = [];
          const params: unknown[] = [];
          if (targetKind !== null && targetKind !== '') { params.push(targetKind); clauses.push(`target_kind = $${params.length}`); }
          if (attrName !== null && attrName !== '') { params.push(attrName); clauses.push(`attr_name = $${params.length}`); }
          if (provenance !== null && provenance !== '') { params.push(provenance); clauses.push(`provenance = $${params.length}`); }
          if (targetId !== null) { params.push(targetId); clauses.push(`target_id = $${params.length}`); }
          const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

          const rows = await dbTxCore(ctx, () =>
            dbMany(
              ctx,
              `SELECT ${svporAttributeCols()}
                 FROM maludb_svpor_attribute
                 ${where}
                ORDER BY attribute_id DESC
                LIMIT ${limit}`,
              params,
            ),
          );
          for (const r of rows) shapeAttribute(r);

          jsonResponse(reply, { attributes: rows }, 200, ctx);
          return;
        }

        case 'POST': {
          const body = bodyObject(request);
          const attr = await dbTxCore(ctx, () => svporCreateAttribute(ctx, body));
          jsonResponse(reply, { attribute: attr }, 201, ctx);
          return;
        }
      }
    },
  });
}
