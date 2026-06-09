/**
 * DELETE /v1/subjects/:id/verbs/:sub_id
 *
 * MaluDB concept: unlink a verb from a subject (requirements.md §4.1).
 * SQL objects: maludb_subject_verb_unlink (function).
 * Teaches:
 *   - Unlinking destroys the per-pair vector compartment via maludb_subject_verb_unlink(subject_id,
 *     verb_id), which returns a removed-count; 0 → no such link → 404.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, pathSubId } from '../../http/request.js';

const FILE = 'subjects_id_verbs_id.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['DELETE'],
    url: '/v1/subjects/:id/verbs/:sub_id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);
      const verbId = pathSubId(request);

      const row = await dbOne(
        ctx,
        'SELECT maludb_subject_verb_unlink($1, $2) AS removed',
        [id, verbId],
      );
      if (Number(row!.removed) === 0) {
        jsonError('not_found', 'That verb is not linked to the subject.', 404);
      }
      jsonResponse(reply, { deleted: true, id, verb_id: verbId }, 200, ctx);
    },
  });
}
