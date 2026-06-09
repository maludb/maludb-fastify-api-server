import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { runCli } from '../../src/cli.js';
import { configDbPath } from '../../src/config/paths.js';

describe('runCli', () => {
  it('init creates the config DB', async () => {
    expect(await runCli(['init'])).toBe(0);
    expect(existsSync(configDbPath())).toBe(true);
  });

  it('migrate is idempotent', async () => {
    expect(await runCli(['migrate'])).toBe(0);
    expect(await runCli(['migrate'])).toBe(0);
  });

  it('help returns 0', async () => {
    expect(await runCli(['help'])).toBe(0);
    expect(await runCli([])).toBe(0);
  });

  it('unknown command returns 1', async () => {
    expect(await runCli(['bogus'])).toBe(1);
  });
});
