/* Dev-server SaaS endpoints over real HTTP (development only).
 * Run: node --test server/tests/dev-server-saas.test.js
 * Boots the real dev server on an ephemeral port with synthetic
 * seed data and exercises POST /api/saas, POST /api/billing, and
 * GET /api/saas/plans end to end. Localhost-only, memory stores.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDevServer } = require('../dev-server');
const Youth = require('../fixtures/synthetic-youth-12');
const Wingback = require('../fixtures/synthetic-wingback-48');
const YOUTH_ID = Youth.athlete.id;
const WINGBACK_ID = Wingback.athlete.id;

async function post(base, pathName, body, headers = {}) {
  const res = await fetch(base + pathName, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('dev server: plans, entitlements, assignment loop, billing guard over HTTP', async () => {
  const dev = createDevServer({ port: 0, seed: true });
  await dev.start();
  try {
    const base = dev.url;
    const coach = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-kayla' };
    const athlete = { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'dev-athlete-youth', 'X-Dev-Athlete': YOUTH_ID };

    const plansRes = await fetch(base + '/api/saas/plans', { headers: coach });
    const plans = await plansRes.json();
    assert.equal(plans.ok, true);
    assert.ok(plans.data.plans.some(p => p.code === 'coach_starter' && p.limits.maxAthletes === 15));

    // Kayla's roster includes her cohort athletes (seeded links).
    const roster = await post(base, '/api/saas', { method: 'myRoster', params: {} }, coach);
    assert.equal(roster.json.ok, true);
    assert.ok(roster.json.data.count >= 1);

    // Assignment loop: coach assigns, athlete completes, history joins.
    const created = await post(base, '/api/saas', {
      method: 'createAssignment',
      params: { athleteId: YOUTH_ID, title: 'Dev speed day', gameIds: ['TP2-001'], build: 'LEARN', dose: { rounds: 3 } },
    }, coach);
    assert.equal(created.json.ok, true, JSON.stringify(created.json));
    const assignmentId = created.json.data.assignment.id;

    const completed = await post(base, '/api/saas', {
      method: 'completeAssignment',
      params: { assignmentId, durationMin: 20, effortRpe: 6 },
    }, athlete);
    assert.equal(completed.json.ok, true, JSON.stringify(completed.json));

    const history = await post(base, '/api/saas', { method: 'athleteHistory', params: {} }, athlete);
    assert.equal(history.json.ok, true);
    assert.equal(history.json.data.completions.length, 1);
    assert.ok(history.json.data.assessments.length >= 1, 'seeded assessment history joins over HTTP');

    // Safety Review game rejected over HTTP with the stable code.
    const blocked = await post(base, '/api/saas', {
      method: 'createAssignment',
      params: { athleteId: YOUTH_ID, title: 'Nope', gameIds: ['TP2-084'] },
    }, coach);
    assert.equal(blocked.json.ok, false);
    assert.equal(blocked.json.error.code, 'GAME_NOT_ASSIGNABLE');

    // Cross-tenant over HTTP: Jordan cannot read Kayla's athlete.
    const jordan = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-jordan' };
    const cross = await post(base, '/api/saas', {
      method: 'athleteHistory', params: { athleteId: YOUTH_ID },
    }, jordan);
    assert.equal(cross.json.ok, false);
    assert.equal(cross.json.error.code, 'ATHLETE_NOT_FOUND');

    // Billing: the wingback holds a $149 membership -> ALREADY_COVERED.
    const checkout = await post(base, '/api/billing', {
      method: 'createCheckoutSession',
      params: { ownerType: 'athlete', ownerId: WINGBACK_ID, planCode: 'athlete_remote' },
    }, { 'X-Dev-Role': 'director', 'X-Dev-User': 'dev-director-marcus' });
    assert.equal(checkout.json.ok, false);
    assert.equal(checkout.json.error.code, 'ALREADY_COVERED');
    assert.equal(checkout.json.error.coveringSource, 'in_person_membership');

    // Unknown method rejected.
    const bad = await post(base, '/api/saas', { method: 'nope', params: {} }, coach);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'INVALID_METHOD');
  } finally {
    await dev.close();
  }
});
