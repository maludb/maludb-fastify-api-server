/**
 * GET    /v1/projects/:id
 * PATCH  /v1/projects/:id
 * DELETE /v1/projects/:id
 *
 * MaluDB concept: project detail + embedded subjects[] / verbs[] (linked identifiers, read from the
 * SVPOR graph; link writes are deferred — §4.6 notes). A project is a subject with
 * subject_type='project'; project id = subject_id.
 * SQL objects: maludb_project (view), maludb_subject, maludb_svpor_relationship; document_neighbors
 *              (graph facade).
 * Teaches:
 *   - Linked identifiers come from the SVPOR graph (source = this project subject); target_kind
 *     splits the edges into subjects[] vs verbs[].
 *   - Documents linked through the unified graph need maludb_core on the search_path, so that one
 *     read runs in its own db_tx_core().
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne, dbExec } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { documentNeighbors } from '../../db/documents.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'projects_id.ts';

/** Fetch a project (subject of type 'project') with linked subjects[]/verbs[], or null. */
async function loadProjectDetail(ctx: RequestCtx, id: number): Promise<Record<string, unknown> | null> {
  const project = await dbOne(
    ctx,
    `SELECT subject_id AS id, canonical_name AS name, description, classifier_md, archived_at
       FROM maludb_project
      WHERE subject_id = $1`,
    [id],
  );
  if (project === null) {
    return null;
  }
  project.id = Number(project.id);

  // Linked identifiers come from the SVPOR graph (source = this project subject).
  const edges = await dbMany(
    ctx,
    `SELECT target_kind, target_id, target_name, relationship_type
       FROM maludb_svpor_relationship
      WHERE source_kind = 'subject' AND source_id = $1
      ORDER BY target_kind, target_name`,
    [id],
  );
  const subjects: Record<string, unknown>[] = [];
  const verbs: Record<string, unknown>[] = [];
  for (const e of edges) {
    const item = {
      id: Number(e.target_id),
      name: e.target_name,
      relationship_type: e.relationship_type,
    };
    if (e.target_kind === 'verb') {
      verbs.push(item);
    } else {
      subjects.push(item);
    }
  }
  project.subjects = subjects;
  project.verbs = verbs;

  // Documents linked to this project through the unified graph (0.87.0). Graph facade needs
  // maludb_core on the search_path, so this one read runs in its own db_tx_core().
  project.documents = await dbTxCore(ctx, () => documentNeighbors(ctx, id));

  return project;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH', 'DELETE'],
    url: '/v1/projects/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const project = await loadProjectDetail(ctx, id);
          if (project === null) {
            jsonError('not_found', 'Project not found.', 404);
          }
          jsonResponse(reply, { project }, 200, ctx);
          return;
        }

        case 'PATCH': {
          if ((await dbOne(ctx, 'SELECT 1 FROM maludb_project WHERE subject_id = $1', [id])) === null) {
            jsonError('not_found', 'Project not found.', 404);
          }

          const body = bodyObject(request);
          const fields: string[] = [];
          const params: unknown[] = [];

          if (Object.prototype.hasOwnProperty.call(body, 'name')) {
            const name = String(body.name ?? '').trim();
            if (name === '') {
              jsonError('validation_failed', 'Field "name" cannot be empty.', 422);
            }
            params.push(name);
            fields.push(`canonical_name = $${params.length}`);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'description')) {
            params.push(body.description === null ? null : String(body.description));
            fields.push(`description = $${params.length}`);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'classifier_md')) {
            params.push(body.classifier_md === null ? null : String(body.classifier_md));
            fields.push(`classifier_md = $${params.length}`);
          }
          if (fields.length === 0) {
            jsonError('bad_request', 'No updatable fields provided (name, description, classifier_md).', 400);
          }

          params.push(id);
          await dbExec(
            ctx,
            `UPDATE maludb_subject SET ${fields.join(', ')} WHERE subject_id = $${params.length} AND subject_type = 'project'`,
            params,
          );

          jsonResponse(reply, { project: await loadProjectDetail(ctx, id) }, 200, ctx);
          return;
        }

        case 'DELETE': {
          const n = await dbExec(
            ctx,
            "DELETE FROM maludb_subject WHERE subject_id = $1 AND subject_type = 'project'",
            [id],
          );
          if (n === 0) {
            jsonError('not_found', 'Project not found.', 404);
          }
          jsonResponse(reply, { deleted: true, id }, 200, ctx);
          return;
        }
      }
    },
  });
}
