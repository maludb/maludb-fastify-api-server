/**
 * Effective LLM config resolution — per-user task → model → connection.
 *
 * Computes the model configuration a pipeline (memory ingest, skill ingest, embeddings) should
 * use for a task, layering three sources:
 *
 *   1. Explicit `model` in the request body:
 *        a. legacy model_prompts row (byte-for-byte today's behavior, including its own
 *           api_key), else
 *        b. default_prompts catalog row (model, task) + the caller's provider key.
 *   2. The user's choice — user_model_choices(user_id, task) → catalog row + provider key, with
 *      the user's optional system_prompt and base_url overrides.
 *   3. Nothing matched → null. Callers keep their existing legacy fallback (the 'chatgpt-4o'
 *      model_prompts row, env embedding, deterministic vectors) so unconfigured tenants see
 *      today's exact errors.
 *
 * The returned object is shaped like a model_prompts row (the shape memory_ingest.ts and
 * skills_ingest.ts already consume): model_name, model_identifier, api_format, base_url,
 * api_key, max_tokens, generation_params (JSON string or null), system_prompt, plus `source`
 * ('model_prompts' | 'catalog_explicit' | 'user_choice') and `provider`.
 */
import {
  defaultPrompt,
  modelPrompt,
  userModelChoice,
  userProviderKey,
} from '../local-db/local-db.js';
import type { DefaultPromptRow } from '../types/auth.js';
import type { LlmConfig } from './llm.js';

/** The effective per-task LLM configuration (a model_prompts-row shape + provenance). */
export interface ResolvedTaskConfig {
  model_name: string;
  model_identifier: string | null;
  api_format: string;
  base_url: string | null;
  api_key: string | null;
  max_tokens: number;
  generation_params: string | null;
  system_prompt: string | null;
  provider: string | null;
  source: 'model_prompts' | 'catalog_explicit' | 'user_choice';
}

/** Assemble an effective config from a catalog row + the user's provider key. */
function catalogConfig(
  userId: number,
  row: DefaultPromptRow,
  source: 'catalog_explicit' | 'user_choice',
  promptOverride: string | null = null,
): ResolvedTaskConfig {
  const key = userProviderKey(userId, row.provider);
  return {
    model_name: row.model_name,
    model_identifier: row.model_identifier,
    api_format: row.api_format,
    // The user's per-provider base_url override wins (e.g. self-hosted ollama).
    base_url: key?.base_url || row.base_url,
    api_key: key?.api_key ?? null,
    max_tokens: Number(row.max_tokens || 2048),
    generation_params: row.generation_params,
    system_prompt: promptOverride ? promptOverride : row.system_prompt,
    provider: row.provider,
    source,
  };
}

/** Resolve the effective LLM config for a task, or null if nothing is set. */
export function resolveTaskConfig(
  userId: number,
  task: string,
  explicitModel: string | null = null,
): ResolvedTaskConfig | null {
  if (explicitModel !== null && explicitModel !== '') {
    // 1a. Legacy model_prompts wins for explicit models — existing deployments that configured
    //     this name see zero behavior change.
    const pr = modelPrompt(explicitModel);
    if (pr !== null) {
      return { ...pr, provider: null, source: 'model_prompts' };
    }
    // 1b. Catalog row for this task.
    const row = defaultPrompt(explicitModel, task);
    if (row !== null) {
      return catalogConfig(userId, row, 'catalog_explicit');
    }
    return null;
  }

  // 2. The user's stored choice for this task.
  const choice = userModelChoice(userId, task);
  if (choice !== null) {
    const row = defaultPrompt(choice.model_name, task);
    if (row !== null) {
      return catalogConfig(userId, row, 'user_choice', choice.system_prompt);
    }
  }

  // 3. Nothing resolved — caller falls back to its legacy behavior.
  return null;
}

/**
 * The user's 'embed' choice as a memEmbed() cfg object; {} when unset.
 *
 * memEmbed falls back to MALUDB_EMBED_* env vars and then the deterministic vector when the
 * returned object is empty or incomplete, so this never breaks an unconfigured tenant.
 */
export function resolveEmbedConfig(userId: number): LlmConfig {
  const cfg = resolveTaskConfig(userId, 'embed');
  if (cfg === null || cfg.api_key === null || cfg.api_key === '') {
    return {};
  }
  return {
    embedding_base_url: cfg.base_url,
    embedding_token: cfg.api_key,
    embedding_model: cfg.model_identifier,
  };
}
