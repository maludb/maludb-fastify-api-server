/**
 * POST /v1/skills/ingest
 *
 * MaluDB concept: Agent-skill bundle ingest (maludb_core 0.97.0).
 * SQL objects: maludb_skill, maludb_source_package, maludb_core.malu$skill_package,
 *              maludb_core.malu$skill_file, maludb_subject_type (catalog),
 *              maludb_memory_ingest_extraction (function), maludb_skill_register (function).
 * tx: yes — one db_tx_core() transaction wraps graph ingest + bundle storage + registration.
 * Teaches:
 *   - A Claude Agent Skill bundle (SKILL.md + scripts/references/assets) becomes an IMMUTABLE
 *     skill version identified by its canonical bundle hash (sorted "<sha256>  <path>\n" lines);
 *     a re-push of the same bundle is idempotent (200 reused:true).
 *   - Materiality decides supersede-vs-coexist: caller override > deterministic screens
 *     (frontmatter capability keys / non-SKILL.md file diffs material; whitespace-only
 *     non-material) > LLM judge for the gray zone (body text changed, defaults to material).
 *   - Discovery tags (subjects/verbs/keywords) come from the configured LLM (skill-extract
 *     prompt + live type catalog) or a deterministic frontmatter-only fallback; the SKILL.md is
 *     ingested as an agent_skill document and the skill itself as a type='skill' subject.
 *   - Bundle files are content-hash-deduped maludb_source_package rows ('skill_file').
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { bodyObject } from '../../http/request.js';
import { llmComplete, llmJsonFromText } from '../../memory/llm.js';
import { renderTypeCatalog } from '../../memory/type-catalog.js';
import { modelPrompt } from '../../local-db/local-db.js';
import {
  bundleHash,
  coerceSkillExtraction,
  deterministicDiscovery,
  fileSha256,
  materialityScreens,
  type SkillFileRef,
} from '../../skills/helpers.js';
import type { ModelPromptRow } from '../../types/auth.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'skills_ingest.ts';

// Bundle size caps (the Anthropic API caps skill uploads at 30 MB zipped; we cap the unpacked
// JSON payload in the same spirit).
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 30 * 1024 * 1024;

/** One decoded bundle file (content + manifest fields). */
interface DecodedFile extends SkillFileRef {
  relative_path: string;
  content: Buffer;
  file_hash: string;
  file_size: number;
  is_executable: boolean;
  media_type: string | null;
}

/** Strict base64 (mirrors Python's base64.b64decode(validate=True)): charset + padding. */
function decodeBase64Strict(s: string): Buffer | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  return Buffer.from(s, 'base64');
}

/**
 * Decode the request's files[] into {relative_path, content(Buffer), ...}.
 *
 * Accepts content_base64 (binary-safe) or content_text per file. SKILL.md is synthesized from
 * the markdown when the client didn't include it, so the manifest always describes the
 * complete, reconstructable bundle.
 */
