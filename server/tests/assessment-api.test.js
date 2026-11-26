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

/* org_admin read-only scope (SaaS validation fix, 2026-11-20):
 * the role table grants org_admin the read methods only, and the
 * access directory scopes those reads to athletes linked inside
 * orgs the caller admins. Recording stays coach/director. */
const ORG_ADMIN = { authUserId: 'auth-org-admin', role: 'org_admin' };
const ORG_ADMIN_OUT = { authUserId: 'auth-org-admin-other', role: 'org_admin' };
const ORG_READ_METHODS = ['listAthletes', 'athleteAssessmentView', 'planReadiness', 'advisoryPriorities'];
const ORG_WRITE_METHODS = ['startAssessment', 'recordAttempts', 'getDraft', 'discardDraft',
  'completeAssessment', 'coachDashboard', 'recordDeferral', 'createPlan', 'finalizePlan'];

function freshOrgApi() {
  const directory = createAccessDirectory({
    athletes: [
      { ...Wingback.athlete, coachIds: [], guardianUserIds: [], authUserId: 'athlete-wingback-uid' },
      { ...Youth.athlete, coachIds: [], guardianUserIds: ['parent-youth-uid'], authUserId: 'athlete-youth-uid' },
    ],
    coachAuth: { 'auth-coach-marcus': 'coach-marcus' },
    links: [
      { coachId: 'coach-marcus', athleteId: W, organizationId: 'org-1', status: 'active' },
      { coachId: 'coach-other', athleteId: Y, organizationId: 'org-2', status: 'active' },
    ],
    orgMemberships: [
      { authUserId: 'auth-org-admin', organizationId: 'org-1', orgRole: 'org_admin', status: 'active' },
      { authUserId: 'auth-org-admin-other', organizationId: 'org-2', orgRole: 'org_admin', status: 'active' },
    ],
  });
  const wf = createAssessmentWorkflow({
    store: new MemoryAssessmentStore(), reassessmentStore: new MemoryReassessmentStore(),
    planStore: new MemoryPlanStore(), directory,
  });
  return { api: createAssessmentApi({ workflow: wf }), wf };
}

test('org_admin is granted on exactly the read methods, never on writes', () => {
  for (const method of ORG_READ_METHODS) {
    assert.ok(ALLOWED[method].includes('org_admin'), `${method} allows org_admin (read)`);
  }
  for (const method of ORG_WRITE_METHODS) {
    assert.ok(!ALLOWED[method].includes('org_admin'), `${method} must not allow org_admin`);
  }
});

test('org_admin views assessments of athletes linked inside their org', async () => {
  const { api } = freshOrgApi();
  const view = await api.athleteAssessmentView(ORG_ADMIN, { athleteId: W });
  assert.equal(view.athleteId, W);
  const listed = api.listAthletes(ORG_ADMIN);
  assert.deepEqual(listed.map(a => a.id), [W], 'only the in-org linked athlete is listed');
  const readiness = await api.planReadiness(ORG_ADMIN, { athleteId: W });
  assert.equal(readiness.athleteId, W);
  const advisory = await api.advisoryPriorities(ORG_ADMIN, { athleteId: W });
  assert.equal(advisory.athleteId, W);
});

test('org_admin cannot see athletes outside their org', async () => {
  const { api } = freshOrgApi();
  await assert.rejects(() => api.athleteAssessmentView(ORG_ADMIN, { athleteId: Y }), e => e.code === 'FORBIDDEN');
  await assert.rejects(() => api.planReadiness(ORG_ADMIN, { athleteId: Y }), e => e.code === 'FORBIDDEN');
  await assert.rejects(() => api.advisoryPriorities(ORG_ADMIN, { athleteId: Y }), e => e.code === 'FORBIDDEN');
  // The other org's admin sees only their own org's athlete.
  const otherView = await api.athleteAssessmentView(ORG_ADMIN_OUT, { athleteId: Y });
  assert.equal(otherView.athleteId, Y);
  await assert.rejects(() => api.athleteAssessmentView(ORG_ADMIN_OUT, { athleteId: W }), e => e.code === 'FORBIDDEN');
});

test('org_admin cannot record, draft, defer, or plan (read-only scope)', async () => {
  const { api } = freshOrgApi();
  for (const method of ORG_WRITE_METHODS) {
    await assert.rejects(
      () => api[method](ORG_ADMIN, { athleteId: W, planId: 'any-plan', entries: Wingback.baseline.entries }),
      e => e.code === 'FORBIDDEN', `${method} forbids org_admin`);
  }
});

test('invalid input is rejected before any workflow call', async () => {
  const { api } = freshApi();
  await assert.rejects(() => api.completeAssessment(COACH, {}), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => api.recordAttempts(COACH, { athleteId: W }), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => api.finalizePlan(COACH, {}), e => e.code === 'INVALID_INPUT');
  assert.throws(() => createAssessmentApi({}), /requires a workflow/);
});
