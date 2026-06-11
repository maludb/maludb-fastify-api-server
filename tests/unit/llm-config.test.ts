/**
 * Tests for the LLM config endpoints — /v1/llm/catalog, /v1/llm/providers, /v1/llm/models —
 * the seeded catalog (src/local-db/llm-catalog.ts), and the resolution helper
 * (src/memory/resolve.ts).
 *
 * No live Postgres needed: the endpoints only touch the local SQLite store (redirected to a
 * temp dir by tests/setup.ts), and requireAuth never opens a tenant connection by itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { seedDefaultPrompts } from '../../src/local-db/llm-catalog.js';
import {
  closeLocalDb,
  insertToken,
  localDb,
  upsertModelPrompt,
  upsertUserModelChoice,
  upsertUserProviderKey,
  userProviderKey,
} from '../../src/local-db/local-db.js';
import { resolveEmbedConfig, resolveTaskConfig } from '../../src/memory/resolve.js';

const app = buildApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeLocalDb();
});

/** Seed one token for `userId` and return the Authorization header for it. */
function seedUserToken(userId: number): { authorization: string } {
  const body = `llmcfg_${userId}_token_body`;
  insertToken({
    tokenHash: createHash('sha256').update(body).digest('hex'),
    tokenPrefix: body.slice(0, 8),
    userId,
    role: 'executor',
    pgDbname: 'llm_tenant_db',
    pgUser: 'llm_tenant_user',
    pgPassword: 'llm_tenant_pass',
    expiresAt: null,
    deviceName: 'llm-config-test',
  });
  return { authorization: `Bearer malu_${body}` };
}

function defaultPromptCount(): number {
  return (localDb().prepare('SELECT COUNT(*) AS n FROM default_prompts').get() as { n: number }).n;
}

describe('endpoint registration', () => {
  const paths: [string, string][] = [
    ['GET', '/v1/llm/catalog'],
    ['GET', '/v1/llm/providers'],
    ['PUT', '/v1/llm/providers/openai'],
    ['DELETE', '/v1/llm/providers/openai'],
    ['GET', '/v1/llm/models'],
    ['PUT', '/v1/llm/models/extract'],
    ['DELETE', '/v1/llm/models/extract'],
  ];
  it.each(paths)('%s %s requires auth (401, not 404)', async (method, url) => {
    const resp = await app.inject({ method: method as 'GET', url });
    expect(resp.statusCode).toBe(401);
    expect(resp.json().error.code).toBe('auth_missing');
  });
});

describe('seeded catalog', () => {
  const headers = seedUserToken(501);

  it('is seeded on openLocalDb (9 chat models × 2 tasks + 2 embed models)', () => {
    expect(defaultPromptCount()).toBe(20);
  });

  it('re-seeding is idempotent and never clobbers existing rows', () => {
    const before = defaultPromptCount();
    expect(seedDefaultPrompts(localDb())).toBe(0); // INSERT OR IGNORE — nothing new
    expect(defaultPromptCount()).toBe(before);
  });

  it('GET /v1/llm/catalog lists tasks and models with flags', async () => {
    const resp = await app.inject({ method: 'GET', url: '/v1/llm/catalog', headers });
    expect(resp.statusCode).toBe(200);
    const data = resp.json();
    expect([...data.tasks].sort()).toEqual(['embed', 'extract', 'skill_extract']);
    const byKey = new Map(
      data.models.map((m: { model_name: string; task: string }) => [
        `${m.model_name}/${m.task}`,
        m,
      ]),
    );
    expect(byKey.get('gpt-4o/extract')).toMatchObject({
      provider: 'openai',
      model_identifier: 'gpt-4o',
      api_format: 'openai',
      base_url: 'https://api.openai.com/v1',
      max_tokens: 2048,
      has_system_prompt: true,
      key_set: false,
      is_choice: false,
    });
    expect(byKey.get('claude-sonnet/extract')).toMatchObject({
      provider: 'anthropic',
      model_identifier: 'claude-sonnet-4-6',
      api_format: 'anthropic',
      base_url: 'https://api.anthropic.com',
      max_tokens: 4096,
    });
    expect(byKey.get('text-embedding-3-small/embed')).toMatchObject({
      has_system_prompt: false,
      max_tokens: 0,
    });
    expect(byKey.has('gpt-4o/skill_extract')).toBe(true);
  });

  it('never returns prompt text or any api_key field', async () => {
    const resp = await app.inject({ method: 'GET', url: '/v1/llm/catalog', headers });
    expect(resp.body).not.toContain('memory-extraction service');
    expect(resp.body).not.toContain('api_key');
  });
});

