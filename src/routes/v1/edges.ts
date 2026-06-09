/**
 * GET /v1/edges  (maludb_core 0.86.0 — unified edge view)
 *
 *   GET  ?source_kind=&source_id=&target_kind=&target_id=&rel=&edge_store=&limit=
 *        List rows from maludb_edge (SVO statements + lineage unified):
 *        (edge_store, edge_id, source_kind, source_id, rel, target_kind, target_id,
 *         confidence, provenance).
 *
 * Read-only. Runs in db_tx_core() (the view resolves its malu$* base tables there).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { queryInt, queryStr } from '../../http/request.js';

const FILE = 'edges.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET'],
    url: '/v1/edges',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const sourceKind = queryStr(request, 'source_kind', null, 40);
      const targetKind = queryStr(request, 'target_kind', null, 40);
      const rel = queryStr(request, 'rel', null, 120);
      const edgeStore = queryStr(request, 'edge_store', null, 40);
      const sourceId = queryInt(request, 'source_id', null);
      const targetId = queryInt(request, 'target_id', null);
      const limit = queryInt(request, 'limit', 100, 500) ?? 100;

      const clauses: string[] = [];
      const params: unknown[] = [];
      if (sourceKind !== null && sourceKind !== '') {
        params.push(sourceKind);
        clauses.push(`source_kind = $${params.length}`);
      }
      if (targetKind !== null && targetKind !== '') {
        params.push(targetKind);
        clauses.push(`target_kind = $${params.length}`);
      }
      if (rel !== null && rel !== '') {
        params.push(rel);
        clauses.push(`rel = $${params.length}`);
      }
      if (edgeStore !== null && edgeStore !== '') {
        params.push(edgeStore);
        clauses.push(`edge_store = $${params.length}`);
      }
      if (sourceId !== null) {
        params.push(sourceId);
        clauses.push(`source_id = $${params.length}`);
      }
      if (targetId !== null) {
        params.push(targetId);
        clauses.push(`target_id = $${params.length}`);
      }
      const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

      const rows = await dbTxCore(ctx, () =>
        dbMany(
          ctx,
          `SELECT edge_store, edge_id, source_kind, source_id, rel, target_kind, target_id, confidence, provenance
             FROM maludb_edge
             ${where}
            ORDER BY edge_store, edge_id DESC
            LIMIT ${limit}`,
          params,
        ),
      );
      for (const r of rows) {
        r.edge_id = r.edge_id === null ? null : Number(r.edge_id);
        r.source_id = Number(r.source_id);
        r.target_id = Number(r.target_id);
        r.confidence = r.confidence === null ? null : Number(r.confidence);
      }

      jsonResponse(reply, { edges: rows }, 200, ctx);
    },
  });
}
