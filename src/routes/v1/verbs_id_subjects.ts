/**
 * GET /v1/verbs/{id}/subjects
 *
 * MaluDB concept: Subjects linked to a verb (requirements.md §4.2).
 * SQL objects: maludb_verb, maludb_subject_verb, maludb_subject.
 * Teaches:
 *   - Read-only listing of the subjects linked to this verb.
 *   - Links live in maludb_subject_verb keyed by verb_name (= the verb's
 *     canonical_name); subject details are resolved by name.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId } from '../../http/request.js';

const FILE = 'verbs_id_subjects.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET'],
    url: '/v1/verbs/:id/subjects',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      const verb = await dbOne(
        ctx,
        'SELECT canonical_name FROM maludb_verb WHERE verb_id = $1',
        [id],
      );
      if (verb === null) {
        jsonError('not_found', 'Verb not found.', 404);
      }

      const subjects = await dbMany(
        ctx,
        `SELECT s.subject_id     AS id,
                s.canonical_name AS label,
                s.subject_type   AS type
           FROM maludb_subject_verb sv
           JOIN maludb_subject s ON s.canonical_name = sv.subject_name
          WHERE sv.verb_name = $1
          ORDER BY s.canonical_name`,
        [verb.canonical_name],
      );
      for (const s of subjects) {
        s.id = Number(s.id);
      }

      jsonResponse(reply, { subjects }, 200, ctx);
    },
  });
}