describe('/v1/llm/providers', () => {
  const headers = seedUserToken(502);

  it('requires api_key on first set', async () => {
    const resp = await app.inject({
      method: 'PUT',
      url: '/v1/llm/providers/openai',
      headers,
      payload: {},
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json().error.code).toBe('missing_field');
  });

  it('rejects a provider not in the catalog with 422', async () => {
    const resp = await app.inject({
      method: 'PUT',
      url: '/v1/llm/providers/closedai',
      headers,
      payload: { api_key: 'sk-x' },
    });
    expect(resp.statusCode).toBe(422);
    expect(resp.json().error.code).toBe('validation_failed');
    expect(resp.json().error.message).toContain('openai');
  });

  it('PUT + GET round-trips, never returning the key value', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/llm/providers/openai',
      headers,
      payload: { api_key: 'sk-secret-123' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().provider).toEqual({ provider: 'openai', key_set: true, base_url: null });
    expect(put.body).not.toContain('sk-secret-123');

    const listed = await app.inject({ method: 'GET', url: '/v1/llm/providers', headers });
    expect(listed.statusCode).toBe(200);
    const providers = listed.json().providers;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ provider: 'openai', key_set: true });
    expect(listed.body).not.toContain('sk-secret-123');

    for (const url of ['/v1/llm/catalog', '/v1/llm/models']) {
      const resp = await app.inject({ method: 'GET', url, headers });
      expect(resp.body).not.toContain('sk-secret-123');
    }
  });

  it('an update without api_key preserves the stored key', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/llm/providers/ollama',
      headers,
      payload: { api_key: 'ol-key' },
    });
    const resp = await app.inject({
      method: 'PUT',
      url: '/v1/llm/providers/ollama',
      headers,
      payload: { base_url: 'http://my-ollama:11434/v1' },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().provider.base_url).toBe('http://my-ollama:11434/v1');
    expect(userProviderKey(502, 'ollama')?.api_key).toBe('ol-key');
  });

  it('DELETE removes the key; a second DELETE is 404', async () => {
    const resp = await app.inject({ method: 'DELETE', url: '/v1/llm/providers/openai', headers });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ deleted: true, provider: 'openai' });

    const again = await app.inject({ method: 'DELETE', url: '/v1/llm/providers/openai', headers });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('not_found');
  });

  it('keys are per-user', async () => {
    expect(userProviderKey(502, 'ollama')).not.toBeNull();
    expect(userProviderKey(503, 'ollama')).toBeNull();
  });
});

describe('/v1/llm/models', () => {
  const headers = seedUserToken(503);

  it('defaults to the legacy extract model when nothing is chosen', async () => {
    const resp = await app.inject({ method: 'GET', url: '/v1/llm/models', headers });
    expect(resp.statusCode).toBe(200);
    const models = new Map(resp.json().models.map((m: { task: string }) => [m.task, m]));
    expect(models.get('extract')).toEqual({
      task: 'extract',
      model_name: 'chatgpt-4o',
      provider: null,
      chosen: false,
      system_prompt_override: false,
    });
    expect(models.get('skill_extract')).toMatchObject({ model_name: null, chosen: false });
    expect(models.get('embed')).toMatchObject({ model_name: null, chosen: false });
  });

  it('PUT warns when the provider has no key', async () => {
    const resp = await app.inject({
      method: 'PUT',
      url: '/v1/llm/models/extract',
      headers,
      payload: { model_name: 'claude-sonnet' },
    });
    expect(resp.statusCode).toBe(200);
    const choice = resp.json().choice;
    expect(choice).toMatchObject({
      task: 'extract',
      model_name: 'claude-sonnet',
      provider: 'anthropic',
      key_set: false,
      system_prompt_override: false,
    });
    expect(choice.warning).toContain('anthropic');
  });

  it('PUT with a stored key has no warning', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/llm/providers/anthropic',
      headers,
      payload: { api_key: 'sk-ant' },
    });
    const resp = await app.inject({
      method: 'PUT',
      url: '/v1/llm/models/extract',
      headers,
      payload: { model_name: 'claude-sonnet' },
    });
    const choice = resp.json().choice;
    expect(choice.key_set).toBe(true);
    expect(choice).not.toHaveProperty('warning');
  });

  it('rejects an unknown model with 422', async () => {
    const resp = await app.inject({
      method: 'PUT',
      url: '/v1/llm/models/extract',
      headers,
      payload: { model_name: 'gpt-99' },
    });
    expect(resp.statusCode).toBe(422);
    expect(resp.json().error.code).toBe('validation_failed');
    expect(resp.json().error.message).toContain('catalog');
  });

  it('rejects a model that exists only for another task with 422', async () => {
    // an embed-only model is not valid for extract
    const resp = await app.inject({
      method: 'PUT',
      url: '/v1/llm/models/extract',
      headers,
      payload: { model_name: 'text-embedding-3-small' },
    });
    expect(resp.statusCode).toBe(422);
  });

  it('rejects a missing model_name with 400', async () => {
    const resp = await app.inject({
      method: 'PUT',
      url: '/v1/llm/models/extract',
      headers,
      payload: {},
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json().error.code).toBe('missing_field');
  });

  it('GET reflects the choice (and a prompt override flag)', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/llm/models/extract',
      headers,
      payload: { model_name: 'claude-sonnet', system_prompt: 'custom' },
    });
    const resp = await app.inject({ method: 'GET', url: '/v1/llm/models', headers });
    const models = new Map(resp.json().models.map((m: { task: string }) => [m.task, m]));
    expect(models.get('extract')).toMatchObject({
      model_name: 'claude-sonnet',
      provider: 'anthropic',
      chosen: true,
      system_prompt_override: true,
    });
    expect(models.get('skill_extract')).toMatchObject({ chosen: false });
    expect(models.get('embed')).toMatchObject({ chosen: false });
  });

  it('the catalog reflects key and choice state', async () => {
    const resp = await app.inject({ method: 'GET', url: '/v1/llm/catalog', headers });
    const byKey = new Map(
      resp
        .json()
        .models.map((m: { model_name: string; task: string }) => [`${m.model_name}/${m.task}`, m]),
    );
    expect(byKey.get('claude-sonnet/extract')).toMatchObject({ key_set: true, is_choice: true });
    expect(byKey.get('gpt-4o/extract')).toMatchObject({ key_set: false, is_choice: false });
  });

  it('DELETE reverts to the default; a second DELETE is 404', async () => {
    const resp = await app.inject({ method: 'DELETE', url: '/v1/llm/models/extract', headers });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ deleted: true, task: 'extract' });

    const again = await app.inject({ method: 'DELETE', url: '/v1/llm/models/extract', headers });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('not_found');
  });
});