function decodeFiles(body: Record<string, unknown>, markdown: string): DecodedFile[] {
  const raw = body.files ?? [];
  if (!Array.isArray(raw)) {
    jsonError('validation_failed', 'Field "files" must be an array.', 422);
  }

  const files: DecodedFile[] = [];
  let total = 0;
  const seenPaths = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      jsonError('validation_failed', `files[${i}] must be an object.`, 422);
    }
    const fo = f as Record<string, unknown>;
    const rel = String(fo.relative_path ?? '').trim();
    if (rel === '' || rel.startsWith('/') || rel.split('/').includes('..')) {
      jsonError('validation_failed', `files[${i}].relative_path is missing or unsafe.`, 422);
    }
    if (seenPaths.has(rel)) {
      jsonError('validation_failed', `files[${i}]: duplicate relative_path '${rel}'.`, 422);
    }
    seenPaths.add(rel);

    let content: Buffer;
    if (fo.content_base64 !== undefined && fo.content_base64 !== null) {
      const decoded = decodeBase64Strict(String(fo.content_base64));
      if (decoded === null) {
        jsonError('validation_failed', `files[${i}].content_base64 is not valid base64.`, 422);
      }
      content = decoded;
    } else if (fo.content_text !== undefined && fo.content_text !== null) {
      content = Buffer.from(String(fo.content_text), 'utf8');
    } else {
      jsonError('validation_failed', `files[${i}] needs content_base64 or content_text.`, 422);
    }

    if (content.length > MAX_FILE_BYTES) {
      jsonError('payload_too_large', `files[${i}] (${rel}) exceeds ${MAX_FILE_BYTES} bytes.`, 413);
    }
    total += content.length;
    if (total > MAX_BUNDLE_BYTES) {
      jsonError('payload_too_large', `Bundle exceeds ${MAX_BUNDLE_BYTES} bytes.`, 413);
    }

    const mediaRaw = fo.media_type;
    const media =
      mediaRaw !== undefined && mediaRaw !== null && mediaRaw !== '' && mediaRaw !== false
        ? String(mediaRaw).trim() || null
        : null;
    files.push({
      relative_path: rel,
      content,
      file_hash: fileSha256(content),
      file_size: content.length,
      is_executable: Boolean(fo.is_executable),
      media_type: media,
    });
  }

  if (!seenPaths.has('SKILL.md')) {
    const content = Buffer.from(markdown, 'utf8');
    files.unshift({
      relative_path: 'SKILL.md',
      content,
      file_hash: fileSha256(content),
      file_size: content.length,
      is_executable: false,
      media_type: 'text/markdown',
    });
  }
  return files;
}

/**
 * LLM judge for the gray zone: SKILL.md body changed, nothing else did.
 *
 * Returns true (materially different → coexist) unless the model clearly answers otherwise;
 * a judge failure must never hide a version wrongly.
 */
async function judgeMateriality(
  pr: ModelPromptRow,
  parentMarkdown: string,
  newMarkdown: string,
  name: string,
): Promise<boolean> {
  const system =
    'You compare two versions of an AI agent skill (its SKILL.md instructions) and decide' +
    ' whether the revision MATERIALLY changes what the skill does: different capabilities,' +
    ' different behavior, different instructions an agent would follow. Typo fixes, rewording' +
    ' with identical meaning, and formatting changes are NOT material.' +
    ' Respond with exactly one JSON object: {"materially_different": true|false}.';
  const user = `SKILL: ${name}\n\n=== PARENT VERSION ===\n${parentMarkdown}\n\n=== NEW VERSION ===\n${newMarkdown}\n`;
  const cfg = {
    api_format: pr.api_format ?? 'openai',
    base_url: pr.base_url ?? '',
    model_identifier: pr.model_identifier,
    token: pr.api_key,
    max_tokens: 64,
    generation_params:
      pr.generation_params !== null && pr.generation_params !== ''
        ? (JSON.parse(pr.generation_params) as Record<string, unknown>)
        : {},
  };
  let verdict: Record<string, unknown> | null;
  try {
    verdict = llmJsonFromText(await llmComplete(cfg, system, user));
  } catch {
    return true;
  }
  if (verdict !== null && typeof verdict.materially_different === 'boolean') {
    return verdict.materially_different;
  }
  return true;
}

