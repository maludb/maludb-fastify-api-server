/**
 * GET    /v1/statements/:id
 * PATCH  /v1/statements/:id
 * DELETE /v1/statements/:id
 *
 * MaluDB concept: a single SVO statement (maludb_core 0.82.0).
 * SQL objects: maludb_svpor_statement, lifecycle facades
 *   maludb_svpor_statement_set_provenance, maludb_svpor_statement_close, maludb_svpor_statement_delete.
 * Teaches:
 *   - PATCH { provenance? } → set_provenance (the accept/reject transition: suggested → accepted | rejected).
 *   - PATCH { valid_to? } or { close:true } → close (close=true uses now()).
 *   - DELETE → delete facade.
 *   - provenance ∈ {provided,suggested,accepted,rejected} (DB-enforced → 422).
 * Everything runs inside dbTxCore() (the facade resolves its malu$* base tables).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { shapeStatement, svporStatementCols } from '../../db/statements.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx, Row } from '../../types/db.js';

const FILE = 'statements_id.ts';

async function loadStatement(ctx: RequestCtx, id: number): Promise<Row | null> {
  const row = await dbOne(
    ctx,
    `SELECT ${svporStatementCols()} FROM maludb_svpor_statement WHERE statement_id = $1`,
    [id],
  );
  if (row === null) return null;
  shapeStatement(row);
  return row;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH', 'DELETE'],
    url: '/v1/statements/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const stmt = await dbTxCore(ctx, () => loadStatement(ctx, id));
          if (stmt === null) {
            jsonError('not_found', 'Statement not found.', 404);
          }
          jsonResponse(reply, { statement: stmt }, 200, ctx);
          return;
        }

        case 'PATCH': {
          const body = bodyObject(request);

          const setProvenance =
            body.provenance !== undefined && String(body.provenance).trim() !== '';
          const doClose =
            (Object.prototype.hasOwnProperty.call(body, 'close') && body.close === true) ||
            Object.prototype.hasOwnProperty.call(body, 'valid_to');
          if (!setProvenance && !doClose) {
            jsonError('bad_request', 'No updatable fields provided (provenance, valid_to, close).', 400);
          }

          const stmt = await dbTxCore(ctx, async () => {
            if ((await dbOne(ctx, 'SELECT 1 FROM maludb_svpor_statement WHERE statement_id = $1', [id])) === null) {
              return null;
            }
            if (setProvenance) {
              await dbOne(ctx, 'SELECT maludb_svpor_statement_set_provenance($1, $2)', [id, String(body.provenance)]);
            }
            if (doClose) {
              // close:true → now(); explicit valid_to → that timestamp (null also closes at now()).
              const validTo =
                Object.prototype.hasOwnProperty.call(body, 'valid_to') && body.valid_to !== null
                  ? String(body.valid_to)
                  : null;
              await dbOne(ctx, 'SELECT maludb_svpor_statement_close($1, COALESCE($2::timestamptz, now()))', [id, validTo]);
            }
            return loadStatement(ctx, id);
          });

          if (stmt === null) {
            jsonError('not_found', 'Statement not found.', 404);
          }
          jsonResponse(reply, { statement: stmt }, 200, ctx);
          return;
        }

        case 'DELETE': {
          const deleted = await dbTxCore(ctx, async () => {
            if ((await dbOne(ctx, 'SELECT 1 FROM maludb_svpor_statement WHERE statement_id = $1', [id])) === null) {
              return false;
            }
            await dbOne(ctx, 'SELECT maludb_svpor_statement_delete($1)', [id]);
            return true;
          });
          if (!deleted) {
            jsonError('not_found', 'Statement not found.', 404);
          }
          jsonResponse(reply, { deleted: true, id }, 200, ctx);
          return;
        }
      }
    },
  });
}
