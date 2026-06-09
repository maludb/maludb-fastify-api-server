/**
 * Path, query, and body parsing (mirrors the PHP `path_id`, `query_int`, `query_str`, `body_json`).
 * Fastify has already parsed `:id`/`:sub_id` path params, the query string, and the JSON body; these
 * helpers add the same validation and defaults the PHP endpoints relied on.
 */
import type { FastifyRequest } from 'fastify';
import { jsonError } from './errors.js';

function params(request: FastifyRequest): Record<string, string> {
  return (request.params ?? {}) as Record<string, string>;
}

function query(request: FastifyRequest): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

/** Required numeric `:id` path segment → int (400 `bad_request` otherwise). */
export function pathId(request: FastifyRequest): number {
  const v = params(request).id;
  if (v === undefined || !/^\d+$/.test(String(v))) {
    jsonError('bad_request', 'Missing or non-numeric path id.', 400);
  }
  return Number.parseInt(String(v), 10);
}

/** Required numeric `:sub_id` path segment → int (400 `bad_request` otherwise). */
export function pathSubId(request: FastifyRequest, name = 'sub_id'): number {
  const v = params(request)[name];
  if (v === undefined || !/^\d+$/.test(String(v))) {
    jsonError('bad_request', `Missing or non-numeric path ${name}.`, 400);
  }
  return Number.parseInt(String(v), 10);
}

/** A non-numeric path segment (e.g. `objects/:kind`). Required → 400 if absent. */
export function pathStr(request: FastifyRequest, name: string): string {
  const v = params(request)[name];
  if (v === undefined || v === '') {
    jsonError('bad_request', `Missing path ${name}.`, 400);
  }
  return String(v);
}

/** Optional integer query param, clamped to `max` (400 if present and non-numeric). */
export function queryInt(
  request: FastifyRequest,
  name: string,
  def: number | null = null,
  max: number | null = null,
): number | null {
  const raw = query(request)[name];
  if (raw === undefined || raw === '') return def;
  const s = String(raw);
  if (!/^\d+$/.test(s)) {
    jsonError('bad_request', `Query param '${name}' must be an integer.`, 400);
  }
  let v = Number.parseInt(s, 10);
  if (max !== null && v > max) v = max;
  return v;
}

/** Optional string query param, truncated to `maxLen`. */
export function queryStr(
  request: FastifyRequest,
  name: string,
  def: string | null = null,
  maxLen = 200,
): string | null {
  const raw = query(request)[name];
  if (raw === undefined) return def;
  const s = String(raw);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * The parsed JSON body as a plain object (mirrors PHP `body_json`). Empty body → `{}`. A JSON array
 * or scalar → 400 `bad_request`. Invalid JSON is rejected earlier by the content-type parser
 * (400 `body_invalid_json`).
 */
export function bodyObject(request: FastifyRequest): Record<string, unknown> {
  const b = request.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) {
    jsonError('bad_request', 'Request body must be a JSON object.', 400);
  }
  return b as Record<string, unknown>;
}
