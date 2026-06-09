/**
 * GET  /v1/subjects/:id/verbs
 * POST /v1/subjects/:id/verbs
 *
 * MaluDB concept: the verbs linked to a subject (requirements.md §4.1).
 * SQL objects: maludb_subject, maludb_subject_verb, maludb_verb, maludb_subject_verb_link (function).
 * Teaches:
 *   - Links live in maludb_subject_verb keyed by subject_name (= canonical_name).
 *   - POST links a verb via maludb_subject_verb_link(subject_id, verb_id), which mints the per-pair
 *     vector compartment and returns its id.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';

const FILE = 'subjects_id_verbs.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/subjects/:id/verbs',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const subject = await dbOne(
            ctx,
            'SELECT canonical_name FROM maludb_subject WHERE subject_id = $1',
            [id],
          );
          if (subject === null) {
            jsonError('not_found', 'Subject not found.', 404);
          }

          const verbs = await dbMany(
            ctx,
            `SELECT v.verb_id        AS id,
                    v.canonical_name AS canonical_name,
                    v.verb_type      AS type
               FROM maludb_subject_verb sv
               JOIN maludb_verb v ON v.canonical_name = sv.verb_name
              WHERE sv.subject_name = $1
              ORDER BY v.canonical_name`,
            [subject!.canonical_name],
          );
          for (const v of verbs) {
            v.id = Number(v.id);
          }

          jsonResponse(reply, { verbs }, 200, ctx);
          return;
        }

        case 'POST': {
          const subject = await dbOne(
            ctx,
            'SELECT canonical_name FROM maludb_subject WHERE subject_id = $1',
            [id],
          );
          if (subject === null) {
            jsonError('not_found', 'Subject not found.', 404);
          }

          const body = bodyObject(request);
          if (!Object.prototype.hasOwnProperty.call(body, 'verb_id') || !Number.isInteger(body.verb_id)) {
            jsonError('missing_field', 'Field "verb_id" (integer) is required.', 400);
          }
          const verbId = Number(body.verb_id);

          const verb = await dbOne(
            ctx,
            'SELECT verb_id AS id, canonical_name, verb_type AS type FROM maludb_verb WHERE verb_id = $1',
            [verbId],
          );
          if (verb === null) {
            jsonError('validation_failed', 'verb_id does not refer to an existing verb.', 422);
          }

          // Already linked? maludb_subject_verb is keyed by name.
          const exists = await dbOne(
            ctx,
            'SELECT 1 FROM maludb_subject_verb WHERE subject_name = $1 AND verb_name = $2',
            [subject!.canonical_name, verb!.canonical_name],
          );
          if (exists !== null) {
            jsonError('conflict', 'That verb is already linked to the subject.', 409);
          }

          const row = await dbOne(
            ctx,
            'SELECT maludb_subject_verb_link($1, $2) AS compartment_id',
            [id, verbId],
          );
          verb!.id = Number(verb!.id);

          jsonResponse(
            reply,
            {
              verb,
              compartment_id: Number(row!.compartment_id),
            },
            201,
            ctx,
          );
          return;
        }
      }
    },
  });
}
