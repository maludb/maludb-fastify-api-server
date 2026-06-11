/**
 * /v1/llm/providers — the caller's per-provider LLM API keys.
 *
 *   GET    /v1/llm/providers            — list the caller's providers (key value never returned)
 *   PUT    /v1/llm/providers/:provider  — store/update the caller's provider API key
 *   DELETE /v1/llm/providers/:provider  — remove the caller's provider API key
 *
 * Keys live in the local SQLite store keyed by user_id (not token): every token a user holds
 * shares the same keys. The api_key value is never selected back into any response — listings
 * carry only a key_set flag. Omitting api_key on an update preserves the stored key (the same
 * COALESCE convention as /v1/model-prompts).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { bodyObject, pathStr } from '../../http/request.js';
import {
  catalogProviders,
  deleteUserProviderKey,
  listUserProviderKeys,
  upsertUserProviderKey,
  userProviderKey,
} from '../../local-db/local-db.js';

const FILE = 'llm_providers.ts';

export async function register(app: FastifyInstance): Promise<void> {
  // GET /v1/llm/providers — caller's stored keys (key_set only, never the key).
  app.route({
    method: ['GET'],
    url: '/v1/llm/providers',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      jsonResponse(reply, { providers: listUserProviderKeys(Number(ctx.userId)) }, 200, ctx);
    },
  });

  // PUT /v1/llm/providers/:provider — store/update a key.
  app.route({
    method: ['PUT'],
    url: '/v1/llm/providers/:provider',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const userId = Number(ctx.userId);
      const body = bodyObject(request);
      const provider = pathStr(request, 'provider').trim().toLowerCase();

      const known = catalogProviders();
      if (!known.includes(provider)) {
        jsonError(
          'validation_failed',
          `Unknown provider "${provider}". Known providers: ${known.join(', ')}.`,
          422,
        );
      }

      const apiKey =
        body.api_key !== undefined && body.api_key !== null && body.api_key !== ''
          ? String(body.api_key)
          : null;
      const baseUrl =
        typeof body.base_url === 'string' ? String(body.base_url).trim() || null : null;

      const existing = userProviderKey(userId, provider);
      if (apiKey === null && existing === null) {
        jsonError('missing_field', '"api_key" is required when storing a new provider key.', 400);
      }

      // A null api_key on update preserves the stored key (COALESCE in the upsert).
      upsertUserProviderKey(userId, provider, apiKey, baseUrl);

      const row = listUserProviderKeys(userId).find((r) => r.provider === provider)!;
      jsonResponse(
        reply,
        { provider: { provider, key_set: row.key_set, base_url: row.base_url } },
        200,
        ctx,
      );
    },
  });

  // DELETE /v1/llm/providers/:provider
  app.route({
    method: ['DELETE'],
    url: '/v1/llm/providers/:provider',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const provider = pathStr(request, 'provider').trim().toLowerCase();
      if (!deleteUserProviderKey(Number(ctx.userId), provider)) {
        jsonError('not_found', `No stored key for provider "${provider}".`, 404);
      }
      jsonResponse(reply, { deleted: true, provider }, 200, ctx);
    },
  });
}
