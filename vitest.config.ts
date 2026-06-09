import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Integration tests that need a live MaluDB Postgres skip themselves unless
    // MALUDB_TEST_PG is set (see tests/integration/*). The unit suite needs nothing.
  },
});
