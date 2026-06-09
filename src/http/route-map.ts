/**
 * Route registration — the mechanical replacement for the PHP `.htaccess` URL→file rewrite rules
 * (brief §16). This is a flat, obvious list: one `register()` import per route file, called once.
 * It is the only place the full endpoint surface is enumerated; keep it boring and explicit so the
 * URL→file relationship stays a two-click lookup. New endpoints are added here as they are ported.
 */
import type { FastifyInstance } from 'fastify';

import { register as health } from '../routes/v1/health.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await health(app);
}
