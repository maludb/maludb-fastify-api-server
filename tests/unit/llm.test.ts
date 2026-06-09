import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  memEmbedDeterministic,
  memEmbedDim,
  memEmbed,
  memChunk,
  llmJsonFromText,
  llmComplete,
} from '../../src/memory/llm.js';
import { memVectorLiteral } from '../../src/memory/memory-db.js';

afterEach(() => vi.restoreAllMocks());

describe('memEmbedDeterministic', () => {
  it('is deterministic, correct length, and L2-normalized', () => {
    const a = memEmbedDeterministic('hello world');
    const b = memEmbedDeterministic('hello world');
    expect(a).toEqual(b);
    expect(a).toHaveLength(memEmbedDim());
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
  it('differs for different text', () => {
    expect(memEmbedDeterministic('a')).not.toEqual(memEmbedDeterministic('b'));
  });
  it('memEmbed falls back to the deterministic vector with no creds', async () => {
    const v = await memEmbed('round-trip me');
    expect(v).toEqual(memEmbedDeterministic('round-trip me'));
  });
});

describe('memChunk', () => {
  it('returns the whole text when short', () => {
    expect(memChunk('short')).toEqual(['short']);
  });
  it('splits long text into overlapping chunks at boundaries', () => {
    const text = ('para one. ' + 'x'.repeat(50) + '\n\n' + 'para two. ' + 'y'.repeat(50)).repeat(40);
    const chunks = memChunk(text, 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });
});

describe('llmJsonFromText', () => {
  it('parses raw, fenced, and embedded JSON', () => {
    expect(llmJsonFromText('{"a":1}')).toEqual({ a: 1 });
    expect(llmJsonFromText('```json\n{"b":2}\n```')).toEqual({ b: 2 });
    expect(llmJsonFromText('noise {"c":3} trailing')).toEqual({ c: 3 });
    expect(llmJsonFromText('no json here')).toBeNull();
  });
});

describe('memVectorLiteral', () => {
  it('formats floats trimming trailing zeros', () => {
    expect(memVectorLiteral([0.1, -0.2, 0])).toBe('[0.1,-0.2,0]');
  });
});

describe('llmComplete', () => {
  it('shapes an OpenAI chat request and returns content', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }),
    );
    const out = await llmComplete(
      { api_format: 'openai', base_url: 'https://api.x/v1', token: 't', model_identifier: 'm' },
      'sys',
      'usr',
    );
    expect(out).toBe('hi');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.x/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('shapes an Anthropic messages request (system top-level)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'yo' }] }), { status: 200 }),
    );
    const out = await llmComplete(
      { api_format: 'anthropic', base_url: 'https://api.anthropic.com', token: 'k', model_identifier: 'claude' },
      'sys',
      'usr',
    );
    expect(out).toBe('yo');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.system).toBe('sys');
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'k' });
  });
});
