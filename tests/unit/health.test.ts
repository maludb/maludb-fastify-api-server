import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('GET /v1/health', () => {
  it('returns 200 JSON {status:ok}', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', name: 'maludb-api-server' });
    await app.close();
  });

  it('returns 404 not_found for an unknown URL', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
    await app.close();
  });

  it('returns 405 method_not_allowed with Allow header for a known URL', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/health' });
    expect(res.statusCode).toBe(405);
    expect(res.json()).toMatchObject({ error: { code: 'method_not_allowed' } });
    expect(res.headers.allow).toContain('GET');
    await app.close();
  });
});
