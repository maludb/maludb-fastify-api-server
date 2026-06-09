/**
 * POST /v1/projects/:id/subjects
 * PUT  /v1/projects/:id/subjects
 *
 * MaluDB concept: the subjects linked to a project (requirements.md §4.6).
 * SQL objects: maludb_project (view), maludb_subject, maludb_svpor_relationship;
 *              maludb_svpor_relationship_create / maludb_svpor_relationship_delete (facade).
 * Teaches:
 *   - POST links one subject via maludb_svpor_relationship_create('subject', project_id, 'subject',
 *     subject_id, 'has_member'). The create helper is not idempotent and does not validate the
 *     target, so the API checks existence + dedupes.
 *   - PUT replaces the full set by diffing the wanted ids against the current 'has_member' edges
 *     (create the missing, delete the extra) inside a single transaction.
 *   - Linked subjects are readable via GET /v1/projects/{id}.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { dbTx } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';

const FILE = 'projects_id_subjects.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST', 'PUT'],
    url: '/v1/projects/:id/subjects',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'POST': {
          if ((await dbOne(ctx, 'SELECT 1 FROM maludb_project WHERE subject_id = $1', [id])) === null) {
            jsonError('not_found', 'Project not found.', 404);
          }

          const body = bodyObject(request);
          if (!Object.prototype.hasOwnProperty.call(body, 'subject_id') || !Number.isInteger(body.subject_id)) {
            jsonError('missing_field', 'Field "subject_id" (integer) is required.', 400);
          }
          const sid = Number(body.subject_id);
          if (sid === id) {
            jsonError('validation_failed', 'A project cannot link to itself.', 422);
          }

          const subject = await dbOne(
            ctx,
            `SELECT subject_id AS id, canonical_name AS name, subject_type AS type
               FROM maludb_subject WHERE subject_id = $1`,
            [sid],
          );
          if (subject === null) {
            jsonError('validation_failed', 'subject_id does not refer to an existing subject.', 422);
          }

          // The svpor create helper is not idempotent — dedupe here.
          const dup = await dbOne(
            ctx,
            `SELECT 1 FROM maludb_svpor_relationship
              WHERE source_kind='subject' AND source_id=$1 AND target_kind='subject'
                AND target_id=$2 AND relationship_type='has_member'`,
            [id, sid],
          );
          if (dup !== null) {
            jsonError('conflict', 'That subject is already linked to the project.', 409);
          }

          const row = await dbOne(
            ctx,
            "SELECT maludb_svpor_relationship_create('subject', $1, 'subject', $2, 'has_member', NULL, '{}'::jsonb, NULL) AS edge_id",
            [id, sid],
          );
          subject!.id = Number(subject!.id);

          jsonResponse(reply, { subject, edge_id: Number(row!.edge_id) }, 201, ctx);
          return;
        }

        case 'PUT': {
          if ((await dbOne(ctx, 'SELECT 1 FROM maludb_project WHERE subject_id = $1', [id])) === null) {
            jsonError('not_found', 'Project not found.', 404);
          }
          const body = bodyObject(request);
          if (!Object.prototype.hasOwnProperty.call(body, 'subject_ids') || !Array.isArray(body.subject_ids)) {
            jsonError('missing_field', 'Field "subject_ids" (array of integers) is required.', 400);
          }
          const wantSet = new Map<number, true>();
          for (const v of body.subject_ids as unknown[]) {
            if (!Number.isInteger(v)) {
              jsonError('validation_failed', 'subject_ids must be integers.', 422);
            }
            const n = Number(v);
            if (n === id) {
              jsonError('validation_failed', 'A project cannot link to itself.', 422);
            }
            if ((await dbOne(ctx, 'SELECT 1 FROM maludb_subject WHERE subject_id = $1', [n])) === null) {
              jsonError('validation_failed', `subject_id ${n} does not refer to an existing subject.`, 422);
            }
            wantSet.set(n, true);
          }
          const want = [...wantSet.keys()];

          await dbTx(ctx, async () => {
            const cur = (
              await dbMany(
                ctx,
                `SELECT target_id FROM maludb_svpor_relationship
                  WHERE source_kind='subject' AND source_id=$1 AND target_kind='subject'
                    AND relationship_type='has_member'`,
                [id],
              )
            ).map((r) => Number(r.target_id));
            for (const c of cur) {
              if (!want.includes(c)) {
                await dbOne(
                  ctx,
                  "SELECT maludb_svpor_relationship_delete('subject', $1, 'subject', $2, 'has_member')",
                  [id, c],
                );
              }
            }
            for (const w of want) {
              if (!cur.includes(w)) {
                await dbOne(
                  ctx,
                  "SELECT maludb_svpor_relationship_create('subject', $1, 'subject', $2, 'has_member', NULL, '{}'::jsonb, NULL)",
                  [id, w],
                );
              }
            }
          });

          const subjects = await dbMany(
            ctx,
            `SELECT s.subject_id AS id, s.canonical_name AS name, s.subject_type AS type
               FROM maludb_svpor_relationship r
               JOIN maludb_subject s ON s.subject_id = r.target_id
              WHERE r.source_kind='subject' AND r.source_id=$1 AND r.target_kind='subject'
                AND r.relationship_type='has_member'
              ORDER BY s.canonical_name`,
            [id],
          );
          for (const x of subjects) {
            x.id = Number(x.id);
          }

          jsonResponse(reply, { subjects }, 200, ctx);
          return;
        }
      }
    },
  });
}
