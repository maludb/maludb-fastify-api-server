/**
 * GET    /v1/attributes/:id
 * PATCH  /v1/attributes/:id
 * DELETE /v1/attributes/:id
 *
 * MaluDB concept: a single typed attribute (maludb_core 0.83.0+).
 * SQL objects: maludb_svpor_attribute, lifecycle facades
 *   maludb_svpor_attribute_set_provenance, maludb_svpor_attribute_delete.
 * Teaches:
 *   - PATCH { provenance? } → set_provenance (the accept/reject transition: suggested → accepted |
 *     rejected). The only "in place" edit; changing a value is an upsert (POST /v1/attributes).
 *   - DELETE → delete facade.
 *   - provenance ∈ {provided,suggested,accepted,rejected} (DB-enforced → 422).
 * Everything runs inside dbTxCore() (the facade resolves its malu$* base tables).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { shapeAttribute, svporAttributeCols } from '../../db/attributes.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx, Row } from '../../types/db.js';

const FILE = 'attributes_id.ts';

async function loadAttribute(ctx: RequestCtx, id: number): Promise<Row | null> {
  const row = await dbOne(
    ctx,
    `SELECT ${svporAttributeCols()} FROM maludb_svpor_attribute WHERE attribute_id = $1`,
    [id],
  );
  if (row === null) return null;
  shapeAttribute(row);
  return row;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH', 'DELETE'],
    url: '/v1/attributes/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const attr = await dbTxCore(ctx, () => loadAttribute(ctx, id));
          if (attr === null) {
            jsonError('not_found', 'Attribute not found.', 404);
          }
          jsonResponse(reply, { attribute: attr }, 200, ctx);
          return;
        }

        case 'PATCH': {
          const body = bodyObject(request);

          // The only "in place" edit is the provenance review transition. Anything that would change
          // a value is an upsert, which already lives on POST /v1/attributes.
          if (body.provenance === undefined || String(body.provenance).trim() === '') {
            jsonError('bad_request', 'PATCH supports only "provenance" (use POST to re-upsert values).', 400);
          }

          const attr = await dbTxCore(ctx, async () => {
            if ((await dbOne(ctx, 'SELECT 1 FROM maludb_svpor_attribute WHERE attribute_id = $1', [id])) === null) {
              return null;
            }
            await dbOne(ctx, 'SELECT maludb_svpor_attribute_set_provenance($1, $2)', [id, String(body.provenance)]);
            return loadAttribute(ctx, id);
          });

          if (attr === null) {
            jsonError('not_found', 'Attribute not found.', 404);
          }
          jsonResponse(reply, { attribute: attr }, 200, ctx);
          return;
        }

        case 'DELETE': {
          const deleted = await dbTxCore(ctx, async () => {
            if ((await dbOne(ctx, 'SELECT 1 FROM maludb_svpor_attribute WHERE attribute_id = $1', [id])) === null) {
              return false;
            }
            await dbOne(ctx, 'SELECT maludb_svpor_attribute_delete($1)', [id]);
            return true;
          });
          if (!deleted) {
            jsonError('not_found', 'Attribute not found.', 404);
          }
          jsonResponse(reply, { deleted: true, id }, 200, ctx);
          return;
        }
      }
    },
  });
}
