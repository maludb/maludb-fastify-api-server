/**
 * GET /v1/subject-types  (requirements.md §4.3)
 *
 * MaluDB concept: the registered subject types (feeds the "Type" dropdown). Read-only.
 * SQL objects: maludb_subject_type.
 * Teaches:
 *   - subject_type is constrained to this registry — these are the only values
 *     maludb_subject.subject_type accepts (a DB trigger rejects others).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';

const FILE = 'subject-types.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET'],
    url: '/v1/subject-types',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      const rows = await dbMany(
        ctx,
        `SELECT subject_type AS type,
                display_name,
                description,
                sort_order
           FROM maludb_subject_type
          ORDER BY sort_order, subject_type`,
      );
      for (const r of rows) {
        r.sort_order = r.sort_order === null ? null : Number(r.sort_order);
      }

      jsonResponse(reply, { subject_types: rows }, 200, ctx);
    },
  });
}
