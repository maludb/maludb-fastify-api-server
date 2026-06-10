/**
 * GET    /v1/skills/:id
 * PATCH  /v1/skills/:id
 * DELETE /v1/skills/:id
 *
 * MaluDB concept: Skill detail (requirements.md §4.8).
 * SQL objects: maludb_skill.
 * Teaches:
 *   - Live-schema mapping: skill_id -> id, skill_name -> name.
 *   - DB enforces visibility/packaging_kind value sets (→ 422).
 *   - Registered agent skills (bundle_hash set, 0.97.0) are content-immutable: PATCH on
 *     name/markdown/version/packaging_kind → 409 skill_content_immutable; re-upload the bundle
 *     via POST /v1/skills/ingest instead.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne, dbExec } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'skills_id.ts';

// Content columns rejected on PATCH once a skill carries a bundle_hash (agent-skill ingest,
// maludb_core 0.97.0): the registered bundle is immutable; lifecycle fields stay editable.
const IMMUTABLE_FIELDS = ['name', 'markdown', 'version', 'packaging_kind'];

/** Fetch a skill by id, or null. */
async function loadSkill(ctx: RequestCtx, id: number): Promise<Record<string, unknown> | null> {
  const skill = await dbOne(
    ctx,
    `SELECT skill_id AS id, skill_name AS name, description, markdown, version,
            visibility, packaging_kind, enabled, created_at, updated_at
       FROM maludb_skill
      WHERE skill_id = $1`,
    [id],
  );
  if (skill === null) {
    return null;
  }
  skill.id = Number(skill.id);
  skill.enabled = skill.enabled === null ? null : Boolean(skill.enabled);
  return skill;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH', 'DELETE'],
    url: '/v1/skills/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const skill = await loadSkill(ctx, id);
          if (skill === null) {
            jsonError('not_found', 'Skill not found.', 404);
          }
          jsonResponse(reply, { skill }, 200, ctx);
          return;
        }

        case 'PATCH': {
          const row = await dbOne(ctx, 'SELECT bundle_hash FROM maludb_skill WHERE skill_id = $1', [
            id,
          ]);
          if (row === null) {
            jsonError('not_found', 'Skill not found.', 404);
          }

          const body = bodyObject(request);

          // Registered agent skills (bundle_hash set) are content-immutable (a DB trigger
          // enforces this too); a changed bundle must be re-ingested as a new skill version.
          if (row.bundle_hash !== null && row.bundle_hash !== undefined && row.bundle_hash !== '') {
            const blocked = IMMUTABLE_FIELDS.filter((f) =>
              Object.prototype.hasOwnProperty.call(body, f),
            );
            if (blocked.length > 0) {
              jsonError(
                'skill_content_immutable',
                'Fields ' +
                  blocked.join(', ') +
                  ' are immutable on a registered agent skill; re-upload the changed bundle' +
                  ' via POST /v1/skills/ingest (it becomes a new version with fork lineage).' +
                  ' Editable here: description, visibility, enabled.',
                409,
              );
            }
          }
          const fields: string[] = [];
          const params: unknown[] = [];

          if (Object.prototype.hasOwnProperty.call(body, 'name')) {
            const name = String(body.name ?? '').trim();
            if (name === '') {
              jsonError('validation_failed', 'Field "name" cannot be empty.', 422);
            }
            params.push(name);
            fields.push(`skill_name = $${params.length}`);
          }
          for (const f of ['description', 'markdown', 'version', 'visibility', 'packaging_kind']) {
            if (Object.prototype.hasOwnProperty.call(body, f)) {
              params.push(body[f] === null ? null : String(body[f]));
              fields.push(`${f} = $${params.length}`);
            }
          }
          if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
            params.push(body.enabled ? 'true' : 'false');
            fields.push(`enabled = $${params.length}`);
          }
          if (fields.length === 0) {
            jsonError(
              'bad_request',
              'No updatable fields provided (name, description, version, visibility, packaging_kind, enabled).',
              400,
            );
          }

          fields.push('updated_at = now()');
          params.push(id);
          await dbExec(
            ctx,
            `UPDATE maludb_skill SET ${fields.join(', ')} WHERE skill_id = $${params.length}`,
            params,
          );

          jsonResponse(reply, { skill: await loadSkill(ctx, id) }, 200, ctx);
          return;
        }

        case 'DELETE': {
          const n = await dbExec(ctx, 'DELETE FROM maludb_skill WHERE skill_id = $1', [id]);
          if (n === 0) {
            jsonError('not_found', 'Skill not found.', 404);
          }
          jsonResponse(reply, { deleted: true, id }, 200, ctx);
          return;
        }
      }
    },
  });
}
