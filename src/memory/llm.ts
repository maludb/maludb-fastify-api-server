/**
 * LLM layer for the MaluDB API (port of `config/llm.php`). PostgreSQL can't make outbound HTTP
 * calls, so the API is the model worker: it calls the LLM (extraction: text → JSON) and the
 * embedding model, then writes results back via the maludb_* facades. This module centralizes ALL
 * outbound model calls so endpoints share one provider-agnostic layer.
 *
 * No live creds? `memEmbed` falls back to a deterministic local embedding (same text → same vector),
 * so upload→ingest→search round-trips in tests; real creds switch on the HTTP path.
 */
import { createHash } from 'node:crypto';
import { httpTimeoutMs } from '../config/env.js';
import { jsonError } from '../http/errors.js';

export interface LlmConfig {
  base_url?: string | null;
  model_identifier?: string | null;
  token?: string | null;
  api_format?: string | null;
  max_tokens?: number | null;
  generation_params?: Record<string, unknown> | null;
  prompt_template?: string | null;
  embedding_base_url?: string | null;
  embedding_token?: string | null;
  embedding_model?: string | null;
}

/* ----------------------------- embeddings ------------------------------ */

/** Dimension of the (fallback) embedding. Every embedding in a namespace shares one model+dim. */
export function memEmbedDim(): number {
  const d = Number.parseInt(process.env.MALUDB_EMBED_DIM ?? '', 10);
  return Number.isFinite(d) && d > 0 ? d : 1536;
}

/** Deterministic sha256-seeded unit vector of `memEmbedDim()` floats in [-1,1], L2-normalized. */
export function memEmbedDeterministic(text: string): number[] {
  const dim = memEmbedDim();
  const vec: number[] = [];
  let i = 0;
  let sum = 0;
  while (vec.length < dim) {
    const block = createHash('sha256').update(`${text}:${i}`).digest();
    for (let b = 0; b < block.length && vec.length < dim; b++) {
      const v = ((block[b] as number) - 127.5) / 127.5;
      vec.push(v);
      sum += v * v;
    }
    i++;
  }
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

/** Call an OpenAI-shape embeddings endpoint (POST {input,model} → {data:[{embedding}]}). */
async function memEmbedHttp(
  text: string,
  base: string,
  token: string,
  model: string,
): Promise<number[]> {
  const resp = await httpPost(
    `${base.replace(/\/+$/, '')}/embeddings`,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    JSON.stringify({ input: text, model }),
  );
  const data = JSON.parse(resp);
  const emb = data?.data?.[0]?.embedding;
  if (!Array.isArray(emb)) {
    jsonError('upstream_error', 'Embedding provider returned no vector.', 502);
  }
  return emb.map(Number);
}

/**
 * Embed text. If a real embedding endpoint is configured (env MALUDB_EMBED_* or cfg), call it;
 * otherwise return a deterministic vector. Returns float[] of `memEmbedDim()`.
 */
export async function memEmbed(text: string, cfg: LlmConfig = {}): Promise<number[]> {
  const base = cfg.embedding_base_url ?? process.env.MALUDB_EMBED_BASE_URL ?? '';
  const token = cfg.embedding_token ?? process.env.MALUDB_EMBED_TOKEN ?? '';
  const model = cfg.embedding_model ?? process.env.MALUDB_EMBED_MODEL ?? '';
  if (base !== '' && token !== '' && model !== '') {
    return memEmbedHttp(text, base, token, model);
  }
  return memEmbedDeterministic(text);
}

/* ------------------------------ chunking ------------------------------- */

/**
 * Split text into chunks of ~`max` chars with `overlap`-char overlap, preferring paragraph then
 * sentence boundaries. Verbatim text is preserved — each chunk is what gets embedded and stored as
 * the edge source_span.
 */
export function memChunk(text: string, max = 2000, overlap = 200): string[] {
  text = text.trim();
  if (text === '') return [];
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  const len = text.length;
  let pos = 0;
  while (pos < len) {
    let slice = text.slice(pos, pos + max);
    if (pos + max < len) {
      const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf(' '));
      if (cut > max * 0.5) slice = slice.slice(0, cut + 1);
    }
    slice = slice.trim();
    if (slice !== '') chunks.push(slice);
    pos += Math.max(1, slice.length - overlap);
  }
  return chunks;
}

/* ----------------------------- extraction ------------------------------ */

/** Provider-agnostic chat completion (OpenAI-shape). Returns the assistant text. */
export async function llmChat(cfg: LlmConfig, prompt: string): Promise<string> {
  const base = cfg.base_url ?? '';
  const token = cfg.token ?? null;
  const model = cfg.model_identifier ?? '';
  if (base === '' || token === null || model === '') {
    jsonError('model_not_configured', 'No LLM model/token configured for this call.', 409);
  }
  const gen = cfg.generation_params ?? {};
  const body = { model, messages: [{ role: 'user', content: prompt }], ...gen };
  const resp = await httpPost(
    `${base.replace(/\/+$/, '')}/chat/completions`,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    JSON.stringify(body),
  );
  const content = JSON.parse(resp)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') jsonError('upstream_error', 'LLM returned no content.', 502);
  return content;
}

