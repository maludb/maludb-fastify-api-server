/**
 * POST /v1/documents-backfill  (maludb_core 0.87.0 — document graph onboarding)
 *
 *   POST   Run maludb_document_graph_backfill() for the current tenant schema: resolve/link
 *          every pre-0.87 document tag (project/subject/stakeholder) into the unified graph —
 *          document→subject edges + resolved tag_object_id + primary_project_id. Idempotent;
 *          safe to re-run. Returns { "linked": <int> } (tags newly linked this run).
 *
 * Admin/onboarding action: call once after enabling memory for a schema that already holds
 * documents. Runs in dbTxCore() (the facade resolves under current_schema()).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';

const FILE = 'documents-backfill.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST'],
    url: '/v1/documents-backfill',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const linked = await dbTxCore(ctx, () =>
        dbOne(ctx, 'SELECT maludb_document_graph_backfill() AS n'),
      );

      jsonResponse(reply, { linked: Number(linked?.n) }, 200, ctx);
    },
  });
}
