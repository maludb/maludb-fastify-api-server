/**
 * GET    /v1/episodes/:id
 * PATCH  /v1/episodes/:id
 * DELETE /v1/episodes/:id
 *
 * MaluDB concept: a single event (maludb_core 0.82.0).
 * SQL objects: maludb_episode (writable view), maludb_episode_get (assembly facade).
 * Teaches:
 *   - GET returns the assembled event { episode, subject, statements[], details[] } via
 *     maludb_episode_get(id) — the RAW facade JSON object (not key-wrapped). statements[] are every
 *     SVO link whose subject or object is this episode, with *_label fields already resolved.
 *   - PATCH updates the episode (title/summary/kind/payload/occurred_at/occurred_until/sensitivity/
 *     provenance/lifecycle_state) via UPDATE maludb_episode; provenance is the accept/reject
 *     transition for machine-suggested events.
 *   - DELETE removes the episode.
 *   - lifecycle_state / sensitivity / provenance value sets are DB-enforced → 422.
 * Everything runs inside dbTxCore() so the facade resolves its malu$* base tables.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne, dbExec } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'episodes_id.ts';

/**
 * Assembled event via maludb_episode_get(); null when the episode doesn't exist. The facade returns
 * jsonb, already parsed by node-pg, so the DB's shape is preserved faithfully (no JSON.parse).
 */
async function loadEpisode(ctx: RequestCtx, id: number): Promise<unknown | null> {
  const row = await dbOne(ctx, 'SELECT maludb_episode_get($1) AS j', [id]);
  if (row === null || row.j === null || row.j === undefined) {
    return null;
  }
  return row.j;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH', 'DELETE'],
    url: '/v1/episodes/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const event = await dbTxCore(ctx, () => loadEpisode(ctx, id));
          if (event === null) {
            jsonError('not_found', 'Episode not found.', 404);
          }
          jsonResponse(reply, event, 200, ctx);
          return;
        }

        case 'PATCH': {
          const body = bodyObject(request);

          // Map request fields → (column, value, placeholder-with-optional-cast).
          const fields: string[] = [];
          const params: unknown[] = [];
          const set = (col: string, val: unknown, cast = ''): void => {
            params.push(val);
            fields.push(`${col} = $${params.length}${cast}`);
          };

          if (Object.prototype.hasOwnProperty.call(body, 'title')) {
            const title = String(body.title).trim();
            if (title === '') {
              jsonError('validation_failed', 'Field "title" cannot be empty.', 422);
            }
            set('title', title);
          }
          if (Object.prototype.hasOwnProperty.call(body, 'summary')) {
            set('summary', body.summary === null ? null : String(body.summary));
          }
          if (Object.prototype.hasOwnProperty.call(body, 'kind')) {
            set('episode_kind', String(body.kind));
          }
          if (Object.prototype.hasOwnProperty.call(body, 'payload')) {
            set('payload_jsonb', body.payload === null ? null : JSON.stringify(body.payload), '::jsonb');
          }
          if (Object.prototype.hasOwnProperty.call(body, 'occurred_at')) {
            set('occurred_at', body.occurred_at === null ? null : String(body.occurred_at), '::timestamptz');
          }
          if (Object.prototype.hasOwnProperty.call(body, 'occurred_until')) {
            set('occurred_until', body.occurred_until === null ? null : String(body.occurred_until), '::timestamptz');
          }
          if (Object.prototype.hasOwnProperty.call(body, 'sensitivity')) {
            set('sensitivity', String(body.sensitivity));
          }
          if (Object.prototype.hasOwnProperty.call(body, 'provenance')) {
            set('provenance', String(body.provenance));
          }
          if (Object.prototype.hasOwnProperty.call(body, 'lifecycle_state')) {
            set('lifecycle_state', String(body.lifecycle_state));
          }

          if (fields.length === 0) {
            jsonError('bad_request', 'No updatable fields provided (title, summary, kind, payload, occurred_at, occurred_until, sensitivity, provenance, lifecycle_state).', 400);
          }

          params.push(id);
          const idIdx = params.length;
          const event = await dbTxCore(ctx, async () => {
            const n = await dbExec(
              ctx,
              `UPDATE maludb_episode SET ${fields.join(', ')} WHERE episode_id = $${idIdx}`,
              params,
            );
            if (n === 0) {
              return null;
            }
            return loadEpisode(ctx, id);
          });
          if (event === null) {
            jsonError('not_found', 'Episode not found.', 404);
          }
          jsonResponse(reply, event, 200, ctx);
          return;
        }

        case 'DELETE': {
          const n = await dbTxCore(ctx, () =>
            dbExec(ctx, 'DELETE FROM maludb_episode WHERE episode_id = $1', [id]),
          );
          if (n === 0) {
            jsonError('not_found', 'Episode not found.', 404);
          }
          jsonResponse(reply, { deleted: true, id }, 200, ctx);
          return;
        }
      }
    },
  });
}
