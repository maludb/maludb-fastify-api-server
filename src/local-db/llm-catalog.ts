/**
 * Seeded LLM model catalog — default prompts for common models.
 *
 * Populates the local store's `default_prompts` table so a fresh install offers working model
 * configurations out of the box: a user only has to store their provider API key
 * (PUT /v1/llm/providers/{provider}) and pick a model (PUT /v1/llm/models/{task}).
 *
 * Seeding rules:
 *   - Runs on every openLocalDb() — INSERT OR IGNORE on the UNIQUE(model_name, task) key, so it
 *     is idempotent and additive: upgrades add new rows but never overwrite a row an operator
 *     hand-edited.
 *   - To *revise* a shipped prompt, add a new model_name (or write an explicit migration);
 *     silently changing seeded rows under operators is not allowed.
 *
 * Prompt files live in config/prompts/ (identical content across the Python, PHP, and Fastify
 * servers):
 *   - extract.rich.system.txt    — full ingest-extraction contract, for capable models
 *   - extract.simple.system.txt  — condensed contract, for small/local models
 *   - skill-extract.system.txt   — skill discovery-tag extraction
 * Embedding rows ('embed' task) have no prompt.
 */
import type { Database } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptsDir } from '../config/paths.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// Tasks the servers run today. The task column is a free string — new tasks only need new seed
// rows and a pipeline that asks for them.
export const TASKS = ['extract', 'skill_extract', 'embed'] as const;

// generation_params presets (stored as JSON strings, merged into the request).
const GP_JSON = '{"temperature": 0.1, "response_format": {"type": "json_object"}}';
const GP_TEMP = '{"temperature": 0.1}';

/** One default_prompts seed row. */
export interface SeedRow {
  provider: string;
  model_name: string;
  model_identifier: string;
  api_format: string;
  base_url: string;
  task: string;
  system_prompt: string | null;
  max_tokens: number;
  generation_params: string | null;
}

// Chat models: [provider, model_name, model_identifier, api_format, base_url,
//               extract_prompt_file, max_tokens, generation_params].
// Each gets two rows: task 'extract' (with its extract prompt) and task 'skill_extract'
// (always skill-extract.system.txt).
// Base-URL convention follows src/memory/llm.ts: the openai format appends /chat/completions
// (base ends in /v1), the anthropic format appends /v1/messages (base is the bare host).
const CHAT_MODELS: [string, string, string, string, string, string, number, string | null][] = [
  [
    'openai',
    'gpt-4o',
    'gpt-4o',
    'openai',
    'https://api.openai.com/v1',
    'extract.rich.system.txt',
    2048,
    GP_JSON,
  ],
  [
    'openai',
    'gpt-4o-mini',
    'gpt-4o-mini',
    'openai',
    'https://api.openai.com/v1',
    'extract.simple.system.txt',
    2048,
    GP_JSON,
  ],
  [
    'anthropic',
    'claude-opus',
    'claude-opus-4-8',
    'anthropic',
    'https://api.anthropic.com',
    'extract.rich.system.txt',
    4096,
    null,
  ],
  [
    'anthropic',
    'claude-sonnet',
    'claude-sonnet-4-6',
    'anthropic',
    'https://api.anthropic.com',
    'extract.rich.system.txt',
    4096,
    null,
  ],
  [
    'anthropic',
    'claude-haiku',
    'claude-haiku-4-5',
    'anthropic',
    'https://api.anthropic.com',
    'extract.simple.system.txt',
    4096,
    null,
  ],
  [
    'google',
    'gemini-flash',
    'gemini-2.5-flash',
    'openai',
    'https://generativelanguage.googleapis.com/v1beta/openai',
    'extract.simple.system.txt',
    2048,
    GP_JSON,
  ],
  [
    'xai',
    'grok',
    'grok-4',
    'openai',
    'https://api.x.ai/v1',
    'extract.rich.system.txt',
    2048,
    GP_JSON,
  ],
  [
    'deepseek',
    'deepseek-chat',
    'deepseek-chat',
    'openai',
    'https://api.deepseek.com/v1',
    'extract.rich.system.txt',
    2048,
    GP_JSON,
  ],
  [
    'ollama',
    'ollama-local',
    'llama3.1',
    'openai',
    'http://localhost:11434/v1',
    'extract.simple.system.txt',
    2048,
    GP_TEMP,
  ],
];

// Embedding models: [provider, model_name, model_identifier, base_url].
// api_format is 'openai' (the only embeddings shape we speak); no prompt.
const EMBED_MODELS: [string, string, string, string][] = [
  ['openai', 'text-embedding-3-small', 'text-embedding-3-small', 'https://api.openai.com/v1'],
  ['ollama', 'ollama-embed', 'nomic-embed-text', 'http://localhost:11434/v1'],
];

const promptCache = new Map<string, string>();

/** Read a prompt file from config/prompts/ (cached per process). */
function promptText(filename: string): string {
  let text = promptCache.get(filename);
  if (text === undefined) {
    text = readFileSync(join(promptsDir(moduleDir), filename), 'utf8');
    promptCache.set(filename, text);
  }
  return text;
}

/** The full seed matrix as a list of default_prompts rows. */
export function seedRows(): SeedRow[] {
  const rows: SeedRow[] = [];
  for (const [provider, name, ident, fmt, base, extractFile, maxTokens, gen] of CHAT_MODELS) {
    rows.push({
      provider,
      model_name: name,
      model_identifier: ident,
      api_format: fmt,
      base_url: base,
      task: 'extract',
      system_prompt: promptText(extractFile),
      max_tokens: maxTokens,
      generation_params: gen,
    });
    rows.push({
      provider,
      model_name: name,
      model_identifier: ident,
      api_format: fmt,
      base_url: base,
      task: 'skill_extract',
      system_prompt: promptText('skill-extract.system.txt'),
      max_tokens: maxTokens,
      generation_params: gen,
    });
  }
  for (const [provider, name, ident, base] of EMBED_MODELS) {
    rows.push({
      provider,
      model_name: name,
      model_identifier: ident,
      api_format: 'openai',
      base_url: base,
      task: 'embed',
      system_prompt: null,
      max_tokens: 0,
      generation_params: null,
    });
  }
  return rows;
}

/**
 * Insert the seed matrix into default_prompts; returns the number of rows inserted.
 *
 * INSERT OR IGNORE on UNIQUE(model_name, task): existing rows (including operator-edited ones)
 * are left untouched.
 */
export function seedDefaultPrompts(db: Database): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO default_prompts
         (provider, model_name, model_identifier, api_format, base_url,
          task, system_prompt, max_tokens, generation_params)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  for (const r of seedRows()) {
    inserted += stmt.run(
      r.provider,
      r.model_name,
      r.model_identifier,
      r.api_format,
      r.base_url,
      r.task,
      r.system_prompt,
      r.max_tokens,
      r.generation_params,
    ).changes;
  }
  return inserted;
}
