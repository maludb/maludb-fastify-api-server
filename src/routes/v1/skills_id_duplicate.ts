/**
 * POST /v1/skills/:id/duplicate
 *
 * MaluDB concept: Duplicate (fork) a skill (requirements.md §4.8).
 * SQL objects: maludb_skill, maludb_skill_fork(source_owner_schema, source_skill_id,
 *              new_skill_name, new_version) facade.
 * Teaches:
 *   - Forking is gated by the DB (only published/forkable skills); a non-forkable source raises a
 *     precondition error which is surfaced as 422 validation_failed (not a 500).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pgErrorMessage } from '../../db/errors.js';
import { pathId, bodyObject } from '../../http/request.js';

const FILE = 'skills_id_duplicate.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST'],
    url: '/v1/skills/:id/duplicate',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      const src = await dbOne(
        ctx,
        `SELECT skill_id, skill_name, COALESCE(owner_schema, current_schema()) AS owner_schema
           FROM maludb_skill WHERE skill_id = $1`,
        [id],
      );
      if (src === null) {
        jsonError('not_found', 'Skill not found.', 404);
      }

      const body = bodyObject(request);
      const newName =
        body.name !== undefined && String(body.name).trim() !== '' ? String(body.name) : null;
      const newVersion =
        body.version !== undefined && String(body.version).trim() !== ''
          ? String(body.version)
          : '1.0.0';

      let row: Record<string, unknown> | null;
      try {
        row = await dbOne(
          ctx,
          'SELECT maludb_skill_fork($1, $2, $3, $4) AS id',
          [src.owner_schema, id, newName, newVersion],
        );
      } catch (e) {
        // e.g. "source skill … is not forkable" — a precondition, not a server error.
        jsonError('validation_failed', pgErrorMessage((e as Error).message ?? ''), 422);
      }

      const newId = Number(row!.id);
      const skill = await dbOne(
        ctx,
        `SELECT skill_id AS id, skill_name AS name, description, version,
                visibility, packaging_kind, enabled, source_skill_id, created_at
           FROM maludb_skill WHERE skill_id = $1`,
        [newId],
      );
      if (skill === null) jsonError('internal_error', 'Forked skill not found.', 500);
      skill.id = Number(skill.id);
      skill.source_skill_id = skill.source_skill_id === null ? null : Number(skill.source_skill_id);
      skill.enabled = skill.enabled === null ? null : Boolean(skill.enabled);

      jsonResponse(reply, { skill }, 201, ctx);
    },
  });
}
