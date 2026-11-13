// Static guards for the migration-005 live-run scripts.
// Same pattern as server/tests/live-checks-004.test.js: no live DB,
// no browser. Guards the file contents so a typo cannot reach the
// live run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const precheck = readFileSync(path.join(root, 'live-checks/005/00-precheck-005.sql'), 'utf8');
const verify = readFileSync(path.join(root, 'live-checks/005/01-verify-005.sql'), 'utf8');
const migration = readFileSync(path.join(root, 'migrations/005_unified_athlete_age_and_result_flags.sql'), 'utf8');

// The test UUIDs used by the verify script (and the one auth UUID the
// pre-check also looks for) must agree across the two scripts.
const TEST_UUIDS = [
  'a5000000-0000-4000-8000-000000000001',
  'b5000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000002',
  'd5000000-0000-4000-8000-000000000003',
  '15000000-0000-4000-8000-000000000001',
  '25000000-0000-4000-8000-000000000001',
  '25000000-0000-4000-8000-000000000002',
];

test('005 verify script uses the documented test UUIDs and pre-check knows the auth one', () => {
  for (const uuid of TEST_UUIDS) {
    assert.ok(verify.includes(uuid), `verify script missing UUID ${uuid}`);
  }
  assert.ok(precheck.includes(TEST_UUIDS[0]), 'pre-check must look for the 005 test auth user');
});

test('005 verify script references only real columns', () => {
  // Real columns the checks rely on (verified against migrations 001/002/004).
  for (const col of ['modified', 'capped', 'age_years', 'idempotency_key', 'assessment_id', 'attempts']) {
    assert.ok(verify.includes(col), `verify script missing real column ${col}`);
  }
  // Invented column names must not appear.
  assert.ok(!verify.includes('created_by'), 'no invented created_by column');
  assert.ok(!verify.includes('draft_data'), 'no invented draft_data column');
  // 'division' appears only inside the V4 absence check — the exact
  // IN-list below is the check itself, not a reference to a real column.
  assert.ok(verify.includes("column_name IN ('division', 'division_id', 'age_group', 'age_division')"),
    'V4 checks absence of exactly those four division-like names');
});

test('005 scripts contain no destructive operations', () => {
  for (const [name, sql] of [['precheck', precheck], ['verify', verify]]) {
    // The only DROP TABLE allowed is the temp results table (same as §5).
    const drops = sql.match(/DROP\s+TABLE[^;]*;/gi) || [];
    for (const drop of drops) {
      assert.ok(/_tst005_results/.test(drop), `${name}: only the temp results table may be dropped, found: ${drop}`);
    }
    assert.ok(!/TRUNCATE/i.test(sql), `${name}: no TRUNCATE`);
    // Every DELETE statement must carry a WHERE clause.
    const deletes = sql.match(/DELETE\s+FROM[^;]*;/gi) || [];
    for (const del of deletes) {
      assert.ok(/WHERE/i.test(del), `${name}: DELETE without WHERE: ${del.slice(0, 60)}`);
    }
  }
  // The migration itself: the only DROP is the old CHECK constraint
  // (by definition match); no table/column drops, no TRUNCATE, no DELETE.
  assert.ok(!/DROP\s+TABLE/i.test(migration), 'migration: no DROP TABLE');
  assert.ok(!/DROP\s+COLUMN/i.test(migration.replace(/^--.*$/gm, '')), 'migration: no live DROP COLUMN (rollback comments excluded)');
  assert.ok(!/TRUNCATE/i.test(migration), 'migration: no TRUNCATE');
  assert.ok(!/DELETE\s+FROM/i.test(migration), 'migration: no DELETE FROM');
  assert.ok(migration.includes('DROP CONSTRAINT'), 'migration drops the old age CHECK constraint');
  assert.ok(migration.includes('CHECK (age_years >= 5)'), 'migration re-issues the floor-only CHECK');
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS modified BOOLEAN NOT NULL DEFAULT FALSE'), 'migration adds modified');
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS capped BOOLEAN NOT NULL DEFAULT FALSE'), 'migration adds capped');
});

test('005 verify script expects the post-004 baseline', () => {
  assert.ok(verify.includes('26 tables'), 'V1 expects 26 tables');
  assert.ok(verify.includes('72 policies'), 'V1/V8 expect 72 policies');
  assert.ok(verify.includes('25 assessment policies'), 'V8 expects 25 assessment policies by name');
  for (const policy of ['asess_coach_write', 'ares_coach_write', 'ader_coach_write', 'adrft_coach', 'dplan_coach']) {
    assert.ok(verify.includes(policy), `V8 must check policy ${policy}`);
  }
});
