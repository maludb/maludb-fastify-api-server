/**
 * GET /v1/llm/catalog — the seeded model catalog (models × tasks), annotated with the caller's
 * key/choice state.
 *
 * MaluDB concept: the `default_prompts` table is seeded at startup (src/local-db/llm-catalog.ts)
 * so a fresh install offers working model configurations out of the box; users attach their own
 * provider keys (/v1/llm/providers) and pick a model per task (/v1/llm/models).
 *
 * Response: {"tasks": [...], "models": [{provider, model_name, model_identifier, api_format,
 * base_url, task, max_tokens, has_system_prompt, key_set, is_choice}]}. The prompt text is NOT
 * returned (it is large) — only the has_system_prompt flag.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { jsonResponse } from '../../http/response.js';
import {
  catalogTasks,
  listDefaultPrompts,
  listUserModelChoices,
  listUserProviderKeys,
} from '../../local-db/local-db.js';

const FILE = 'llm_catalog.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET'],
    url: '/v1/llm/catalog',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const userId = Number(ctx.userId);

      const keys = new Set(
        listUserProviderKeys(userId)
          .filter((k) => k.key_set)
          .map((k) => k.provider),
      );
      const choices = new Map(listUserModelChoices(userId).map((c) => [c.task, c.model_name]));

      const models = listDefaultPrompts().map((r) => ({
        provider: r.provider,
        model_name: r.model_name,
        model_identifier: r.model_identifier,
        api_format: r.api_format,
        base_url: r.base_url,
        task: r.task,
        max_tokens: Number(r.max_tokens),
        has_system_prompt: r.has_system_prompt,
        key_set: keys.has(r.provider),
        is_choice: choices.get(r.task) === r.model_name,
      }));

      jsonResponse(reply, { tasks: catalogTasks(), models }, 200, ctx);
    },
  });
}
