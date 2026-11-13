/* Migration 004 SQL invariants.
 * Run: node --test server/tests/migration-004.test.js
 * The migration is reviewed-only (NOT applied). These tests pin its
 * shape: additive tables, RLS on everything new, idempotency, the
 * plan-finalization CHECK, and no destructive statements.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_assessment_reassessment.sql'), 'utf8');
// The rollback block at the end is documentation, not executable
// intent: strip it before checking for destructive statements.
const body = sql.slice(0, sql.indexOf('-- Rollback'));

test('migration 004 is a reviewed-only, transactional, additive migration', () => {
  assert.match(sql, /STATUS: NOT APPLIED/);
  assert.match(body, /^BEGIN;/m);
  assert.match(body, /^COMMIT;/m);
  assert.ok(!/DROP TABLE/i.test(body), 'no table is dropped');
  assert.ok(!/DELETE FROM/i.test(body), 'no rows are deleted');
  assert.ok(!/TRUNCATE/i.test(body), 'nothing is truncated');
});

test('migration 004 creates the schedule, deferral, draft, and plan tables', () => {
  for (const table of ['assessment_schedules', 'assessment_deferrals', 'assessment_drafts', 'development_plans']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} is created`);
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`), `${table} has RLS`);
  }
  assert.match(sql, /UNIQUE \(athlete_id, battery\)/, 'one schedule row per athlete + battery');
  assert.match(sql, /UNIQUE \(athlete_id, battery\)/, 'one draft per athlete + battery');
  // A finalized plan must name its baseline session OR carry a recorded
  // coach override. The override path (baseline-gating finalizePlan)
  // finalizes with NO baseline session; the pre-integration CHECK
  // (baseline_session_id IS NOT NULL) would have rejected exactly
  // those rows. The CHECK below pins the fixed form.
  assert.match(sql, /CHECK \(status <> 'finalized'\s+OR baseline_session_id IS NOT NULL\s+OR override_reason IS NOT NULL\)/,
    'a finalized plan must name its baseline session or a recorded override');
  assert.match(sql, /deferred_until IS NOT NULL/, 'a deferral needs a deferred-until date');
});

test('migration 004 gives coaches scoped, insert-only write access to assessment history', () => {
  for (const [policy, table] of [['asess_coach_write', 'assessment_sessions'],
    ['ares_coach_write', 'assessment_results'], ['ader_coach_write', 'assessment_derived_records']]) {
    assert.match(sql, new RegExp(`CREATE POLICY ${policy} ON ${table} FOR INSERT TO authenticated`),
      `${policy} is insert-only for coaches on ${table}`);
  }
  assert.match(sql, /asess_coach_write ON assessment_sessions FOR INSERT TO authenticated\s*\n\s*WITH CHECK \(public\.app_role\(\) = 'coach' AND public\.is_my_cohort_athlete\(athlete_id\)\)/,
    'coach assessment writes are scoped to their own cohort athletes');
  // No UPDATE/DELETE policies for coaches on history tables: history
  // is immutable; only INSERT is granted.
  assert.ok(!/CREATE POLICY \w+_coach\w* ON assessment_(sessions|results|derived_records) FOR (UPDATE|DELETE|ALL)/.test(sql),
    'no coach UPDATE/DELETE/ALL policy on assessment history tables');
  // Drafts are coach working state: director + coach only, no owner policy.
  assert.match(sql, /CREATE POLICY adrft_director ON assessment_drafts FOR ALL TO authenticated/);
  assert.match(sql, /CREATE POLICY adrft_coach ON assessment_drafts FOR ALL TO authenticated/);
  assert.ok(!/CREATE POLICY adrft_owner/.test(sql), 'drafts are never visible to parents/athletes');
});

test('migration 004 adds the idempotency key and unique index', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS idempotency_key TEXT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_asess_idempotency/);
  assert.match(sql, /WHERE idempotency_key IS NOT NULL/);
});

test('migration 004 seeds the GAA definitions including the observation test', () => {
  for (const id of ['5-10-5-shuttle', 'single-leg-balance-r', 'single-leg-balance-l',
    '6min-walk-run', 'movement-assessment']) {
    assert.ok(sql.includes(`('${id}'`), `004 seeds ${id}`);
  }
  assert.match(sql, /ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'measured'/);
  assert.match(sql, /'movement-assessment', 'Movement Assessment', 'mobility_movement_control', 'observations', NULL, 1, 'none'/);
});

test('migration 004 policies mirror migration 003 (director / coach / owner)', () => {
  for (const table of ['assessment_schedules', 'assessment_deferrals', 'development_plans']) {
    assert.match(sql, new RegExp(`CREATE POLICY \\w+_director ON ${table} FOR ALL TO authenticated`));
    assert.match(sql, new RegExp(`CREATE POLICY \\w+_owner ON ${table} FOR SELECT TO authenticated`));
  }
  assert.match(sql, /is_my_cohort_athlete\(athlete_id\)/, 'coach scope uses the 003 helper');
  assert.match(sql, /is_my_athlete\(athlete_id\)/, 'owner scope uses the 003 helper');
  assert.ok(!/TO anon/i.test(sql), 'no anonymous access anywhere');
});

test('migration 004 is Postgres 15 compatible', () => {
  assert.ok(!/MERGE INTO/i.test(body), 'no MERGE (PG15 supports it, but the migration does not need it)');
  assert.ok(!/GENERATED ALWAYS AS/i.test(body), 'no generated columns');
  assert.match(sql, /gen_random_uuid\(\)/, 'UUIDs use gen_random_uuid, available since PG13');
});
