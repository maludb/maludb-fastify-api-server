/**
 * Agent-skill ingest helpers (maludb_core 0.97.0) — port of the Python reference
 * `app/helpers/skills.py`.
 *
 * A Claude Agent Skill is a directory bundle: SKILL.md (YAML frontmatter + markdown body) plus
 * optional scripts/, references/, assets/. The terminal parses the frontmatter and uploads the
 * bundle; this module owns the parts the server is responsible for:
 *
 *   - the canonical bundle hash (identity of a skill version)
 *   - the deterministic materiality screens (does a revision supersede its parent or coexist?)
 *   - extraction of discovery subjects/verbs/keywords — via the configured LLM when a model is
 *     given, or a deterministic fallback that needs no credentials (the "stub extractor" path).
 *
 * Pure functions only: no DB, no HTTP, no Fastify — unit-testable in isolation.
 */
import { createHash } from 'node:crypto';

/** One bundle file as carried through the ingest pipeline (hash + manifest fields). */
export interface SkillFileRef {
  relative_path: string;
  file_hash: string;
  [key: string]: unknown;
}

/** The deterministic materiality verdict for a revision vs. its parent. */
export interface MaterialityResult {
  verdict: 'material' | 'non_material' | 'gray';
  reasons: string[];
}

/** The parent skill row (markdown + frontmatter) plus its file manifest. */
export interface ParentSkill {
  markdown?: string | null;
  frontmatter_jsonb?: unknown;
  files?: SkillFileRef[] | null;
}

// Frontmatter keys whose change always makes a revision materially different: they alter what
// the skill does or is allowed to do.
const MATERIAL_FRONTMATTER_KEYS = [
  'description',
  'when_to_use',
  'allowed-tools',
  'disallowed-tools',
  'compatibility',
] as const;

/* ------------------------- canonical bundle hash ------------------------- */

/** sha256 hex of a file's content. */
export function fileSha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * sha256 over the sorted per-file hashes.
 *
 * Canonical line format: `"<file sha256>  <relative_path>\n"` (two spaces), sorted by line.
 * A script edit changes the bundle hash even when SKILL.md is untouched. The terminal computes
 * the same value client-side; the server's recomputation is authoritative.
 */
export function bundleHash(files: SkillFileRef[]): string {
  const lines = files.map((f) => `${f.file_hash}  ${f.relative_path}\n`).sort();
  return createHash('sha256').update(lines.join(''), 'utf8').digest('hex');
}

/* -------------------------- materiality screens -------------------------- */

function normalizeWs(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic comparison of a revision against its parent skill row.
 *
 *   material      — capability surface changed (description / tool policy / any non-SKILL.md
 *                   file): versions must coexist.
 *   non_material  — bundles differ only in SKILL.md whitespace: supersede.
 *   gray          — SKILL.md body text changed but nothing else did; a judgment call (LLM judge
 *                   when available, else treated as material so nothing is hidden wrongly).
 *
 * `parent` carries the maludb_skill row (markdown, frontmatter_jsonb) plus a `files` list of
 * {relative_path, file_hash} from malu$skill_file.
 */
export function materialityScreens(
  parent: ParentSkill,
  newMarkdown: string,
  newFrontmatter: Record<string, unknown> | null | undefined,
  newFiles: SkillFileRef[] | null | undefined,
): MaterialityResult {
  const reasons: string[] = [];

  let oldFm: Record<string, unknown> = {};
  const rawFm = parent.frontmatter_jsonb;
  if (typeof rawFm === 'string') {
    try {
      const parsed = JSON.parse(rawFm);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        oldFm = parsed as Record<string, unknown>;
      }
    } catch {
      oldFm = {};
    }
  } else if (rawFm !== null && typeof rawFm === 'object' && !Array.isArray(rawFm)) {
    oldFm = rawFm as Record<string, unknown>;
  }

  const fm = newFrontmatter ?? {};
  for (const key of MATERIAL_FRONTMATTER_KEYS) {
    const oldVal = oldFm[key] ?? null;
    const newVal = fm[key] ?? null;
    // Falsy values ('' / 0 / false) collapse to null, mirroring Python's `x or None`.
    const norm = (v: unknown): unknown => (v ? v : null);
    if (JSON.stringify(norm(oldVal)) !== JSON.stringify(norm(newVal))) {
      reasons.push(`frontmatter:${key}`);
    }
  }

  const oldFiles = new Map<string, string>();
  for (const f of parent.files ?? []) {
    if (f.relative_path !== 'SKILL.md') oldFiles.set(f.relative_path, f.file_hash);
  }
  const newFilesMap = new Map<string, string>();
  for (const f of newFiles ?? []) {
    if (f.relative_path !== 'SKILL.md') newFilesMap.set(f.relative_path, f.file_hash);
  }
  const allPaths = [...new Set([...oldFiles.keys(), ...newFilesMap.keys()])].sort();
  for (const path of allPaths) {
    if (oldFiles.get(path) !== newFilesMap.get(path)) {
      reasons.push(`file:${path}`);
    }
  }

  if (reasons.length > 0) {
    return { verdict: 'material', reasons };
  }

  if (normalizeWs(parent.markdown ?? '') === normalizeWs(newMarkdown)) {
    return { verdict: 'non_material', reasons: ['skill_md_whitespace_only'] };
  }

  return { verdict: 'gray', reasons: ['skill_md_body_changed'] };
}

