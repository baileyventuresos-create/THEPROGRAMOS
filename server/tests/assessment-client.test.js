/* Tests for the assessment transport adapter (assessment-ui/assessment-client.js).
 * Node only — the browser never re-implements workflow logic, so the
 * adapter is fully testable here with a fake fetch. No network, no
 * credentials, no live service.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAssessmentClient, METHODS } = require('../../assessment-ui/assessment-client');

function jsonResponse(status, payload) {
  return { status, json: async () => payload };
}

test('client exposes exactly the 13 API-contract methods', () => {
  const client = createAssessmentClient({ fetchImpl: async () => jsonResponse(200, { ok: true, data: {} }) });
  assert.deepEqual(client.methods, [
    'listAthletes', 'startAssessment', 'recordAttempts', 'getDraft',
    'discardDraft', 'completeAssessment', 'athleteAssessmentView',
    'coachDashboard', 'recordDeferral', 'planReadiness', 'createPlan',
    'finalizePlan', 'advisoryPriorities',
  ]);
  assert.deepEqual(METHODS, client.methods);
  for (const m of METHODS) assert.equal(typeof client[m], 'function', m);
});

test('call POSTs {method,params} and returns data on {ok:true}', async () => {
  const seen = [];
  const client = createAssessmentClient({
    endpoint: 'http://dev/api/assessments',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(200, { ok: true, data: { athletes: [{ id: 'a1' }] } });
    },
  });
  const data = await client.listAthletes({});
  assert.deepEqual(data, { athletes: [{ id: 'a1' }] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://dev/api/assessments');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(JSON.parse(seen[0].init.body).method, 'listAthletes');
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json');
});

test('call surfaces the server error code and never retries application errors', async () => {
  let calls = 0;
  const client = createAssessmentClient({
    fetchImpl: async () => {
      calls++;
      return jsonResponse(403, { ok: false, error: { code: 'FORBIDDEN', message: 'not your athlete' } });
    },
  });
  await assert.rejects(
    client.startAssessment({ athleteId: 'a1' }),
    (e) => e.code === 'FORBIDDEN' && /not your athlete/.test(e.message),
  );
  assert.equal(calls, 1, 'application error must not be retried');
});

test('unknown method is rejected without a fetch', async () => {
  let calls = 0;
  const client = createAssessmentClient({
    fetchImpl: async () => { calls++; return jsonResponse(200, { ok: true, data: {} }); },
  });
  await assert.rejects(client.call('deleteEverything', {}), (e) => e.code === 'INVALID_METHOD');
  assert.equal(calls, 0);
});

test('network failure is retried and the same idempotency key is reused for completeAssessment', async () => {
  const keys = [];
  let calls = 0;
  const client = createAssessmentClient({
    retryDelayMs: 0,
    generateId: () => 'fixed-key-1',
    fetchImpl: async (url, init) => {
      calls++;
      keys.push(JSON.parse(init.body).params.idempotencyKey);
      if (calls < 3) throw new Error('socket hang up');
      return jsonResponse(200, { ok: true, data: { session: { id: 's1' }, idempotentReplay: false } });
    },
  });
  const data = await client.completeAssessment({ athleteId: 'a1', entries: [] });
  assert.equal(data.session.id, 's1');
  assert.equal(calls, 3);
  assert.deepEqual(keys, ['fixed-key-1', 'fixed-key-1', 'fixed-key-1']);
});

test('a caller-supplied idempotency key is reused on retry, not replaced', async () => {
  const keys = [];
  let calls = 0;
  const client = createAssessmentClient({
    retryDelayMs: 0,
    fetchImpl: async (url, init) => {
      calls++;
      keys.push(JSON.parse(init.body).params.idempotencyKey);
      if (calls === 1) throw new Error('reset');
      return jsonResponse(200, { ok: true, data: {} });
    },
  });
  await client.recordAttempts({ athleteId: 'a1', entries: [] }, { idempotencyKey: 'caller-key-9' });
  assert.deepEqual(keys, ['caller-key-9', 'caller-key-9']);
});

test('HTTP 500 is retried, HTTP 400 is not', async () => {
  let calls500 = 0;
  const c500 = createAssessmentClient({
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls500++;
      return calls500 === 1
        ? jsonResponse(500, { ok: false, error: { code: 'HTTP_500', message: 'boom' } })
        : jsonResponse(200, { ok: true, data: { ok: 1 } });
    },
  });
  assert.deepEqual(await c500.listAthletes({}), { ok: 1 });
  assert.equal(calls500, 2);

  let calls400 = 0;
  const c400 = createAssessmentClient({
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls400++;
      return jsonResponse(400, { ok: false, error: { code: 'INVALID_INPUT', message: 'bad input' } });
    },
  });
  await assert.rejects(c400.listAthletes({}), (e) => e.code === 'INVALID_INPUT');
  assert.equal(calls400, 1);
});

test('after retries are exhausted the last error is thrown', async () => {
  let calls = 0;
  const client = createAssessmentClient({
    retryDelayMs: 0,
    fetchImpl: async () => { calls++; throw new Error('down'); },
  });
  await assert.rejects(client.listAthletes({}), (e) => e.code === 'NETWORK_ERROR');
  assert.equal(calls, 3, 'initial attempt + 2 retries');
});

test('getBattery fetches the read-only protocol route and validates its shape', async () => {
  const client = createAssessmentClient({
    endpoint: '/api/assessments/',
    fetchImpl: async (url, init) => {
      assert.equal(url, '/api/assessments/battery');
      assert.equal(init.method, 'GET');
      return jsonResponse(200, { protocolVersion: 'gaa-v1', retestDays: 28, tests: [{ id: '10yd-sprint' }] });
    },
  });
  const battery = await client.getBattery();
  assert.equal(battery.protocolVersion, 'gaa-v1');
  assert.equal(battery.tests.length, 1);

  const bad = createAssessmentClient({
    fetchImpl: async () => jsonResponse(200, { protocolVersion: 'gaa-v1' }),
  });
  await assert.rejects(bad.getBattery(), (e) => e.code === 'INVALID_RESPONSE');

  const missing = createAssessmentClient({
    fetchImpl: async () => jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'no route' } }),
  });
  await assert.rejects(missing.getBattery(), (e) => e.code === 'HTTP_404');
});

test('probe returns true when the service answers, false when it does not, and never throws', async () => {
  const up = createAssessmentClient({
    fetchImpl: async () => jsonResponse(200, { ok: true, data: [] }),
  });
  assert.equal(await up.probe(), true);
  const down = createAssessmentClient({
    fetchImpl: async () => { throw new Error('refused'); },
  });
  assert.equal(await down.probe(), false);
  const forbidden = createAssessmentClient({
    fetchImpl: async () => jsonResponse(403, { ok: false, error: { code: 'FORBIDDEN', message: 'no' } }),
  });
  assert.equal(await forbidden.probe(), false);
});

test('getToken adds a Bearer header; dev headers are passed through when configured', async () => {
  let seenHeaders;
  const client = createAssessmentClient({
    getToken: () => 'jwt-123',
    devRole: 'coach',
    devUser: 'dev-coach-1',
    fetchImpl: async (url, init) => {
      seenHeaders = init.headers;
      return jsonResponse(200, { ok: true, data: {} });
    },
  });
  await client.listAthletes({});
  assert.equal(seenHeaders.Authorization, 'Bearer jwt-123');
  assert.equal(seenHeaders['X-Dev-Role'], 'coach');
  assert.equal(seenHeaders['X-Dev-User'], 'dev-coach-1');
});
