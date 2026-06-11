/**
 * POST /v1/memory/ingest
 *   (text → LLM extraction → memory ingest; per-model prompt, OpenAI + Anthropic)
 *
 *   POST  Body: { text (required), model? (optional — explicit model name; resolution order is
 *                 legacy model_prompts → seeded catalog + the caller's provider key → the user's
 *                 'extract' choice → the legacy 'chatgpt-4o' model_prompts row), hints? (array of
 *                 {"subject-type","subject-name"}), namespace?, preview? }
 *
 *   Contract (per the GPT-4o memory-extraction prompt): the model is given the stored SYSTEM
 *   prompt + a USER message built from the TEXT, the HINTS, and the schema's current
 *   KNOWN_SUBJECTS / KNOWN_VERBS (read from maludb_subject / maludb_verb so the model reuses
 *   canonical names). The model returns ONE JSON object {subjects, verbs, episodes, edges,
 *   relationships}; the API uploads the text as a document and passes the JSON verbatim to
 *   maludb_memory_ingest_extraction(<json>::jsonb, 'document', <document_id>).
 *
 *   preview=true returns the assembled SYSTEM + USER messages without calling the model or
 *   writing — verify the prompt / test without live model credentials.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { bodyObject } from '../../http/request.js';
import { llmComplete, llmJsonFromText } from '../../memory/llm.js';
import { resolveTaskConfig, type ResolvedTaskConfig } from '../../memory/resolve.js';
import { renderTypeCatalog } from '../../memory/type-catalog.js';
import { modelPrompt } from '../../local-db/local-db.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'memory_ingest.ts';

/** PHP `empty()` semantics: false for missing/null/false/0/""/"0"/[]. */
function phpEmpty(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === false ||
    v === 0 ||
    v === '' ||
    v === '0' ||
    (Array.isArray(v) && v.length === 0)
  );
}

export interface IngestCoreOptions {
  text: string;
  hintsJson: string;
  namespace: string;
  explicitModel: string | null;
  preview: boolean;
}

/**
 * The ingest pipeline (resolve model → assemble prompt → LLM → graph ingest), shared by the REST
 * route and the MCP store_memory tool. Returns the response payload (the preview payload when
 * `preview` is true); throws ApiError on failure.
 */
