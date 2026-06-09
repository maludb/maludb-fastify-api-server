/**
 * GET    /v1/notes/:id
 * PATCH  /v1/notes/:id
 * DELETE /v1/notes/:id
 *
 * MaluDB concept: Note detail (requirements.md §4.5).
 * SQL objects: maludb_memory, maludb_project (project_id validation).
 * Teaches:
 *   - Backed by maludb_memory (see notes.ts for the field mapping).
 *   - project_id lives inside payload_jsonb: setting it uses jsonb_set(...to_jsonb($N::bigint)),
 *     clearing it (null) uses `payload_jsonb - 'project_id'`.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne, dbExec } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'notes_id.ts';

/** Fetch a note by id, or null. */
async function loadNote(ctx: RequestCtx, id: number): Promise<Record<string, unknown> | null> {
  const note = await dbOne(
    ctx,
    `SELECT memory_id AS id, title, summary AS body, memory_kind AS type,
            (payload_jsonb->>'project_id')::bigint AS project_id,
            issue_closed_at, created_at, updated_at
       FROM maludb_memory
      WHERE memory_id = $1`,
    [id],
  );
  if (note === null) {
    return null;
  }
  note.id = Number(note.id);
  note.project_id = note.project_id === null ? null : Number(note.project_id);
  return note;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH', 'DELETE'],
    url: '/v1/notes/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const note = await loadNote(ctx, id);
          if (note === null) {
            jsonError('not_found', 'Note not found.', 404);
          }
          jsonResponse(reply, { note }, 200, ctx);
          return;
        }

        case 'PATCH': {
          if ((await dbOne(ctx, 'SELECT 1 FROM maludb_memory WHERE memory_id = $1', [id])) === null) {
            jsonError('not_found', 'Note not found.', 404);
          }

          const body = bodyObject(request);
          const fields: string[] = [];
          const params: unknown[] = [];

          if (Object.prototype.hasOwnProperty.call(body, 'title')) {
            const title = String(body.title ?? '').trim();
            if (title === '') {
              jsonError('validation_failed', 'Field "title" cannot be empty.', 422);
            }
            params.push(title);
            fields.push(`title = $${params.length}`);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'body')) {
            params.push(body.body === null ? null : String(body.body));
            fields.push(`summary = $${params.length}`);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'type')) {
            const type = String(body.type ?? '').trim();
            if (type === '') {
              jsonError('validation_failed', 'Field "type" cannot be empty.', 422);
            }
            params.push(type);
            fields.push(`memory_kind = $${params.length}`);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'project_id')) {
            if (body.project_id === null) {
              fields.push("payload_jsonb = payload_jsonb - 'project_id'");
            } else {
              if (!Number.isInteger(body.project_id)) {
                jsonError('validation_failed', '"project_id" must be an integer or null.', 422);
              }
              const pid = Number(body.project_id);
              if (
                (await dbOne(ctx, 'SELECT 1 FROM maludb_project WHERE subject_id = $1', [pid])) ===
                null
              ) {
                jsonError(
                  'validation_failed',
                  'project_id does not refer to an existing project.',
                  422,
                );
              }
              params.push(pid);
              fields.push(
                `payload_jsonb = jsonb_set(COALESCE(payload_jsonb,'{}'::jsonb), '{project_id}', to_jsonb($${params.length}::bigint))`,
              );
            }
          }
          if (fields.length === 0) {
            jsonError('bad_request', 'No updatable fields provided (title, body, type, project_id).', 400);
          }

          fields.push('updated_at = now()');
          params.push(id);
          await dbExec(
            ctx,
            `UPDATE maludb_memory SET ${fields.join(', ')} WHERE memory_id = $${params.length}`,
            params,
          );

          jsonResponse(reply, { note: await loadNote(ctx, id) }, 200, ctx);
          return;
        }

        case 'DELETE': {
          const n = await dbExec(ctx, 'DELETE FROM maludb_memory WHERE memory_id = $1', [id]);
          if (n === 0) {
            jsonError('not_found', 'Note not found.', 404);
          }
          jsonResponse(reply, { deleted: true, id }, 200, ctx);
          return;
        }
      }
    },
  });
}
