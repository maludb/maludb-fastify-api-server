/**
 * Tests for the MCP endpoint — POST /mcp (stateless Streamable HTTP, spec 2025-06-18).
 *
 * Mirrors the Python reference server's tests/test_mcp.py. No live Postgres needed: the auth
 * store is the temp SQLite database (tests/setup.ts), and the tool tests mock the db helpers /
 * pipeline cores that src/routes/v1/mcp.ts imports.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Response as InjectResponse } from 'light-my-request';

vi.mock('../../src/db/query.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/db/query.js')>();
  return { ...mod, dbMany: vi.fn(), dbOne: vi.fn() };
});
vi.mock('../../src/db/tx.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/db/tx.js')>();
  return { ...mod, dbTxCore: vi.fn() };
});
vi.mock('../../src/routes/v1/memory_ingest.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/routes/v1/memory_ingest.js')>();
  return { ...mod, ingestCore: vi.fn() };
});
vi.mock('../../src/routes/v1/memory_search.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/routes/v1/memory_search.js')>();
  return { ...mod, searchCore: vi.fn() };
});
vi.mock('../../src/routes/v1/memory_documents.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/routes/v1/memory_documents.js')>();
  return { ...mod, documentsCore: vi.fn() };
});

import { buildApp } from '../../src/app.js';
import { ApiError } from '../../src/http/errors.js';
import { TOOLS } from '../../src/routes/v1/mcp.js';
import { insertToken, closeLocalDb } from '../../src/local-db/local-db.js';
import { dbMany, dbOne } from '../../src/db/query.js';
import { dbTxCore } from '../../src/db/tx.js';
import { ingestCore } from '../../src/routes/v1/memory_ingest.js';
import { searchCore } from '../../src/routes/v1/memory_search.js';
import { documentsCore } from '../../src/routes/v1/memory_documents.js';

const TOKEN_BODY = 'mcp_test_token';
const TOKEN = `malu_${TOKEN_BODY}`;
const HEADERS = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

const READ_TOOLS = new Set([
  'search_memory',
  'find_subjects',
  'explore_subject',
  'get_document',
  'find_skills',
  'get_skill',
]);
const WRITE_TOOLS = new Set(['store_memory', 'store_document']);

const app = buildApp();

beforeAll(async () => {
  await app.ready();
  insertToken({
    tokenHash: createHash('sha256').update(TOKEN_BODY).digest('hex'),
    tokenPrefix: TOKEN_BODY.slice(0, 8),
    userId: 9,
    role: 'executor',
    pgDbname: 'testdb',
    pgUser: 'testuser',
    pgPassword: 'testpass',
    expiresAt: null,
    deviceName: 'mcp-test',
  });
});

afterAll(async () => {
  await app.close();
  closeLocalDb();
});

beforeEach(() => {
  vi.mocked(dbMany).mockReset();
  vi.mocked(dbOne).mockReset();
  vi.mocked(dbTxCore).mockReset();
  vi.mocked(ingestCore).mockReset();
  vi.mocked(searchCore).mockReset();
  vi.mocked(documentsCore).mockReset();
});

function rpc(
  method: string,
  params?: unknown,
  reqId: unknown = 1,
  headers: Record<string, string> = HEADERS,
) {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', id: reqId, method };
  if (params !== undefined) msg.params = params;
  return app.inject({ method: 'POST', url: '/mcp', headers, payload: JSON.stringify(msg) });
}

function callTool(name: string, args: Record<string, unknown> = {}) {
  return rpc('tools/call', { name, arguments: args });
}

/** Decode the JSON inside the first text content block of a tool result. */
function toolText(resp: InjectResponse): Record<string, any> {
  const result = resp.json().result;
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe('transport', () => {
  it('missing auth returns 401', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json().error.code).toBe('auth_missing');
  });

  it('GET returns 405 with Allow: POST', async () => {
    const resp = await app.inject({ method: 'GET', url: '/mcp' });
    expect(resp.statusCode).toBe(405);
    expect(resp.json().error.code).toBe('method_not_allowed');
    expect(resp.json().error.message).toBe('MCP requires POST. SSE streaming is not supported.');
    expect(resp.headers.allow).toBe('POST');
  });

  it('DELETE returns 405', async () => {
    const resp = await app.inject({ method: 'DELETE', url: '/mcp' });
    expect(resp.statusCode).toBe(405);
  });

  it('malformed JSON is a JSON-RPC parse error (HTTP 200, id null)', async () => {
    const resp = await app.inject({ method: 'POST', url: '/mcp', headers: HEADERS, payload: '{nope' });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it('batch requests are rejected with -32600', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: HEADERS,
      payload: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
    });
    expect(resp.json().error.code).toBe(-32600);
  });

  it('wrong jsonrpc version is rejected with -32600', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: HEADERS,
      payload: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }),
    });
    expect(resp.json().error.code).toBe(-32600);
  });

  it('notification returns 202 with an empty body', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: HEADERS,
      payload: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(resp.statusCode).toBe(202);
    expect(resp.body).toBe('');
  });

  it('unknown method returns -32601', async () => {
    const resp = await rpc('resources/list');
    expect(resp.json().error.code).toBe(-32601);
  });

  it('responds with a single JSON object', async () => {
    const resp = await rpc('ping');
    expect(resp.headers['content-type']).toMatch(/^application\/json/);
    const body = resp.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('security', () => {
  it('rejects a foreign Origin with 403', async () => {
    const resp = await rpc('ping', undefined, 1, { ...HEADERS, origin: 'https://evil.example' });
    expect(resp.statusCode).toBe(403);
    expect(resp.json().error.code).toBe('origin_forbidden');
  });

  it('allows a localhost Origin', async () => {
    const resp = await rpc('ping', undefined, 1, { ...HEADERS, origin: 'http://localhost:3000' });
    expect(resp.statusCode).toBe(200);
  });

  it('allows a same-host Origin', async () => {
    const resp = await rpc('ping', undefined, 1, {
      ...HEADERS,
      host: 'maludb.example',
      origin: 'http://maludb.example',
    });
    expect(resp.statusCode).toBe(200);
  });

  it('rejects an unsupported MCP-Protocol-Version header with 400', async () => {
    const resp = await rpc('ping', undefined, 1, { ...HEADERS, 'mcp-protocol-version': '2024-11-05' });
    expect(resp.statusCode).toBe(400);
    expect(resp.json().error.code).toBe('unsupported_protocol_version');
  });

  it('accepts a supported MCP-Protocol-Version header', async () => {
    const resp = await rpc('ping', undefined, 1, { ...HEADERS, 'mcp-protocol-version': '2025-06-18' });
    expect(resp.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle methods
// ---------------------------------------------------------------------------

describe('initialize', () => {
  it('echoes a supported protocol version', async () => {
    const resp = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    expect(resp.json().result.protocolVersion).toBe('2025-03-26');
  });

  it('falls back for an unknown version', async () => {
    const resp = await rpc('initialize', { protocolVersion: '1999-01-01' });
    expect(resp.json().result.protocolVersion).toBe('2025-06-18');
  });

  it('falls back for a missing version', async () => {
    const resp = await rpc('initialize');
    expect(resp.json().result.protocolVersion).toBe('2025-06-18');
  });

  it('reports capabilities and serverInfo', async () => {
    const result = (await rpc('initialize')).json().result;
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo.name).toBe('maludb');
    expect(result.serverInfo.title).toBe('MaluDB Memory');
  });
});

describe('tools/list', () => {
  it('lists all eight tools without a nextCursor', async () => {
    const result = (await rpc('tools/list')).json().result;
    const names = new Set(result.tools.map((t: { name: string }) => t.name));
    expect(names).toEqual(new Set([...READ_TOOLS, ...WRITE_TOOLS]));
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('ignores a cursor', async () => {
    const result = (await rpc('tools/list', { cursor: 'abc' })).json().result;
    expect(result.tools).toHaveLength(8);
  });

  it('tool shapes carry schemas and the read/write annotation pattern', async () => {
    for (const tool of (await rpc('tools/list')).json().result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      const expectedReadOnly = READ_TOOLS.has(tool.name);
      expect(tool.annotations.readOnlyHint, tool.name).toBe(expectedReadOnly);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it('the registry is plain data (JSON round-trips as-is)', () => {
    // The registry is a cross-server contract — must be JSON-serializable as-is.
    expect(JSON.parse(JSON.stringify(TOOLS))).toEqual(TOOLS);
  });
});

// ---------------------------------------------------------------------------
// tools/call — protocol-level validation
// ---------------------------------------------------------------------------

describe('tools/call validation', () => {
  it('unknown tool returns -32602', async () => {
    const resp = await callTool('drop_database');
    expect(resp.json().error.code).toBe(-32602);
  });

  it('missing required argument returns -32602 naming the field', async () => {
    const resp = await callTool('store_memory', {});
    const body = resp.json();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('"text"');
  });

  it('get_skill requires skill_id or name', async () => {
    const resp = await callTool('get_skill', {});
    const body = resp.json();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('skill_id');
  });
});

// ---------------------------------------------------------------------------
// tools/call — handlers (db helpers / cores mocked)
// ---------------------------------------------------------------------------

describe('tools/call handlers', () => {
  it('find_subjects round-trips rows and passes the limit through', async () => {
    const rows = [{ id: 1, name: 'Edward', type: 'person', description: null }];
    vi.mocked(dbMany).mockResolvedValue(rows);

    const resp = await callTool('find_subjects', { query: 'ed', limit: 5 });
    const result = resp.json().result;
    expect(result).not.toHaveProperty('isError');
    expect(toolText(resp).subjects[0].name).toBe('Edward');
    // limit is passed through as the last SQL param
    const call = vi.mocked(dbMany).mock.calls[0]!;
    expect((call[2] as unknown[]).at(-1)).toBe(5);
  });

  it('get_document returns the document when found', async () => {
    const doc = {
      id: 7,
      title: 'T',
      source_type: 'document',
      media_type: null,
      document_type: null,
      primary_project_id: null,
      description: null,
      content_size: 10,
      content_hash: 'x',
      created_at: null,
      updated_at: null,
    };
    vi.mocked(dbOne).mockResolvedValue({ ...doc });
    vi.mocked(dbMany).mockResolvedValue([]);

    const resp = await callTool('get_document', { document_id: 7 });
    expect(toolText(resp).document.id).toBe(7);
  });

  it('get_document not found is an isError tool result', async () => {
    vi.mocked(dbOne).mockResolvedValue(null);

    const resp = await callTool('get_document', { document_id: 999 });
    const result = resp.json().result;
    expect(result.isError).toBe(true);
    expect(toolText(resp).error.code).toBe('not_found');
  });

  it('search_memory without a pre-filter suggests subjects and skips the core', async () => {
    vi.mocked(dbMany).mockResolvedValue([{ name: 'Edward', type: 'person' }]);

    const resp = await callTool('search_memory', { query: 'edward oracle upgrade' });
    const result = resp.json().result;
    expect(result.isError).toBe(true);
    const err = toolText(resp).error;
    expect(err.code).toBe('missing_field');
    expect(err.message).toContain('Edward');
    expect(err.message).toContain('find_subjects');
    expect(searchCore).not.toHaveBeenCalled();
  });

  it('search_memory delegates to the core with the limit clamped', async () => {
    const canned = { namespace: 'default', embedding_model: 'm', results: [] };
    vi.mocked(searchCore).mockResolvedValue(canned);

    const resp = await callTool('search_memory', { query: 'x', subject: 'Edward', limit: 999 });
    expect(toolText(resp)).toEqual(canned);
    const opts = vi.mocked(searchCore).mock.calls[0]![1];
    expect(opts.limit).toBe(50); // clamped to the schema max
    expect(opts.subject).toBe('Edward');
  });

  it('store_memory turns an ApiError into an isError result preserving the code', async () => {
    vi.mocked(ingestCore).mockRejectedValue(new ApiError('model_not_configured', 'no model', 422));

    const resp = await callTool('store_memory', { text: 'remember this' });
    const result = resp.json().result;
    expect(result.isError).toBe(true);
    expect(toolText(resp).error.code).toBe('model_not_configured');
  });

  it('store_document delegates to the core', async () => {
    const canned = {
      document_id: 3,
      namespace: 'default',
      embedding_model: 'm',
      extractor: 'llm',
      chunk_count: 1,
      edges: [],
    };
    vi.mocked(documentsCore).mockResolvedValue(canned);

    const resp = await callTool('store_document', { title: 'T', text: 'body', subjects: ['Edward'] });
    expect(toolText(resp).document_id).toBe(3);
    const opts = vi.mocked(documentsCore).mock.calls[0]![1];
    expect(opts.subjects).toEqual(['Edward']);
    expect(opts.providedEdges).toBeNull();
  });

  it('explore_subject with an ambiguous name is an isError result', async () => {
    const candidates = [
      { id: 1, name: 'Oracle Database 21c', type: 'software' },
      { id: 2, name: 'Oracle Cloud', type: 'software' },
    ];
    vi.mocked(dbOne).mockResolvedValue(null);
    vi.mocked(dbMany).mockResolvedValue(candidates);

    const resp = await callTool('explore_subject', { subject: 'Oracle' });
    const result = resp.json().result;
    expect(result.isError).toBe(true);
    const err = toolText(resp).error;
    expect(err.code).toBe('ambiguous_subject');
    expect(err.message).toContain('Oracle Cloud');
  });

  it('explore_subject returns neighbors at depth 1', async () => {
    const subjectRow = { id: 5, name: 'Edward', type: 'person' };
    const neighbors = [
      {
        neighbor_kind: 'subject',
        neighbor_id: 9,
        rel: 'perform',
        edge_store: 'svo',
        confidence: null,
        provenance: 'suggested',
        label: 'upgrade',
      },
    ];
    vi.mocked(dbOne).mockResolvedValue({ ...subjectRow });
    vi.mocked(dbTxCore).mockResolvedValue(neighbors);

    const resp = await callTool('explore_subject', { subject: 'Edward' });
    const payload = toolText(resp);
    expect(payload.subject.name).toBe('Edward');
    expect(payload.neighbors[0].neighbor_id).toBe(9);
  });

  it('explore_subject rejects a bad direction with -32602', async () => {
    vi.mocked(dbOne).mockResolvedValue({ id: 1, name: 'E', type: 'person' });

    const resp = await callTool('explore_subject', { subject: '1', direction: 'sideways' });
    expect(resp.json().error.code).toBe(-32602);
  });

  it('get_skill by name not found is an isError result', async () => {
    vi.mocked(dbOne).mockResolvedValue(null);

    const resp = await callTool('get_skill', { name: 'no-such-skill' });
    expect(toolText(resp).error.code).toBe('not_found');
    expect(resp.json().result.isError).toBe(true);
  });
});
