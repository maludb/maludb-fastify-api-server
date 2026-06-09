/**
 * GET    /v1/subject-relationships/:id
 * PATCH  /v1/subject-relationships/:id
 * DELETE /v1/subject-relationships/:id
 *
 * MaluDB concept: a single subject↔subject relationship row.
 * SQL objects: maludb_subject_relationship (writable view).
 * Teaches:
 *   - Row-level companion to the pair-level DELETE /v1/subjects/:id/related-subjects/:otherId.
 *   - The DB enforces the relationship_type FK (unregistered type → 422) and the valid_from <
 *     valid_to CHECK (→ 422).
 *   - PATCH: pass null for valid_from/valid_to to clear that bound; omit the field to leave it
 *     unchanged.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne, dbExec } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'subject-relationships_id.ts';

async function loadRelationship(ctx: RequestCtx, id: number): Promise<Record<string, unknown> | null> {
  const row = await dbOne(
    ctx,
    `SELECT relationship_id   AS id,
            from_subject_id, to_subject_id,
            from_subject_label, to_subject_label,
            relationship_type,
            label,
            valid_from, valid_to,
            created_at
       FROM maludb_subject_relationship
      WHERE relationship_id = $1`,
    [id],
  );
  if (row === null) {
    return null;
  }
  row.id = Number(row.id);
  row.from_subject_id = Number(row.from_subject_id);
  row.to_subject_id = Number(row.to_subject_id);
  return row;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH', 'DELETE'],
    url: '/v1/subject-relationships/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const row = await loadRelationship(ctx, id);
          if (row === null) {
            jsonError('not_found', 'Relationship not found.', 404);
          }
          jsonResponse(reply, { relationship: row }, 200, ctx);
          return;
        }

        case 'PATCH': {
          if (
            (await dbOne(
              ctx,
              'SELECT 1 FROM maludb_subject_relationship WHERE relationship_id = $1',
              [id],
            )) === null
          ) {
            jsonError('not_found', 'Relationship not found.', 404);
          }

          const body = bodyObject(request);
          const fields: string[] = [];
          const params: unknown[] = [];

          if (Object.prototype.hasOwnProperty.call(body, 'relationship_type')) {
            const rt = String(body.relationship_type ?? '').trim();
            if (rt === '') {
              jsonError('validation_failed', 'Field "relationship_type" cannot be empty.', 422);
            }
            params.push(rt);
            fields.push(`relationship_type = $${params.length}`);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'label')) {
            params.push(body.label === null ? null : String(body.label));
            fields.push(`label = $${params.length}`);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'valid_from')) {
            params.push(body.valid_from === null || body.valid_from === '' ? null : String(body.valid_from));
            fields.push(`valid_from = $${params.length}::timestamptz`);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'valid_to')) {
            params.push(body.valid_to === null || body.valid_to === '' ? null : String(body.valid_to));
            fields.push(`valid_to = $${params.length}::timestamptz`);
          }
          if (fields.length === 0) {
            jsonError('bad_request', 'No updatable fields provided (relationship_type, label, valid_from, valid_to).', 400);
          }

          params.push(id);
          await dbExec(
            ctx,
            `UPDATE maludb_subject_relationship SET ${fields.join(', ')} WHERE relationship_id = $${params.length}`,
            params,
          );

          jsonResponse(reply, { relationship: await loadRelationship(ctx, id) }, 200, ctx);
          return;
        }

        case 'DELETE': {
          const n = await dbExec(
            ctx,
            'DELETE FROM maludb_subject_relationship WHERE relationship_id = $1',
            [id],
          );
          if (n === 0) {
            jsonError('not_found', 'Relationship not found.', 404);
          }
          jsonResponse(reply, { deleted: true, id }, 200, ctx);
          return;
        }
      }
    },
  });
}
