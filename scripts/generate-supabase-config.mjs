// THE PROGRAM OS — generate saas-ui/supabase-config.js at deploy time.
//
// Netlify build step (see netlify.toml). Reads the two PUBLIC values
// from the environment — THE_PROGRAM_SUPABASE_URL and
// THE_PROGRAM_SUPABASE_ANON_KEY — and writes them as
// window.THE_PROGRAM_SUPABASE_URL / window.THE_PROGRAM_SUPABASE_ANON_KEY,
// the shape saas-ui/supabase-auth.js reads.
//
// The anon key is a PUBLIC/publishable key by Supabase design — it
// ships in browser code — but it still lives in config, never
// hardcoded in source and never committed: saas-ui/supabase-config.js
// is gitignored. The service_role key is NEVER stored here, in the
// environment, or anywhere in the browser.
//
// Fails loudly (non-zero exit) when either value is missing or
// malformed, so a misconfigured deploy fails the build instead of
// publishing a site that reports "Production sign-in is not
// configured".
//
// Usage: node scripts/generate-supabase-config.mjs [output-path]
// Default output: <repo-root>/saas-ui/supabase-config.js
// No dependencies — node builtins only.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(repoRoot, 'saas-ui', 'supabase-config.js');

function fail(message) {
  console.error(`generate-supabase-config: ${message}`);
  process.exit(1);
}

const url = (process.env.THE_PROGRAM_SUPABASE_URL || '').trim();
const anonKey = (process.env.THE_PROGRAM_SUPABASE_ANON_KEY || '').trim();

if (!url) fail('THE_PROGRAM_SUPABASE_URL is not set.');
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) {
  fail('THE_PROGRAM_SUPABASE_URL must be https://<project-ref>.supabase.co');
}
if (!anonKey) fail('THE_PROGRAM_SUPABASE_ANON_KEY is not set.');
if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(anonKey)) {
  fail('THE_PROGRAM_SUPABASE_ANON_KEY does not look like a JWT (three dot-separated segments).');
}

const normalizedUrl = url.replace(/\/$/, '');
const content = `/* THE PROGRAM OS — Supabase client config.
 * Generated at deploy time by scripts/generate-supabase-config.mjs
 * from the Netlify environment variables THE_PROGRAM_SUPABASE_URL
 * and THE_PROGRAM_SUPABASE_ANON_KEY. This file is gitignored and
 * never committed. The anon key is a PUBLIC/publishable key by
 * Supabase design — it ships in browser code. The service_role key
 * is NEVER stored here or anywhere in the browser.
 */
window.THE_PROGRAM_SUPABASE_URL = '${normalizedUrl}';
window.THE_PROGRAM_SUPABASE_ANON_KEY = '${anonKey}';
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, content);
console.log(`generate-supabase-config: wrote ${outPath}`);
