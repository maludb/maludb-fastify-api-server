/**
 * GET    /v1/verbs/{id}
 * PATCH  /v1/verbs/{id}
 * DELETE /v1/verbs/{id}
 *
 * MaluDB concept: Verb detail (requirements.md §4.2).
 * SQL objects: maludb_verb, maludb_subject_verb, maludb_subject.
 * Teaches:
 *   - Live-schema mapping: verb_id → id, verb_type → type.
 *   - GET embeds subjects[] (the linked subjects), resolved by name through
 *     maludb_subject_verb keyed by verb_name (= canonical_name).
 *   - PATCH is a partial update: only the fields present in the body are written.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne, dbExec } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx, Row } from '../../types/db.js';

const FILE = 'verbs_id.ts';

/** Fetch a verb with its embedded subjects[], or null if it doesn't exist. */
async function loadVerbDetail(ctx: RequestCtx, id: number): Promise<Row | null> {
  const verb = await dbOne(
    ctx,
    `SELECT verb_id        AS id,
            canonical_name AS canonical_name,
            verb_type      AS type,
            description,
            classifier_md
       FROM maludb_verb
      WHERE verb_id = $1`,
    [id],
  );
  if (verb === null) {
    return null;
  }
  verb.id = Number(verb.id);

  // Linked subjects — resolve subject details by name through the compartment table.
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
  verb.subjects = subjects;

  return verb;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH', 'DELETE'],
    url: '/v1/verbs/:id',
    handler: async (request: FastifyRequest, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      if (request.method === 'GET') {
        const verb = await loadVerbDetail(ctx, id);
        if (verb === null) {
          jsonError('not_found', 'Verb not found.', 404);
        }
        jsonResponse(reply, { verb }, 200, ctx);
        return;
      }

      if (request.method === 'PATCH') {
        if ((await dbOne(ctx, 'SELECT 1 FROM maludb_verb WHERE verb_id = $1', [id])) === null) {
          jsonError('not_found', 'Verb not found.', 404);
        }

        const body = bodyObject(request);
        const fields: string[] = [];
        const params: unknown[] = [];

        if (Object.prototype.hasOwnProperty.call(body, 'canonical_name')) {
          const name = String(body.canonical_name ?? '').trim();
          if (name === '') {
            jsonError('validation_failed', 'Field "canonical_name" cannot be empty.', 422);
          }
          params.push(name);
          fields.push(`canonical_name = $${params.length}`);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'type')) {
          params.push(body.type === null ? null : String(body.type));
          fields.push(`verb_type = $${params.length}`);
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
          jsonError(
            'bad_request',
            'No updatable fields provided (canonical_name, type, description, classifier_md).',
            400,
          );
        }

        params.push(id);
        await dbExec(
          ctx,
          `UPDATE maludb_verb SET ${fields.join(', ')} WHERE verb_id = $${params.length}`,
          params,
        );

        jsonResponse(reply, { verb: await loadVerbDetail(ctx, id) }, 200, ctx);
        return;
      }

      // DELETE
      const n = await dbExec(ctx, 'DELETE FROM maludb_verb WHERE verb_id = $1', [id]);
      if (n === 0) {
        jsonError('not_found', 'Verb not found.', 404);
      }
      jsonResponse(reply, { deleted: true, id }, 200, ctx);
    },
  });
}
