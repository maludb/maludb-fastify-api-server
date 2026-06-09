/**
 * GET  /v1/notes
 * POST /v1/notes
 *
 * MaluDB concept: Notes / memories (requirements.md §4.5).
 * SQL objects: maludb_memory, maludb_project (project_id validation).
 * Teaches:
 *   - Live-schema mapping: memory_id -> id, title -> title, summary -> body,
 *     memory_kind -> type (default 'note'; 'issue' enables close/reopen).
 *   - project_id is stored INSIDE payload_jsonb (payload_jsonb->>'project_id'); it is read back
 *     with a ::bigint cast and bound on write via $N::jsonb.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr, bodyObject } from '../../http/request.js';

const FILE = 'notes.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/notes',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      if (request.method === 'GET') {
        const q = queryStr(request, 'q', null, 200);
        const type = queryStr(request, 'type', null, 60);
        const limit = queryInt(request, 'limit', 50, 200) ?? 50;

        const clauses: string[] = [];
        const params: unknown[] = [];
        if (type !== null && type !== '') {
          params.push(type);
          clauses.push(`memory_kind = $${params.length}`);
        }
        if (q !== null && q !== '') {
          params.push(`%${q}%`);
          clauses.push(`(title ILIKE $${params.length} OR summary ILIKE $${params.length})`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = params.length;

        const sql = `
          SELECT memory_id   AS id,
                 title,
                 summary     AS body,
                 memory_kind AS type,
                 (payload_jsonb->>'project_id')::bigint AS project_id,
                 issue_closed_at,
                 created_at
            FROM maludb_memory
            ${where}
           ORDER BY created_at DESC NULLS LAST, memory_id DESC
           LIMIT $${limitIdx}`;

        const rows = await dbMany(ctx, sql, params);
        for (const r of rows) {
          r.id = Number(r.id);
          r.project_id = r.project_id === null ? null : Number(r.project_id);
        }

        jsonResponse(reply, { notes: rows }, 200, ctx);
        return;
      }

      // POST
      const body = bodyObject(request);
      const title = String(body.title ?? '').trim();
      if (title === '') {
        jsonError('missing_field', 'Field "title" is required.', 400);
      }
      const text = body.body !== undefined ? String(body.body) : null;
      const type =
        body.type !== undefined && String(body.type).trim() !== '' ? String(body.type) : 'note';

      let payload = '{}';
      let projectId: number | null = null;
      if (Object.prototype.hasOwnProperty.call(body, 'project_id') && body.project_id !== null) {
        if (!Number.isInteger(body.project_id)) {
          jsonError('validation_failed', '"project_id" must be an integer.', 422);
        }
        projectId = Number(body.project_id);
        if (
          (await dbOne(ctx, 'SELECT 1 FROM maludb_project WHERE subject_id = $1', [projectId])) ===
          null
        ) {
          jsonError('validation_failed', 'project_id does not refer to an existing project.', 422);
        }
        payload = JSON.stringify({ project_id: projectId });
      }

      const note = await dbOne(
        ctx,
        `INSERT INTO maludb_memory (memory_kind, title, summary, payload_jsonb, recorded_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         RETURNING memory_id AS id, title, summary AS body, memory_kind AS type,
                   issue_closed_at, created_at`,
        [type, title, text, payload],
      );
      if (note === null) jsonError('internal_error', 'Note creation returned no row.', 500);
      note.id = Number(note.id);
      note.project_id = projectId;

      jsonResponse(reply, { note }, 201, ctx);
    },
  });
}
