/**
 * POST /v1/projects/:id/unarchive
 *
 * MaluDB concept: unarchive a project (409 not_archived if not archived).
 * SQL objects: maludb_project (view), maludb_project_unarchive(p_project_id).
 * Teaches:
 *   - Archived state is maludb_subject.archived_at; maludb_project_unarchive() clears it.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId } from '../../http/request.js';

const FILE = 'projects_id_unarchive.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST'],
    url: '/v1/projects/:id/unarchive',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      const project = await dbOne(
        ctx,
        'SELECT archived_at FROM maludb_project WHERE subject_id = $1',
        [id],
      );
      if (project === null) {
        jsonError('not_found', 'Project not found.', 404);
      }
      if (project.archived_at === null) {
        jsonError('not_archived', 'Project is not archived.', 409);
      }

      await dbOne(ctx, 'SELECT maludb_project_unarchive($1)', [id]);

      const updated = await dbOne(
        ctx,
        `SELECT subject_id AS id, canonical_name AS name, description, classifier_md, archived_at
           FROM maludb_project WHERE subject_id = $1`,
        [id],
      );
      updated!.id = Number(updated!.id);
      jsonResponse(reply, { project: updated }, 200, ctx);
    },
  });
}
