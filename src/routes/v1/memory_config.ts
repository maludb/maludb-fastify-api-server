/**
 * GET/PUT/POST /v1/memory/config
 *   (maludb_core memory — model/embedding/prompt config; endpoint group 1)
 *
 *   GET  ?namespace=default
 *        → maludb_memory_model_config(namespace) : jsonb {extraction_alias, model_identifier,
 *          provider_kind, base_url, secret_ref, embedding_model, prompt_template,
 *          generation_params, default_subject_type, default_provenance}. secret_ref is the
 *          NAME, never the token value.
 *
 *   PUT/POST  Configure the tenant+namespace: store the token encrypted (secret_set), register
 *        the provider + alias (base_url rides in the alias runtime_params), then bind the alias
 *        + prompt + embedding model + defaults (maludb_memory_set_model_config). Returns the
 *        read-back config. The whole sequence runs in one dbTxCore() transaction. (PUT and POST
 *        do the same configure.)
 *
 * Uses the per-tenant self-service facades (maludb_core 0.91.0): the schema-local
 * maludb_register_model_provider / maludb_register_model_alias (SECURITY DEFINER, granted to
 * maludb_memory_executor) register into the current schema — no global model-admin grant needed.
 * The token is never inlined into provider/alias rows or logs; it is stored via secret_set
 * (redacted from the SQL trace) and referenced by name. Body shape:
 *   { namespace, secret_name, token?, provider:{name,kind,adapter_name?,data_sensitivity?},
 *     alias:{name,model_identifier,context_length?,base_url}, prompt_template?, embedding_model,
 *     generation_params?, default_subject_type?, default_provenance? }
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { dbOneRedacted } from '../../db/redacted.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { bodyObject, queryStr } from '../../http/request.js';

const FILE = 'memory_config.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PUT', 'POST'],
    url: '/v1/memory/config',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      if (request.method === 'GET') {
        const namespace = queryStr(request, 'namespace', 'default', 120) ?? 'default';
        const row = await dbTxCore(ctx, () =>
          dbOne(ctx, 'SELECT maludb_memory_model_config($1) AS cfg', [namespace]),
        );
        // jsonb is already parsed by node-pg — no JSON.parse.
        const cfg = row !== null && row.cfg !== null ? row.cfg : null;
        jsonResponse(reply, { namespace, config: cfg }, 200, ctx);
        return;
      }

      // PUT / POST — both do the same configure.
      const body = bodyObject(request);

      const namespace =
        body.namespace !== undefined && String(body.namespace).trim() !== ''
          ? String(body.namespace)
          : 'default';
      const secretName =
        body.secret_name !== undefined && String(body.secret_name).trim() !== ''
          ? String(body.secret_name)
          : null;
      const token =
        Object.prototype.hasOwnProperty.call(body, 'token') && body.token !== null
          ? String(body.token)
          : null;

      const provider = isObject(body.provider) ? body.provider : {};
      const alias = isObject(body.alias) ? body.alias : {};

      const provName = provider.name !== undefined ? String(provider.name).trim() : '';
      const provKind = provider.kind !== undefined ? String(provider.kind).trim() : '';
      const provAdapter =
        provider.adapter_name !== undefined ? String(provider.adapter_name) : null;
      const provSens =
        provider.data_sensitivity !== undefined &&
        String(provider.data_sensitivity).trim() !== ''
          ? String(provider.data_sensitivity)
          : 'internal';

      const aliasName = alias.name !== undefined ? String(alias.name).trim() : '';
      const aliasModel =
        alias.model_identifier !== undefined ? String(alias.model_identifier).trim() : '';
      const aliasCtx =
        alias.context_length !== undefined && alias.context_length !== null
          ? Number(alias.context_length)
          : null;
      const baseUrl = alias.base_url !== undefined ? String(alias.base_url).trim() : '';

      const embeddingModel =
        body.embedding_model !== undefined ? String(body.embedding_model).trim() : '';
      const promptTemplate =
        Object.prototype.hasOwnProperty.call(body, 'prompt_template') &&
        body.prompt_template !== null
          ? String(body.prompt_template)
          : null;
      // PHP is_array() is true for a JSON array or object (both decode to a PHP array).
      const genParams =
        isObject(body.generation_params) || Array.isArray(body.generation_params)
          ? JSON.stringify(body.generation_params)
          : '{}';
      const defaultSubject =
        body.default_subject_type !== undefined &&
        String(body.default_subject_type).trim() !== ''
          ? String(body.default_subject_type)
          : 'other';
      const defaultProv =
        body.default_provenance !== undefined && String(body.default_provenance).trim() !== ''
          ? String(body.default_provenance)
          : 'suggested';

      // ---- shape validation (no DB writes yet) ----
      if (provName === '' || provKind === '') {
        jsonError('missing_field', 'provider.name and provider.kind are required.', 400);
      }
      if (aliasName === '' || aliasModel === '') {
        jsonError('missing_field', 'alias.name and alias.model_identifier are required.', 400);
      }
      if (baseUrl === '') jsonError('missing_field', 'alias.base_url is required.', 400);
      if (embeddingModel === '') {
        jsonError('missing_field', '"embedding_model" is required.', 400);
      }
      if (promptTemplate !== null && !promptTemplate.includes('{{chunk}}')) {
        jsonError(
          'validation_failed',
          'prompt_template must contain the {{chunk}} placeholder.',
          422,
        );
      }
      if (token !== null && secretName === null) {
        jsonError('missing_field', '"secret_name" is required when a token is provided.', 400);
      }

      const cfg = await dbTxCore(ctx, async () => {
        // 1. store the token encrypted (redacted from the SQL trace).
        if (token !== null) {
          await dbOneRedacted(
            ctx,
            "SELECT secret_id FROM maludb_core.secret_set(p_name => $1, p_kind => 'provider', p_value => $2)",
            [secretName, token],
            [2], // redact the token (2nd param)
          );
        }
        // 2. register the provider (per-tenant self-service facade; secret by name, never inlined).
        await dbOne(
          ctx,
          `SELECT maludb_register_model_provider(
                      p_name => $1, p_kind => $2, p_adapter_name => $3,
                      p_secret_ref => $4, p_data_sensitivity => $5) AS id`,
          [provName, provKind, provAdapter, secretName, provSens],
        );
        // 3. register the alias (per-tenant facade; base_url rides in runtime_params).
        await dbOne(
          ctx,
          `SELECT maludb_register_model_alias(
                      p_alias => $1, p_provider => $2, p_model_identifier => $3,
                      p_context_length => $4, p_runtime_params => jsonb_build_object('base_url', $5::text)) AS id`,
          [aliasName, provName, aliasModel, aliasCtx, baseUrl],
        );
        // 4. bind alias + prompt + embedding + defaults for this tenant/namespace.
        await dbOne(
          ctx,
          `SELECT maludb_memory_set_model_config(
                      p_extraction_alias     => $1,
                      p_prompt_template      => $2,
                      p_embedding_model      => $3,
                      p_namespace            => $4,
                      p_generation_params    => $5::jsonb,
                      p_default_subject_type => $6,
                      p_default_provenance   => $7) AS cfg`,
          [aliasName, promptTemplate, embeddingModel, namespace, genParams, defaultSubject, defaultProv],
        );
        // 5. read it back.
        const row = await dbOne(ctx, 'SELECT maludb_memory_model_config($1) AS cfg', [namespace]);
        // jsonb is already parsed by node-pg — no JSON.parse.
        return row !== null && row.cfg !== null ? row.cfg : null;
      });

      jsonResponse(reply, { namespace, config: cfg }, 200, ctx);
    },
  });
}

/** True for a plain JSON object (mirrors PHP `is_array($x ?? null)` for object-shaped fields). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
