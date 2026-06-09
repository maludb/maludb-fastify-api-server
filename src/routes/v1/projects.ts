/**
 * GET  /v1/projects
 * POST /v1/projects
 *
 * MaluDB concept: a "project" is a subject with subject_type='project' (maludb_project is a view of
 * maludb_subject WHERE subject_type='project'). project id = subject_id. Projects expose `name`
 * (-> canonical_name).
 * SQL objects: maludb_project (view), maludb_subject.
 * Teaches:
 *   - Projects reuse the subject catalog; subject_id has no sequence, so POST derives it inline with
 *     COALESCE(MAX+1).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr, bodyObject } from '../../http/request.js';

const FILE = 'projects.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/projects',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      if (request.method === 'GET') {
        const q = queryStr(request, 'q', null, 200);
        const limit = queryInt(request, 'limit', 50, 200) ?? 50;

        let where = '';
        const params: unknown[] = [];
        if (q !== null && q !== '') {
          where = 'WHERE canonical_name ILIKE $1 OR description ILIKE $1';
          params.push(`%${q}%`);
        }

        const sql = `
          SELECT subject_id     AS id,
                 canonical_name AS name,
                 description,
                 classifier_md,
                 archived_at
            FROM maludb_project
            ${where}
           ORDER BY canonical_name
           LIMIT ${limit}`;

        const rows = await dbMany(ctx, sql, params);
        for (const r of rows) {
          r.id = Number(r.id);
        }

        jsonResponse(reply, { projects: rows }, 200, ctx);
        return;
      }

      // POST
      const body = bodyObject(request);

      const name = String(body.name ?? '').trim();
      if (name === '') {
        jsonError('missing_field', 'Field "name" is required.', 400);
      }
      const description = body.description !== undefined ? String(body.description) : null;
      const classifierMd = body.classifier_md !== undefined ? String(body.classifier_md) : null;

      // A project is a subject of type 'project'; subject_id has no sequence.
      const created = await dbOne(
        ctx,
        `INSERT INTO maludb_subject
             (subject_id, canonical_name, subject_type, description, classifier_md, created_at)
         SELECT COALESCE(MAX(subject_id), 0) + 1, $1, 'project', $2, $3, now()
           FROM maludb_subject
         RETURNING subject_id AS id, canonical_name AS name, description, classifier_md`,
        [name, description, classifierMd],
      );
      if (created === null) jsonError('internal_error', 'Project creation returned no row.', 500);
      created.id = Number(created.id);

      jsonResponse(reply, { project: created }, 201, ctx);
    },
  });
}
