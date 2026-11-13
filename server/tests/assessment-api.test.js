/* Assessment API authorization tests (development only).
 * Run: node --test server/tests/assessment-api.test.js
 *
 * Proves the thin API layer (server/assessment-api.js) enforces the
 * same auth model as server/api.js: auth context first, actor always
 * the auth UID, role table per method, and workflow-level scoping
 * (coach only for their own cohort athletes). Synthetic athletes
 * only, in-memory stores, no live database.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Wingback = require('../fixtures/synthetic-wingback-48');
const Youth = require('../fixtures/synthetic-youth-12');
const { MemoryAssessmentStore } = require('../assessment-store');
const { MemoryReassessmentStore } = require('../reassessment');
const { createAccessDirectory } = require('../assessment-access');
const { createAssessmentWorkflow, MemoryPlanStore } = require('../assessment-workflow');
const { createAssessmentApi, ALLOWED } = require('../assessment-api');

const W = Wingback.athlete.id;
const Y = Youth.athlete.id;
const COACH = { authUserId: 'auth-coach-marcus', role: 'coach', coachId: 'coach-marcus' };
const COACH_OTHER = { authUserId: 'auth-coach-other', role: 'coach', coachId: 'coach-other' };
const DIRECTOR = { authUserId: 'auth-director', role: 'director' };
const PARENT = { authUserId: 'parent-youth-uid', role: 'parent' };
const ATHLETE = { authUserId: 'athlete-wingback-uid', role: 'athlete' };
const ANON = { authUserId: '', role: 'coach' };
const NO_AUTH = null;

function freshApi() {
  const directory = createAccessDirectory({
    athletes: [
      { ...Wingback.athlete, coachIds: ['coach-marcus'], guardianUserIds: [], authUserId: 'athlete-wingback-uid' },
      { ...Youth.athlete, coachIds: ['coach-marcus'], guardianUserIds: ['parent-youth-uid'], authUserId: 'athlete-youth-uid' },
    ],
    coachAuth: { 'auth-coach-marcus': 'coach-marcus', 'auth-coach-other': 'coach-other' },
  });
  const wf = createAssessmentWorkflow({
    store: new MemoryAssessmentStore(), reassessmentStore: new MemoryReassessmentStore(),
    planStore: new MemoryPlanStore(), directory,
  });
  return { api: createAssessmentApi({ workflow: wf }), wf };
}

test('role table: recording methods are coach/director only', async () => {
  const { api } = freshApi();
  for (const method of ['startAssessment', 'recordAttempts', 'completeAssessment', 'createPlan', 'finalizePlan']) {
    await assert.rejects(() => api[method](PARENT, { athleteId: Y }), e => e.code === 'FORBIDDEN', `${method} forbids parent`);
    await assert.rejects(() => api[method](ATHLETE, { athleteId: W }), e => e.code === 'FORBIDDEN', `${method} forbids athlete`);
  }
  // Reading is open to parent (own) and athlete (self).
  const view = await api.athleteAssessmentView(PARENT, { athleteId: Y });
  assert.equal(view.athleteId, Y);
  await assert.rejects(() => api.athleteAssessmentView(PARENT, { athleteId: W }), e => e.code === 'FORBIDDEN');
});

test('unauthenticated callers are rejected on every method', async () => {
  const { api } = freshApi();
  for (const method of Object.keys(ALLOWED)) {
    // Wrap in an async arrow: listAthletes is synchronous, and
    // assert.rejects only catches promise rejections, not sync throws.
    await assert.rejects(async () => api[method](NO_AUTH, { athleteId: W }), e => e.code === 'UNAUTHENTICATED', `${method} rejects null auth`);
    await assert.rejects(async () => api[method](ANON, { athleteId: W }), e => e.code === 'UNAUTHENTICATED', `${method} rejects empty authUserId`);
  }
});

test('a coach outside the cohort is forbidden even though the role is allowed', async () => {
  const { api } = freshApi();
  await assert.rejects(() => api.startAssessment(COACH_OTHER, { athleteId: W }), e => e.code === 'FORBIDDEN');
  await assert.rejects(() => api.athleteAssessmentView(COACH_OTHER, { athleteId: W }), e => e.code === 'FORBIDDEN');
  const dash = await api.coachDashboard(COACH_OTHER, {});
  assert.deepEqual(dash.athletes, [], 'out-of-cohort coach sees no athletes');
  assert.deepEqual(dash.reminders.neverAssessed, [], 'and no reminders for them');
});

test('a client-supplied actor is ignored: the recorded coach is always the auth UID', async () => {
  const { api, wf } = freshApi();
  const done = await api.completeAssessment(
    { ...COACH, actor: 'coach-other' }, // forged actor in the auth object AND params
    { athleteId: W, entries: Wingback.baseline.entries, idempotencyKey: 'api-actor-spoof',
      actor: 'coach-other', now: Wingback.baseline.recordedAt });
  assert.equal(done.session.coachId, 'coach-marcus', 'session names the authenticated coach, not the forged actor');
  const view = await wf.athleteAssessmentView(COACH, { athleteId: W, now: Wingback.baseline.recordedAt });
  assert.equal(view.history[0].coachId, 'coach-marcus');
});

test('invalid input is rejected before any workflow call', async () => {
  const { api } = freshApi();
  await assert.rejects(() => api.completeAssessment(COACH, {}), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => api.recordAttempts(COACH, { athleteId: W }), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => api.finalizePlan(COACH, {}), e => e.code === 'INVALID_INPUT');
  assert.throws(() => createAssessmentApi({}), /requires a workflow/);
});
