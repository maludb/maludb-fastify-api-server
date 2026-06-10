/**
 * GET /v1/skills/:id/bundle
 *
 * MaluDB concept: Skill pull — the full agent-skill bundle for client-side reconstruction
 * (maludb_core 0.97.0).
 * SQL objects: maludb_skill, maludb_skill_file, maludb_source_package.
 * tx: no
 * Teaches:
 *   - The bundle manifest (maludb_skill_file) joins to content-hash-deduped
 *     maludb_source_package rows; content is returned base64-encoded with per-file hashes and
 *     executable bits so the client can rebuild the directory byte-for-byte and verify it
 *     against bundle_hash.
 *   - Older (pre-bundle) markdown-only skills still pull as a synthesized one-file SKILL.md
 *     bundle.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId } from '../../http/request.js';
import { fileSha256 } from '../../skills/helpers.js';

const FILE = 'skills_id_bundle.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET'],
    url: '/v1/skills/:id/bundle',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      const skill = await dbOne(
        ctx,
        `SELECT skill_id AS id, skill_name AS name, description, markdown, version,
                visibility, enabled, bundle_hash, frontmatter_jsonb,
                source_owner_schema, source_skill_id, created_at
           FROM maludb_skill WHERE skill_id = $1`,
        [id],
      );
      if (skill === null) {
        jsonError('not_found', 'Skill not found.', 404);
      }
      skill.id = Number(skill.id);
      if (skill.source_skill_id !== null) {
        skill.source_skill_id = Number(skill.source_skill_id);
      }
      skill.enabled = skill.enabled === null ? null : Boolean(skill.enabled);

      const rows = await dbMany(
        ctx,
        `SELECT f.relative_path, f.file_hash, f.file_size, f.is_executable,
                f.media_type, sp.content_bytes, sp.content_text
           FROM maludb_skill_file f
           JOIN maludb_source_package sp ON sp.source_package_id = f.source_package_id
          WHERE f.skill_id = $1
          ORDER BY f.relative_path`,
        [id],
      );
      const files: Record<string, unknown>[] = [];
      for (const r of rows) {
        const content: Buffer =
          r.content_bytes !== null
            ? Buffer.from(r.content_bytes)
            : Buffer.from(String(r.content_text ?? ''), 'utf8');
        files.push({
          relative_path: r.relative_path,
          file_hash: r.file_hash,
          file_size: Number(r.file_size),
          is_executable: Boolean(r.is_executable),
          media_type: r.media_type,
          content_base64: content.toString('base64'),
        });
      }

      // Older (pre-bundle) markdown skills still pull as a one-file bundle.
      if (files.length === 0 && skill.markdown !== null && skill.markdown !== '') {
        const content = Buffer.from(String(skill.markdown), 'utf8');
        files.push({
          relative_path: 'SKILL.md',
          file_hash: fileSha256(content),
          file_size: content.length,
          is_executable: false,
          media_type: 'text/markdown',
          content_base64: content.toString('base64'),
        });
      }

      jsonResponse(reply, { skill, files }, 200, ctx);
    },
  });
}
