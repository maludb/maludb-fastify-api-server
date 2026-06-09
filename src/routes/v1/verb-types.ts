/**
 * GET /v1/verb-types
 *
 * MaluDB concept: Registered verb types (requirements.md §4.3) — feeds the
 * "Type" dropdown. Read-only.
 * SQL objects: maludb_verb_type.
 * Teaches:
 *   - These are the only values maludb_verb.verb_type accepts (the DB trigger
 *     rejects others).
 *   - sort_order is nullable; it is coerced to a number only when present.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';

const FILE = 'verb-types.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET'],
    url: '/v1/verb-types',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const rows = await dbMany(
        ctx,
        `SELECT verb_type AS type,
                display_name,
                semantic_class,
                description,
                sort_order
           FROM maludb_verb_type
          ORDER BY sort_order, verb_type`,
      );
      for (const r of rows) {
        r.sort_order = r.sort_order === null ? null : Number(r.sort_order);
      }

      jsonResponse(reply, { verb_types: rows }, 200, ctx);
    },
  });
}
