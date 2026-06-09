/**
 * PATCH  /v1/episode-types/{id}
 * DELETE /v1/episode-types/{id}
 *
 * MaluDB concept: Episode-type picker entry (maludb_core 0.82.0).
 * SQL objects: maludb_episode_type (writable per-schema view).
 * Teaches:
 *   - The label is case-insensitive unique — a colliding update raises 23505,
 *     mapped to 409 by the global handler.
 *   - Deleting a type does NOT affect episodes already tagged with that kind
 *     string: episode.episode_kind is free text with no FK to this list.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne, dbExec } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx, Row } from '../../types/db.js';

const FILE = 'episode-types_id.ts';

async function loadEpisodeType(ctx: RequestCtx, id: number): Promise<Row | null> {
  const row = await dbOne(
    ctx,
    `SELECT episode_type_id AS id, episode_type, description, display_order, created_at
       FROM maludb_episode_type
      WHERE episode_type_id = $1`,
    [id],
  );
  if (row === null) {
    return null;
  }
  row.id = Number(row.id);
  row.display_order = row.display_order === null ? null : Number(row.display_order);
  return row;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['PATCH', 'DELETE'],
    url: '/v1/episode-types/:id',
    handler: async (request: FastifyRequest, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      if (request.method === 'PATCH') {
        if (
          (await dbOne(ctx, 'SELECT 1 FROM maludb_episode_type WHERE episode_type_id = $1', [
            id,
          ])) === null
        ) {
          jsonError('not_found', 'Episode type not found.', 404);
        }

        const body = bodyObject(request);
        const fields: string[] = [];
        const params: unknown[] = [];

        if (Object.prototype.hasOwnProperty.call(body, 'episode_type')) {
          const label = String(body.episode_type ?? '').trim();
          if (label === '') {
            jsonError('validation_failed', 'Field "episode_type" cannot be empty.', 422);
          }
          params.push(label);
          fields.push(`episode_type = $${params.length}`);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'description')) {
          params.push(body.description === null ? null : String(body.description));
          fields.push(`description = $${params.length}`);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'display_order')) {
          if (body.display_order !== null && !Number.isInteger(body.display_order)) {
            jsonError('validation_failed', '"display_order" must be an integer.', 422);
          }
          params.push(body.display_order === null ? null : Number(body.display_order));
          fields.push(`display_order = $${params.length}`);
        }
        if (fields.length === 0) {
          jsonError(
            'bad_request',
            'No updatable fields provided (episode_type, description, display_order).',
            400,
          );
        }

        params.push(id);
        await dbExec(
          ctx,
          `UPDATE maludb_episode_type SET ${fields.join(', ')} WHERE episode_type_id = $${params.length}`,
          params,
        );

        jsonResponse(reply, { episode_type: await loadEpisodeType(ctx, id) }, 200, ctx);
        return;
      }

      // DELETE
      const n = await dbExec(ctx, 'DELETE FROM maludb_episode_type WHERE episode_type_id = $1', [
        id,
      ]);
      if (n === 0) {
        jsonError('not_found', 'Episode type not found.', 404);
      }
      jsonResponse(reply, { deleted: true, id }, 200, ctx);
    },
  });
}
