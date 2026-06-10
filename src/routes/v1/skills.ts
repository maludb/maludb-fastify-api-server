/**
 * GET  /v1/skills
 * POST /v1/skills
 *
 * MaluDB concept: Skills (requirements.md §4.8).
 * SQL objects: maludb_skill (direct-INSERT view; skill_id from sequence),
 *              maludb_skill_search (function; ?subject= / ?verb= tag search, 0.97.0).
 * Teaches:
 *   - Live-schema mapping: skill_id -> id, skill_name -> name; the skill body lives in `markdown`.
 *   - GET supports an optional visibility filter and q search; with ?subject= or ?verb= the
 *     listing switches to tag-aware discovery through maludb_skill_search (0.97.0), which folds
 *     in visible public skills, scoring, match_reasons, and fork lineage.
 *   - POST defaults: version '1.0.0', visibility 'private', enabled true (DB-side defaults).
 *     DB enforces visibility ∈ {private,shared,public} and packaging_kind ∈
 *     {system_prompt,markdown,mcp_tool,plugin} (→ 422).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr, bodyObject } from '../../http/request.js';

const FILE = 'skills.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/skills',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      if (request.method === 'GET') {
        const visibility = queryStr(request, 'visibility', null, 40);
        const q = queryStr(request, 'q', null, 200);
        const subject = queryStr(request, 'subject', null, 200);
        const verb = queryStr(request, 'verb', null, 200);
        const limit = queryInt(request, 'limit', 50, 200) ?? 50;

        // Tag-aware discovery: subject/verb hit the skill_subject/skill_verb tag tables (and q
        // the keyword/tsquery rails) through maludb_skill_search, which also folds in visible
        // public skills, scoring, and lineage. The plain list keeps the ILIKE semantics.
        if ((subject !== null && subject !== '') || (verb !== null && verb !== '')) {
          const rows = await dbMany(
            ctx,
            `SELECT owner_schema, skill_id AS id, skill_name AS name, description,
                    version, visibility, subjects, verbs, keywords, score,
                    match_reasons, is_public, is_forkable,
                    source_owner_schema, source_skill_id, updated_at
               FROM maludb_skill_search($1, $2, $3, NULL, $4)`,
            [q, subject, verb, limit],
          );
          for (const r of rows) {
            r.id = Number(r.id);
            r.score = r.score === null ? null : Number(r.score);
            if (r.source_skill_id !== null) {
              r.source_skill_id = Number(r.source_skill_id);
            }
          }
          jsonResponse(reply, { skills: rows }, 200, ctx);
          return;
        }

        const clauses: string[] = [];
        const params: unknown[] = [];
        if (visibility !== null && visibility !== '') {
          params.push(visibility);
          clauses.push(`visibility = $${params.length}`);
        }
        if (q !== null && q !== '') {
          params.push(`%${q}%`);
          clauses.push(`(skill_name ILIKE $${params.length} OR description ILIKE $${params.length})`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = params.length;

        const sql = `
          SELECT skill_id AS id, skill_name AS name, description, version,
                 visibility, packaging_kind, enabled, created_at
            FROM maludb_skill
            ${where}
           ORDER BY skill_name
           LIMIT $${limitIdx}`;

        const rows = await dbMany(ctx, sql, params);
        for (const r of rows) {
          r.id = Number(r.id);
          r.enabled = r.enabled === null ? null : Boolean(r.enabled);
        }

        jsonResponse(reply, { skills: rows }, 200, ctx);
        return;
      }

      // POST
      const body = bodyObject(request);
      const name = String(body.name ?? '').trim();
      if (name === '') {
        jsonError('missing_field', 'Field "name" is required.', 400);
      }

      const cols: string[] = ['skill_name'];
      const params: unknown[] = [name];
      const ph: string[] = ['$1'];
      for (const f of ['description', 'markdown', 'version', 'visibility', 'packaging_kind']) {
        if (body[f] !== undefined) {
          cols.push(f);
          params.push(String(body[f]));
          ph.push(`$${params.length}`);
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
        cols.push('enabled');
        params.push(body.enabled ? 'true' : 'false');
        ph.push(`$${params.length}`);
      }

      const created = await dbOne(
        ctx,
        `INSERT INTO maludb_skill (${cols.join(', ')})
         VALUES (${ph.join(', ')})
         RETURNING skill_id AS id, skill_name AS name, description, markdown, version,
                   visibility, packaging_kind, enabled, created_at`,
        params,
      );
      if (created === null) jsonError('internal_error', 'Skill creation returned no row.', 500);
      created.id = Number(created.id);
      created.enabled = created.enabled === null ? null : Boolean(created.enabled);

      jsonResponse(reply, { skill: created }, 201, ctx);
    },
  });
}
