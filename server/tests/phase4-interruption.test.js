/* Phase 4 — network interruption + retry, composed client <-> dev server.
 * Run: node --test server/tests/phase4-interruption.test.js
 *
 * The client-level retry tests (assessment-client.test.js) use a stubbed
 * fetch, and the workflow tests (assessment-workflow.test.js) call the
 * workflow directly. Neither proves the two halves compose: a request
 * whose response is LOST after the server already recorded must be
 * retried with the same idempotency key and replay the original
 * session — never a second session, never a partial recording.
 *
 * These tests exercise the real AssessmentClient against the real dev
 * server over real HTTP, with a fetch wrapper that faults exactly one
 * attempt (dropped response after the server processed, or a synthetic
 * HTTP 500 that never reaches the server). Synthetic data only, memory
 * stores only; nothing touches a live database.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDevServer } = require('../dev-server');
const { createAssessmentClient } = require('../../assessment-ui/assessment-client');
const Youth = require('../fixtures/synthetic-youth-12');

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

/* Fetch wrapper that faults exactly one call to `dropMethod`:
 *  - 'drop': let the request reach the server and be processed, then
 *    throw before the caller sees the response (lost response).
 *  - 'fail500': answer HTTP 500 without ever calling the server.
 * Records every idempotency key the client sends, so the test can
 * prove the retry reused the same key instead of minting a new one. */
function makeFlakyFetch({ dropMethod = null, fail500Method = null } = {}) {
  const seenKeys = [];
  const calls = {};
  async function flaky(url, init) {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && typeof body.method === 'string') {
      calls[body.method] = (calls[body.method] || 0) + 1;
      if (body.params && body.params.idempotencyKey) seenKeys.push(body.params.idempotencyKey);
      if (body.method === dropMethod && calls[body.method] === 1) {
        const res = await fetch(url, init); // server records; response is lost
        await res.text();
        throw new Error('simulated network drop: response lost after the server recorded');
      }
      if (body.method === fail500Method && calls[body.method] === 1) {
        return { status: 500, json: async () => ({ ok: false }) };
      }
    }
    return fetch(url, init);
  }
  flaky.seenKeys = seenKeys;
  flaky.calls = calls;
  return flaky;
}

function coachClient(fetchImpl) {
  return createAssessmentClient({
    endpoint: base + '/api/assessments',
    devRole: 'director',
    devUser: 'dev-director-marcus',
    fetchImpl,
    retryDelayMs: 0,
  });
}

test('lost complete response: retry replays the original session, exactly one session', async () => {
  const athleteId = 'dev-ath-06';
  const flaky = makeFlakyFetch({ dropMethod: 'completeAssessment' });
  const client = coachClient(flaky);

  const started = await client.startAssessment({ athleteId });
  assert.equal(started.missing.length, 10, 'nine measured + movement');

  const done = await client.completeAssessment({ athleteId, entries: Youth.baseline.entries });
  assert.equal(done.baseline.complete, true, 'baseline established despite the lost response');
  assert.equal(done.idempotentReplay, true, 'the retry replayed the first attempt');
  assert.ok(done.schedule.nextDueAt, 'next reassessment is set');
  assert.equal(flaky.calls.completeAssessment, 2, 'one dropped attempt + one retry');
  assert.equal(flaky.seenKeys.length, 2, 'both attempts carried a key');
  assert.equal(flaky.seenKeys[0], flaky.seenKeys[1], 'retry reused the same idempotency key');

  const view = await client.athleteAssessmentView({ athleteId });
  assert.equal(view.history.length, 1, 'exactly one session — the retry recorded nothing twice');
  assert.equal(view.history[0].sessionId, done.session.id, 'the replayed session is the recorded one');
  assert.equal(view.history[0].results.length, 9, 'nine measured results, nothing partial');
});

test('HTTP 500 on the first complete attempt is retried and records once', async () => {
  const athleteId = 'dev-ath-01';
  const flaky = makeFlakyFetch({ fail500Method: 'completeAssessment' });
  const client = coachClient(flaky);

  await client.startAssessment({ athleteId });
  const done = await client.completeAssessment({ athleteId, entries: Youth.baseline.entries });
  assert.equal(done.baseline.complete, true);
  assert.equal(done.idempotentReplay, false, 'the 500 never reached the server, so the retry was the first recording');
  assert.equal(flaky.calls.completeAssessment, 2, 'one fake 500 + one real attempt');
  assert.equal(flaky.seenKeys[0], flaky.seenKeys[1], 'retry reused the same idempotency key');

  const view = await client.athleteAssessmentView({ athleteId });
  assert.equal(view.history.length, 1, 'exactly one session');
  assert.equal(view.history[0].sessionId, done.session.id);
});

test('lost draft-save response: retry replays the same draft, no duplicate draft', async () => {
  const athleteId = 'dev-ath-02';
  const flaky = makeFlakyFetch({ dropMethod: 'recordAttempts' });
  const client = coachClient(flaky);

  await client.startAssessment({ athleteId });
  const saved = await client.recordAttempts({ athleteId, entries: Youth.baseline.entries.slice(0, 3) });
  assert.equal(saved.entries.length, 3, 'partial save landed despite the lost response');
  assert.equal(flaky.calls.recordAttempts, 2, 'one dropped attempt + one retry');
  assert.equal(flaky.seenKeys[0], flaky.seenKeys[1], 'retry reused the same idempotency key');

  const draft = await client.getDraft({ athleteId });
  assert.equal(draft.entries.length, 3, 'one draft with the three entries — no duplicate draft');

  const done = await client.completeAssessment({ athleteId, entries: Youth.baseline.entries });
  assert.equal(done.baseline.complete, true, 'workflow still completes after the interrupted save');
  const view = await client.athleteAssessmentView({ athleteId });
  assert.equal(view.history.length, 1, 'exactly one session');
});
