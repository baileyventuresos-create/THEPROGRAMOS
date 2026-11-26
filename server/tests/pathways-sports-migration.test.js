/* Athlete Pathways V1 — sport configs, goals, scouting (G6) + migration 009.
 * Run: node --test server/tests/pathways-sports-migration.test.js
 * Synthetic data only, in-memory store. Pins: the four new sport
 * batteries load and the 8-test GAA core is intact; assignSport
 * stores sport + positions on the coach-athlete link; goals and
 * scouting evaluations are recorded and visible to the athlete;
 * only coach-approved evaluations enter the public profile;
 * migration 009 is additive, transactional, reviewed-only, and
 * creates every Pathways table with RLS.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { MemorySaasStore } = require('../saas-store');
const { createSaasApi } = require('../saas-api');
const engine = require('../../assessment-engine/assessment-engine');
const {
  GAA_TESTS, GAA_DEFINITION_IDS, SPORT_TESTS, SPORT_BATTERIES, SPORTS,
  sportTestsFor, protocolFor, validateAttempts,
} = require('../assessment-battery');

const NOW = Date.parse('2026-11-20T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const DIRECTOR = { authUserId: 'auth-director', role: 'director' };

function codeOf(fn) {
  try { fn(); } catch (e) { return e.code; }
  return null;
}

function freshWorld() {
  const store = new MemorySaasStore();
  const api = createSaasApi({ store });
  api.registerCoach({ authUserId: 'auth-coach-a', role: 'coach' },
    { email: 'a@dev.invalid', name: 'Coach A', now: NOW });
  api.registerCoach({ authUserId: 'auth-coach-b', role: 'coach' },
    { email: 'b@dev.invalid', name: 'Coach B', now: NOW });
  const athA = api.registerAthlete({ authUserId: 'auth-ath-a', role: 'athlete' },
    { email: 'atha@dev.invalid', name: 'Athlete A', age: 25, now: NOW });
  const authA = { authUserId: 'auth-coach-a', role: 'coach' };
  const authB = { authUserId: 'auth-coach-b', role: 'coach' };
  api.linkAthlete(authA, { athleteId: athA.athlete.id, now: NOW });
  return { store, api, athA, authA, authB };
}

test('sport batteries load: soccer, basketball, football, flag_football; GAA core intact', () => {
  assert.deepEqual(Object.keys(SPORT_BATTERIES).sort(),
    ['baseball', 'basketball', 'flag_football', 'football', 'soccer']);
  assert.deepEqual(SPORT_BATTERIES.soccer, ['30m-sprint', 't-test-agility']);
  assert.deepEqual(SPORT_BATTERIES.basketball, ['vertical-jump', 'lane-agility']);
  assert.deepEqual(SPORT_BATTERIES.football, ['40yd-dash', 'broad-jump', 'vertical-jump']);
  assert.deepEqual(SPORT_BATTERIES.flag_football, ['40yd-dash', '5-10-5-shuttle', '30m-sprint']);
  // Engine mirrors the same batteries and every sport definition resolves.
  for (const sport of SPORTS) {
    for (const id of engine.batteries[sport]) {
      assert.ok(engine.definitions[id], `${sport} definition ${id} exists`);
      assert.equal(engine.definitions[id].retestDays, 28);
    }
  }
  // GAA core untouched: 8 tests / 9 definition ids, same battery.
  assert.equal(GAA_TESTS.length, 8);
  assert.equal(GAA_DEFINITION_IDS.length, 9);
  assert.deepEqual(engine.batteries.generalAthleticAssessment,
    ['10yd-sprint', 'broad-jump', '5-10-5-shuttle', 'push-ups', 'side-plank-r', 'side-plank-l',
      'single-leg-balance-r', 'single-leg-balance-l', '6min-walk-run']);
  // No norms, thresholds, or readiness scores anywhere in the new tests.
  for (const t of SPORT_TESTS) {
    assert.equal(t.kind, 'measured');
    assert.ok(!('norm' in t) && !('percentile' in t) && !('readiness' in t), `${t.id} carries no norm/score`);
  }
  // Protocol entries exist and validate attempts (e.g. 30m sprint).
  assert.equal(protocolFor('30m-sprint').name, '30-Metre Sprint');
  assert.equal(validateAttempts('30m-sprint', [4.5, 4.4, 4.6]).ok, true);
  assert.equal(validateAttempts('vertical-jump', [24, 25]).ok, true);
  assert.deepEqual(sportTestsFor('soccer').map(t => t.id), ['30m-sprint', 't-test-agility']);
  assert.throws(() => sportTestsFor('hockey'), /Unknown sport/);
});

test('assignSport stores sport + positions on the coach-athlete link', () => {
  const { store, api, athA, authA, authB } = freshWorld();
  const out = api.assignSport(authA, {
    athleteId: athA.athlete.id, sport: 'soccer', positions: ['midfielder', 'winger'], now: NOW,
  });
  assert.equal(out.link.sport, 'soccer');
  assert.deepEqual(out.link.positions, ['midfielder', 'winger']);
  assert.ok(out.athlete.sports.includes('soccer'));
  assert.equal(codeOf(() => api.assignSport(authA,
    { athleteId: athA.athlete.id, sport: 'hockey', now: NOW })), 'INVALID_INPUT');
  // Coach B has no link to this athlete: tenant isolation holds.
  assert.equal(codeOf(() => api.assignSport(authB,
    { athleteId: athA.athlete.id, sport: 'basketball', now: NOW })), 'FORBIDDEN');
  assert.ok(store.auditEvents.some(e => e.action === 'assign_sport'));
});

test('development goals and scouting evaluations: recorded, visible to the athlete', () => {
  const { store, api, athA, authA } = freshWorld();
  const { goal } = api.setDevelopmentGoals(authA, {
    athleteId: athA.athlete.id, goal: 'Improve first-step acceleration over the next cycle.',
    targetDate: '2026-12-18', now: NOW,
  });
  assert.equal(goal.status, 'active');
  const done = api.updateDevelopmentGoal(authA, { goalId: goal.id, status: 'completed', now: NOW });
  assert.equal(done.goal.status, 'completed');
  const { evaluation } = api.recordScoutingEvaluation(authA, {
    athleteId: athA.athlete.id, body: 'Strong change of direction; keeps shape under pressure.', now: NOW,
  });
  assert.equal(evaluation.coachApproved, true, 'coach-authored evaluation is coach-approved on record');
  const athAuth = { authUserId: 'auth-ath-a', role: 'athlete' };
  assert.equal(api.listDevelopmentGoals(athAuth, { athleteId: athA.athlete.id }).goals.length, 1);
  assert.equal(api.listScoutingEvaluations(athAuth, { athleteId: athA.athlete.id }).evaluations.length, 1);
  assert.ok(store.auditEvents.some(e => e.action === 'set_development_goal'));
  assert.ok(store.auditEvents.some(e => e.action === 'record_scouting_evaluation'));
});

test('only coach-approved evaluations enter the public profile', () => {
  const { api, athA, authA } = freshWorld();
  const athAuth = { authUserId: 'auth-ath-a', role: 'athlete' };
  const profile = api.createProspectProfile(authA, {
    athleteId: athA.athlete.id, primarySport: 'soccer', bio: 'Fictional prospect.', now: NOW,
  }).profile;
  api.recordScoutingEvaluation(authA, {
    athleteId: athA.athlete.id, body: 'Approved note.', coachApproved: true, now: NOW,
  });
  api.recordScoutingEvaluation(authA, {
    athleteId: athA.athlete.id, body: 'Draft note, not approved.', coachApproved: false, now: NOW,
  });
  api.approveProspectProfile(authA, { profileId: profile.id, approval: 'coach', now: NOW });
  api.approveProspectProfile(athAuth, { profileId: profile.id, approval: 'athlete', now: NOW });
  const { token } = api.createProfileShare(authA, { profileId: profile.id, now: NOW });
  const pub = api.getPublicProfile({ token, now: NOW });
  assert.equal(pub.profile.scoutingEvaluations.length, 1);
  assert.equal(pub.profile.scoutingEvaluations[0].body, 'Approved note.');
  assert.ok(!JSON.stringify(pub).includes('Draft note'), 'unapproved evaluation never leaks');
  // The athlete still sees both in their own scoped read.
  assert.equal(api.getProspectProfile(athAuth, { profileId: profile.id }).scoutingEvaluations.length, 2);
});

const MIG = path.join(__dirname, '..', 'migrations');
function read(f) { return fs.readFileSync(path.join(MIG, f), 'utf8'); }
const m009 = read('009_athlete_pathways.sql');
const body009 = m009.slice(0, m009.indexOf('-- Rollback'));

test('migration 009 is reviewed-only, transactional, additive, and creates every Pathways table with RLS', () => {
  assert.match(m009, /STATUS: NOT APPLIED/, 'marked not applied');
  assert.match(body009, /^BEGIN;/m, 'transactional');
  assert.match(body009, /^COMMIT;/m, 'commits');
  assert.ok(!/DROP TABLE/i.test(body009), 'drops no table');
  assert.ok(!/DROP COLUMN/i.test(body009), 'drops no column');
  assert.ok(!/DELETE FROM/i.test(body009), 'deletes no rows');
  assert.ok(!/TRUNCATE/i.test(body009), 'truncates nothing');
  assert.ok(!/UPDATE\s+\w+\s+SET/i.test(body009), 'rewrites no existing rows');
  for (const table of ['complimentary_grants', 'prospect_profiles', 'profile_shares',
    'recruitment_contacts', 'recruitment_opportunities', 'recruitment_notes', 'referrals',
    'prospect_media_links', 'development_goals', 'scouting_evaluations']) {
    assert.match(m009, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} is created`);
    assert.match(m009, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`), `${table} has RLS`);
  }
  assert.match(m009, /token_hash TEXT NOT NULL/, 'share tokens are stored hashed');
  assert.match(m009, /expires_at TIMESTAMPTZ,   -- NULL = indefinite/, 'indefinite grants are null expiry');
  assert.match(m009, /ADD COLUMN IF NOT EXISTS status TEXT/, 'athletes.status is additive');
  assert.match(m009, /ADD COLUMN IF NOT EXISTS sport TEXT/, 'link sport is additive');
  assert.ok(!/CREATE TABLE IF NOT EXISTS.*storage/i.test(m009), 'no storage bucket is created');
  assert.ok(!/supabase\.storage/i.test(m009), 'no Storage calls in the migration');
  // G6: the five sport definitions are seeded, matching the engine.
  for (const id of ['30m-sprint', 't-test-agility', 'vertical-jump', 'lane-agility', '40yd-dash']) {
    assert.match(m009, new RegExp(`\\('${id}'`), `migration 009 seeds ${id}`);
  }
});
