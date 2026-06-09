import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { pathId, pathSubId, queryInt, queryStr, bodyObject } from '../../src/http/request.js';
import { ApiError, jsonError } from '../../src/http/errors.js';

function req(parts: Partial<Record<'params' | 'query' | 'body', unknown>>): FastifyRequest {
  return parts as unknown as FastifyRequest;
}

describe('jsonError', () => {
  it('throws an ApiError carrying code + status', () => {
    try {
      jsonError('missing_field', 'nope', 400);
      throw new Error('should not reach');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe('missing_field');
      expect((e as ApiError).status).toBe(400);
    }
  });
});

describe('pathId / pathSubId', () => {
  it('parses numeric ids', () => {
    expect(pathId(req({ params: { id: '17' } }))).toBe(17);
    expect(pathSubId(req({ params: { sub_id: '42' } }))).toBe(42);
  });
  it('rejects non-numeric ids with 400', () => {
    expect(() => pathId(req({ params: { id: 'x' } }))).toThrow(ApiError);
  });
});

describe('queryInt', () => {
  it('returns default when absent', () => {
    expect(queryInt(req({ query: {} }), 'limit', 50)).toBe(50);
  });
  it('clamps to max', () => {
    expect(queryInt(req({ query: { limit: '500' } }), 'limit', 50, 200)).toBe(200);
  });
  it('rejects non-integers with 400', () => {
    expect(() => queryInt(req({ query: { limit: 'abc' } }), 'limit')).toThrow(ApiError);
  });
});

describe('queryStr', () => {
  it('returns default when absent', () => {
    expect(queryStr(req({ query: {} }), 'q', null)).toBeNull();
  });
  it('truncates to maxLen', () => {
    expect(queryStr(req({ query: { q: 'abcdef' } }), 'q', null, 3)).toBe('abc');
  });
});

describe('bodyObject', () => {
  it('returns {} for empty body', () => {
    expect(bodyObject(req({}))).toEqual({});
  });
  it('returns the parsed object', () => {
    expect(bodyObject(req({ body: { a: 1 } }))).toEqual({ a: 1 });
  });
  it('rejects arrays with 400', () => {
    expect(() => bodyObject(req({ body: [1, 2] }))).toThrow(ApiError);
  });
});
