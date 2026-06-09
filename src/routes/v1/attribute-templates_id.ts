/**
 * GET    /v1/attribute-templates/:id
 * DELETE /v1/attribute-templates/:id
 *
 * MaluDB concept: a single typed-property form-catalog entry (maludb_core 0.83.0+).
 * SQL objects: maludb_attribute_template (writable view), maludb_attribute_template_delete (facade).
 * Teaches:
 *   - No PATCH — the 0.83.0 surface exposes only create + delete (re-create to change).
 * Runs in dbTxCore() so the facade resolves its malu$* base tables.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId } from '../../http/request.js';
import { shapeTemplate, templateCols } from './attribute-templates.js';
import type { RequestCtx, Row } from '../../types/db.js';

const FILE = 'attribute-templates_id.ts';

async function loadTemplate(ctx: RequestCtx, id: number): Promise<Row | null> {
  const row = await dbOne(
    ctx,
    `SELECT ${templateCols()} FROM maludb_attribute_template WHERE template_id = $1`,
    [id],
  );
  if (row === null) return null;
  shapeTemplate(row);
  return row;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'DELETE'],
    url: '/v1/attribute-templates/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const t = await dbTxCore(ctx, () => loadTemplate(ctx, id));
          if (t === null) {
            jsonError('not_found', 'Attribute template not found.', 404);
          }
          jsonResponse(reply, { attribute_template: t }, 200, ctx);
          return;
        }

        case 'DELETE': {
          const deleted = await dbTxCore(ctx, async () => {
            if ((await dbOne(ctx, 'SELECT 1 FROM maludb_attribute_template WHERE template_id = $1', [id])) === null) {
              return false;
            }
            await dbOne(ctx, 'SELECT maludb_attribute_template_delete($1)', [id]);
            return true;
          });
          if (!deleted) {
            jsonError('not_found', 'Attribute template not found.', 404);
          }
          jsonResponse(reply, { deleted: true, id }, 200, ctx);
          return;
        }
      }
    },
  });
}