export async function ingestCore(
  ctx: RequestCtx,
  { text, hintsJson, namespace, explicitModel, preview }: IngestCoreOptions,
): Promise<Record<string, unknown>> {
  // --- per-model prompt + LLM connection. Resolution order: explicit model (legacy
  //     model_prompts first, then the seeded catalog + the caller's provider key) → the
  //     user's 'extract' choice → the legacy default ('chatgpt-4o' model_prompts row). ---
  let pr: ResolvedTaskConfig | null = resolveTaskConfig(
    Number(ctx.userId),
    'extract',
    explicitModel,
  );
  const model = pr !== null ? pr.model_name : (explicitModel ?? 'chatgpt-4o');
  if (pr === null) {
    const legacy = modelPrompt(model);
    if (legacy !== null) pr = { ...legacy, provider: null, source: 'model_prompts' };
  }
  if (pr === null) {
    jsonError(
      'model_not_configured',
      'No prompt configured for model "' + model + '". Set one via POST /v1/model-prompts.',
      422,
    );
  }

  // --- KNOWN_SUBJECTS / KNOWN_VERBS from Postgres (so the model reuses canonical names) ---
  const subjRows = await dbMany(
    ctx,
    'SELECT canonical_name AS name, subject_type AS type FROM maludb_subject ORDER BY canonical_name',
  );
  const verbRows = await dbMany(
    ctx,
    'SELECT canonical_name FROM maludb_verb ORDER BY canonical_name',
  );
  const knownSubjectsJson = JSON.stringify(
    subjRows.map((r) => ({ name: r.name, type: r.type })),
  );
  const knownVerbsJson = JSON.stringify(verbRows.map((r) => r.canonical_name));

  // --- SUBJECT TYPE CATALOG (0.96.0): render the entity/event vocabularies straight from the
  //     tenant catalog so the prompt's allowed types can never drift from what the ingest
  //     accepts (shared with /v1/skills/ingest — see src/memory/type-catalog.ts). ---
  const catalog = await renderTypeCatalog(ctx);

  // --- build the messages ---
  // Substitute the rendered catalog into the stored SYSTEM prompt. A legacy prompt with no
  // {{ENTITY_TYPES}}/{{EVENT_KINDS}} placeholders is left unchanged (backward-compatible).
  const system = String(pr.system_prompt ?? '')
    .replace(/\{\{ENTITY_TYPES\}\}/g, catalog.entityBlock)
    .replace(/\{\{EVENT_KINDS\}\}/g, catalog.eventBlock);
  const user = `TEXT:\n${text}\n\nHINTS:\n${hintsJson}\n\nKNOWN_SUBJECTS:\n${knownSubjectsJson}\n\nKNOWN_VERBS:\n${knownVerbsJson}\n`;

  if (preview) {
    return {
      model,
      api_format: pr.api_format,
      system_prompt: system,
      user_message: user,
      counts: {
        known_subjects: subjRows.length,
        known_verbs: verbRows.length,
        entity_types: catalog.entityCount,
        event_kinds: catalog.eventCount,
      },
    };
  }

  if (pr.api_key === null || pr.api_key === '') {
    const msg =
      pr.source === 'catalog_explicit' || pr.source === 'user_choice'
        ? `No API key stored for provider "${pr.provider}".` +
          ` Set one via PUT /v1/llm/providers/${pr.provider}.`
        : 'No API key set for model "' + model + '". Set it via POST /v1/model-prompts.';
    jsonError('model_api_key_missing', msg, 409);
  }

  // The 0.92.0 ingest facade must be present (the model JSON is passed to it verbatim).
  const hasFacade = await dbOne(
    ctx,
    "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'maludb_memory_ingest_extraction') AS ok",
  );
  if (hasFacade === null || !hasFacade.ok) {
    jsonError(
      'ingest_unavailable',
      'maludb_memory_ingest_extraction is not available in this database (requires maludb_core 0.92.0).',
      501,
    );
  }

  // --- call the LLM (OpenAI or Anthropic shape) and parse the extraction JSON ---
  const cfg = {
    api_format: pr.api_format,
    base_url: pr.base_url,
    model_identifier:
      pr.model_identifier !== null && pr.model_identifier !== ''
        ? pr.model_identifier
        : model,
    token: pr.api_key,
    max_tokens: Number(pr.max_tokens),
    generation_params:
      pr.generation_params !== null && pr.generation_params !== ''
        ? (JSON.parse(pr.generation_params) as Record<string, unknown>)
        : {},
  };
  const content = await llmComplete(cfg, system, user);
  const extraction = llmJsonFromText(content);
  if (extraction === null) {
    jsonError('upstream_error', 'LLM output was not a JSON object.', 502);
  }

  // --- upload the text + ingest the extraction (one transaction) ---
  const result = await dbTxCore(ctx, async () => {
    const doc = await dbOne(
      ctx,
      "SELECT maludb_upload_document(p_title => $1, p_content_text => $2, p_source_type => 'document') AS id",
      [text.trim().substring(0, 80), text],
    );
    const documentId = Number(doc!.id);
    // LLM-derived → stage as 'suggested' (review queue), consistent with the rest of the
    // pipeline (the facade itself defaults to 'accepted'). The model JSON is passed verbatim.
    const row = await dbOne(
      ctx,
      `SELECT maludb_memory_ingest_extraction(
                  p_extraction => $1::jsonb, p_source_kind => 'document',
                  p_source_id => $2, p_provenance => 'suggested') AS result`,
      [JSON.stringify(extraction), documentId],
    );
    // jsonb is already parsed by node-pg — no JSON.parse.
    return { document_id: documentId, result: row!.result !== null ? row!.result : null };
  });

  return {
    document_id: result.document_id,
    model,
    api_format: pr.api_format,
    namespace,
    result: result.result,
  };
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST'],
    url: '/v1/memory/ingest',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const body = bodyObject(request);

      const text = body.text !== undefined ? String(body.text) : '';
      if (text.trim() === '') jsonError('missing_field', 'Field "text" is required.', 400);

      const explicitModel =
        body.model !== undefined && String(body.model).trim() !== ''
          ? String(body.model).trim()
          : null;
      const namespace =
        body.namespace !== undefined && String(body.namespace).trim() !== ''
          ? String(body.namespace)
          : 'default';
      const preview = !phpEmpty(body.preview);

      // HINTS: a list of {"subject-type","subject-name"}. Accept an array (preferred); tolerate a
      // pre-encoded JSON string; default to [].
      let hintsJson: string;
      if (Array.isArray(body.hints)) {
        hintsJson = JSON.stringify(body.hints);
      } else if (typeof body.hints === 'string' && body.hints.trim() !== '') {
        let decoded: unknown = null;
        try {
          decoded = JSON.parse(body.hints);
        } catch {
          decoded = null;
        }
        hintsJson = Array.isArray(decoded)
          ? JSON.stringify(decoded)
          : JSON.stringify([{ 'subject-type': 'note', 'subject-name': String(body.hints) }]);
      } else {
        hintsJson = '[]';
      }

      const payload = await ingestCore(ctx, {
        text,
        hintsJson,
        namespace,
        explicitModel,
        preview,
      });
      jsonResponse(reply, payload, preview ? 200 : 201, ctx);
    },
  });
}
