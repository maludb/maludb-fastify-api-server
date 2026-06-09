/**
 * POST /v1/objects/:kind  (maludb_core 0.85.0+ — atomic object + attributes create)
 *
 *   POST  Create an object AND apply its typed attributes in ONE transaction:
 *         register the object, then maludb_attributes_apply(kind, id, attributes), then
 *         return maludb_object_get(kind, id). Either both land or neither does.
 *
 * Supported kinds (those with a register_* helper): 'subject', 'episode_object'.
 * Body = the object's fields + an optional "attributes" array, each element
 *   {attr_name, value_timestamp?|value_range?|value_numeric?|value_text?|value_jsonb?,
 *    unit?, provenance?, confidence?, ref_source?, ref_entity?, ref_key?}.
 *
 *   subject:        {canonical_name|name|label (req), subject_type?(='other'),
 *                    description?, classifier_md?, attributes?[]}
 *   episode_object: {title (req), kind?(='activity'), summary?, payload?, occurred_at?,
 *                    occurred_until?, sensitivity?(='internal'), provenance?, attributes?[]}
 *
 * Routed at /v1/objects/:kind. Runs in db_tx_core() (register_* + attributes_apply +
 * object_get all need maludb_core).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathStr, bodyObject } from '../../http/request.js';

const FILE = 'objects.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST'],
    url: '/v1/objects/:kind',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const kind = pathStr(request, 'kind');

      // POST
      const body = bodyObject(request);

      // Validate the optional attributes array up front (no partial writes).
      let attributes: unknown[] = [];
      if (Object.prototype.hasOwnProperty.call(body, 'attributes') && body.attributes !== null) {
        if (!Array.isArray(body.attributes)) {
          jsonError('validation_failed', '"attributes" must be an array of attribute objects.', 422);
        }
        attributes = body.attributes;
      }

      const object = await dbTxCore(ctx, async () => {
        // ---- 1. create the object via its register_* helper ----
        let targetId: number;
        if (kind === 'subject') {
          const name = String(body.canonical_name ?? body.name ?? body.label ?? '').trim();
          if (name === '') jsonError('missing_field', 'Field "canonical_name" is required for a subject.', 400);
          const type =
            body.subject_type !== undefined && String(body.subject_type).trim() !== ''
              ? String(body.subject_type)
              : body.type !== undefined && String(body.type).trim() !== ''
                ? String(body.type)
                : 'other';
          const description = body.description !== undefined ? String(body.description) : null;
          const classifier = body.classifier_md !== undefined ? String(body.classifier_md) : null;
          const row = await dbOne(
            ctx,
            `SELECT register_svpor_subject(
                        p_canonical_name => $1, p_description => $2, p_subject_type => $3, p_classifier_md => $4
                    ) AS id`,
            [name, description, type, classifier],
          );
          targetId = Number(row!.id);
        } else if (kind === 'episode_object') {
          const title = String(body.title ?? '').trim();
          if (title === '') jsonError('missing_field', 'Field "title" is required for an episode.', 400);
          const ekind =
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
            body.payload !== undefined &&
            typeof body.payload === 'object' &&
            body.payload !== null
              ? JSON.stringify(body.payload)
              : '{}';
          const row = await dbOne(
            ctx,
            `SELECT maludb_register_episode(
                        p_episode_kind => $1, p_title => $2, p_summary => $3, p_payload_jsonb => $4::jsonb,
                        p_occurred_at => $5::timestamptz, p_occurred_until => $6::timestamptz,
                        p_sensitivity => $7, p_provenance => $8
                    ) AS id`,
            [ekind, title, summary, payloadJson, occurredAt, occurredUntil, sensitivity, provenance],
          );
          targetId = Number(row!.id);
        } else {
          jsonError(
            'validation_failed',
            'Unsupported object kind "' + kind + '" for atomic create (supported: subject, episode_object).',
            422,
          );
        }

        // ---- 2. apply the typed attributes atomically ----
        if (attributes.length) {
          await dbOne(ctx, 'SELECT maludb_attributes_apply($1, $2, $3::jsonb) AS n', [
            kind,
            targetId,
            JSON.stringify(attributes),
          ]);
        }

        // ---- 3. return the assembled handle (object + attributes [+ statements/details]) ----
        const got = await dbOne(ctx, 'SELECT maludb_object_get($1, $2) AS obj', [kind, targetId]);
        // maludb_object_get returns jsonb — node-pg already parses it (no JSON.parse).
        return got && got.obj !== null ? got.obj : null;
      });

      jsonResponse(reply, { object }, 201, ctx);
    },
  });
}
