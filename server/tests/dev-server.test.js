/* Dev-server tests — the Phase 2 UI's backend, over real HTTP.
 * Run: node --test server/tests/dev-server.test.js
 *
 * Starts server/dev-server.js on an ephemeral localhost port (seeded
 * with the two synthetic fixture athletes) and exercises the exact
 * calls the browser client makes: static serving, GET .../battery,
 * and POST /api/assessments dispatch with dev-role headers. Synthetic
 * data only, memory stores only; nothing touches a live database.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDevServer } = require('../dev-server');
const Youth = require('../fixtures/synthetic-youth-12');
const Wingback = require('../fixtures/synthetic-wingback-48');

let dev;
let base;

test.before(async () => {
  dev = createDevServer({ port: 0, seed: true });
  await dev.start();
  base = dev.url;
});

test.after(async () => {
  await dev.close();
});

async function post(method, params, headers) {
  const res = await fetch(base + '/api/assessments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify({ method, params }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

const DIRECTOR = { 'X-Dev-Role': 'director', 'X-Dev-User': 'dev-director-marcus' };
const KAYLA = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-kayla' };
const JORDAN = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-jordan' };
const PARENT_YOUTH = { 'X-Dev-Role': 'parent', 'X-Dev-User': 'dev-parent-youth' };
const ATHLETE_YOUTH = { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'dev-athlete-youth', 'X-Dev-Athlete': Youth.athlete.id };

test('serves the prototype and the assessment UI scripts', async () => {
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.ok(html.includes('THE PROGRAM OS'), 'index loads the prototype');
  assert.ok(html.includes('assessment-ui/assessment-ui.js'), 'index loads the UI module');
  assert.ok(html.includes('assessment-ui/assessment-client.js'), 'index loads the transport adapter');
  const clientJs = await fetch(base + '/assessment-ui/assessment-client.js');
  assert.equal(clientJs.status, 200);
  const uiJs = await fetch(base + '/assessment-ui/assessment-ui.js');
  assert.equal(uiJs.status, 200);
  assert.ok((await uiJs.text()).includes('createAssessmentUI'));
});

test('battery route returns the real GAA protocol text', async () => {
  const res = await fetch(base + '/api/assessments/battery');
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.protocolVersion, 'gaa-v1');
  assert.equal(payload.retestDays, 28);
  assert.equal(payload.tests.length, 8);
  assert.deepEqual(payload.tests.map((t) => t.id), [
    '10yd-sprint', 'broad-jump', '5-10-5-shuttle', 'push-ups',
    'side-plank', 'single-leg-balance', '6min-walk-run', 'movement-assessment',
  ]);
});

test('listAthletes is scoped per role (director 8, coach 4/2, parent 1, athlete self)', async () => {
  const all = await post('listAthletes', {}, DIRECTOR);
  assert.equal(all.ok, true);
  assert.equal(all.data.length, 8);
  const kayla = await post('listAthletes', {}, KAYLA);
  assert.deepEqual(kayla.data.map((a) => a.id).sort(), [
    Youth.athlete.id, 'dev-ath-01', 'dev-ath-02', 'dev-ath-03',
  ].sort());
  const jordan = await post('listAthletes', {}, JORDAN);
  assert.deepEqual(jordan.data.map((a) => a.id).sort(), ['dev-ath-04', 'dev-ath-05']);
  const parent = await post('listAthletes', {}, PARENT_YOUTH);
  assert.deepEqual(parent.data.map((a) => a.id), [Youth.athlete.id]);
  const athlete = await post('listAthletes', {}, ATHLETE_YOUTH);
  assert.deepEqual(athlete.data.map((a) => a.id), [Youth.athlete.id]);
});

test('seeded dashboard buckets: youth due, wingback overdue, six never-assessed', async () => {
  const res = await post('coachDashboard', {}, DIRECTOR);
  assert.equal(res.ok, true);
  const byBucket = {};
  for (const [bucket, list] of Object.entries(res.data.reminders)) {
    byBucket[bucket] = list.map((s) => s.athleteId);
  }
  assert.deepEqual(byBucket.due, [Youth.athlete.id]);
  assert.deepEqual(byBucket.overdue, [Wingback.athlete.id]);
  assert.equal(byBucket.neverAssessed.length, 6);
  assert.deepEqual(byBucket.approaching, []);
  assert.deepEqual(byBucket.deferred, []);
});

test('full coach workflow over HTTP: start, partial save, resume, complete, history, plan', async () => {
  const athleteId = 'dev-ath-06';
  const started = await post('startAssessment', { athleteId }, DIRECTOR);
  assert.equal(started.ok, true);
  assert.equal(started.data.missing.length, 10, 'nine measured + movement');
  assert.equal(started.data.isReassessment, false);

  const partial = await post('recordAttempts', {
    athleteId,
    entries: Youth.baseline.entries.slice(0, 3),
  }, DIRECTOR);
  assert.equal(partial.ok, true);
  assert.equal(partial.data.entries.length, 3);
  assert.equal(partial.data.missing.length, 7);

  const resumed = await post('getDraft', { athleteId }, DIRECTOR);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.entries.length, 3);

  const done = await post('completeAssessment', {
    athleteId, entries: Youth.baseline.entries, idempotencyKey: 'dev-test-complete-06',
  }, DIRECTOR);
  assert.equal(done.ok, true);
  assert.equal(done.data.baseline.complete, true);
  assert.equal(done.data.idempotentReplay, false);
  assert.ok(done.data.schedule.nextDueAt, 'next reassessment is set');

  const replay = await post('completeAssessment', {
    athleteId, entries: Youth.baseline.entries, idempotencyKey: 'dev-test-complete-06',
  }, DIRECTOR);
  assert.equal(replay.ok, true);
  assert.equal(replay.data.idempotentReplay, true);
  assert.equal(replay.data.session.id, done.data.session.id, 'retry records nothing twice');

  const view = await post('athleteAssessmentView', { athleteId }, DIRECTOR);
  assert.equal(view.ok, true);
  assert.equal(view.data.history.length, 1, 'one session, no duplicate');
  assert.equal(view.data.history[0].results.length, 9, 'nine measured results');
  assert.ok(view.data.personalBests['10yd-sprint'], 'personal bests present');
  assert.ok(view.data.progress.tests['10yd-sprint'], 'progress present');

  const readiness = await post('planReadiness', { athleteId }, DIRECTOR);
  assert.equal(readiness.ok, true);
  assert.equal(readiness.data.ready, true);
  const plan = await post('createPlan', { athleteId }, DIRECTOR);
  assert.equal(plan.ok, true);
  const finalized = await post('finalizePlan', { planId: plan.data.id }, DIRECTOR);
  assert.equal(finalized.ok, true);
  assert.equal(finalized.data.status, 'finalized');
});

test('incomplete completion is refused with the missing list, nothing stored', async () => {
  const athleteId = 'dev-ath-01';
  const res = await post('completeAssessment', {
    athleteId, entries: Youth.baseline.entries.slice(0, 1), idempotencyKey: 'dev-test-incomplete-01',
  }, DIRECTOR);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'INCOMPLETE_ASSESSMENT');
  assert.ok(res.error.message.includes('broad-jump'));
  const view = await post('athleteAssessmentView', { athleteId }, DIRECTOR);
  assert.equal(view.data.history.length, 0);
});

test('exclusion lets a baseline complete without the excluded test', async () => {
  const athleteId = 'dev-ath-02';
  const def = await post('recordDeferral', {
    athleteId, scope: 'test', kind: 'exclusion',
    assessmentId: 'broad-jump', reason: 'Ankle sprain — no jumping until cleared',
  }, DIRECTOR);
  assert.equal(def.ok, true);
  const entries = Youth.baseline.entries.filter((e) => e.assessmentId !== 'broad-jump');
  const done = await post('completeAssessment', {
    athleteId, entries, idempotencyKey: 'dev-test-exclusion-02',
  }, DIRECTOR);
  assert.equal(done.ok, true);
  assert.equal(done.data.baseline.complete, true);
  assert.deepEqual(done.data.baseline.excluded, ['broad-jump']);
});

test('plan finalization refuses an unready plan without a recorded override', async () => {
  const athleteId = 'dev-ath-03';
  const plan = await post('createPlan', { athleteId }, DIRECTOR);
  assert.equal(plan.ok, true);
  const refused = await post('finalizePlan', { planId: plan.data.id }, DIRECTOR);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'PLAN_NOT_READY');
  const over = await post('finalizePlan', {
    planId: plan.data.id,
    override: { reason: 'Coach judgement: baseline tests not safe this week', approvedBy: 'dev-director-marcus' },
  }, DIRECTOR);
  assert.equal(over.ok, true);
  assert.equal(over.data.status, 'finalized');
  assert.equal(over.data.overrideReason, 'Coach judgement: baseline tests not safe this week');
});

test('out-of-scope access is forbidden over HTTP', async () => {
  const wrongCoach = await post('startAssessment', { athleteId: 'dev-ath-04' }, KAYLA);
  assert.equal(wrongCoach.ok, false);
  assert.equal(wrongCoach.error.code, 'FORBIDDEN');
  const otherAthlete = await post('athleteAssessmentView', { athleteId: Wingback.athlete.id }, ATHLETE_YOUTH);
  assert.equal(otherAthlete.ok, false);
  assert.equal(otherAthlete.error.code, 'FORBIDDEN');
  const parentWrite = await post('recordAttempts', { athleteId: Youth.athlete.id, entries: [] }, PARENT_YOUTH);
  assert.equal(parentWrite.ok, false);
  assert.equal(parentWrite.error.code, 'FORBIDDEN');
});

test('unknown method, malformed JSON, and traversal are rejected', async () => {
  const unknown = await fetch(base + '/api/assessments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...DIRECTOR },
    body: JSON.stringify({ method: 'noSuchMethod', params: {} }),
  });
  assert.equal(unknown.status, 400);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.ok, false);
  assert.equal(unknownBody.error.code, 'INVALID_METHOD');
  const bad = await fetch(base + '/api/assessments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
  });
  assert.equal(bad.status, 400);
  const traversal = await fetch(base + '/..%2fpackage.json');
  assert.ok(traversal.status === 400 || traversal.status === 404);
  assert.ok(!(await traversal.text()).includes('the-program-os-server'), 'traversal must not leak repo files');
  const missing = await fetch(base + '/no-such-file.js');
  assert.equal(missing.status, 404);
});
