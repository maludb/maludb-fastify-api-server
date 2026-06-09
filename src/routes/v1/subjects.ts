/**
 * GET  /v1/subjects
 * POST /v1/subjects
 *
 * MaluDB concept: Subject catalog.
 * SQL objects: maludb_subject, maludb_subject_verb, maludb_subject_relationship,
 *              maludb_subject_with_attributes (?with=attributes)
 * Teaches:
 *   - Subjects are canonical named entities; subject_id → id, canonical_name → label.
 *   - Subject↔verb links are counted through maludb_subject_verb (keyed by canonical_name).
 *   - subject_id has no sequence in this DB — POST derives it inline with COALESCE(MAX+1).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { attachAttributes } from '../../db/attributes.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr, bodyObject } from '../../http/request.js';

const FILE = 'subjects.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/subjects',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      if (request.method === 'GET') {
        const q = queryStr(request, 'q', null, 200);
        const limit = queryInt(request, 'limit', 50, 200) ?? 50;

        const params: unknown[] = [];
        let where = '';
        if (q !== null && q !== '') {
          params.push(`%${q}%`);
          where = 'WHERE s.canonical_name ILIKE $1 OR s.description ILIKE $1';
        }
        params.push(limit);
        const limitIdx = params.length;

        const sql = `
          SELECT s.subject_id     AS id,
                 s.canonical_name AS label,
                 s.subject_type   AS type,
                 s.description,
                 s.classifier_md,
                 (SELECT count(*) FROM maludb_subject_verb sv
                    WHERE sv.subject_name = s.canonical_name) AS linked_verbs,
                 (SELECT count(*) FROM maludb_subject_relationship r
                    WHERE r.from_subject_id = s.subject_id
                       OR r.to_subject_id   = s.subject_id) AS related_subjects
            FROM maludb_subject s
            ${where}
           ORDER BY s.canonical_name
           LIMIT $${limitIdx}`;

        const rows = await dbMany(ctx, sql, params);
        for (const r of rows) {
          r.id = Number(r.id);
          r.linked_verbs = Number(r.linked_verbs);
          r.related_subjects = Number(r.related_subjects);
        }

        if (queryStr(request, 'with', null, 40) === 'attributes') {
          await attachAttributes(ctx, rows, 'maludb_subject_with_attributes', 'subject_id');
        }

        jsonResponse(reply, { subjects: rows }, 200, ctx);
        return;
      }

      // POST
      const body = bodyObject(request);
      const label = String(body.label ?? '').trim();
      if (label === '') {
        jsonError('missing_field', 'Field "label" is required.', 400);
      }
      const type = body.type !== undefined ? String(body.type) : null;
      const description = body.description !== undefined ? String(body.description) : null;
      const classifierMd = body.classifier_md !== undefined ? String(body.classifier_md) : null;

      const created = await dbOne(
        ctx,
        `INSERT INTO maludb_subject
             (subject_id, canonical_name, subject_type, description, classifier_md, created_at)
         SELECT COALESCE(MAX(subject_id), 0) + 1, $1, $2, $3, $4, now()
           FROM maludb_subject
         RETURNING subject_id     AS id,
                   canonical_name AS label,
                   subject_type   AS type,
                   description,
                   classifier_md`,
        [label, type, description, classifierMd],
      );
      if (created === null) jsonError('internal_error', 'Subject creation returned no row.', 500);
      created.id = Number(created.id);
      created.linked_verbs = 0;

      jsonResponse(reply, { subject: created }, 201, ctx);
    },
  });
}
