/**
 * DELETE /v1/projects/:id/subjects/:sub_id
 *
 * MaluDB concept: unlink one subject from the project (requirements.md §4.6).
 * SQL objects: maludb_svpor_relationship_delete (facade).
 * Teaches:
 *   - Removes the 'has_member' SVPOR edge; the helper returns the number of removed edges, so a
 *     0 result means there was no such link (404).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, pathSubId } from '../../http/request.js';

const FILE = 'projects_id_subjects_id.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['DELETE'],
    url: '/v1/projects/:id/subjects/:sub_id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);
      const sid = pathSubId(request);

      const row = await dbOne(
        ctx,
        "SELECT maludb_svpor_relationship_delete('subject', $1, 'subject', $2, 'has_member') AS removed",
        [id, sid],
      );
      if (Number(row!.removed) === 0) {
        jsonError('not_found', 'That subject is not linked to the project.', 404);
      }
      jsonResponse(reply, { deleted: true, id, subject_id: sid }, 200, ctx);
    },
  });
}
