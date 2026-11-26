// Static guards for the §5 live functional checks (migration 004).
// These tests do NOT touch any database: they guard the SQL files
// themselves (fixtures, impersonation method, check coverage, cleanup
// completeness) so a typo in a table name or a missing UUID fails here
// instead of wasting the live run in the dashboard SQL editor.
// The scripts were additionally rehearsed end-to-end against a
// throwaway local Postgres; see server/live-checks/004/README.md.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'live-checks', '004');
const setup = fs.readFileSync(path.join(DIR, '01-setup-synthetic-data.sql'), 'utf8');
const checks = fs.readFileSync(path.join(DIR, '02-checks.sql'), 'utf8');
const cleanup = fs.readFileSync(path.join(DIR, '03-cleanup.sql'), 'utf8');

const ALL = [setup, checks, cleanup];

const CHECK_IDS = [
  'CHECK-1a-first-insert', 'CHECK-1b-duplicate-rejected', 'CHECK-1c-retry-noop',
  'CHECK-2a-out-of-cohort-denied', 'CHECK-2b-own-cohort-insert',
  'CHECK-2c-own-cohort-result', 'CHECK-2d-own-cohort-derived',
  'CHECK-3a-athlete-own', 'CHECK-3b-parent-own', 'CHECK-3c-anon-nothing',
  'CHECK-4a-override-inserts', 'CHECK-4b-neither-rejected',
  'CHECK-5a-draft-created', 'CHECK-5b-athlete-no-draft', 'CHECK-5c-parent-no-draft',
  'CHECK-5d-draft-not-a-session', 'SANITY-absolute-counts',
];

// Fixed test UUIDs documented in the scripts' headers. Setup creates
// the fixture UUIDs; the checks create the check-row UUIDs (and attempt
// the rejected ones, which are never inserted); cleanup deletes exactly
// the rows that can exist.
const FIXTURE_UUIDS = [
  'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004',
  'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
  'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000004',
  'c0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002',
  'e0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002',
  'f0000000-0000-4000-8000-000000000003',
];
const CHECK_ROW_UUIDS = [
  '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
];
// Attempted inserts that must be REJECTED/DENIED: they never exist as rows.
const ATTEMPT_UUIDS = [
  '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000004',
  '50000000-0000-4000-8000-000000000002',
];

// Tables that exist after migrations 001–004 (the only tables the
// scripts may reference).
const TABLES = [
  'app_users', 'athletes', 'guardians', 'athlete_guardians', 'coaches',
  'cohorts', 'cohort_enrollments', 'locations', 'memberships',
  'training_sessions', 'session_coaches', 'reservations', 'waitlist_entries',
  'attendance_records', 'operational_audit_events', 'assessment_sessions',
  'assessment_results', 'assessment_derived_records', 'assessment_definitions',
  'assessment_schedules', 'assessment_deferrals', 'assessment_drafts',
  'development_plans', 'coach_availability', 'training_spaces',
  'session_templates', 'auth.users',
];

test('§5 live-check scripts exist', () => {
  for (const f of ['01-setup-synthetic-data.sql', '02-checks.sql', '03-cleanup.sql', 'README.md']) {
    assert.ok(fs.existsSync(path.join(DIR, f)), `${f} is missing`);
  }
});

test('setup is re-runnable and creates only synthetic fixtures', () => {
  assert.ok(setup.includes('ON CONFLICT'), 'setup must use ON CONFLICT DO NOTHING for re-runs');
  assert.ok(!/DROP\s+TABLE/i.test(setup), 'setup must not drop tables');
  assert.ok(!/DELETE\s+FROM/i.test(setup), 'setup must not delete');
  assert.ok(!/TRUNCATE/i.test(setup), 'setup must not truncate');
  for (const u of FIXTURE_UUIDS) assert.ok(setup.includes(u), `setup is missing UUID ${u}`);
  assert.ok(setup.includes('test-programos.test'), 'setup identities must use the test domain');
  assert.ok(setup.includes('PRE-FLIGHT'), 'setup must pre-flight the post-004 state');
});

test('checks reference the identity and check-row UUIDs, and attempt the rejected ones', () => {
  // Checks need the auth/app/coach/athlete identities and the check
  // rows; they never reference the guardian/location/cohort fixtures.
  const CHECK_UUIDS = [
    ...FIXTURE_UUIDS.slice(0, 11), // auth x4, app x4, coach, athletes x2
    ...CHECK_ROW_UUIDS, ...ATTEMPT_UUIDS,
  ];
  for (const u of CHECK_UUIDS) {
    assert.ok(checks.includes(u), `checks are missing UUID ${u}`);
  }
});