describe('resolveTaskConfig', () => {
  it('an explicit model prefers a legacy model_prompts row over the catalog', () => {
    // A legacy row whose name collides with a catalog model must win.
    upsertModelPrompt({
      modelName: 'gpt-4o',
      modelIdentifier: 'gpt-4o',
      apiFormat: 'openai',
      systemPrompt: 'legacy prompt',
      baseUrl: 'https://legacy.example/v1',
      apiKey: 'legacy-key',
      maxTokens: 2048,
      generationParams: null,
    });
    const cfg = resolveTaskConfig(601, 'extract', 'gpt-4o');
    expect(cfg).toMatchObject({
      source: 'model_prompts',
      base_url: 'https://legacy.example/v1',
      api_key: 'legacy-key',
    });
  });

  it('an explicit model falls back to the catalog + the caller key', () => {
    upsertUserProviderKey(602, 'anthropic', 'sk-ant', null);
    const cfg = resolveTaskConfig(602, 'extract', 'claude-sonnet');
    expect(cfg).toMatchObject({
      source: 'catalog_explicit',
      api_format: 'anthropic',
      model_identifier: 'claude-sonnet-4-6',
      api_key: 'sk-ant',
      provider: 'anthropic',
    });
    expect(cfg!.system_prompt).toContain('{{ENTITY_TYPES}}');
  });

  it('uses the user choice with base_url and prompt overrides', () => {
    upsertUserProviderKey(603, 'ollama', 'ol-key', 'http://my-box:11434/v1');
    upsertUserModelChoice(603, 'extract', 'ollama-local', 'my custom prompt');
    const cfg = resolveTaskConfig(603, 'extract');
    expect(cfg).toMatchObject({
      source: 'user_choice',
      model_name: 'ollama-local',
      base_url: 'http://my-box:11434/v1', // user base_url override
      system_prompt: 'my custom prompt', // user prompt override
    });
  });

  it('returns null when nothing is configured', () => {
    expect(resolveTaskConfig(604, 'extract')).toBeNull();
    expect(resolveTaskConfig(604, 'extract', 'no-such-model')).toBeNull();
  });

  it('skill_extract resolves the skill prompt (differs from the extract prompt)', () => {
    upsertUserProviderKey(605, 'openai', 'sk-x', null);
    const skillCfg = resolveTaskConfig(605, 'skill_extract', 'gpt-4o-mini');
    expect(skillCfg).toMatchObject({ source: 'catalog_explicit' });
    expect(skillCfg!.system_prompt).not.toBe('');
    const extractCfg = resolveTaskConfig(605, 'extract', 'gpt-4o-mini');
    expect(skillCfg!.system_prompt).not.toBe(extractCfg!.system_prompt);
  });
});

describe('resolveEmbedConfig', () => {
  it('returns {} when nothing is configured', () => {
    expect(resolveEmbedConfig(701)).toEqual({});
  });

  it('returns {} for a choice whose provider has no key', () => {
    upsertUserModelChoice(702, 'embed', 'text-embedding-3-small', null);
    expect(resolveEmbedConfig(702)).toEqual({});
  });

  it('returns the memEmbed connection for a choice with a key', () => {
    upsertUserProviderKey(703, 'openai', 'sk-x', null);
    upsertUserModelChoice(703, 'embed', 'text-embedding-3-small', null);
    expect(resolveEmbedConfig(703)).toEqual({
      embedding_base_url: 'https://api.openai.com/v1',
      embedding_token: 'sk-x',
      embedding_model: 'text-embedding-3-small',
    });
  });
});
