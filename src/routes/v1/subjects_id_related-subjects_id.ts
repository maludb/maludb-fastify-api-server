/**
 * DELETE /v1/subjects/:id/related-subjects/:sub_id
 *
 * MaluDB concept: unlink a related subject (requirements.md §4.1).
 * SQL objects: maludb_subject_relationship.
 * Teaches:
 *   - A pair-level unlink removes the relationship between the two subjects regardless of which is
 *     `from`/`to` (either direction). 0 rows removed → 404.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbExec } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, pathSubId } from '../../http/request.js';

const FILE = 'subjects_id_related-subjects_id.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['DELETE'],
    url: '/v1/subjects/:id/related-subjects/:sub_id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);
      const other = pathSubId(request);

      const n = await dbExec(
        ctx,
        `DELETE FROM maludb_subject_relationship
          WHERE (from_subject_id = $1 AND to_subject_id = $2)
             OR (from_subject_id = $2 AND to_subject_id = $1)`,
        [id, other],
      );
      if (n === 0) {
        jsonError('not_found', 'No relationship between those subjects.', 404);
      }
      jsonResponse(reply, { deleted: true, id, related_subject_id: other, removed: n }, 200, ctx);
    },
  });
}
