/**
 * GET  /v1/statements
 * POST /v1/statements
 *
 * MaluDB concept: the SVO statement layer (maludb_core 0.82.0).
 * SQL objects: maludb_svpor_statement, maludb_svpor_statement_create (facade).
 * Teaches:
 *   - A statement is (subject_kind, subject_id) --verb_id--> (object_kind, object_id).
 *   - The review queue is just ?provenance=suggested (machine-derived links awaiting accept/reject).
 *   - Create is idempotent on those five fields; the body shape (verb/subject name resolution)
 *     lives in svporCreateStatement(). Both run inside dbTxCore() — the verb/subject/predicate
 *     resolvers and the facade need maludb_core on the search path.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { svporCreateStatement, shapeStatement, svporStatementCols } from '../../db/statements.js';
import { jsonResponse } from '../../http/response.js';
import { queryInt, queryStr, bodyObject } from '../../http/request.js';

const FILE = 'statements.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/statements',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      switch (request.method) {
        case 'GET': {
          const provenance = queryStr(request, 'provenance', null, 40);
          const objectKind = queryStr(request, 'object_kind', null, 40);
          const subjectKind = queryStr(request, 'subject_kind', null, 40);
          const objectId = queryInt(request, 'object_id', null);
          const subjectId = queryInt(request, 'subject_id', null);
          const verbId = queryInt(request, 'verb_id', null);
          const limit = queryInt(request, 'limit', 50, 200) ?? 50;

          const clauses: string[] = [];
          const params: unknown[] = [];
          if (provenance !== null && provenance !== '') { params.push(provenance); clauses.push(`provenance = $${params.length}`); }
          if (objectKind !== null && objectKind !== '') { params.push(objectKind); clauses.push(`object_kind = $${params.length}`); }
          if (subjectKind !== null && subjectKind !== '') { params.push(subjectKind); clauses.push(`subject_kind = $${params.length}`); }
          if (objectId !== null) { params.push(objectId); clauses.push(`object_id = $${params.length}`); }
          if (subjectId !== null) { params.push(subjectId); clauses.push(`subject_id = $${params.length}`); }
          if (verbId !== null) { params.push(verbId); clauses.push(`verb_id = $${params.length}`); }
          const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

          const rows = await dbTxCore(ctx, () =>
            dbMany(
              ctx,
              `SELECT ${svporStatementCols()}
                 FROM maludb_svpor_statement
                 ${where}
                ORDER BY statement_id DESC
                LIMIT ${limit}`,
              params,
            ),
          );
          for (const r of rows) shapeStatement(r);

          jsonResponse(reply, { statements: rows }, 200, ctx);
          return;
        }

        case 'POST': {
          const body = bodyObject(request);
          const stmt = await dbTxCore(ctx, () => svporCreateStatement(ctx, body));
          jsonResponse(reply, { statement: stmt }, 201, ctx);
          return;
        }
      }
    },
  });
}