/* -------------------- deterministic (no-LLM) discovery ------------------- */

const STOPWORDS = new Set(
  ('a an and are as at be by for from in into is it of on or the this to use ' +
    'used uses using when with you your').split(' '),
);

/** The deterministic discovery output: keywords + the skill-self subject, no guessed verbs. */
export interface DiscoveryResult {
  keywords: string[];
  subjects: { name: string }[];
  verbs: { name: string }[];
}

/**
 * Frontmatter-only discovery tags — the credential-free fallback.
 *
 * The skill name and the description's content words become keywords; the skill itself is the
 * only subject. No verbs are guessed: a wrong verb tag poisons verb search, while keywords
 * degrade gracefully.
 */
export function deterministicDiscovery(
  name: string,
  frontmatter: Record<string, unknown> | null | undefined,
): DiscoveryResult {
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const token of name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token !== '' && !STOPWORDS.has(token) && !seen.has(token)) {
      seen.add(token);
      keywords.push(token);
    }
  }
  const description = String((frontmatter ?? {}).description ?? '');
  for (const token of description.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length > 2 && !STOPWORDS.has(token) && !seen.has(token)) {
      seen.add(token);
      keywords.push(token);
    }
  }
  return {
    keywords: keywords.slice(0, 24),
    subjects: [{ name }],
    verbs: [],
  };
}

/* ------------------- skill extraction JSON post-processing ---------------- */

/**
 * Make an LLM extraction safe for the one-call ingest.
 *
 * Guarantees the document section (SKILL.md as an agent_skill document) and a subject of type
 * 'skill' carrying the skill's own name, whatever the model produced. The model's "keywords"
 * key is left in place: ingest ignores unknown sections and the register step reads it.
 */
export function coerceSkillExtraction(
  extraction: Record<string, unknown> | null | undefined,
  name: string,
  markdown: string,
  frontmatter: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(extraction ?? {}) };
  out.document = {
    title: name,
    content_text: markdown,
    source_type: 'document',
    document_type: 'agent_skill',
    metadata: { frontmatter: frontmatter ?? {} },
  };

  const rawSubjects = Array.isArray(out.subjects) ? out.subjects : [];
  const subjects = rawSubjects.filter(
    (s): s is Record<string, unknown> => s !== null && typeof s === 'object' && !Array.isArray(s),
  );
  let skillKey: unknown = null;
  for (const s of subjects) {
    if (String(s.name ?? '').trim().toLowerCase() === name.trim().toLowerCase()) {
      s.type = 'skill';
      skillKey = s.key ?? null;
      break;
    }
  }
  if (skillKey === null || skillKey === undefined) {
    const description = String((frontmatter ?? {}).description ?? '');
    subjects.unshift({
      key: 'skill_self',
      name,
      type: 'skill',
      description: description !== '' ? description : null,
    });
  }
  out.subjects = subjects;
  return out;
}
