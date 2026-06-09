/**
 * GET /v1/attribute-check
 *
 * MaluDB concept: advisory completeness check (maludb_core 0.83.0+).
 * SQL objects: maludb_attribute_check(target_kind, target_id) → jsonb
 *   {applies_to, type_value, missing_required[], fields[]}.
 * Teaches:
 *   - Advisory only — the DB never rejects on missing attributes; this is for the form layer to
 *     validate completeness on submit.
 * Runs in dbTxCore() (the facade resolves its malu$* base tables unqualified).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr } from '../../http/request.js';

const FILE = 'attribute-check.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET'],
    url: '/v1/attribute-check',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const targetKind = queryStr(request, 'target_kind', null, 40);
      const targetId = queryInt(request, 'target_id', null);
      if (targetKind === null || targetKind === '') {
        jsonError('missing_field', 'Query param "target_kind" is required.', 400);
      }
      if (targetId === null) {
        jsonError('missing_field', 'Query param "target_id" is required.', 400);
      }

      const row = await dbTxCore(ctx, () =>
        dbOne(ctx, 'SELECT maludb_attribute_check($1, $2) AS check', [targetKind, targetId]),
      );

      // The facade returns jsonb, already parsed by node-pg (no JSON.parse).
      const check = row && row.check !== null && row.check !== undefined ? row.check : null;
      jsonResponse(reply, { check }, 200, ctx);
    },
  });
}
