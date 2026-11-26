/* Netlify deploy-time Supabase config generation (Option B, 2026-11-26).
 * Run: node --test server/tests/netlify-supabase-config.test.js
 *
 * Covers scripts/generate-supabase-config.mjs with FAKE values only —
 * the real anon key is never in this repo or this test. The script
 * must write the two window assignments, and must fail loudly when a
 * value is missing or malformed, so a misconfigured deploy fails the
 * build instead of publishing an unconfigured site. Also guards the
 * wiring itself: netlify.toml must run the generator, and .gitignore
 * must still ignore the generated file.
 */
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const script = path.join(repoRoot, 'scripts', 'generate-supabase-config.mjs');
const FAKE_URL = 'https://testref1234567890.supabase.co';
const FAKE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlc3RyZWYxMjM0NTY3ODkwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5MjE3ODEsImV4cCI6MjEwNzQ5Nzc4MX0.dGVzdC1zaWduYXR1cmU';

function run(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tpo-config-'));
  const out = path.join(tmp, 'supabase-config.js');
  const res = spawnSync(process.execPath, [script, out], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { res, out, tmp };
}

function cleanup(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

test('writes both window assignments from env', () => {
  const { res, out, tmp } = run({
    THE_PROGRAM_SUPABASE_URL: FAKE_URL,
    THE_PROGRAM_SUPABASE_ANON_KEY: FAKE_KEY,
  });
  try {
    assert.equal(res.status, 0, res.stderr);
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes(`window.THE_PROGRAM_SUPABASE_URL = '${FAKE_URL}';`));
    assert.ok(text.includes(`window.THE_PROGRAM_SUPABASE_ANON_KEY = '${FAKE_KEY}';`));
    assert.ok(!text.includes('PASTE_THE_ANON_PUBLIC_KEY_HERE'));
  } finally {
    cleanup(tmp);
  }
});

test('strips a trailing slash from the URL', () => {
  const { res, out, tmp } = run({
    THE_PROGRAM_SUPABASE_URL: `${FAKE_URL}/`,
    THE_PROGRAM_SUPABASE_ANON_KEY: FAKE_KEY,
  });
  try {
    assert.equal(res.status, 0, res.stderr);
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes(`window.THE_PROGRAM_SUPABASE_URL = '${FAKE_URL}';`));
  } finally {
    cleanup(tmp);
  }
});

test('fails when the URL is missing', () => {
  const { res, tmp } = run({ THE_PROGRAM_SUPABASE_ANON_KEY: FAKE_KEY });
  try {
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /THE_PROGRAM_SUPABASE_URL is not set/);
  } finally {
    cleanup(tmp);
  }
});

test('fails when the key is missing', () => {
  const { res, tmp } = run({ THE_PROGRAM_SUPABASE_URL: FAKE_URL });
  try {
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /THE_PROGRAM_SUPABASE_ANON_KEY is not set/);
  } finally {
    cleanup(tmp);
  }
});

test('fails on a non-https or non-Supabase URL', () => {
  const { res, tmp } = run({
    THE_PROGRAM_SUPABASE_URL: 'http://example.com',
    THE_PROGRAM_SUPABASE_ANON_KEY: FAKE_KEY,
  });
  try {
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /must be https:\/\/<project-ref>\.supabase\.co/);
  } finally {
    cleanup(tmp);
  }
});

test('fails when the key is not JWT-shaped', () => {
  const { res, tmp } = run({
    THE_PROGRAM_SUPABASE_URL: FAKE_URL,
    THE_PROGRAM_SUPABASE_ANON_KEY: 'not-a-jwt',
  });
  try {
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /does not look like a JWT/);
  } finally {
    cleanup(tmp);
  }
});

test('netlify.toml runs the generator and publishes the repo root', () => {
  const toml = fs.readFileSync(path.join(repoRoot, 'netlify.toml'), 'utf8');
  assert.match(toml, /command = "node scripts\/generate-supabase-config\.mjs"/);
  assert.match(toml, /publish = "\."/);
});

test('.gitignore still ignores the generated config file', () => {
  const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.ok(
    gitignore.split('\n').some((line) => line.trim() === 'saas-ui/supabase-config.js'),
    '.gitignore must keep ignoring saas-ui/supabase-config.js',
  );
});
