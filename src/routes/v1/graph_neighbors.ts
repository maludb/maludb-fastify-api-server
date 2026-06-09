/**
 * GET /v1/graph/neighbors  (maludb_core 0.86.0 — one-hop graph traversal)
 *
 *   GET  ?kind=&id=&direction=both&rel=a,b,c
 *        → maludb_graph_neighbors(kind, id, direction='both', rel_filter text[])
 *          TABLE(neighbor_kind, neighbor_id, rel, edge_store, confidence, provenance, label).
 *
 * One labeled hop out of the (kind, id) handle over the unified edge view (SVO statements
 * + lineage). `direction` ∈ {both, out, in}; `rel` is an optional comma-separated filter.
 * Reads kind/id from the query string. Runs in db_tx_core().
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr } from '../../http/request.js';

const FILE = 'graph_neighbors.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET'],
    url: '/v1/graph/neighbors',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const kind = queryStr(request, 'kind', null, 40);
      const id = queryInt(request, 'id', null);
      const direction = queryStr(request, 'direction', 'both', 20);
      const rel = queryStr(request, 'rel', null, 400);
      if (kind === null || kind === '') jsonError('missing_field', 'Query param "kind" is required.', 400);
      if (id === null) jsonError('missing_field', 'Query param "id" is required.', 400);

      const relStr = rel ?? '';
      const rows = await dbTxCore(ctx, () =>
        dbMany(
          ctx,
          `SELECT neighbor_kind, neighbor_id, rel, edge_store, confidence, provenance, label
             FROM maludb_graph_neighbors($1, $2, $3, CASE WHEN $4 = '' THEN NULL ELSE string_to_array($4, ',') END)`,
          [kind, id, direction, relStr],
        ),
      );
      for (const r of rows) {
        r.neighbor_id = Number(r.neighbor_id);
        r.confidence = r.confidence === null ? null : Number(r.confidence);
      }

      jsonResponse(reply, { kind, id, direction, neighbors: rows }, 200, ctx);
    },
  });
}
