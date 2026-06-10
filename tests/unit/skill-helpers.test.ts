import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import {
  bundleHash,
  coerceSkillExtraction,
  deterministicDiscovery,
  fileSha256,
  materialityScreens,
  type SkillFileRef,
} from '../../src/skills/helpers.js';

function f(path: string, content: Buffer | string): SkillFileRef {
  return { relative_path: path, file_hash: fileSha256(content) };
}

describe('bundleHash', () => {
  it('is order independent', () => {
    const a = [f('SKILL.md', 'x'), f('scripts/run.py', 'y')];
    const b = [f('scripts/run.py', 'y'), f('SKILL.md', 'x')];
    expect(bundleHash(a)).toBe(bundleHash(b));
  });

  it('changes when a script is edited', () => {
    const base = [f('SKILL.md', 'same'), f('scripts/run.py', 'v1')];
    const edited = [f('SKILL.md', 'same'), f('scripts/run.py', 'v2')];
    expect(bundleHash(base)).not.toBe(bundleHash(edited));
  });

  it('is sha256 hex', () => {
    const h = bundleHash([f('SKILL.md', 'x')]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the canonical line format (cross-implementation check)', () => {
    // Must match the Python/Rust implementations: sha256 of "<sha256('hello')>  SKILL.md\n"
    const content = 'hello';
    const fh = createHash('sha256').update(content).digest('hex');
    const expected = createHash('sha256').update(`${fh}  SKILL.md\n`, 'utf8').digest('hex');
    expect(bundleHash([f('SKILL.md', content)])).toBe(expected);
  });
});

describe('materialityScreens', () => {
  const PARENT = {
    markdown: '# Skill\nDo the thing carefully.',
    frontmatter_jsonb: { description: 'Does the thing. Use when thinging.' },
    files: [
      { relative_path: 'SKILL.md', file_hash: 'aaa' },
      { relative_path: 'scripts/run.py', file_hash: 'bbb' },
    ],
  };
  const NEW_FILES = [
    { relative_path: 'SKILL.md', file_hash: 'ccc' },
    { relative_path: 'scripts/run.py', file_hash: 'bbb' },
  ];

  it('description change is material', () => {
    const r = materialityScreens(
      PARENT,
      PARENT.markdown,
      { description: 'Does a different thing.' },
      NEW_FILES,
    );
    expect(r.verdict).toBe('material');
    expect(r.reasons).toContain('frontmatter:description');
  });

  it('allowed-tools change is material', () => {
    const fm = { ...PARENT.frontmatter_jsonb, 'allowed-tools': 'Bash(git:*)' };
    const r = materialityScreens(PARENT, PARENT.markdown, fm, NEW_FILES);
    expect(r.verdict).toBe('material');
    expect(r.reasons).toContain('frontmatter:allowed-tools');
  });

  it('script change is material', () => {
    const files = [
      { relative_path: 'SKILL.md', file_hash: 'aaa' },
      { relative_path: 'scripts/run.py', file_hash: 'EDITED' },
    ];
    const r = materialityScreens(PARENT, PARENT.markdown, PARENT.frontmatter_jsonb, files);
    expect(r.verdict).toBe('material');
    expect(r.reasons).toContain('file:scripts/run.py');
  });

  it('file added is material', () => {
    const files = [...NEW_FILES, { relative_path: 'assets/template.txt', file_hash: 'ddd' }];
    const r = materialityScreens(PARENT, PARENT.markdown, PARENT.frontmatter_jsonb, files);
    expect(r.verdict).toBe('material');
    expect(r.reasons).toContain('file:assets/template.txt');
  });

  it('whitespace-only SKILL.md change is non_material', () => {
    const r = materialityScreens(
      PARENT,
      '# Skill\n\n  Do the thing   carefully.\n',
      PARENT.frontmatter_jsonb,
      NEW_FILES,
    );
    expect(r.verdict).toBe('non_material');
  });

  it('body text change is gray', () => {
    const r = materialityScreens(
      PARENT,
      '# Skill\nDo the thing very carefully and twice.',
      PARENT.frontmatter_jsonb,
      NEW_FILES,
    );
    expect(r.verdict).toBe('gray');
  });

  it('a SKILL.md hash diff alone is not a file reason', () => {
    // SKILL.md content is judged by text, not by its manifest hash.
    const r = materialityScreens(PARENT, PARENT.markdown, PARENT.frontmatter_jsonb, NEW_FILES);
    expect(r.verdict).toBe('non_material');
  });

  it('accepts parent frontmatter_jsonb as a JSON string', () => {
    const parent = {
      ...PARENT,
      frontmatter_jsonb: '{"description": "Does the thing. Use when thinging."}',
    };
    const r = materialityScreens(parent, PARENT.markdown, { description: 'Other.' }, NEW_FILES);
    expect(r.verdict).toBe('material');
  });
});

describe('deterministicDiscovery', () => {
  it('keywords from name tokens and description content words', () => {
    const d = deterministicDiscovery('pdf-processing', {
      description: 'Extract text from PDF files. Use when working with PDFs.',
    });
    expect(d.keywords).toContain('pdf');
    expect(d.keywords).toContain('processing');
    expect(d.keywords).toContain('extract');
    expect(d.subjects).toEqual([{ name: 'pdf-processing' }]);
    expect(d.verbs).toEqual([]);
  });

  it('excludes stopwords', () => {
    const d = deterministicDiscovery('the-helper', {
      description: 'Use this when you are with it.',
    });
    expect(d.keywords).not.toContain('the');
    expect(d.keywords).not.toContain('when');
  });
});

describe('coerceSkillExtraction', () => {
  it('injects the skill subject and the agent_skill document', () => {
    const out = coerceSkillExtraction({}, 'pdf-processing', '# body', { description: 'D.' });
    const doc = out.document as Record<string, unknown>;
    expect(doc.document_type).toBe('agent_skill');
    expect(doc.content_text).toBe('# body');
    const subjects = out.subjects as Record<string, unknown>[];
    expect(subjects[0]?.name).toBe('pdf-processing');
    expect(subjects[0]?.type).toBe('skill');
  });

  it('retypes an existing skill subject (case-insensitive name match)', () => {
    const out = coerceSkillExtraction(
      { subjects: [{ key: 's1', name: 'PDF-Processing', type: 'software' }] },
      'pdf-processing',
      '# body',
      {},
    );
    const subjects = out.subjects as Record<string, unknown>[];
    expect(subjects).toHaveLength(1);
    expect(subjects[0]?.type).toBe('skill');
  });

  it('preserves the keywords key', () => {
    const out = coerceSkillExtraction({ keywords: ['pdf'] }, 'x', '# b', {});
    expect(out.keywords).toEqual(['pdf']);
  });
});

describe('skill route registration', () => {
  // The new URLs must resolve to route handlers: an unregistered URL answers 404 not_found,
  // a registered one reaches requireAuth and answers 401 auth_missing.
  it('POST /v1/skills/ingest is registered (401 without a token, not 404)', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/skills/ingest', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'auth_missing' } });
    await app.close();
  });

  it('GET /v1/skills/:id/bundle is registered (401 without a token, not 404)', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/skills/1/bundle' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'auth_missing' } });
    await app.close();
  });
});
