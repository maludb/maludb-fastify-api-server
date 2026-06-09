import { describe, it, expect, afterAll } from 'vitest';
import {
  closeLocalDb,
  deleteToken,
  getToken,
  insertToken,
  listTokens,
  modelPrompt,
  nextUserId,
  resolveToken,
  upsertModelPrompt,
} from '../../src/local-db/local-db.js';

afterAll(() => closeLocalDb());

function seedToken(hash: string, overrides: Partial<Parameters<typeof insertToken>[0]> = {}): number {
  return insertToken({
    tokenHash: hash,
    tokenPrefix: hash.slice(0, 8),
    userId: 1,
    role: 'executor',
    pgDbname: 'tenant_db',
    pgUser: 'tenant_user',
    pgPassword: 'tenant_pass',
    expiresAt: null,
    deviceName: 'unit-test',
    ...overrides,
  });
}

describe('resolveToken', () => {
  it('round-trips an inserted token to its tenant connection + role', () => {
    seedToken('hash_valid_1');
    const row = resolveToken('hash_valid_1');
    expect(row).toMatchObject({
      role: 'executor',
      pg_dbname: 'tenant_db',
      pg_user: 'tenant_user',
      pg_password: 'tenant_pass',
    });
  });

  it('returns null for an unknown hash', () => {
    expect(resolveToken('nope')).toBeNull();
  });

  it('returns null for an expired token', () => {
    seedToken('hash_expired', { expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(resolveToken('hash_expired')).toBeNull();
  });

  it('resolves a token whose expiry is in the future', () => {
    seedToken('hash_future', { expiresAt: '2999-01-01T00:00:00.000Z' });
    expect(resolveToken('hash_future')).not.toBeNull();
  });
});

describe('nextUserId', () => {
  it('returns max(user_id)+1', () => {
    const before = nextUserId();
    seedToken('hash_userid', { userId: before + 5 });
    expect(nextUserId()).toBe(before + 6);
  });
});

describe('listTokens / getToken / deleteToken', () => {
  it('lists tokens for a connection and revokes by id', () => {
    const id = seedToken('hash_listme', { pgDbname: 'conn_db', pgUser: 'conn_user' });
    const list = listTokens('conn_db', 'conn_user');
    expect(list.some((t) => t.id === id)).toBe(true);
    // metadata only — never the token or password
    expect(Object.keys(list[0] ?? {})).not.toContain('pg_password');
    expect(Object.keys(list[0] ?? {})).not.toContain('token_hash');

    expect(getToken(id)?.id).toBe(id);
    expect(deleteToken(id)).toBe(1);
    expect(getToken(id)).toBeNull();
  });
});

describe('model_prompts', () => {
  it('upserts and reads back a model prompt, preserving the key on a null re-upsert', () => {
    upsertModelPrompt({
      modelName: 'chatgpt-4o',
      modelIdentifier: 'gpt-4o',
      apiFormat: 'openai',
      systemPrompt: 'extract',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-secret',
      maxTokens: 2048,
      generationParams: null,
    });
    expect(modelPrompt('chatgpt-4o')).toMatchObject({ model_identifier: 'gpt-4o', api_key: 'sk-secret' });

    // Re-upsert without a key keeps the stored one.
    upsertModelPrompt({
      modelName: 'chatgpt-4o',
      modelIdentifier: 'gpt-4o',
      apiFormat: 'openai',
      systemPrompt: 'extract v2',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: null,
      maxTokens: 4096,
      generationParams: null,
    });
    const p = modelPrompt('chatgpt-4o');
    expect(p?.system_prompt).toBe('extract v2');
    expect(p?.api_key).toBe('sk-secret');
  });
});