/** The materiality block returned to the client (verdict + reasons + final decision). */
interface Materiality {
  verdict: string;
  reasons: string[];
  materially_different?: boolean;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['POST'],
    url: '/v1/skills/ingest',
    handler: async (request, reply) => {
      const ctx: RequestCtx = await requireAuth(request, FILE);
      const body = bodyObject(request);

      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const markdown = String(body.markdown ?? '');
      if (name === '') {
        jsonError('missing_field', 'Field "name" is required.', 400);
      }
      if (markdown.trim() === '') {
        jsonError('missing_field', 'Field "markdown" (the SKILL.md text) is required.', 400);
      }

      const frontmatter =
        body.frontmatter !== null && typeof body.frontmatter === 'object' && !Array.isArray(body.frontmatter)
          ? (body.frontmatter as Record<string, unknown>)
          : {};
      const model =
        body.model !== undefined && body.model !== null && String(body.model).trim() !== ''
          ? String(body.model).trim()
          : null;
      const preview = Boolean(body.preview);

      const files = decodeFiles(body, markdown);
      const computedHash = bundleHash(files);

      // maludb_skill_register arrived in 0.97.0 (with the bundle schema).
      const hasRegister = await dbOne(
        ctx,
        "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'maludb_skill_register') AS ok",
      );
      if (hasRegister === null || !hasRegister.ok) {
        jsonError(
          'ingest_unavailable',
          'maludb_skill_register is not available (requires maludb_core 0.97.0;' +
            " re-run enable_memory_schema('<tenant>') after upgrading).",
          501,
        );
      }

      // Idempotent re-push: same name + bundle → the existing version, no LLM.
      const existing = await dbOne(
        ctx,
        'SELECT skill_id AS id, version FROM maludb_skill WHERE skill_name = $1 AND bundle_hash = $2',
        [name, computedHash],
      );
      if (existing !== null && !preview) {
        jsonResponse(
          reply,
          {
            skill_id: Number(existing.id),
            version: existing.version,
            bundle_hash: computedHash,
            reused: true,
          },
          200,
          ctx,
        );
        return;
      }

      // Parent: explicit {owner_schema, skill_id}, else the newest enabled same-name skill in
      // the tenant's own schema (the re-upload case).
      let parentSchema: string | null = null;
      let parentId: number | null = null;
      let parentNote: string | null = null;
      const parentBody = body.parent;
      if (
        parentBody !== null &&
        typeof parentBody === 'object' &&
        !Array.isArray(parentBody) &&
        (parentBody as Record<string, unknown>).skill_id !== undefined &&
        (parentBody as Record<string, unknown>).skill_id !== null
      ) {
        const pb = parentBody as Record<string, unknown>;
        parentSchema = String(pb.owner_schema ?? '').trim() || null;
        parentId = Number(pb.skill_id);
        if (parentSchema === null) {
          jsonError(
            'validation_failed',
            'Field "parent.owner_schema" is required with parent.skill_id.',
            422,
          );
        }
      } else {
        const auto = await dbOne(
          ctx,
          `SELECT skill_id AS id, owner_schema FROM maludb_skill
            WHERE skill_name = $1 AND enabled ORDER BY skill_id DESC LIMIT 1`,
          [name],
        );
        if (auto !== null) {
          parentSchema = auto.owner_schema;
          parentId = Number(auto.id);
          parentNote = 'auto_detected_same_name';
        }
      }

      // Materiality: explicit override > deterministic screens > LLM judge.
      let materiality: Materiality = { verdict: 'material', reasons: ['no_parent'] };
      let materiallyDifferent = true;
      if (parentId !== null) {
        const parentRow = await dbOne(
          ctx,
          // single-quoted on purpose: the `$` in malu$skill_* must not be parsed as a variable
          'SELECT s.markdown, s.frontmatter_jsonb,' +
            "       COALESCE((SELECT jsonb_agg(jsonb_build_object(" +
            "                     'relative_path', f.relative_path," +
            "                     'file_hash', f.file_hash))" +
            '                   FROM maludb_core.malu$skill_file f' +
            '                  WHERE f.owner_schema = s.owner_schema' +
            "                    AND f.skill_id = s.skill_id), '[]'::jsonb) AS files" +
            '  FROM maludb_core.malu$skill_package s' +
            ' WHERE s.owner_schema = $1 AND s.skill_id = $2',
          [parentSchema, parentId],
        );
        if (parentRow === null) {
          jsonError('not_found', 'Parent skill not found.', 404);
        }
        let parentFiles = parentRow.files;
        if (typeof parentFiles === 'string') parentFiles = JSON.parse(parentFiles);
        materiality = materialityScreens(
          {
            markdown: parentRow.markdown,
            frontmatter_jsonb: parentRow.frontmatter_jsonb,
            files: parentFiles as SkillFileRef[],
          },
          markdown,
          frontmatter,
          files,
        );
        if (typeof body.materially_different === 'boolean') {
          materiallyDifferent = body.materially_different;
          materiality.reasons.push('caller_override');
        } else if (materiality.verdict === 'material') {
          materiallyDifferent = true;
        } else if (materiality.verdict === 'non_material') {
          materiallyDifferent = false;
        } else {
          // gray zone
          const prJudge = model !== null ? modelPrompt(model) : null;
          if (prJudge !== null && prJudge.api_key !== null && prJudge.api_key !== '') {
            materiallyDifferent = await judgeMateriality(
              prJudge,
              String(parentRow.markdown ?? ''),
              markdown,
              name,
            );
            materiality.reasons.push('llm_judged');
          } else {
            materiallyDifferent = true;
            materiality.reasons.push('gray_zone_default_material');
          }
        }
        materiality.materially_different = materiallyDifferent;
      }

      // Discovery extraction: LLM when a model is configured, else the deterministic
      // frontmatter-only fallback.
      let extraction: Record<string, unknown>;
      if (model !== null) {
        const pr = modelPrompt(model);
        if (pr === null) {
          jsonError(
            'model_not_configured',
            'No prompt configured for model "' + model + '". Set one via POST /v1/model-prompts.',
            422,
          );
        }
        const catalog = await renderTypeCatalog(ctx);
        const system = String(pr.system_prompt ?? '')
          .replace(/\{\{ENTITY_TYPES\}\}/g, catalog.entityBlock)
          .replace(/\{\{EVENT_KINDS\}\}/g, catalog.eventBlock);
        const userMsg =
          `SKILL_NAME: ${name}\n\nFRONTMATTER:\n${JSON.stringify(frontmatter)}\n\n` +
          `SKILL_MD:\n${markdown}\n`;
        if (preview) {
          jsonResponse(
            reply,
            {
              model,
              system_prompt: system,
              user_message: userMsg,
              bundle_hash: computedHash,
              materiality,
              parent: { owner_schema: parentSchema, skill_id: parentId, note: parentNote },
            },
            200,
            ctx,
          );
          return;
        }
        if (pr.api_key === null || pr.api_key === '') {
          jsonError('model_api_key_missing', 'No API key set for model "' + model + '".', 409);
        }
        const cfg = {
          api_format: pr.api_format ?? 'openai',
          base_url: pr.base_url ?? '',
          model_identifier:
            pr.model_identifier !== null && pr.model_identifier !== '' ? pr.model_identifier : model,
          token: pr.api_key,
          max_tokens: Number(pr.max_tokens ?? 2048),
          generation_params:
            pr.generation_params !== null && pr.generation_params !== ''
              ? (JSON.parse(pr.generation_params) as Record<string, unknown>)
              : {},
        };
        const raw = llmJsonFromText(await llmComplete(cfg, system, userMsg));
        if (raw === null) {
          jsonError('upstream_error', 'LLM output was not a JSON object.', 502);
        }
        extraction = coerceSkillExtraction(raw, name, markdown, frontmatter);
      } else {
        const discovery = deterministicDiscovery(name, frontmatter);
        extraction = coerceSkillExtraction(
          { subjects: [], verbs: [], edges: [], keywords: discovery.keywords },
          name,
          markdown,
          frontmatter,
        );
        if (preview) {
          jsonResponse(
            reply,
            {
              model: null,
              extraction,
              bundle_hash: computedHash,
              materiality,
              parent: { owner_schema: parentSchema, skill_id: parentId, note: parentNote },
            },
            200,
            ctx,
          );
          return;
        }
      }

      const fmMetadata =
        frontmatter.metadata !== null &&
        typeof frontmatter.metadata === 'object' &&
        !Array.isArray(frontmatter.metadata)
          ? (frontmatter.metadata as Record<string, unknown>)
          : null;
      const version =
        body.version !== undefined && body.version !== null && String(body.version).trim() !== ''
          ? String(body.version).trim()
          : fmMetadata !== null
            ? String(fmMetadata.version ?? '').trim() || null
            : null;
      const description = String(frontmatter.description ?? '').trim() || null;

      // One transaction: graph ingest, bundle storage, skill registration.
      const result = await dbTxCore(ctx, async () => {
        const ingestRow = await dbOne(
          ctx,
          `SELECT maludb_memory_ingest_extraction(
                      p_extraction => $1::jsonb, p_source_kind => 'document',
                      p_source_id => NULL, p_provenance => 'suggested') AS result`,
          [JSON.stringify(extraction)],
        );
        let report = ingestRow!.result;
        if (typeof report === 'string') report = JSON.parse(report);

        // subject names → graph ids, via the report's key→id map
        const ids: Record<string, unknown> =
          report !== null && typeof report === 'object' && report.ids !== null && typeof report.ids === 'object'
            ? (report.ids as Record<string, unknown>)
            : {};
        const subjectsParam: Record<string, unknown>[] = [];
        const exSubjects = Array.isArray(extraction.subjects) ? extraction.subjects : [];
        for (const s of exSubjects as Record<string, unknown>[]) {
          const entry: Record<string, unknown> = { name: s.name };
          const key = s.key;
          if (key !== undefined && key !== null && String(key) in ids) {
            entry.id = ids[String(key)];
          }
          subjectsParam.push(entry);
        }
        const exVerbs = Array.isArray(extraction.verbs) ? extraction.verbs : [];
        const verbsParam = (exVerbs as Record<string, unknown>[])
          .filter((v) => v.name !== undefined && v.name !== null && v.name !== '')
          .map((v) => ({ name: v.name }));
        const exKeywords = Array.isArray(extraction.keywords) ? extraction.keywords : [];
        const keywords = exKeywords.map((k) => String(k)).filter((k) => k.trim() !== '');

        // Bundle files: content-hash-deduped source packages in the tenant schema.
        const filesParam: Record<string, unknown>[] = [];
        for (const f of files) {
          let sp = await dbOne(
            ctx,
            `SELECT source_package_id FROM maludb_source_package
              WHERE content_hash = $1 AND source_type = 'skill_file'
              ORDER BY source_package_id LIMIT 1`,
            [f.file_hash],
          );
          if (sp === null) {
            sp = await dbOne(
              ctx,
              `INSERT INTO maludb_source_package
                   (source_type, content_bytes, media_type, content_size, content_hash, ingested_at)
               VALUES ('skill_file', $1, $2, $3, $4, now())
               RETURNING source_package_id`,
              [f.content, f.media_type, f.file_size, f.file_hash],
            );
          }
          filesParam.push({
            relative_path: f.relative_path,
            source_package_id: Number(sp!.source_package_id),
            file_hash: f.file_hash,
            file_size: f.file_size,
            is_executable: f.is_executable,
            media_type: f.media_type,
          });
        }

        const regRow = await dbOne(
          ctx,
          `SELECT maludb_skill_register(
                      p_skill_name => $1, p_markdown => $2, p_bundle_hash => $3,
                      p_description => $4, p_frontmatter => $5::jsonb, p_version => $6,
                      p_keywords => $7, p_subjects => $8::jsonb, p_verbs => $9::jsonb,
                      p_files => $10::jsonb, p_parent_owner_schema => $11,
                      p_parent_skill_id => $12, p_materially_different => $13) AS result`,
          [
            name,
            markdown,
            computedHash,
            description,
            JSON.stringify(frontmatter),
            version,
            keywords.length > 0 ? keywords : null, // node-pg adapts string[] → text[]
            JSON.stringify(subjectsParam),
            JSON.stringify(verbsParam),
            JSON.stringify(filesParam),
            parentSchema,
            parentId,
            materiallyDifferent,
          ],
        );
        let registerResult = regRow!.result;
        if (typeof registerResult === 'string') registerResult = JSON.parse(registerResult);
        return { ingest: report, register: registerResult };
      });

      jsonResponse(
        reply,
        {
          skill_id: result.register?.skill_id ?? null,
          version: result.register?.version ?? null,
          bundle_hash: computedHash,
          reused: Boolean(result.register?.reused),
          model,
          parent: { owner_schema: parentSchema, skill_id: parentId, note: parentNote },
          materiality,
          register: result.register,
          ingest: result.ingest,
        },
        201,
        ctx,
      );
    },
  });
}
