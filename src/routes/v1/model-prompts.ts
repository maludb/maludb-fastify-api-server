/**
 * GET  /v1/model-prompts   — list configured model prompts (api_key never returned)
 * POST /v1/model-prompts   — upsert a model's extraction prompt + LLM connection
 *
 * MaluDB concept: per-model extraction prompts + LLM creds live in the local config store, NOT in
 * Postgres (the API is the model worker for /v1/memory/ingest).
 * SQL objects: none in Postgres — operates on the local SQLite `model_prompts` table.
 * Teaches:
 *   - Authorization is the Postgres login (same as /v1/tokens); proven by connecting.
 *   - The api_key is write-only: returned only as `api_key_set`. Omitting it on update keeps the key.
 *   - Does NOT call requireAuth.
 */
import type { FastifyInstance } from 'fastify';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { bodyObject } from '../../http/request.js';
import { testCredentials } from '../../db/tenant.js';
import { localDb, modelPrompt } from '../../local-db/local-db.js';

/** Verify the Postgres login supplied in the body (authorization for managing prompts). */
async function modelPromptsAuthorize(body: Record<string, unknown>): Promise<void> {
  const db = String(body.pg_dbname ?? '').trim();
  const user = String(body.pg_user ?? '').trim();
  const pass = 'pg_password' in body ? String(body.pg_password ?? '') : '';
  if (db === '' || user === '' || pass === '') {
    jsonError('missing_field', 'pg_dbname, pg_user and pg_password are required.', 400);
  }
  if (!(await testCredentials({ dbname: db, user, password: pass }))) {
    jsonError('pg_auth_failed', 'Could not connect to Postgres with the supplied credentials.', 403);
  }
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/model-prompts',
    handler: async (request, reply) => {
      const body = bodyObject(request);
      await modelPromptsAuthorize(body);

      if (request.method === 'POST') {
        const modelName = body.model_name !== undefined ? String(body.model_name).trim() : '';
        const apiFormat = body.api_format !== undefined ? String(body.api_format).toLowerCase().trim() : '';
        const system = body.system_prompt !== undefined ? String(body.system_prompt) : '';
        const baseUrl = body.base_url !== undefined ? String(body.base_url).trim() : '';
        const apiKey =
          'api_key' in body && body.api_key !== null && body.api_key !== '' ? String(body.api_key) : null;
        const maxTokens =
          Number.isInteger(body.max_tokens) && (body.max_tokens as number) > 0 ? (body.max_tokens as number) : 2048;

        if (modelName === '') jsonError('missing_field', '"model_name" is required.', 400);
        if (system === '') jsonError('missing_field', '"system_prompt" is required.', 400);
        if (baseUrl === '') jsonError('missing_field', '"base_url" is required.', 400);
        if (apiFormat !== 'openai' && apiFormat !== 'anthropic') {
          jsonError('validation_failed', '"api_format" must be "openai" or "anthropic".', 422);
        }

        // Upsert keyed on model_name; omitting api_key keeps the stored one. model_identifier /
        // generation_params are left untouched (this endpoint does not manage them).
        localDb()
          .prepare(
            `INSERT INTO model_prompts (model_name, api_format, system_prompt, base_url, api_key, max_tokens)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(model_name) DO UPDATE SET
               api_format    = excluded.api_format,
               system_prompt = excluded.system_prompt,
               base_url      = excluded.base_url,
               max_tokens    = excluded.max_tokens,
               api_key       = COALESCE(excluded.api_key, model_prompts.api_key),
               updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          )
          .run(modelName, apiFormat, system, baseUrl, apiKey, maxTokens);

        const pr = modelPrompt(modelName);
        jsonResponse(reply, {
          model_prompt: {
            model_name: pr?.model_name,
            api_format: pr?.api_format,
            base_url: pr?.base_url,
            max_tokens: Number(pr?.max_tokens),
            api_key_set: pr?.api_key !== null && pr?.api_key !== '' && pr?.api_key !== undefined,
            system_prompt: pr?.system_prompt,
          },
        });
        return;
      }

      // GET
      const rows = localDb()
        .prepare(
          `SELECT model_name, api_format, base_url, max_tokens,
                  (api_key IS NOT NULL AND api_key <> '') AS api_key_set, updated_at, system_prompt
             FROM model_prompts ORDER BY model_name`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        r.max_tokens = Number(r.max_tokens);
        r.api_key_set = Boolean(r.api_key_set);
      }
      jsonResponse(reply, { model_prompts: rows });
    },
  });
}
