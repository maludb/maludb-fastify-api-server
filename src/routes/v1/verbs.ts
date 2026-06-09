/**
 * GET  /v1/verbs
 * POST /v1/verbs
 *
 * MaluDB concept: Verb catalog (requirements.md §4.2).
 * SQL objects: maludb_verb, maludb_subject_verb.
 * Teaches:
 *   - Live-schema mapping: verb_id → id, verb_type → type; canonical_name,
 *     description, classifier_md map straight through.
 *   - Each row carries linked_subjects, counted through maludb_subject_verb
 *     keyed by verb_name (= canonical_name).
 *   - verb_id has no sequence/default in this DB — POST derives it inline with
 *     COALESCE(MAX+1).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr, bodyObject } from '../../http/request.js';

const FILE = 'verbs.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/verbs',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      if (request.method === 'GET') {
        const q = queryStr(request, 'q', null, 200);
        const limit = queryInt(request, 'limit', 50, 200) ?? 50;

        const params: unknown[] = [];
        let where = '';
        if (q !== null && q !== '') {
          params.push(`%${q}%`);
          where = 'WHERE v.canonical_name ILIKE $1 OR v.description ILIKE $1';
        }
        params.push(limit);
        const limitIdx = params.length;

        const sql = `
          SELECT v.verb_id        AS id,
                 v.canonical_name AS canonical_name,
                 v.verb_type      AS type,
                 v.description,
                 v.classifier_md,
                 (SELECT count(*) FROM maludb_subject_verb sv
                    WHERE sv.verb_name = v.canonical_name) AS linked_subjects
            FROM maludb_verb v
            ${where}
           ORDER BY v.canonical_name
           LIMIT $${limitIdx}`;

        const rows = await dbMany(ctx, sql, params);
        for (const r of rows) {
          r.id = Number(r.id);
          r.linked_subjects = Number(r.linked_subjects);
        }

        jsonResponse(reply, { verbs: rows }, 200, ctx);
        return;
      }

      // POST
      const body = bodyObject(request);
      const name = String(body.canonical_name ?? '').trim();
      if (name === '') {
        jsonError('missing_field', 'Field "canonical_name" is required.', 400);
      }
      const type = body.type !== undefined ? String(body.type) : null;
      const description = body.description !== undefined ? String(body.description) : null;
      const classifierMd = body.classifier_md !== undefined ? String(body.classifier_md) : null;

      // verb_id has no sequence/default in this DB — derive it inline.
      const created = await dbOne(
        ctx,
        `INSERT INTO maludb_verb
             (verb_id, canonical_name, verb_type, description, classifier_md, created_at)
         SELECT COALESCE(MAX(verb_id), 0) + 1, $1, $2, $3, $4, now()
           FROM maludb_verb
         RETURNING verb_id        AS id,
                   canonical_name AS canonical_name,
                   verb_type      AS type,
                   description,
                   classifier_md`,
        [name, type, description, classifierMd],
      );
      if (created === null) jsonError('internal_error', 'Verb creation returned no row.', 500);
      created.id = Number(created.id);
      created.linked_subjects = 0;

      jsonResponse(reply, { verb: created }, 201, ctx);
    },
  });
}
