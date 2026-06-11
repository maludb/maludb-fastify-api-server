// Copy non-TS runtime assets into dist/ after `tsc`. The local-db schema is kept as a
// readable .sql file (not embedded as a string), so it must be copied next to the compiled
// local-db.js, which resolves it relative to its own location. The seeded LLM prompt files
// (config/prompts/) are copied to dist/config/prompts so the catalog seeder finds them from
// the compiled tree (see promptsDir() in src/config/paths.ts).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const assets = [
  ['src/local-db/schema.sql', 'dist/local-db/schema.sql'],
  ['config/prompts', 'dist/config/prompts'],
];

for (const [from, to] of assets) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
