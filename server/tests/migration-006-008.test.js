/* Migration 006-008 SQL invariants + schema-snapshot proof.
 * Run: node --test server/tests/migration-006-008.test.js
 * The migrations are reviewed-only (NOT applied). These tests pin
 * their shape: additive tables/columns only, RLS on everything new,
 * idempotency, no destructive statements — and, by snapshot over
 * migrations 001-005, that no existing table/column/policy is
 * changed beyond the documented additive columns + role CHECK.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const MIG = path.join(__dirname, '..', 'migrations');
function read(f) { return fs.readFileSync(path.join(MIG, f), 'utf8'); }
function bodyOf(sql) { return sql.slice(0, sql.indexOf('-- Rollback')); }

const m006 = read('006_saas_foundation.sql');
const m007 = read('007_training_assignments.sql');
const m008 = read('008_billing_shape.sql');
const b006 = bodyOf(m006); const b007 = bodyOf(m007); const b008 = bodyOf(m008);
const all = [m006, m007, m008].join('\n');
const allBody = [b006, b007, b008].join('\n');

const priorSql = ['001_operational_foundation.sql', '002_assessment_persistence.sql',
  '003_auth_rls.sql', '004_assessment_reassessment.sql',
  '005_unified_athlete_age_and_result_flags.sql'].map(read).join('\n');

test('migrations 006-008 are reviewed-only, transactional, additive', () => {
  for (const [name, sql, body] of [['006', m006, b006], ['007', m007, b007], ['008', m008, b008]]) {
    assert.match(sql, /STATUS: NOT APPLIED/, `${name} is marked not applied`);
    assert.match(body, /^BEGIN;/m, `${name} is transactional`);
    assert.match(body, /^COMMIT;/m, `${name} commits`);
    assert.ok(!/DROP TABLE/i.test(body), `${name} drops no table`);
    assert.ok(!/DROP COLUMN/i.test(body), `${name} drops no column`);
    assert.ok(!/DROP POLICY/i.test(body.replace(/DROP POLICY IF EXISTS/g, '')), `${name} drops no policy (IF EXISTS re-issue only)`);
    assert.ok(!/DELETE FROM/i.test(body), `${name} deletes no rows`);
    assert.ok(!/TRUNCATE/i.test(body), `${name} truncates nothing`);
    assert.ok(!/UPDATE\s+\w+\s+SET/i.test(body), `${name} rewrites no existing rows`);
  }
});

test('migration 006 creates the SaaS foundation tables with RLS', () => {
  for (const table of ['organizations', 'organization_memberships', 'coach_athlete_links', 'invitations', 'guardian_consents']) {
    assert.match(m006, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} is created`);
    assert.match(m006, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`), `${table} has RLS`);
  }
  assert.match(m006, /kind TEXT NOT NULL CHECK \(kind IN \('solo','team','academy','program_internal'\)\)/);
  assert.match(m006, /uq_link_active/, 'one live link per coach+athlete+org');
  assert.match(m006, /token_hash TEXT NOT NULL/, 'invitation tokens are stored hashed');
  assert.match(m006, /program_internal/, 'the internal tenant is seeded');
});

test('migration 006 adds only the four documented nullable tenancy columns', () => {
  for (const table of ['coaches', 'cohorts', 'locations', 'training_sessions']) {
    assert.match(m006, new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations\\(id\\) ON DELETE SET NULL`),
      `${table}.organization_id is additive + nullable`);
  }
  const addColumns = [...b006.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)/g)]
    .map(m => `${m[1]}.${m[2]}`);
  assert.deepEqual(addColumns.sort(), [
    'coaches.organization_id', 'cohorts.organization_id',
    'locations.organization_id', 'training_sessions.organization_id',
  ], '006 adds exactly the four documented columns and nothing else');
});

test('migration 006 role CHECK gains org_admin and keeps every existing role', () => {
  assert.match(m006, /CHECK \(role IN \('director','coach','parent','athlete','admin','org_admin'\)\)/);
  assert.match(m006, /pg_get_constraintdef\(oid\) NOT LIKE '%org_admin%'/, 're-issue is guarded (idempotent)');
});

test('migration 006 RLS helpers mirror the 003 style and stay additive', () => {
  for (const fn of ['my_org_ids', 'is_my_org', 'is_my_org_admin', 'is_my_linked_athlete', 'has_guardian_consent']) {
    assert.match(m006, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`), `${fn} helper exists`);
    assert.match(m006, /SECURITY DEFINER/, 'helpers are SECURITY DEFINER like 003');
  }
  assert.match(m006, /CREATE POLICY asess_link_read ON assessment_sessions FOR SELECT/, 'link scope added to assessment reads');
  assert.match(m006, /CREATE POLICY asess_link_write ON assessment_sessions FOR INSERT/, 'link scope added to assessment writes (insert-only)');
  assert.ok(!/TO anon/i.test(allBody), 'no anon policies anywhere');
});

test('migration 007 creates assignments + completions keyed by TP2 ID', () => {
  for (const table of ['training_assignments', 'training_completions']) {
    assert.match(m007, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} is created`);
    assert.match(m007, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`), `${table} has RLS`);
  }
  assert.match(m007, /game_ids TEXT\[\]/, 'games referenced by TP2 ID array, no games table');
  assert.match(m007, /build TEXT CHECK \(build IS NULL OR build IN \('LEARN','COMPETE','PRESSURE','CHAOS'\)\)/);
  assert.match(m007, /dose JSONB/, 'coach dose is data');
  assert.match(m007, /UNIQUE \(assignment_id\)/, 'one completion per assignment');
  assert.match(m007, /effort_rpe INT CHECK \(effort_rpe IS NULL OR effort_rpe BETWEEN 1 AND 10\)/);
  assert.ok(!/CREATE TABLE IF NOT EXISTS games/.test(all), 'no games/drill table is created');
});

test('migration 008 creates the billing shape and seeds the research plan catalogue', () => {
  for (const table of ['subscription_plans', 'subscriptions', 'sponsorships', 'billing_events']) {
    assert.match(m008, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} is created`);
    assert.match(m008, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`), `${table} has RLS`);
  }
  assert.match(m008, /provider TEXT NOT NULL DEFAULT 'none' CHECK \(provider IN \('none','stripe_test'\)\)/,
    'provider is test-mode only by construction');
  assert.match(m008, /provider_event_id TEXT UNIQUE NOT NULL/, 'webhook idempotency key');
  for (const code of ['free_athlete', 'athlete_remote', 'coach_starter', 'coach_pro', 'team_academy', 'academy_scale']) {
    assert.match(m008, new RegExp(`'${code}'`), `plan ${code} is seeded`);
  }
  assert.match(m008, /"priceMonthlyCents":1499/, 'Athlete Remote $14.99/mo');
  assert.match(m008, /"priceMonthlyCents":2900/, 'Coach Starter $29/mo');
  assert.match(m008, /"priceMonthlyCents":7900/, 'Coach Pro $79/mo');
  assert.match(m008, /"priceMonthlyCents":19900/, 'Team/Academy $199/mo');
  assert.match(m008, /"priceMonthlyCents":34900/, 'Academy Scale $349/mo');
  assert.match(m008, /"maxAthletes":15/, 'Starter caps at 15 athletes');
  assert.match(m008, /"trialDays":14/, '14-day trials on coach/org tiers');
  assert.match(m008, /ON CONFLICT \(code\) DO NOTHING/, 'plan seed is idempotent');
  assert.ok(!/sk_live|live mode/i.test(b008.replace(/test-mode only/g, '')), 'no live billing anywhere');
});

test('schema snapshot: 006-008 create no table that 001-005 already created', () => {
  const priorTables = new Set([...priorSql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]));
  const newTables = [...allBody.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  assert.ok(newTables.length >= 11, '006-008 create the eleven new tables');
  for (const t of newTables) {
    assert.ok(!priorTables.has(t), `${t} does not collide with an existing table`);
  }
});

test('schema snapshot: no existing policy is redefined by 006-008', () => {
  const priorPolicies = new Set([...priorSql.matchAll(/CREATE POLICY (\w+)/g)].map(m => m[1]));
  const newPolicies = [...allBody.matchAll(/CREATE POLICY (\w+)/g)].map(m => m[1]);
  assert.ok(newPolicies.length > 0, 'new policies exist');
  for (const p of newPolicies) {
    assert.ok(!priorPolicies.has(p), `policy ${p} is new (no existing policy redefined)`);
  }
});

test('schema snapshot: 006-008 never ALTER an existing table except the documented additions', () => {
  const priorTables = new Set([...priorSql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]));
  const alters = [...allBody.matchAll(/ALTER TABLE (?:IF EXISTS )?(\w+)/g)].map(m => m[1]);
  const allowedExisting = new Set(['coaches', 'cohorts', 'locations', 'training_sessions', 'app_users']);
  for (const t of alters) {
    if (priorTables.has(t)) {
      assert.ok(allowedExisting.has(t), `ALTER on existing table ${t} is one of the documented additions`);
    }
  }
  // The only constraint change on an existing table is the app_users role CHECK.
  const constraintDrops = [...allBody.matchAll(/DROP CONSTRAINT/g)].length;
  assert.ok(constraintDrops <= 1, 'at most the guarded role-CHECK drop');
  assert.ok(!/ALTER TABLE athletes/i.test(allBody), 'athletes stays tenant-neutral (no organization_id)');
  assert.ok(!/ALTER TABLE memberships/i.test(allBody), 'the $149 memberships table is untouched');
  assert.ok(!/ALTER TABLE assessment_/i.test(allBody.replace(/ALTER TABLE assessment_sessions ENABLE/g, '').replace(/ALTER TABLE assessment_results ENABLE/g, '')),
    'assessment tables gain policies only, never columns');
});
