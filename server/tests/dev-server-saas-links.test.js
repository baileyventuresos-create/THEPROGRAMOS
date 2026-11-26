/* Dev-server SaaS -> assessment directory integration (dev only).
 * Run: node --test server/tests/dev-server-saas-links.test.js
 *
 * Proves the frontend-slice integration wiring: SaaS links created
 * through POST /api/saas appear in the dev assessment directory
 * immediately (linked coach can assess/view; org_admin views but
 * never assesses; cross-tenant stays refused), and SaaS-registered
 * remote athletes are assessable in dev. Localhost-only, memory
 * stores, synthetic data.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDevServer } = require('../dev-server');

async function post(base, pathName, body, headers = {}) {
  const res = await fetch(base + pathName, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('dev server: SaaS-registered athlete + linked coach appear in assessment flows', async () => {
  const dev = createDevServer({ port: 0, seed: true });
  await dev.start();
  try {
    const base = dev.url;
    const coach = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-remote' };
    const athlete = { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'dev-ath-remote' };

    // Register a remote coach (trial) and a remote adult athlete.
    const coachReg = await post(base, '/api/saas', {
      method: 'registerCoach', params: { email: 'remote-coach@dev.invalid', name: 'Remote Coach' },
    }, coach);
    assert.equal(coachReg.json.ok, true, JSON.stringify(coachReg.json));

    const athReg = await post(base, '/api/saas', {
      method: 'registerAthlete', params: { email: 'remote-ath@dev.invalid', name: 'Remote Athlete', age: 26 },
    }, athlete);
    assert.equal(athReg.json.ok, true, JSON.stringify(athReg.json));
    const athleteId = athReg.json.data.athlete.id;

    // Before linking, the coach cannot see the athlete in assessments.
    const before = await post(base, '/api/assessments', { method: 'listAthletes', params: {} }, coach);
    assert.equal(before.json.ok, true);
    assert.ok(!before.json.data.some(a => a.id === athleteId), 'unlinked athlete is invisible');

    // Link through the SaaS API.
    const linked = await post(base, '/api/saas', {
      method: 'linkAthlete', params: { athleteId },
    }, coach);
    assert.equal(linked.json.ok, true, JSON.stringify(linked.json));

    // Now the linked athlete appears in the assessment roster and
    // the coach can start an assessment for them.
    const after = await post(base, '/api/assessments', { method: 'listAthletes', params: {} }, coach);
    assert.equal(after.json.ok, true);
    assert.ok(after.json.data.some(a => a.id === athleteId), 'linked athlete appears in assessment roster');

    const started = await post(base, '/api/assessments', {
      method: 'startAssessment', params: { athleteId },
    }, coach);
    assert.equal(started.json.ok, true, JSON.stringify(started.json));

    // Cross-tenant: an unlinked coach still cannot view them.
    const other = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-jordan' };
    const cross = await post(base, '/api/assessments', {
      method: 'athleteAssessmentView', params: { athleteId },
    }, other);
    assert.equal(cross.json.ok, false);
    assert.equal(cross.json.error.code, 'FORBIDDEN');

    // The athlete themself can view their own (empty) assessment record.
    const selfView = await post(base, '/api/assessments', {
      method: 'athleteAssessmentView', params: { athleteId },
    }, { ...athlete, 'X-Dev-Athlete': athleteId });
    assert.equal(selfView.json.ok, true, JSON.stringify(selfView.json));
  } finally {
    await dev.close();
  }
});

test('dev server: org_admin views (never assesses) athletes linked inside their org', async () => {
  const dev = createDevServer({ port: 0, seed: true });
  await dev.start();
  try {
    const base = dev.url;
    const founder = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-founder' };
    const athlete = { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'dev-ath-org' };

    const coachReg = await post(base, '/api/saas', {
      method: 'registerCoach', params: { email: 'founder@dev.invalid', name: 'Founder Coach' },
    }, founder);
    assert.equal(coachReg.json.ok, true, JSON.stringify(coachReg.json));
    const orgId = coachReg.json.data.organization.id;

    const athReg = await post(base, '/api/saas', {
      method: 'registerAthlete', params: { email: 'org-ath@dev.invalid', name: 'Org Athlete', age: 19 },
    }, athlete);
    assert.equal(athReg.json.ok, true, JSON.stringify(athReg.json));
    const athleteId = athReg.json.data.athlete.id;

    const linked = await post(base, '/api/saas', {
      method: 'linkAthlete', params: { athleteId, organizationId: orgId },
    }, founder);
    assert.equal(linked.json.ok, true, JSON.stringify(linked.json));

    // The founder is org_admin of their solo org. The access
    // directory grants org_admin VIEW (never assess) over athletes
    // linked inside their orgs (server/assessment-access.js), and
    // the directory wiring above carries the live links. The
    // assessment API role table (server/assessment-api.js ALLOWED,
    // mirrored in the Edge Function) now grants org_admin the READ
    // methods only (SaaS validation fix, 2026-11-20): view succeeds
    // in-org, every recording/writing method stays FORBIDDEN, and
    // athletes outside the org stay invisible.
    const admin = { 'X-Dev-Role': 'org_admin', 'X-Dev-User': 'dev-coach-founder' };
    const view = await post(base, '/api/assessments', {
      method: 'athleteAssessmentView', params: { athleteId },
    }, admin);
    assert.equal(view.json.ok, true, JSON.stringify(view.json));
    assert.equal(view.json.data.athleteId, athleteId);

    const listed = await post(base, '/api/assessments', { method: 'listAthletes', params: {} }, admin);
    assert.equal(listed.json.ok, true, JSON.stringify(listed.json));
    assert.ok(listed.json.data.some(a => a.id === athleteId), 'org_admin lists in-org linked athlete');
    assert.ok(!listed.json.data.some(a => a.id === 'ath-synth-youth-12'), 'org_admin does not list out-of-org athletes');

    const readiness = await post(base, '/api/assessments', {
      method: 'planReadiness', params: { athleteId },
    }, admin);
    assert.equal(readiness.json.ok, true, JSON.stringify(readiness.json));

    const advisory = await post(base, '/api/assessments', {
      method: 'advisoryPriorities', params: { athleteId },
    }, admin);
    assert.equal(advisory.json.ok, true, JSON.stringify(advisory.json));

    // Out-of-org athlete (seeded youth, different org) stays refused.
    const outside = await post(base, '/api/assessments', {
      method: 'athleteAssessmentView', params: { athleteId: 'ath-synth-youth-12' },
    }, admin);
    assert.equal(outside.json.ok, false);
    assert.equal(outside.json.error.code, 'FORBIDDEN', 'org_admin cannot view athletes outside their org');

    // Read-only scope: every recording/writing method is refused.
    for (const method of ['startAssessment', 'recordAttempts', 'getDraft', 'discardDraft',
      'completeAssessment', 'coachDashboard', 'recordDeferral', 'createPlan', 'finalizePlan']) {
      const res = await post(base, '/api/assessments', {
        method, params: { athleteId, planId: 'any-plan', entries: [] },
      }, admin);
      assert.equal(res.json.ok, false, `${method} must refuse org_admin`);
      assert.equal(res.json.error.code, 'FORBIDDEN', `${method} refuses org_admin (read-only scope)`);
    }

    const assess = await post(base, '/api/assessments', {
      method: 'startAssessment', params: { athleteId },
    }, admin);
    assert.equal(assess.json.ok, false);
    assert.equal(assess.json.error.code, 'FORBIDDEN', 'org_admin never assesses');

    // Directory-level proof that the link scope itself is wired:
    // the founder as COACH (their linked-coach scope) sees them.
    const asCoach = await post(base, '/api/assessments', {
      method: 'athleteAssessmentView', params: { athleteId },
    }, founder);
    assert.equal(asCoach.json.ok, true, JSON.stringify(asCoach.json));
  } finally {
    await dev.close();
  }
});
