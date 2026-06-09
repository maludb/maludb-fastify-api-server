/**
 * GET  /v1/episodes/:id/statements
 * POST /v1/episodes/:id/statements
 *
 * MaluDB concept: an event's links (maludb_core 0.82.0).
 * SQL objects: maludb_episode, maludb_svpor_statement, maludb_svpor_statement_create (facade).
 * Teaches:
 *   - GET returns statements whose object is this episode (object_kind='episode_object' AND
 *     object_id={id}): attendees, attached documents, decisions.
 *   - POST adds a link to this event — same body as POST /v1/statements, except object_kind/object_id
 *     default to this episode (forced to {kind:'episode_object', id}).
 * Everything runs inside dbTxCore() (the resolvers + facade need maludb_core on the search path).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { svporCreateStatement, shapeStatement, svporStatementCols } from '../../db/statements.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';

const FILE = 'episodes_id_statements.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/episodes/:id/statements',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const result = await dbTxCore(ctx, async () => {
            if ((await dbOne(ctx, 'SELECT 1 FROM maludb_episode WHERE episode_id = $1', [id])) === null) {
              return null;
            }
            return dbMany(
              ctx,
              `SELECT ${svporStatementCols()}
                 FROM maludb_svpor_statement
                WHERE object_kind = 'episode_object' AND object_id = $1
                ORDER BY statement_id DESC`,
              [id],
            );
          });
          if (result === null) {
            jsonError('not_found', 'Episode not found.', 404);
          }
          for (const r of result) shapeStatement(r);

          jsonResponse(reply, { statements: result }, 200, ctx);
          return;
        }

        case 'POST': {
          const body = bodyObject(request);
          const stmt = await dbTxCore(ctx, async () => {
            if ((await dbOne(ctx, 'SELECT 1 FROM maludb_episode WHERE episode_id = $1', [id])) === null) {
              return null;
            }
            return svporCreateStatement(ctx, body, { kind: 'episode_object', id });
          });
          if (stmt === null) {
            jsonError('not_found', 'Episode not found.', 404);
          }
          jsonResponse(reply, { statement: stmt }, 201, ctx);
          return;
        }
      }
    },
  });
}
