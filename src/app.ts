/**
 * The Fastify application. Restrained on purpose (brief §3): Fastify is the HTTP transport and a
 * mechanical route-mapping layer, nothing more. The cross-cutting behaviour here mirrors the PHP
 * `config/response.php` edge: a tolerant JSON body parser, the stable error envelope with
 * PostgreSQL-SQLSTATE mapping, a 405-aware not-found handler, and one api.log line per request.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { registerRoutes } from './http/route-map.js';
import { ApiError } from './http/errors.js';
import { sendError } from './http/response.js';
import { mapError } from './db/errors.js';
import { apiLog } from './logging/api-log.js';
import type { RequestCtx } from './types/db.js';

/** Default max JSON body size (memory ingest can be large; multipart has its own limit). */
const BODY_LIMIT = 25 * 1024 * 1024;

interface RoutePattern {
  raw: string;
  re: RegExp;
  methods: Set<string>;
}

/** Turn a Fastify route pattern (`/v1/subjects/:id`) into an anchored matcher for 405 detection. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return '[^/]+';
      if (seg === '*') return '.*';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${escaped}$`);
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT });

  // Tolerant JSON parser: empty body → {} (like PHP `body_json`); invalid JSON → 400 body_invalid_json.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const s = body as string;
      if (s === '' || s == null) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(s));
      } catch {
        done(new ApiError('body_invalid_json', 'Request body is not valid JSON.', 400));
      }
    },
  );

  // Track which methods each URL pattern supports, so an unknown method on a known URL is a
  // 405 (with an Allow header) rather than Fastify's default 404.
  const patterns: RoutePattern[] = [];
  app.addHook('onRoute', (route) => {
    if (!route.url) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    let entry = patterns.find((p) => p.raw === route.url);
    if (!entry) {
      entry = { raw: route.url, re: patternToRegExp(route.url), methods: new Set() };
      patterns.push(entry);
    }
    for (const m of methods) entry.methods.add(m);
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const match = patterns.find((p) => p.re.test(path));
    if (match) {
      const allow = [...match.methods].filter((m) => m !== 'HEAD' && m !== 'OPTIONS').sort();
      reply.header('Allow', allow.join(', '));
      sendError(reply, 'method_not_allowed', `This endpoint supports ${allow.join(', ')}.`, 405);
    } else {
      sendError(reply, 'not_found', 'Resource not found.', 404);
    }
  });

  app.setErrorHandler((err, _request, reply) => {
    const { status, code, message } = mapError(err);
    if (status >= 500) {
      (reply as FastifyReply & { apiErrorStack?: string }).apiErrorStack = (err as Error).stack ?? '';
    }
    sendError(reply, code, message, status);
  });

  // One api.log line per request (brief §11).
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = (request as FastifyRequest & { ctx?: RequestCtx }).ctx;
    const r = reply as FastifyReply & { apiErrorCode?: string; apiErrorStack?: string };
    apiLog({
      method: request.method,
      path: request.url,
      status: reply.statusCode,
      durMs: reply.elapsedTime,
      user: ctx?.userId ?? 'anon',
      tokenPrefix: ctx?.tokenPrefix ?? null,
      errorCode: r.apiErrorCode ?? null,
      stack: reply.statusCode >= 500 ? r.apiErrorStack ?? null : null,
    });
  });

  // Routes registered last so the onRoute hook has captured the method map for every URL.
  app.register(registerRoutes);

  return app;
}
