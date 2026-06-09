/**
 * POST /v1/projects/:id/verbs
 * PUT  /v1/projects/:id/verbs
 *
 * MaluDB concept: the verbs linked to a project (requirements.md §4.6).
 * SQL objects: maludb_project (view), maludb_verb, maludb_svpor_relationship;
 *              maludb_svpor_relationship_create / maludb_svpor_relationship_delete (facade).
 * Teaches:
 *   - POST links one verb via maludb_svpor_relationship_create('subject', project_id, 'verb',
 *     verb_id, 'has_member'). The create helper is not idempotent and does not validate the target,
 *     so the API checks existence + dedupes.
 *   - PUT replaces the full set by diffing the wanted ids against the current 'has_member' edges
 *     (create the missing, delete the extra) inside a single transaction.
 *   - Linked verbs are readable via GET /v1/projects/{id}.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { dbTx } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';

const FILE = 'projects_id_verbs.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST', 'PUT'],
    url: '/v1/projects/:id/verbs',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'POST': {
          if ((await dbOne(ctx, 'SELECT 1 FROM maludb_project WHERE subject_id = $1', [id])) === null) {
            jsonError('not_found', 'Project not found.', 404);
          }

          const body = bodyObject(request);
          if (!Object.prototype.hasOwnProperty.call(body, 'verb_id') || !Number.isInteger(body.verb_id)) {
            jsonError('missing_field', 'Field "verb_id" (integer) is required.', 400);
          }
          const vid = Number(body.verb_id);

          const verb = await dbOne(
            ctx,
            `SELECT verb_id AS id, canonical_name AS name, verb_type AS type
               FROM maludb_verb WHERE verb_id = $1`,
            [vid],
          );
          if (verb === null) {
            jsonError('validation_failed', 'verb_id does not refer to an existing verb.', 422);
          }

          const dup = await dbOne(
            ctx,
            `SELECT 1 FROM maludb_svpor_relationship
              WHERE source_kind='subject' AND source_id=$1 AND target_kind='verb'
                AND target_id=$2 AND relationship_type='has_member'`,
            [id, vid],
          );
          if (dup !== null) {
            jsonError('conflict', 'That verb is already linked to the project.', 409);
          }

          const row = await dbOne(
            ctx,
            "SELECT maludb_svpor_relationship_create('subject', $1, 'verb', $2, 'has_member', NULL, '{}'::jsonb, NULL) AS edge_id",
            [id, vid],
          );
          verb!.id = Number(verb!.id);

          jsonResponse(reply, { verb, edge_id: Number(row!.edge_id) }, 201, ctx);
          return;
        }

        case 'PUT': {
          if ((await dbOne(ctx, 'SELECT 1 FROM maludb_project WHERE subject_id = $1', [id])) === null) {
            jsonError('not_found', 'Project not found.', 404);
          }
          const body = bodyObject(request);
          if (!Object.prototype.hasOwnProperty.call(body, 'verb_ids') || !Array.isArray(body.verb_ids)) {
            jsonError('missing_field', 'Field "verb_ids" (array of integers) is required.', 400);
          }
          const wantSet = new Map<number, true>();
          for (const v of body.verb_ids as unknown[]) {
            if (!Number.isInteger(v)) {
              jsonError('validation_failed', 'verb_ids must be integers.', 422);
            }
            const n = Number(v);
            if ((await dbOne(ctx, 'SELECT 1 FROM maludb_verb WHERE verb_id = $1', [n])) === null) {
              jsonError('validation_failed', `verb_id ${n} does not refer to an existing verb.`, 422);
            }
            wantSet.set(n, true);
          }
          const want = [...wantSet.keys()];

          await dbTx(ctx, async () => {
            const cur = (
              await dbMany(
                ctx,
                `SELECT target_id FROM maludb_svpor_relationship
                  WHERE source_kind='subject' AND source_id=$1 AND target_kind='verb'
                    AND relationship_type='has_member'`,
                [id],
              )
            ).map((r) => Number(r.target_id));
            for (const c of cur) {
              if (!want.includes(c)) {
                await dbOne(
                  ctx,
                  "SELECT maludb_svpor_relationship_delete('subject', $1, 'verb', $2, 'has_member')",
                  [id, c],
                );
              }
            }
            for (const w of want) {
              if (!cur.includes(w)) {
                await dbOne(
                  ctx,
                  "SELECT maludb_svpor_relationship_create('subject', $1, 'verb', $2, 'has_member', NULL, '{}'::jsonb, NULL)",
                  [id, w],
                );
              }
            }
          });

          const verbs = await dbMany(
            ctx,
            `SELECT v.verb_id AS id, v.canonical_name AS name, v.verb_type AS type
               FROM maludb_svpor_relationship r
               JOIN maludb_verb v ON v.verb_id = r.target_id
              WHERE r.source_kind='subject' AND r.source_id=$1 AND r.target_kind='verb'
                AND r.relationship_type='has_member'
              ORDER BY v.canonical_name`,
            [id],
          );
          for (const x of verbs) {
            x.id = Number(x.id);
          }

          jsonResponse(reply, { verbs }, 200, ctx);
          return;
        }
      }
    },
  });
}
