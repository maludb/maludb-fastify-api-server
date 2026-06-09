/**
 * GET /v1/graph/walk  (maludb_core 0.86.0 — multi-hop graph traversal)
 *
 *   GET  ?kind=&id=&max_depth=4&direction=both&rel=a,b,c
 *        → maludb_graph_walk(kind, id, max_depth=4, direction='both', rel_filter text[])
 *          TABLE(object_kind, object_id, depth, rel, edge_store, label, path text[]).
 *
 * Cycle-safe breadth-first walk from the (kind, id) handle. Each row is a reached object
 * with its depth, the rel that reached it, and the path of object ids walked.
 * Reads kind/id from the query string. Runs in db_tx_core().
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr } from '../../http/request.js';

const FILE = 'graph_walk.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET'],
    url: '/v1/graph/walk',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const kind = queryStr(request, 'kind', null, 40);
      const id = queryInt(request, 'id', null);
      const maxDepth = queryInt(request, 'max_depth', 4, 20) ?? 4;
      const direction = queryStr(request, 'direction', 'both', 20);
      const rel = queryStr(request, 'rel', null, 400);
      if (kind === null || kind === '') jsonError('missing_field', 'Query param "kind" is required.', 400);
      if (id === null) jsonError('missing_field', 'Query param "id" is required.', 400);

      const relStr = rel ?? '';
      const rows = await dbTxCore(ctx, () =>
        dbMany(
          ctx,
          `SELECT object_kind, object_id, depth, rel, edge_store, label, path
             FROM maludb_graph_walk($1, $2, $3, $4, CASE WHEN $5 = '' THEN NULL ELSE string_to_array($5, ',') END)`,
          [kind, id, maxDepth, direction, relStr],
        ),
      );
      for (const r of rows) {
        r.object_id = Number(r.object_id);
        r.depth = Number(r.depth);
        // path is a Postgres text[] — node-pg already returns it as a JS array of strings;
        // map it to ints (empty/NULL → []).
        r.path = Array.isArray(r.path) ? (r.path as unknown[]).map((p) => Number(p)) : [];
      }

      jsonResponse(reply, { kind, id, max_depth: maxDepth, direction, walk: rows }, 200, ctx);
    },
  });
}
