import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { redactParams } from '../../src/logging/redact.js';
import { formatSqlLine, sqlLog } from '../../src/logging/sql-log.js';
import { apiLog } from '../../src/logging/api-log.js';
import { sqlLogPath, apiLogPath } from '../../src/config/paths.js';
import type { RequestCtx } from '../../src/types/db.js';

function fakeCtx(): RequestCtx {
  return {
    userId: 7,
    role: 'executor',
    tokenPrefix: 'abc12345',
    tenant: { dbname: 'd', user: 'u', password: 'p' },
    pool: {} as RequestCtx['pool'],
    sqlTrace: [],
    endpointFile: 'subjects.ts',
    method: 'GET',
    path: '/v1/subjects',
    debug: false,
  };
}

describe('redactParams', () => {
  it('replaces 1-based positions with <redacted>', () => {
    expect(redactParams(['a', 'b', 'c'], [2])).toEqual(['a', '<redacted>', 'c']);
  });
  it('ignores out-of-range positions', () => {
    expect(redactParams(['a'], [5])).toEqual(['a']);
  });
});

describe('formatSqlLine', () => {
  it('renders the multi-line block with indented SQL', () => {
    const line = formatSqlLine({
      time: '2026-06-08T00:00:00.000Z',
      file: 'subjects.ts',
      method: 'GET',
      path: '/v1/subjects',
      user: '7',
      sql: 'SELECT 1\nFROM t',
      params: [1],
      rows: 1,
      durMs: 2.34,
    });
    expect(line).toContain('subjects.ts  GET  /v1/subjects  user=7');
    expect(line).toContain('SQL: SELECT 1\n       FROM t');
    expect(line).toContain('PARAMS: [1]');
    expect(line).toContain('ROWS: 1');
    expect(line).toContain('DUR:  2.3 ms');
  });
});

describe('sqlLog', () => {
  it('pushes onto ctx.sqlTrace and appends to sql.log', () => {
    const ctx = fakeCtx();
    sqlLog(ctx, 'SELECT 42 AS n', [42], 1, 1.5);
    expect(ctx.sqlTrace).toHaveLength(1);
    expect(ctx.sqlTrace[0]).toMatchObject({ sql: 'SELECT 42 AS n', rows: 1 });
    const log = readFileSync(sqlLogPath(), 'utf8');
    expect(log).toContain('SELECT 42 AS n');
  });

  it('logs redacted params when provided', () => {
    const ctx = fakeCtx();
    sqlLog(ctx, 'INSERT secret', ['tok'], 1, 0.2, ['<redacted>']);
    expect(ctx.sqlTrace[0]?.params).toEqual(['<redacted>']);
    const log = readFileSync(sqlLogPath(), 'utf8');
    expect(log).not.toContain('"tok"');
  });
});

describe('apiLog', () => {
  it('writes one line with method/path/status/user', () => {
    apiLog({ method: 'GET', path: '/v1/health', status: 200, durMs: 1.2, user: 'anon' });
    const log = readFileSync(apiLogPath(), 'utf8');
    expect(log).toContain('GET  /v1/health  200');
    expect(log).toContain('user=anon');
  });
});
