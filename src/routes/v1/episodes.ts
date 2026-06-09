/**
 * GET  /v1/episodes
 * POST /v1/episodes
 *
 * MaluDB concept: first-class events (maludb_core 0.82.0), folded onto subjects (0.94.0+).
 * SQL objects: maludb_episode (writable view), maludb_register_episode (facade),
 *              maludb_episode_with_attributes (?with=attributes).
 * Teaches:
 *   - Episodes are rows in the writable maludb_episode view (newest occurrence first).
 *   - Create goes through the search-path-safe facade maludb_register_episode(...) (named args).
 *   - 0.94.0+: an episode is backed by a SUBJECT (an event = a subject carrying a time); the view
 *     exposes that linkage as subject_id + the subject's dated canonical_name ("<title> (YYYY-MM-DD)").
 *   - sensitivity ∈ {public,internal,restricted,prohibited} and provenance ∈
 *     {provided,suggested,accepted,rejected} are DB-enforced → 422; episode_kind is free text.
 * Everything runs inside dbTxCore() so the facade resolves its malu$* base tables + RLS grants.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { attachAttributes } from '../../db/attributes.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr, bodyObject } from '../../http/request.js';
import type { Row } from '../../types/db.js';

const FILE = 'episodes.ts';

/**
 * SELECT list for an episode row. `subject_id` + `canonical_name` (0.94.0+) surface the backing
 * subject the event was folded onto; `canonical_name` is the server-minted dated name.
 */
const EPISODE_COLS = `episode_id AS id, episode_kind AS kind, title, summary,
                      payload_jsonb AS payload, occurred_at, occurred_until, recorded_at,
                      sensitivity, lifecycle_state, provenance, created_at,
                      subject_id, canonical_name`;

/** Normalize scalar types on an episode row in place (jsonb is already parsed by node-pg). */
function shapeEpisode(e: Row): void {
  e.id = Number(e.id);
  e.subject_id = e.subject_id !== undefined && e.subject_id !== null ? Number(e.subject_id) : null;
  if (e.payload === undefined) e.payload = null;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/episodes',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      switch (request.method) {
        case 'GET': {
          const q = queryStr(request, 'q', null, 200);
          const kind = queryStr(request, 'kind', null, 120);
          const provenance = queryStr(request, 'provenance', null, 40);
          const limit = queryInt(request, 'limit', 50, 200) ?? 50;

          const clauses: string[] = [];
          const params: unknown[] = [];
          if (kind !== null && kind !== '') { params.push(kind); clauses.push(`episode_kind = $${params.length}`); }
          if (provenance !== null && provenance !== '') { params.push(provenance); clauses.push(`provenance = $${params.length}`); }
          if (q !== null && q !== '') {
            params.push(`%${q}%`);
            const a = params.length;
            params.push(`%${q}%`);
            const b = params.length;
            clauses.push(`(title ILIKE $${a} OR summary ILIKE $${b})`);
          }
          const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

          const rows = await dbTxCore(ctx, () =>
            dbMany(
              ctx,
              `SELECT ${EPISODE_COLS}
                 FROM maludb_episode
                 ${where}
                ORDER BY occurred_at DESC NULLS LAST, episode_id DESC
                LIMIT ${limit}`,
              params,
            ),
          );
          for (const r of rows) shapeEpisode(r);

          if (queryStr(request, 'with', null, 40) === 'attributes') {
            await attachAttributes(ctx, rows, 'maludb_episode_with_attributes', 'episode_id');
          }

          jsonResponse(reply, { episodes: rows }, 200, ctx);
          return;
        }

        case 'POST': {
          const body = bodyObject(request);

          const title = String(body.title ?? '').trim();
          if (title === '') {
            jsonError('missing_field', 'Field "title" is required.', 400);
          }
          const kind =
            body.kind !== undefined && String(body.kind).trim() !== '' ? String(body.kind) : 'activity';
          const summary = body.summary !== undefined ? String(body.summary) : null;
          const occurredAt = body.occurred_at !== undefined ? String(body.occurred_at) : null;
          const occurredUntil = body.occurred_until !== undefined ? String(body.occurred_until) : null;
          const sensitivity =
            body.sensitivity !== undefined && String(body.sensitivity).trim() !== ''
              ? String(body.sensitivity)
              : 'internal';
          const provenance =
            body.provenance !== undefined && String(body.provenance).trim() !== ''
              ? String(body.provenance)
              : 'provided';
          const payloadJson =
            body.payload !== undefined && body.payload !== null && typeof body.payload === 'object'
              ? JSON.stringify(body.payload)
              : '{}';

          const episode = await dbTxCore(ctx, async () => {
            const row = await dbOne(
              ctx,
              `SELECT maludb_register_episode(
                          p_episode_kind   => $1,
                          p_title          => $2,
                          p_summary        => $3,
                          p_payload_jsonb  => $4::jsonb,
                          p_occurred_at    => $5::timestamptz,
                          p_occurred_until => $6::timestamptz,
                          p_sensitivity    => $7,
                          p_provenance     => $8
                      ) AS id`,
              [kind, title, summary, payloadJson, occurredAt, occurredUntil, sensitivity, provenance],
            );
            return dbOne(
              ctx,
              `SELECT ${EPISODE_COLS} FROM maludb_episode WHERE episode_id = $1`,
              [Number(row?.id)],
            );
          });

          if (episode === null) jsonError('internal_error', 'Episode vanished after creation.', 500);
          shapeEpisode(episode);
          jsonResponse(reply, { episode }, 201, ctx);
          return;
        }
      }
    },
  });
}
