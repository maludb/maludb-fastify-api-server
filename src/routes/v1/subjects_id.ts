/**
 * GET    /v1/subjects/:id
 * PATCH  /v1/subjects/:id
 * DELETE /v1/subjects/:id
 *
 * MaluDB concept: Subject detail + embedded verbs[] and related_subjects[] (requirements.md §4.10).
 * SQL objects: maludb_subject, maludb_subject_verb, maludb_verb, maludb_subject_relationship;
 *              document_neighbors (graph facade).
 * Teaches:
 *   - Live-schema mapping: subject_id->id, canonical_name->label, subject_type->type.
 *   - Verb links: maludb_subject_verb (keyed by subject_name = canonical_name).
 *   - Relationships: maludb_subject_relationship (from/to subject ids + labels); the "other" side
 *     is returned with a direction flag.
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

const FILE = 'subjects_id.ts';

/** Fetch a subject with its embedded verbs[] and related_subjects[], or null. */
async function loadSubjectDetail(ctx: RequestCtx, id: number): Promise<Record<string, unknown> | null> {
  const subject = await dbOne(
    ctx,
    `SELECT subject_id     AS id,
            canonical_name AS label,
            subject_type   AS type,
            description,
            classifier_md
       FROM maludb_subject
      WHERE subject_id = $1`,
    [id],
  );
  if (subject === null) {
    return null;
  }
  subject.id = Number(subject.id);

  // Linked verbs — resolve verb details by name through the compartment table.
  const verbs = await dbMany(
    ctx,
    `SELECT v.verb_id        AS id,
            v.canonical_name AS canonical_name,
            v.verb_type      AS type
       FROM maludb_subject_verb sv
       JOIN maludb_verb v ON v.canonical_name = sv.verb_name
      WHERE sv.subject_name = $1
      ORDER BY v.canonical_name`,
    [subject.label],
  );
  for (const v of verbs) {
    v.id = Number(v.id);
  }
  subject.verbs = verbs;

  // Related subjects — either endpoint of a relationship; the "other" side is returned.
  const rels = await dbMany(
    ctx,
    `SELECT relationship_id,
            from_subject_id,
            to_subject_id,
            from_subject_label,
            to_subject_label,
            relationship_type,
            label AS relationship_label,
            valid_from,
            valid_to
       FROM maludb_subject_relationship
      WHERE from_subject_id = $1 OR to_subject_id = $1
      ORDER BY relationship_id`,
    [id],
  );
  const related: Record<string, unknown>[] = [];
  for (const r of rels) {
    const outgoing = Number(r.from_subject_id) === id;
    related.push({
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
  subject.related_subjects = related;

  // Documents linked to this subject through the unified graph (0.87.0). Graph facade needs
  // maludb_core on the search_path, so this one read runs in its own db_tx_core().
  subject.documents = await dbTxCore(ctx, () => documentNeighbors(ctx, id));

  return subject;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH', 'DELETE'],
    url: '/v1/subjects/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const subject = await loadSubjectDetail(ctx, id);
          if (subject === null) {
            jsonError('not_found', 'Subject not found.', 404);
          }
          jsonResponse(reply, { subject }, 200, ctx);
          return;
        }

        case 'PATCH': {
          // Must exist before we attempt an update.
          if ((await dbOne(ctx, 'SELECT 1 FROM maludb_subject WHERE subject_id = $1', [id])) === null) {
            jsonError('not_found', 'Subject not found.', 404);
          }

          const body = bodyObject(request);
          const fields: string[] = [];
          const params: unknown[] = [];

          if (Object.prototype.hasOwnProperty.call(body, 'label')) {
            const label = String(body.label ?? '').trim();
            if (label === '') {
              jsonError('validation_failed', 'Field "label" cannot be empty.', 422);
            }
            params.push(label);
            fields.push(`canonical_name = $${params.length}`);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'type')) {
            params.push(body.type === null ? null : String(body.type));
            fields.push(`subject_type = $${params.length}`);
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
            jsonError('bad_request', 'No updatable fields provided (label, type, description, classifier_md).', 400);
          }

          params.push(id);
          await dbExec(
            ctx,
            `UPDATE maludb_subject SET ${fields.join(', ')} WHERE subject_id = $${params.length}`,
            params,
          );

          jsonResponse(reply, { subject: await loadSubjectDetail(ctx, id) }, 200, ctx);
          return;
        }

        case 'DELETE': {
          const n = await dbExec(ctx, 'DELETE FROM maludb_subject WHERE subject_id = $1', [id]);
          if (n === 0) {
            jsonError('not_found', 'Subject not found.', 404);
          }
          jsonResponse(reply, { deleted: true, id }, 200, ctx);
          return;
        }
      }
    },
  });
}
