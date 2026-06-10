/**
 * POST /v1/memory/documents  (maludb_core memory — process a document; endpoint group 2)
 *
 *   POST  Upload a document/transcript, extract SVPO edges, embed them, and ingest them into
 *         the graph-bound vector store. The API is the model worker: it chunks the text, calls
 *         the LLM (extraction) and the embedding model, then writes back via the facades.
 *
 *   Body: { title (req), text (req), source_type='document', media_type?, document_type?,
 *           projects?[], subjects?[], verbs?[], events?[], metadata?{}, namespace='default',
 *           embedding_model?, chunk?:{max,overlap},
 *           edges?[] }    // optional pre-extracted candidate_edges → bypass the LLM call
 *
 *   Pipeline: read config → chunk (in code) → extract (LLM, or use body.edges) → embed each
 *   edge → ONE dbTxCore(): maludb_upload_document(...) then maludb_memory_ingest_edge(...) per
 *   edge (atomic per document; HTTP done before the tx opens). Extraction edges default to
 *   provenance='suggested' (review queue).
 *
 *   No live model creds? memEmbed() falls back to a deterministic embedding and you can supply
 *   "edges" directly — so the upload→ingest→search pipeline round-trips without a model.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { bodyObject } from '../../http/request.js';
import { memChunk, memEmbed, memExtract, type LlmConfig } from '../../memory/llm.js';
import { resolveEmbedConfig, resolveTaskConfig, type ResolvedTaskConfig } from '../../memory/resolve.js';
import { memVectorLiteral, memResolveToken } from '../../memory/memory-db.js';
import { modelPrompt } from '../../local-db/local-db.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'memory_documents.ts';

/** Build a Postgres text[] array literal from a list of strings, escaping `"` exactly as the PHP. */
function toPgArrayLiteral(items: string[]): string {
  return '{' + items.map((s) => '"' + s.replace(/"/g, '\\"') + '"').join(',') + '}';
}

/** Coerce a JSON value to a list of trimmed non-empty strings (mirrors PHP $to_text_array). */
function toTextArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    if (typeof s === 'string' && s.trim() !== '') out.push(s.trim());
  }
  return out;
}

export interface DocumentsCoreOptions {
  title: string;
  text: string;
  sourceType: string;
  mediaType: string | null;
  documentType: string | null;
  metadataJson: string;
  projects: string[];
  subjects: string[];
  verbs: string[];
  events: string[];
  chunkMax: number;
  chunkOverlap: number;
  embeddingModel: string | null;
  explicitModel: string | null;
  providedEdges: unknown[] | null;
  namespace: string;
}

/**
 * The documents pipeline (chunk → extract → embed → ingest), shared by the REST route and the MCP
 * store_document tool. Returns the response payload; throws ApiError on failure.
 */
