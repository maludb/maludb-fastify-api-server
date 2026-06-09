/**
 * GET /v1/objects/:kind/:id  (maludb_core 0.85.0+ — object-with-attributes ergonomics)
 *
 *   GET   maludb_object_get(kind, id) → jsonb
 *         {kind, id, object, attributes, [statements, details for episodes]}.
 *
 * The (object_kind, object_id) handle is the canonical resource identifier across the
 * graph/attribute/traversal surface — this endpoint resolves one handle inline with its
 * typed attributes (and, for episodes, its statements + details) in a single read.
 *
 * Routed at /v1/objects/:kind/:id (the {kind} segment is text, so it can't use the
 * generic numeric-id rewrite).
 *
 * Runs in db_tx_core() — maludb_object_get references its malu$* base tables unqualified.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathStr, pathId } from '../../http/request.js';

const FILE = 'objects_id.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET'],
    url: '/v1/objects/:kind/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const kind = pathStr(request, 'kind');
      const id = pathId(request);

      const row = await dbTxCore(ctx, () =>
        dbOne(ctx, 'SELECT maludb_object_get($1, $2) AS obj', [kind, id]),
      );

      // maludb_object_get returns NULL (or a null-object envelope) when the handle is unknown.
      // The jsonb is already parsed by node-pg (no JSON.parse).
      const obj = row && row.obj !== null ? (row.obj as Record<string, unknown>) : null;
      if (obj === null || (obj.object !== undefined && obj.object === null)) {
        jsonError('not_found', 'Object not found for the given (kind, id).', 404);
      }

      jsonResponse(reply, { object: obj }, 200, ctx);
    },
  });
}