/** Run the prompt template (with {{chunk}}/{{text}} substituted) through the LLM, decode the JSON. */
export async function llmExtractJson(text: string, cfg: LlmConfig): Promise<Record<string, unknown>> {
  const tmpl = cfg.prompt_template ?? memDefaultPrompt();
  const prompt = tmpl.replace(/\{\{chunk\}\}/g, text).replace(/\{\{text\}\}/g, text);
  const content = await llmChat(cfg, prompt);
  const parsed = JSON.parse(content);
  if (typeof parsed !== 'object' || parsed === null) {
    jsonError('upstream_error', 'LLM output was not valid JSON.', 502);
  }
  return parsed as Record<string, unknown>;
}

/** Extract SVPO candidate edges from a chunk via the configured LLM. */
export async function memExtract(chunk: string, cfg: LlmConfig): Promise<unknown[]> {
  const parsed = await llmExtractJson(chunk, cfg);
  const edges = parsed.candidate_edges;
  if (!Array.isArray(edges)) {
    jsonError('upstream_error', 'LLM output was not the candidate_edges contract.', 502);
  }
  return edges;
}

/** Provider-agnostic system+user completion, dispatched by cfg.api_format. */
export async function llmComplete(cfg: LlmConfig, system: string, user: string): Promise<string> {
  const fmt = String(cfg.api_format ?? 'openai').toLowerCase();
  return fmt === 'anthropic'
    ? llmCompleteAnthropic(cfg, system, user)
    : llmCompleteOpenai(cfg, system, user);
}

async function llmCompleteOpenai(cfg: LlmConfig, system: string, user: string): Promise<string> {
  const base = cfg.base_url ?? '';
  const token = cfg.token ?? null;
  const model = cfg.model_identifier ?? '';
  if (base === '' || token === null || token === '' || model === '') {
    jsonError('model_not_configured', 'OpenAI base_url/api_key/model not configured.', 409);
  }
  const gen = cfg.generation_params ?? {};
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...gen,
  };
  const resp = await httpPost(
    `${base.replace(/\/+$/, '')}/chat/completions`,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    JSON.stringify(body),
  );
  const content = JSON.parse(resp)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') jsonError('upstream_error', 'OpenAI returned no content.', 502);
  return content;
}

async function llmCompleteAnthropic(cfg: LlmConfig, system: string, user: string): Promise<string> {
  const base = cfg.base_url ?? '';
  const token = cfg.token ?? null;
  const model = cfg.model_identifier ?? '';
  if (base === '' || token === null || token === '' || model === '') {
    jsonError('model_not_configured', 'Anthropic base_url/api_key/model not configured.', 409);
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: cfg.max_tokens ?? 2048,
    system,
    messages: [{ role: 'user', content: user }],
    ...(cfg.generation_params ?? {}),
  };
  const resp = await httpPost(
    `${base.replace(/\/+$/, '')}/v1/messages`,
    { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    JSON.stringify(body),
  );
  const data = JSON.parse(resp);
  let text = '';
  for (const block of data?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  if (text === '') jsonError('upstream_error', 'Anthropic returned no text content.', 502);
  return text;
}

/** Decode a JSON object from an LLM response that may wrap it in prose or a ```json fence. */
export function llmJsonFromText(content: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(content.trim());
  if (direct) return direct;
  const fenced = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (fenced && fenced[1]) {
    const v = tryParse(fenced[1]);
    if (v) return v;
  }
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const v = tryParse(content.slice(start, end + 1));
    if (v) return v;
  }
  return null;
}

/** Built-in extraction prompt (used when no template is configured). Must contain {{chunk}}. */
export function memDefaultPrompt(): string {
  return (
    'Extract Subject-Verb-Predicate-Object edges from the text. Use SMALL canonical verbs ' +
    '(e.g. "upgrade", not "performed_upgrade"); put status/timing/role/detail into the ' +
    'predicate array as edge-attributes (value_text / value_timestamp / value_numeric). ' +
    'Prefer subject_type in person|software|project|other. Return ONLY JSON of the form ' +
    '{"candidate_edges":[{"subject_text":"","subject_type":"","verb_text":"",' +
    '"predicate":[{"attr_name":"","value_text":""}],"source_span":"","confidence":0.0}]}.\n\n' +
    'Text:\n{{chunk}}'
  );
}

/* ------------------------------- transport ----------------------------- */

/** Minimal JSON POST over fetch with a hard timeout. Returns the response body; maps errors. */
export async function httpPost(
  url: string,
  headers: Record<string, string>,
  json: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), httpTimeoutMs());
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: json, signal: controller.signal });
  } catch (e) {
    jsonError('upstream_error', `Model HTTP call failed: ${(e as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (resp.status >= 400) {
    jsonError('upstream_error', `Model endpoint returned HTTP ${resp.status}.`, 502);
  }
  return resp.text();
}