test('checks contain all 17 verdicts and the A/B/C impersonation method', () => {
  for (const id of CHECK_IDS) assert.ok(checks.includes(id), `checks are missing ${id}`);
  assert.ok(checks.includes('SET LOCAL ROLE authenticated'), 'checks must impersonate via SET LOCAL ROLE');
  assert.ok(checks.includes('SET LOCAL request.jwt.claims'), 'checks must set the JWT claims');
  assert.ok(checks.includes('SET LOCAL ROLE anon'), 'checks must include an anonymous block');
  assert.ok(checks.includes('insufficient_privilege'), 'checks must assert the RLS denial SQLSTATE');
  assert.ok(checks.includes('check_violation'), 'checks must assert the CHECK rejection SQLSTATE');
  assert.ok(checks.includes('unique_violation'), 'checks must assert the duplicate-key SQLSTATE');
  assert.ok(checks.includes('ON CONFLICT (athlete_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING'),
    'checks must use the store retry form with the partial-index predicate');
  assert.ok(checks.includes('has_table_privilege'), 'checks must pre-flight the table grants (RLS and grants both deny with 42501)');
  assert.ok(checks.includes('GRANTS PRE-FLIGHT'), 'checks must contain the grants pre-flight block');
  assert.ok(checks.includes('finalized_by'), 'checks must use the real development_plans.finalized_by column (004)');
  assert.ok(checks.includes('override_approved_by'), 'checks must use the real development_plans.override_approved_by column (004)');
  assert.ok(!checks.includes('created_by'), 'development_plans has no created_by column (004) — must not be referenced');
  assert.ok(checks.includes('entries'), 'checks must use the real assessment_drafts.entries column (004)');
  assert.ok(!checks.includes('draft_data'), 'assessment_drafts has no draft_data column (004) — must not be referenced');
  assert.ok(!/INSERT INTO auth\.users/i.test(checks), 'checks must not create identities');
  assert.ok(!/DELETE\s+FROM/i.test(checks), 'checks must not delete rows');
  assert.ok(!/SET\s+(LOCAL\s+)?ROLE\s+service_role/i.test(checks), 'checks must never impersonate service_role');
});

test('cleanup deletes every documented UUID and verifies the pre-check state', () => {
  for (const u of [...FIXTURE_UUIDS, ...CHECK_ROW_UUIDS]) assert.ok(cleanup.includes(u), `cleanup is missing UUID ${u}`);
  for (const u of ATTEMPT_UUIDS) assert.ok(!cleanup.includes(u), `cleanup must not reference a rejected-attempt UUID that can never exist as a row: ${u}`);
  assert.ok(!/TRUNCATE\s+(TABLE\s+)?[a-z_]/i.test(cleanup), 'cleanup must not truncate');
  assert.ok(!/DROP\s+TABLE/i.test(cleanup), 'cleanup must not drop tables');
  assert.ok(/DELETE\s+FROM\s+\w+\s+WHERE/i.test(cleanup), 'cleanup deletes must be WHERE-scoped');
  assert.ok(!/DELETE\s+FROM\s+\w+\s*;/i.test(cleanup), 'cleanup must not contain an unscoped DELETE');
  assert.ok(cleanup.includes('v_tables = 26'), 'cleanup must verify 26 tables');
  assert.ok(cleanup.includes('v_defs = 15'), 'cleanup must verify 15 definitions');
  assert.ok(cleanup.includes('v_policies = 72'), 'cleanup must verify 72 policies');
  assert.ok(cleanup.includes('CLEANUP PASS'), 'cleanup must report PASS/FAIL');
});

test('all three scripts reference only tables that exist after 001–004', () => {
  for (const [name, sql] of [['setup', setup], ['checks', checks], ['cleanup', cleanup]]) {
    const refs = new Set();
    for (const m of sql.matchAll(/(?:FROM|JOIN|UPDATE)\s+(?:auth\.)?([a-z_][a-z0-9_]*)/g)) refs.add(m[1]);
    for (const m of sql.matchAll(/INSERT INTO\s+(?:auth\.)?([a-z_][a-z0-9_]*)/g)) refs.add(m[1]);
    for (const m of sql.matchAll(/DELETE FROM\s+(?:auth\.)?([a-z_][a-z0-9_]*)/g)) refs.add(m[1]);
    for (const t of refs) {
      // information_schema / pg_policies are the system catalogs the
      // state-verification queries read; everything else must be an
      // application table that exists after 001–004.
      assert.ok(TABLES.includes(t) || t === 'users' || t === 'information_schema' || t === 'pg_policies' || t === '_tst004_results',
        `${name} references unknown table "${t}"`);
    }
    // No real-domain emails anywhere: only test-programos.test.
    for (const m of sql.matchAll(/[\w.+-]+@[\w.-]+/g)) {
      assert.ok(m[0].endsWith('@test-programos.test'), `${name} contains a non-test email: ${m[0]}`);
    }
  }
});

test('no script touches the live project by network or migration', () => {
  for (const [name, sql] of [['setup', setup], ['checks', checks], ['cleanup', cleanup]]) {
    assert.ok(!/CREATE\s+EXTENSION/i.test(sql), `${name} must not create extensions`);
    assert.ok(!/ALTER\s+TABLE/i.test(sql), `${name} must not alter tables`);
    assert.ok(!/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER|INDEX)/i.test(sql),
      `${name} must not create functions, policies, triggers, or indexes`);
  }
});
