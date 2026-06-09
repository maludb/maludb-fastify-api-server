/**
 * GET  /v1/subjects/:id/related-subjects
 * POST /v1/subjects/:id/related-subjects
 *
 * MaluDB concept: the subjects related to this subject (requirements.md §4.1).
 * SQL objects: maludb_subject, maludb_subject_relationship.
 * Teaches:
 *   - Relationships live in maludb_subject_relationship (insertable single-table view); each row is
 *     bidirectional, typed, and temporally bounded (valid_from/valid_to timestamptz).
 *   - GET returns the "other" endpoint of each relationship with a direction flag.
 *   - POST defaults relationship_type to 'related_to'; relationship_id is derived inline via
 *     COALESCE(MAX+1).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { Row } from '../../types/db.js';

const FILE = 'subjects_id_related-subjects.ts';

/** The other endpoint of each relationship row, mapped for output. */
function mapRelated(rels: Row[], id: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of rels) {
    const outgoing = Number(r.from_subject_id) === id;
    out.push({
      relationship_id: Number(r.relationship_id),
      id: Number(outgoing ? r.to_subject_id : r.from_subject_id),
      label: outgoing ? r.to_subject_label : r.from_subject_label,
      relationship_type: r.relationship_type,
      relationship_label: r.relationship_label,
      direction: outgoing ? 'outgoing' : 'incoming',
      valid_from: r.valid_from,
      valid_to: r.valid_to,
    });
  }
  return out;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/subjects/:id/related-subjects',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const subject = await dbOne(
            ctx,
            'SELECT subject_id FROM maludb_subject WHERE subject_id = $1',
            [id],
          );
          if (subject === null) {
            jsonError('not_found', 'Subject not found.', 404);
          }
          const rels = await dbMany(
            ctx,
            `SELECT relationship_id, from_subject_id, to_subject_id,
                    from_subject_label, to_subject_label,
                    relationship_type, label AS relationship_label,
                    valid_from, valid_to
               FROM maludb_subject_relationship
              WHERE from_subject_id = $1 OR to_subject_id = $1
              ORDER BY relationship_id`,
            [id],
          );
          jsonResponse(reply, { related_subjects: mapRelated(rels, id) }, 200, ctx);
          return;
        }

        case 'POST': {
          const me = await dbOne(
            ctx,
            'SELECT canonical_name FROM maludb_subject WHERE subject_id = $1',
            [id],
          );
          if (me === null) {
            jsonError('not_found', 'Subject not found.', 404);
          }

          const body = bodyObject(request);
          if (
            !Object.prototype.hasOwnProperty.call(body, 'related_subject_id') ||
            !Number.isInteger(body.related_subject_id)
          ) {
            jsonError('missing_field', 'Field "related_subject_id" (integer) is required.', 400);
          }
          const otherId = Number(body.related_subject_id);
          if (otherId === id) {
            jsonError('validation_failed', 'A subject cannot be related to itself.', 422);
          }
          const rtype =
            body.relationship_type !== undefined &&
            body.relationship_type !== null &&
            String(body.relationship_type).trim() !== ''
              ? String(body.relationship_type)
              : 'related_to';
          const validFrom =
            body.valid_from !== undefined && body.valid_from !== null && body.valid_from !== ''
              ? String(body.valid_from)
              : null;
          const validTo =
            body.valid_to !== undefined && body.valid_to !== null && body.valid_to !== ''
              ? String(body.valid_to)
              : null;

          const other = await dbOne(
            ctx,
            'SELECT canonical_name FROM maludb_subject WHERE subject_id = $1',
            [otherId],
          );
          if (other === null) {
            jsonError('validation_failed', 'related_subject_id does not refer to an existing subject.', 422);
          }

          // Reject an exact duplicate (same direction + type).
          const dup = await dbOne(
            ctx,
            `SELECT 1 FROM maludb_subject_relationship
              WHERE from_subject_id = $1 AND to_subject_id = $2 AND relationship_type = $3`,
            [id, otherId, rtype],
          );
          if (dup !== null) {
            jsonError('conflict', 'That related-subject link already exists.', 409);
          }

          const created = await dbOne(
            ctx,
            `INSERT INTO maludb_subject_relationship
                 (relationship_id, from_subject_id, to_subject_id,
                  from_subject_label, to_subject_label, relationship_type, valid_from, valid_to, created_at)
             SELECT COALESCE(MAX(relationship_id), 0) + 1, $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, now()
               FROM maludb_subject_relationship
             RETURNING relationship_id, valid_from, valid_to`,
            [id, otherId, me!.canonical_name, other!.canonical_name, rtype, validFrom, validTo],
          );

          jsonResponse(
            reply,
            {
              related_subject: {
                relationship_id: Number(created!.relationship_id),
                id: otherId,
                label: other!.canonical_name,
                relationship_type: rtype,
                relationship_label: null,
                direction: 'outgoing',
                valid_from: created!.valid_from,
                valid_to: created!.valid_to,
              },
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
