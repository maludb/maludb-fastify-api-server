import { describe, it, expect } from 'vitest';
import { shapeStatement } from '../../src/db/statements.js';
import { shapeAttribute } from '../../src/db/attributes.js';
import { documentLinkSpec } from '../../src/db/documents.js';
import { isNumeric, toNumOrNull, jsonOrDefault } from '../../src/db/coerce.js';

describe('coerce', () => {
  it('toNumOrNull turns numeric strings into numbers, keeps null', () => {
    expect(toNumOrNull('42')).toBe(42);
    expect(toNumOrNull(null)).toBeNull();
    expect(toNumOrNull(undefined)).toBeNull();
  });
  it('isNumeric matches PHP is_numeric', () => {
    expect(isNumeric(1.5)).toBe(true);
    expect(isNumeric('0.9')).toBe(true);
    expect(isNumeric('abc')).toBe(false);
    expect(isNumeric(null)).toBe(false);
  });
  it('jsonOrDefault stringifies objects, falls back otherwise', () => {
    expect(jsonOrDefault({ a: 1 })).toBe('{"a":1}');
    expect(jsonOrDefault(null)).toBe('{}');
  });
});

describe('shapeStatement', () => {
  it('coerces bigint/numeric strings (as node-pg returns them) to numbers', () => {
    const r = {
      id: '5',
      subject_id: '10',
      verb_id: '3',
      object_id: '20',
      predicate_id: null,
      source_package_id: null,
      confidence: '0.80',
      metadata: { k: 'v' },
    };
    shapeStatement(r);
    expect(r).toMatchObject({ id: 5, subject_id: 10, verb_id: 3, object_id: 20, confidence: 0.8 });
    expect(r.predicate_id).toBeNull();
    expect(r.metadata).toEqual({ k: 'v' });
  });
});

describe('shapeAttribute', () => {
  it('coerces id/target_id and value_numeric/confidence', () => {
    const r = {
      id: '7',
      target_id: '99',
      value_numeric: '3.14',
      confidence: null,
      value_jsonb: { a: 1 },
      metadata: undefined,
    };
    shapeAttribute(r);
    expect(r).toMatchObject({ id: 7, target_id: 99, value_numeric: 3.14 });
    expect(r.confidence).toBeNull();
    expect(r.metadata).toBeNull();
  });
});

describe('documentLinkSpec', () => {
  it('maps the three subject-like kinds', () => {
    expect(documentLinkSpec('project')).toEqual(['project', 'concerns']);
    expect(documentLinkSpec('subject')).toEqual(['concept', 'mentions']);
    expect(documentLinkSpec('stakeholder')).toEqual(['person', 'involves']);
    expect(documentLinkSpec('bogus')).toBeNull();
  });
});
