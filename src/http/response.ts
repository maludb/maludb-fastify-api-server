/**
 * Success responses (brief §13). Endpoint payloads are endpoint-specific but always JSON. When the
 * request asked for `?debug=1` and the server enabled it (`ctx.debug`), the executed-SQL trace is
 * attached as `meta.debug` (brief §12) — mirrors the PHP `json_response()`.
 */
import type { FastifyReply } from 'fastify';
import type { RequestCtx } from '../types/db.js';

/** Send a JSON payload with an optional status. Pass `ctx` to enable the `?debug=1` SQL trace. */
export function jsonResponse(
  reply: FastifyReply,
  data: unknown,
  status = 200,
  ctx?: RequestCtx,
): void {
  if (ctx?.debug && data !== null && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const meta = (d.meta as Record<string, unknown> | undefined) ?? {};
    meta.debug = { file: ctx.endpointFile, queries: ctx.sqlTrace };
    d.meta = meta;
  }
  reply.code(status).header('content-type', 'application/json; charset=utf-8').send(data);
}

/**
 * Send the stable error envelope `{ error: { code, message } }`. Records the code on the reply so
 * the api.log hook can include it. Used by the Fastify error / not-found handlers.
 */
export function sendError(reply: FastifyReply, code: string, message: string, status: number): void {
  (reply as FastifyReply & { apiErrorCode?: string }).apiErrorCode = code;
  reply
    .code(status)
    .header('content-type', 'application/json; charset=utf-8')
    .send({ error: { code, message } });
}
