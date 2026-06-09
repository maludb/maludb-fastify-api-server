/**
 * POST /v1/notes/:id/close-issue
 *
 * MaluDB concept: Close an issue-type note (requirements.md §4.5).
 * SQL objects: maludb_memory.
 * Teaches:
 *   - Sets issue_closed_at = now(). Gated on memory_kind = 'issue'.
 *   - 409 conflict if the note is not an issue (type != 'issue') or is already closed.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne, dbExec } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId } from '../../http/request.js';

const FILE = 'notes_id_close-issue.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST'],
    url: '/v1/notes/:id/close-issue',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      const note = await dbOne(
        ctx,
        'SELECT memory_kind, issue_closed_at FROM maludb_memory WHERE memory_id = $1',
        [id],
      );
      if (note === null) {
        jsonError('not_found', 'Note not found.', 404);
      }
      if (note.memory_kind !== 'issue') {
        jsonError('conflict', 'Note is not an issue.', 409);
      }
      if (note.issue_closed_at !== null) {
        jsonError('conflict', 'Issue is already closed.', 409);
      }

      await dbExec(
        ctx,
        'UPDATE maludb_memory SET issue_closed_at = now(), updated_at = now() WHERE memory_id = $1',
        [id],
      );

      const row = await dbOne(
        ctx,
        `SELECT memory_id AS id, title, summary AS body, memory_kind AS type,
                issue_closed_at FROM maludb_memory WHERE memory_id = $1`,
        [id],
      );
      if (row === null) jsonError('internal_error', 'Note not found after update.', 500);
      row.id = Number(row.id);

      jsonResponse(reply, { note: row }, 200, ctx);
    },
  });
}
