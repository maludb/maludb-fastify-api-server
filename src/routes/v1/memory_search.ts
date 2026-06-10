/**
 * POST /v1/memory/search  (maludb_core memory — query the stored memory; endpoint group 3)
 *
 *   POST  { query (req text), subject?, verb?, namespace='default', limit=20, metric='cosine' }
 *         Embed the query with the SAME embedding model used at ingest, then call
 *         maludb_memory_search(...). subject/verb pre-filter to a compartment before the ANN.
 *         Returns rows: {chunk_id, statement_id, document_id, source_text, distance, similarity,
 *         rank_no, subject_name, verb_name}.
 *
 *   The query embedding MUST use the same embedding model/dimension as the stored vectors —
 *   memEmbed() reads the configured/namespace model (deterministic fallback otherwise).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { bodyObject } from '../../http/request.js';
import { memEmbed } from '../../memory/llm.js';
import { resolveEmbedConfig } from '../../memory/resolve.js';
import { memVectorLiteral } from '../../memory/memory-db.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'memory_search.ts';

export interface SearchCoreOptions {
  query: string;
  subject: string | null;
  verb: string | null;
  namespace: string;
  limit: number;
  metric: string;
  embeddingModel: string | null;
}

/**
 * Embed the query and run the vector search, shared by the REST route and the MCP search_memory
 * tool. Returns the response payload; throws ApiError on failure.
 */
export async function searchCore(
  ctx: RequestCtx,
  { query, subject, verb, namespace, limit, metric, embeddingModel }: SearchCoreOptions,
): Promise<Record<string, unknown>> {
  // Same embedding model (and precedence) as document ingest:
  // caller > namespace config > the user's 'embed' choice > env default.
  const row = await dbTxCore(ctx, () =>
    dbOne(ctx, 'SELECT maludb_memory_model_config($1) AS cfg', [namespace]),
  );
  // jsonb is already parsed by node-pg — no JSON.parse.
  const cfg = row !== null && row.cfg !== null ? (row.cfg as Record<string, unknown>) : {};
  const userEmbed = resolveEmbedConfig(Number(ctx.userId));
  const resolvedModel =
    embeddingModel ??
    (cfg.embedding_model as string | undefined) ??
    userEmbed.embedding_model ??
    (process.env.MALUDB_EMBED_MODEL || 'maludb-local-dev');

  const vector = memVectorLiteral(
    await memEmbed(query, { ...userEmbed, embedding_model: resolvedModel }),
  );

  const rows = await dbTxCore(ctx, () =>
    dbMany(
      ctx,
      `SELECT chunk_id, statement_id, document_id, source_text, distance, similarity,
              rank_no, subject_name, verb_name
         FROM maludb_memory_search(
                  p_query_embedding => $1::maludb_core.malu_vector,
                  p_subject         => $2,
                  p_verb            => $3,
                  p_namespace       => $4,
                  p_limit           => $5,
                  p_metric          => $6)`,
      [vector, subject, verb, namespace, limit, metric],
    ),
  );
  for (const r of rows) {
    for (const k of ['chunk_id', 'statement_id', 'document_id', 'rank_no']) {
      r[k] = r[k] === null ? null : Number(r[k]);
    }
    for (const k of ['distance', 'similarity']) {
      r[k] = r[k] === null ? null : Number(r[k]);
    }
  }

  return {
    namespace,
    embedding_model: resolvedModel,
    results: rows,
  };
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST'],
    url: '/v1/memory/search',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const body = bodyObject(request);

      const query = body.query !== undefined ? String(body.query) : '';
      if (query.trim() === '') jsonError('missing_field', 'Field "query" is required.', 400);

      const namespace =
        body.namespace !== undefined && String(body.namespace).trim() !== ''
          ? String(body.namespace)
          : 'default';
      const subject =
        body.subject !== undefined && String(body.subject).trim() !== ''
          ? String(body.subject)
          : null;
      const verb =
        body.verb !== undefined && String(body.verb).trim() !== '' ? String(body.verb) : null;
      // The graph-bound search pre-filters to a (subject, verb) compartment before the ANN, so at
      // least one is required (the DB enforces this too — surface it as a clean 400).
      if (subject === null && verb === null) {
        jsonError(
          'missing_field',
          'Provide "subject" and/or "verb" — the compartment pre-filter is required.',
          400,
        );
      }
      const limit =
        body.limit !== undefined ? Math.max(1, Math.min(200, Number(body.limit))) : 20;
      const metric =
        body.metric !== undefined && String(body.metric).trim() !== ''
          ? String(body.metric)
          : 'cosine';

      const payload = await searchCore(ctx, {
        query,
        subject,
        verb,
        namespace,
        limit,
        metric,
        embeddingModel:
          body.embedding_model !== undefined && String(body.embedding_model).trim() !== ''
            ? String(body.embedding_model)
            : null,
      });

      jsonResponse(reply, payload, 200, ctx);
    },
  });
}