export async function documentsCore(
  ctx: RequestCtx,
  {
    title,
    text,
    sourceType,
    mediaType,
    documentType,
    metadataJson,
    projects,
    subjects,
    verbs,
    events,
    chunkMax,
    chunkOverlap,
    embeddingModel: callerEmbeddingModel,
    explicitModel,
    providedEdges,
    namespace,
  }: DocumentsCoreOptions,
): Promise<Record<string, unknown>> {
  const docType = documentType;
  const metadata = metadataJson;

  // --- config (may be empty if no model is bound yet) ---
  const row = await dbTxCore(ctx, () =>
    dbOne(ctx, 'SELECT maludb_memory_model_config($1) AS cfg', [namespace]),
  );
  // jsonb is already parsed by node-pg — no JSON.parse.
  const cfg = row !== null && row.cfg !== null ? (row.cfg as Record<string, unknown>) : {};

  // Embedding model precedence: caller > namespace config > the user's 'embed' choice > env.
  const userEmbed = resolveEmbedConfig(Number(ctx.userId));
  const embeddingModel =
    callerEmbeddingModel ??
    (cfg.embedding_model as string | undefined) ??
    userEmbed.embedding_model ??
    (process.env.MALUDB_EMBED_MODEL || 'maludb-local-dev');
  const defaultSubject = (cfg.default_subject_type as string | undefined) ?? 'other';
  const defaultProv = (cfg.default_provenance as string | undefined) ?? 'suggested';

  // Extraction connection: Store A (namespace) first, else borrow from Store B
  // (model_prompts / the seeded catalog) so a tenant that only configured
  // /v1/memory/ingest can still extract here. The candidate_edges contract
  // (prompt_template) is never taken from Store B — its prompt targets a different
  // contract.
  let extractCfg: LlmConfig;
  const cfgBaseUrl = String((cfg.base_url as string | undefined) ?? '').trim();
  const cfgModelId = String((cfg.model_identifier as string | undefined) ?? '').trim();
  if (cfgBaseUrl !== '' && cfgModelId !== '') {
    extractCfg = {
      api_format: 'openai',
      base_url: cfgBaseUrl,
      model_identifier: cfgModelId,
      prompt_template: (cfg.prompt_template as string | undefined) ?? null,
      generation_params:
        (cfg.generation_params as Record<string, unknown> | undefined) ?? {},
      max_tokens: 2048,
      token: await memResolveToken(ctx, (cfg.secret_ref as string | undefined) ?? null),
    };
  } else {
    // Borrow a connection from Store B: explicit model → the user's 'extract' choice →
    // the legacy 'chatgpt-4o' model_prompts row. Only the connection crosses over.
    const fbModel = explicitModel;
    let pr: ResolvedTaskConfig | null = resolveTaskConfig(
      Number(ctx.userId),
      'extract',
      fbModel,
    );
    if (pr === null) {
      const legacy = modelPrompt(fbModel ?? 'chatgpt-4o');
      if (legacy !== null) pr = { ...legacy, provider: null, source: 'model_prompts' };
    }
    if (pr !== null && String(pr.base_url ?? '').trim() !== '') {
      extractCfg = {
        api_format: pr.api_format ?? 'openai',
        base_url: pr.base_url ?? '',
        model_identifier: pr.model_identifier || pr.model_name || '',
        prompt_template: (cfg.prompt_template as string | undefined) ?? null, // default candidate_edges template
        generation_params:
          pr.generation_params !== null && pr.generation_params !== ''
            ? (JSON.parse(pr.generation_params) as Record<string, unknown>)
            : {},
        max_tokens: Number(pr.max_tokens ?? 2048),
        token: pr.api_key,
      };
    } else {
      // Neither store configured — only caller-supplied "edges" can be ingested;
      // memExtract (if reached) raises model_not_configured.
      extractCfg = {
        api_format: 'openai',
        base_url: '',
        model_identifier: '',
        prompt_template: (cfg.prompt_template as string | undefined) ?? null,
        generation_params:
          (cfg.generation_params as Record<string, unknown> | undefined) ?? {},
        max_tokens: 2048,
        token: await memResolveToken(ctx, (cfg.secret_ref as string | undefined) ?? null),
      };
    }
  }

  const modelId = String(extractCfg.model_identifier ?? '');
  // Embedding config — the user's stored embed connection (if any), with the resolved
  // embedding_model name on top.
  const embedCfg: LlmConfig = { ...userEmbed, embedding_model: embeddingModel };

  // --- 1. obtain candidate edges: caller-supplied (bypass) OR LLM extraction per chunk ---
  const provided = providedEdges;
  const chunks = memChunk(text, chunkMax, chunkOverlap);

  const edges: Record<string, unknown>[] = [];
  let extractor = 'provided';
  if (provided !== null) {
    for (const e of provided) {
      if (isObject(e)) edges.push(e);
    }
  } else {
    extractor = 'llm';
    for (const chunk of chunks) {
      for (const e of await memExtract(chunk, extractCfg)) {
        if (isObject(e)) {
          if (
            e.source_span === undefined ||
            String(e.source_span ?? '').trim() === ''
          ) {
            e.source_span = chunk;
          }
          edges.push(e);
        }
      }
    }
  }
  if (edges.length === 0) {
    jsonError(
      'no_edges',
      'No SVPO edges to ingest (supply "edges" or configure an extraction model).',
      422,
    );
  }

  // --- 2. embed each edge (HTTP if configured, else deterministic) ---
  for (const e of edges) {
    const span =
      e.source_span !== undefined && String(e.source_span ?? '').trim() !== ''
        ? String(e.source_span)
        : (
            String(e.subject_text ?? '') +
            ' ' +
            String(e.verb_text ?? '')
          ).trim();
    e.__vector = memVectorLiteral(await memEmbed(span, embedCfg));
    e.source_span = span;
  }

  // --- 3. one transaction per document: upload, then ingest every edge ---
  const result = await dbTxCore(ctx, async () => {
    const doc = await dbOne(
      ctx,
      `SELECT maludb_upload_document(
                  p_title => $1, p_content_text => $2, p_source_type => $3,
                  p_media_type => $4, p_document_type => $5,
                  p_projects => $6::text[], p_subjects => $7::text[],
                  p_verbs => $8::text[], p_events => $9::text[],
                  p_metadata_jsonb => $10::jsonb) AS id`,
      [
        title,
        text,
        sourceType,
        mediaType,
        docType,
        toPgArrayLiteral(projects),
        toPgArrayLiteral(subjects),
        toPgArrayLiteral(verbs),
        toPgArrayLiteral(events),
        metadata,
      ],
    );
    const documentId = Number(doc!.id);

    const out: Record<string, unknown>[] = [];
    for (const e of edges) {
      const subjectText = String(e.subject_text ?? '').trim();
      const verbText = String(e.verb_text ?? '').trim();
      if (subjectText === '' || verbText === '') {
        jsonError('validation_failed', 'Each edge needs subject_text and verb_text.', 422);
      }
      // PHP is_array() is true for a JSON array or object (both decode to a PHP array).
      const predicate =
        Array.isArray(e.predicate) || isObject(e.predicate)
          ? JSON.stringify(e.predicate)
          : '[]';
      const subjectTy =
        e.subject_type !== undefined && String(e.subject_type).trim() !== ''
          ? String(e.subject_type)
          : defaultSubject;
      const confidence =
        Object.prototype.hasOwnProperty.call(e, 'confidence') && e.confidence !== null
          ? String(e.confidence)
          : null;
      const provenance =
        e.provenance !== undefined && String(e.provenance).trim() !== ''
          ? String(e.provenance)
          : defaultProv;
      const extrModel = modelId !== '' ? modelId : extractor;

      const st = await dbOne(
        ctx,
        `SELECT maludb_memory_ingest_edge(
                    p_source_kind      => 'document', p_source_id => $1,
                    p_subject_text     => $2, p_verb_text => $3,
                    p_predicate        => $4::jsonb,
                    p_embedding        => $5::maludb_core.malu_vector,
                    p_embedding_model  => $6,
                    p_subject_type     => $7,
                    p_source_span      => $8,
                    p_confidence       => $9::numeric,
                    p_provenance       => $10,
                    p_extraction_model => $11,
                    p_namespace        => $12,
                    p_document_id      => $13) AS statement_id`,
        [
          documentId,
          subjectText,
          verbText,
          predicate,
          e.__vector,
          embeddingModel,
          subjectTy,
          String(e.source_span),
          confidence,
          provenance,
          extrModel,
          namespace,
          documentId,
        ],
      );
      out.push({
        statement_id: Number(st!.statement_id),
        subject_text: subjectText,
        verb_text: verbText,
        subject_type: subjectTy,
        provenance,
      });
    }
    return { document_id: documentId, edges: out };
  });

  return {
    document_id: result.document_id,
    namespace,
    embedding_model: embeddingModel,
    extractor,
    chunk_count: chunks.length,
    edges: result.edges,
  };
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST'],
    url: '/v1/memory/documents',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const body = bodyObject(request);

      const title = body.title !== undefined ? String(body.title).trim() : '';
      const text = body.text !== undefined ? String(body.text) : '';
      if (title === '') jsonError('missing_field', 'Field "title" is required.', 400);
      if (text.trim() === '') jsonError('missing_field', 'Field "text" is required.', 400);

      const namespace =
        body.namespace !== undefined && String(body.namespace).trim() !== ''
          ? String(body.namespace)
          : 'default';
      const sourceType =
        body.source_type !== undefined && String(body.source_type).trim() !== ''
          ? String(body.source_type)
          : 'document';
      const mediaType =
        body.media_type !== undefined && body.media_type !== null
          ? String(body.media_type)
          : null;
      const docType =
        body.document_type !== undefined && String(body.document_type).trim() !== ''
          ? String(body.document_type)
          : null;
      // PHP is_array() is true for a JSON array or object (both decode to a PHP array).
      const metadata =
        isObject(body.metadata) || Array.isArray(body.metadata)
          ? JSON.stringify(body.metadata)
          : '{}';

      const chunkObj = isObject(body.chunk) ? body.chunk : {};

      const payload = await documentsCore(ctx, {
        title,
        text,
        sourceType,
        mediaType,
        documentType: docType,
        metadataJson: metadata,
        projects: toTextArray(body.projects),
        subjects: toTextArray(body.subjects),
        verbs: toTextArray(body.verbs),
        events: toTextArray(body.events),
        chunkMax: chunkObj.max !== undefined ? Math.max(200, Number(chunkObj.max)) : 2000,
        chunkOverlap:
          chunkObj.overlap !== undefined ? Math.max(0, Number(chunkObj.overlap)) : 200,
        embeddingModel:
          body.embedding_model !== undefined && String(body.embedding_model).trim() !== ''
            ? String(body.embedding_model)
            : null,
        explicitModel:
          body.model !== undefined && String(body.model).trim() !== ''
            ? String(body.model).trim()
            : null,
        providedEdges: Array.isArray(body.edges) ? (body.edges as unknown[]) : null,
        namespace,
      });

      jsonResponse(reply, payload, 201, ctx);
    },
  });
}

/** True for a plain JSON object (mirrors PHP `is_array($x ?? null)` for object-shaped fields). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
