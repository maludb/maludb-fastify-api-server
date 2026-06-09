/**
 * GET /v1/health
 *
 * MaluDB concept: none — this is the one endpoint with no auth and no SQL.
 * SQL objects: none.
 * Teaches: the entry point of the learning path; confirms the server is up and speaking JSON.
 *
 * (No PHP source file — the PHP health/diag lived outside `/v1/`. Added fresh for the TS server.)
 */
import type { FastifyInstance } from 'fastify';
import { jsonResponse } from '../../http/response.js';

const VERSION = '0.1.0';

export async function register(app: FastifyInstance): Promise<void> {
  app.get('/v1/health', async (_request, reply) => {
    jsonResponse(reply, {
      status: 'ok',
      name: 'maludb-api-server',
      version: VERSION,
      time: new Date().toISOString(),
    });
  });
}
