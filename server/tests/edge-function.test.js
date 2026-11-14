/* Edge Function verification tests (development only).
 * Run: node --test server/tests/edge-function.test.js
 *
 * Proves the Supabase Edge Function (supabase/functions/
 * assessment-api/*.ts) against the same contract as the Node server:
 * the TypeScript dispatch layer (api.ts) enforces the same role
 * table and auth rules as server/assessment-api.js; the PostgREST
 * store adapters (store.ts) map modified/capped and idempotency
 * keys to the exact columns migration 005 added; the directory
 * builder (directory.ts) maps a verified JWT to the same access
 * rules as server/assessment-access.js; and the HTTP entrypoint
 * (index.ts) serves GET …/battery and dispatches POST methods with
 * the same error codes — all without a live project, a Deno runtime,
 * or any network.
 *
 * How the Deno-only parts run in Node:
 *   - Node 24 type-strips the .ts modules on import (they use only
 *     erasable syntax); api.ts / store.ts / directory.ts /
 *     workflow.ts import nothing at runtime except types.
 *   - index.ts imports createClient from esm.sh, which Node cannot
 *     resolve: edge-function-hooks.mjs maps that one specifier to
 *     the local stub, which returns the fake Supabase client
 *     (fake-supabase.js). Deno.serve / Deno.env are stubbed on
 *     globalThis so the entrypoint's handler can be captured and
 *     driven with real Request/Response objects.
 *   - The workflow bundle (vendor/workflow.bundle.mjs) is generated,
 *     not committed. If it is missing, this file generates it with
 *     `node build.mjs` (esbuild via npx — needs network the first
 *     time); if generation fails, the bundle-dependent tests skip
 *     with the reason recorded instead of failing on a missing
 *     artifact. RLS is NOT enforced by the fake client: the live
 *     RLS policies were verified separately in the §5 live checks;
 *     these tests verify the JavaScript layer the function adds.
 *
 * Synthetic data only, in-memory stores, no live database.
 */
'use strict';

const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { register } = require('node:module');

const Wingback = require('../fixtures/synthetic-wingback-48');
const Youth = require('../fixtures/synthetic-youth-12');
const { GAA_TESTS, GAA_DEFINITION_IDS, GAA_MEASURED_IDS, PROTOCOL_VERSION, BATTERY_ID, RETEST_DAYS } = require('../assessment-battery');
const { MemoryAssessmentStore } = require('../assessment-store');
const { MemoryReassessmentStore } = require('../reassessment');
const { MemoryPlanStore } = require('../assessment-workflow');
const { ALLOWED: SERVER_ALLOWED } = require('../assessment-api');
const { createFakeSupabase, seedDirectoryTables } = require('./fake-supabase');

const FN_DIR = path.join(__dirname, '..', '..', 'supabase', 'functions', 'assessment-api');
const FN = '../../supabase/functions/assessment-api';
const BUNDLE_PATH = path.join(FN_DIR, 'vendor', 'workflow.bundle.mjs');

// The esm.sh import in index.ts lands on the local stub (see
// edge-function-hooks.mjs). Registered before any import of the
// entrypoint; node --test runs this file in its own process.
register('./edge-function-hooks.mjs', pathToFileURL(__filename));

// Deno runtime stub: env for the function's config, serve to capture
// the request handler instead of listening.
let handler = null;
globalThis.Deno = {
  env: {
    get: (k) => (k === 'SUPABASE_URL' ? 'https://test.supabase.co'
      : k === 'SUPABASE_ANON_KEY' ? 'anon-key-test' : ''),
  },
  serve: (h) => { handler = h; },
};

// The bundle is generated, not committed. Generate it when missing or
// stale (any bundle input newer than the bundle), so the tests always
// exercise the current workflow code; if generation fails (no esbuild
// / no network) and a bundle exists, keep the existing one, and the
// bundle-dependent tests skip with the reason recorded instead of
// failing on a missing artifact.
const BUNDLE_INPUTS = [
  'server/assessment-workflow.js', 'server/assessment-access.js',
  'server/assessment-store.js', 'server/assessment-battery.js',
  'server/reassessment.js', 'server/baseline-gating.js', 'server/progress.js',
  'server/smart-draft-adapter.js', 'assessment-engine/assessment-engine.js',
  'supabase/functions/assessment-api/entry.mjs',
];
let bundleOk = fs.existsSync(BUNDLE_PATH);
let bundleError = '';
function bundleIsStale() {
  if (!bundleOk) return true;
  const bundleMtime = fs.statSync(BUNDLE_PATH).mtimeMs;
  return BUNDLE_INPUTS.some((rel) => {
    const p = path.join(__dirname, '..', '..', rel);
    return fs.existsSync(p) && fs.statSync(p).mtimeMs > bundleMtime;
  });
}
if (bundleIsStale()) {
  const built = spawnSync(process.execPath, ['build.mjs'], { cwd: FN_DIR, encoding: 'utf8' });
  bundleOk = built.status === 0 && fs.existsSync(BUNDLE_PATH);
  if (!bundleOk) bundleError = (built.stderr || built.stdout || 'build.mjs failed').trim().slice(0, 200);
}
function bundleTest(name, fn) {
  return test(name, {
    skip: bundleOk ? false : `workflow bundle unavailable (${bundleError || 'run node build.mjs in supabase/functions/assessment-api'})`,
  }, fn);
}

const W = Wingback.athlete.id;
const Y = Youth.athlete.id;
const COACH = { authUserId: 'auth-coach-marcus', role: 'coach', coachId: 'coach-marcus' };
const COACH_OTHER = { authUserId: 'auth-coach-other', role: 'coach', coachId: 'coach-other' };
const DIRECTOR = { authUserId: 'auth-director', role: 'director' };
const PARENT = { authUserId: 'parent-youth-uid', role: 'parent' };
const ATHLETE = { authUserId: 'athlete-wingback-uid', role: 'athlete' };
const ANON = { authUserId: '', role: 'coach' };

let apiTs; let storeTs; let directoryTs; let workflowTs;
function installFake() {
  const fake = createFakeSupabase(seedDirectoryTables(Wingback, Youth));
  globalThis.__fakeSupabase = fake;
  globalThis.__createClientCalls = [];
  return fake;
}
async function callHandler({ method = 'POST', path = '/', token = null, body = undefined } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await handler(new Request(`https://test.supabase.co/functions/v1/assessment-api${path}`, init));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text, cors: res.headers.get('Access-Control-Allow-Origin'), methods: res.headers.get('Access-Control-Allow-Methods') };
}
function freshTsApi() {
  const athletes = [
    { ...Wingback.athlete, coachIds: ['coach-marcus'], guardianUserIds: [], authUserId: 'athlete-wingback-uid' },
    { ...Youth.athlete, coachIds: ['coach-marcus'], guardianUserIds: ['parent-youth-uid'], authUserId: 'athlete-youth-uid' },
  ];
  const directory = {
    athletes,
    coachAuth: { 'auth-coach-marcus': 'coach-marcus', 'auth-coach-other': 'coach-other' },
    byId: new Map(athletes.map((a) => [a.id, a])),
  };
  return workflowTs.loadWorkflow({
    store: new MemoryAssessmentStore(),
    reassessmentStore: new MemoryReassessmentStore(),
    planStore: new MemoryPlanStore(),
  }, directory).then((workflow) => apiTs.createAssessmentApi({ workflow }));
}

before(async () => {
  apiTs = await import(`${FN}/api.ts`);
  storeTs = await import(`${FN}/store.ts`);
  directoryTs = await import(`${FN}/directory.ts`);
  workflowTs = await import(`${FN}/workflow.ts`);
  await import(`${FN}/index.ts`); // Deno.serve stub captures the handler
  assert.equal(typeof handler, 'function', 'index.ts must register a Deno.serve handler');
});

// --- api.ts parity with server/assessment-api.js -----------------------

test('Edge api.ts: ALLOWED role table is identical to the Node server', () => {
  assert.deepEqual(apiTs.ALLOWED, SERVER_ALLOWED);
});

bundleTest('Edge api.ts: recording methods are coach/director only', async () => {
  const api = await freshTsApi();
  // The TS api wrapper throws synchronously for auth/param checks
  // (unlike the async Node api), so assert.rejects needs the async
  // arrow — same convention as server/tests/assessment-api.test.js.
  for (const method of ['startAssessment', 'recordAttempts', 'completeAssessment', 'createPlan', 'finalizePlan']) {
    await assert.rejects(async () => api[method](PARENT, { athleteId: Y }), (e) => e.code === 'FORBIDDEN', `${method} forbids parent`);
    await assert.rejects(async () => api[method](ATHLETE, { athleteId: W }), (e) => e.code === 'FORBIDDEN', `${method} forbids athlete`);
  }
  const view = await api.athleteAssessmentView(PARENT, { athleteId: Y });
  assert.equal(view.athleteId, Y);
  await assert.rejects(() => api.athleteAssessmentView(PARENT, { athleteId: W }), (e) => e.code === 'FORBIDDEN');
});

bundleTest('Edge api.ts: unauthenticated callers are rejected on every method', async () => {
  const api = await freshTsApi();
  for (const method of Object.keys(apiTs.ALLOWED)) {
    await assert.rejects(async () => api[method](null, { athleteId: W }), (e) => e.code === 'UNAUTHENTICATED', `${method} rejects null auth`);
    await assert.rejects(async () => api[method](ANON, { athleteId: W }), (e) => e.code === 'UNAUTHENTICATED', `${method} rejects empty authUserId`);
  }
});

bundleTest('Edge api.ts: a coach outside the cohort is forbidden even though the role is allowed', async () => {
  const api = await freshTsApi();
  await assert.rejects(() => api.startAssessment(COACH_OTHER, { athleteId: W }), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(() => api.athleteAssessmentView(COACH_OTHER, { athleteId: W }), (e) => e.code === 'FORBIDDEN');
  const dash = await api.coachDashboard(COACH_OTHER, {});
  assert.deepEqual(dash.athletes, [], 'out-of-cohort coach sees no athletes');
  assert.deepEqual(dash.reminders.neverAssessed, [], 'and no reminders for them');
});

bundleTest('Edge api.ts: a client-supplied actor is ignored', async () => {
  const api = await freshTsApi();
  const done = await api.completeAssessment(
    { ...COACH, actor: 'coach-other' },
    { athleteId: W, entries: Wingback.baseline.entries, idempotencyKey: 'edge-actor-spoof', actor: 'coach-other', now: Wingback.baseline.recordedAt },
  );
  assert.equal(done.session.coachId, 'coach-marcus', 'session names the authenticated coach, not the forged actor');
});

bundleTest('Edge api.ts: invalid input is rejected before any workflow call', async () => {
  const api = await freshTsApi();
  await assert.rejects(async () => api.completeAssessment(COACH, {}), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(async () => api.recordAttempts(COACH, { athleteId: W }), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(async () => api.finalizePlan(COACH, {}), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => apiTs.createAssessmentApi({}), /requires a workflow/);
});

bundleTest('Edge workflow: duplicate completion with one idempotency key records once', async () => {
  const api = await freshTsApi();
  const params = { athleteId: W, entries: Wingback.baseline.entries, idempotencyKey: 'edge-dup-key', now: Wingback.baseline.recordedAt };
  const first = await api.completeAssessment(COACH, params);
  assert.equal(first.idempotentReplay, false);
  const second = await api.completeAssessment(COACH, params);
  assert.equal(second.idempotentReplay, true, 'retried completion replays instead of recording');
  assert.equal(second.session.id, first.session.id, 'replay returns the original session');
  const view = await api.athleteAssessmentView(COACH, { athleteId: W });
  assert.equal(view.history.length, 1, 'exactly one session in history after the replay');
});

bundleTest('Edge workflow: modified/capped flags round-trip through the view', async () => {
  const api = await freshTsApi();
  const entries = Wingback.baseline.entries.map((e) => {
    if (e.assessmentId === 'push-ups') return { ...e, modified: true, notes: 'Incline push-ups, hands on bench.' };
    if (e.assessmentId === 'side-plank-r') return { ...e, attempts: [120], capped: true };
    return e;
  });
  await api.completeAssessment(COACH, { athleteId: W, entries, idempotencyKey: 'edge-flags-key', now: Wingback.baseline.recordedAt });
  const view = await api.athleteAssessmentView(COACH, { athleteId: W });
  const byId = {};
  for (const r of view.history[0].results) byId[r.assessmentId] = r;
  assert.equal(byId['push-ups'].modified, true, 'modified push-ups stay flagged');
  assert.equal(byId['push-ups'].capped, false);
  assert.equal(byId['side-plank-r'].capped, true, 'capped side plank stays flagged');
  assert.equal(byId['side-plank-r'].result, 120, 'capped result is the cap value, never beyond it');
  assert.equal(byId['broad-jump'].modified, false, 'standard results are not flagged');
  assert.equal(byId['broad-jump'].capped, false);
  // Regression (Phase 3, 2026-11-14): loadData dropped capped /
  // attempts / unit, so history showed no "(capped)" and no unit.
  assert.deepEqual(byId['push-ups'].attempts, [18], 'attempts survive into history');
  assert.equal(byId['push-ups'].unit, 'reps', 'units survive into history');
  assert.deepEqual(byId['side-plank-r'].attempts, [120]);
  assert.equal(byId['side-plank-r'].unit, 'sec');
});

bundleTest('Edge workflow: Smart Draft is advisory-only — no plan is created or changed', async () => {
  const api = await freshTsApi();
  await api.completeAssessment(COACH, { athleteId: W, entries: Wingback.baseline.entries, idempotencyKey: 'edge-draft-key', now: Wingback.baseline.recordedAt });
  const priorities = await api.advisoryPriorities(COACH, { athleteId: W });
  assert.equal(typeof priorities, 'object', 'advisory priorities are returned as read-only evidence');
  assert.equal(priorities.advisoryOnly, true, 'the advisory contract marks the evidence advisory-only');
  assert.equal(priorities.autoRewrite, false, 'and it must never rewrite a program');
  assert.ok(Array.isArray(priorities.priorities), 'priorities are a list inside the advisory object');
  // A plan exists only when a coach explicitly creates one; the
  // advisory call must not create, finalize, or rewrite anything.
  const plan = await api.createPlan(COACH, { athleteId: W });
  assert.equal(plan.status, 'draft', 'plans start as drafts and change only via finalizePlan');
});

// --- battery payload (workflow.ts loadBattery) -------------------------

bundleTest('Edge battery: loadBattery returns the real GAA protocol, same shape as the dev server', async () => {
  const payload = await workflowTs.loadBattery();
  assert.equal(payload.battery, BATTERY_ID);
  assert.equal(payload.protocolVersion, PROTOCOL_VERSION);
  assert.equal(payload.retestDays, RETEST_DAYS);
  assert.equal(payload.tests.length, 8, 'eight tests');
  assert.deepEqual(payload.tests, GAA_TESTS, 'the exact protocol text from server/assessment-battery.js');
  assert.equal(GAA_DEFINITION_IDS.length, 9, 'nine definition ids (movement assessment has none)');
  assert.equal(GAA_MEASURED_IDS.length, 9, 'nine measured slots');
  const bilateral = payload.tests.filter((t) => t.definitionIds.length === 2).map((t) => t.id);
  assert.deepEqual(bilateral.sort(), ['side-plank', 'single-leg-balance'], 'the two bilateral tests expand to ten recordable slots');
});

bundleTest('Edge battery: loadBattery deep-clones, so a caller cannot mutate the bundled protocol', async () => {
  const first = await workflowTs.loadBattery();
  first.tests[0].name = 'MUTATED';
  const second = await workflowTs.loadBattery();
  assert.equal(second.tests[0].name, '10-Yard Sprint', 'the bundled protocol is unchanged by the mutation');
});

// --- store.ts PostgREST mapping (fake client, no live database) --------

test('Edge store: insertResult sends modified/capped as columns and maps them back', async () => {
  const fake = createFakeSupabase();
  const { store } = storeTs.createSupabaseStores(fake);
  const saved = await store.insertResult({
    sessionId: 'sess-1', athleteId: W, assessmentId: 'push-ups', kind: 'measured',
    attempts: [12], result: 12, unit: 'reps', direction: 'higher', protocolVersion: 'gaa-v1',
    recordedAt: '2026-11-14T00:00:00.000Z', modified: true, capped: false,
  });
  assert.equal(saved.modified, true);
  assert.equal(saved.capped, false);
  const row = fake.db.assessment_results[0];
  assert.equal(row.modified, true, 'modified is sent as its own column, not stuffed into attempts');
  assert.equal(row.capped, false);
  assert.deepEqual(row.attempts, [12], 'attempts stay the preserved numeric attempts');
  assert.equal(typeof row.id, 'string');
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id), 'Postgres ids are UUIDs, not Node uid() strings');
  const listed = await store.listResults(W, 'push-ups');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].modified, true);
});

test('Edge store: idempotency key is written and found again', async () => {
  const fake = createFakeSupabase();
  const { store } = storeTs.createSupabaseStores(fake);
  const saved = await store.insertSession({
    athleteId: W, coachId: 'coach-marcus', battery: BATTERY_ID,
    recordedAt: '2026-11-14T00:00:00.000Z', engineVersion: '1.1.0', idempotencyKey: 'key-abc',
  });
  assert.equal(saved.idempotencyKey, 'key-abc');
  assert.equal(fake.db.assessment_sessions[0].idempotency_key, 'key-abc', 'the key is stored snake_case');
  const found = await store.findSessionByIdempotencyKey(W, 'key-abc');
  assert.equal(found.id, saved.id);
  assert.equal(await store.findSessionByIdempotencyKey(W, 'key-other'), null);
  assert.equal(await store.findSessionByIdempotencyKey(W, ''), null);
});

test('Edge store: updatePlan keeps the caller id instead of minting a new UUID', async () => {
  const fake = createFakeSupabase();
  const { planStore } = storeTs.createSupabaseStores(fake);
  const created = await planStore.insertPlan({ athleteId: W, status: 'draft', createdAt: '2026-11-14T00:00:00.000Z' });
  const updated = await planStore.updatePlan({ ...created, status: 'finalized', finalizedBy: 'coach-marcus', finalizedAt: '2026-11-14T01:00:00.000Z' });
  assert.equal(updated.id, created.id, 'update must not mint a fresh id');
  assert.equal(updated.status, 'finalized');
  assert.equal(fake.db.development_plans.length, 1, 'exactly one plan row');
});

// --- directory.ts mapping (fake client, seeded directory tables) ------

test('Edge directory: coach mapping, guardian links, and adult ages come from the database', async () => {
  const fake = createFakeSupabase(seedDirectoryTables(Wingback, Youth));
  const { auth, directory } = await directoryTs.buildDirectory(fake, 'auth-coach-marcus');
  assert.equal(auth.role, 'coach');
  assert.equal(auth.coachId, 'coach-marcus');
  assert.equal(auth.authUserId, 'auth-coach-marcus');
  assert.equal(directory.athletes.length, 2);
  const wingback = directory.byId.get(W);
  assert.equal(wingback.age, 48, 'an adult athlete is reported as-is (migration 005 removed the 19 maximum)');
  assert.deepEqual(wingback.coachIds, ['coach-marcus']);
  assert.deepEqual(wingback.guardianUserIds, []);
  assert.equal(wingback.authUserId, 'athlete-wingback-uid');
  const youth = directory.byId.get(Y);
  assert.equal(youth.age, 12);
  assert.deepEqual(youth.guardianUserIds, ['parent-youth-uid'], 'guardian link resolves through athlete_guardians -> guardians -> app_users');
  assert.equal(youth.authUserId, 'athlete-youth-uid');
});

test('Edge directory: parent and athlete auth contexts carry no coach id', async () => {
  const fake = createFakeSupabase(seedDirectoryTables(Wingback, Youth));
  const parent = await directoryTs.buildDirectory(fake, 'parent-youth-uid');
  assert.equal(parent.auth.role, 'parent');
  assert.equal(parent.auth.coachId, null);
  const athlete = await directoryTs.buildDirectory(fake, 'athlete-wingback-uid');
  assert.equal(athlete.auth.role, 'athlete');
  assert.equal(athlete.auth.athleteId, W);
});

test('Edge directory: a user with no app role is forbidden, never defaulted', async () => {
  const fake = createFakeSupabase(seedDirectoryTables(Wingback, Youth));
  await assert.rejects(() => directoryTs.buildDirectory(fake, 'auth-unknown'), (e) => e.code === 'FORBIDDEN');
});

// --- index.ts HTTP flow (real entrypoint, stubbed Auth, fake client) ---

bundleTest('Edge HTTP: OPTIONS answers with CORS; GET /battery needs a valid token', async () => {
  installFake();
  const options = await callHandler({ method: 'OPTIONS', path: '/battery' });
  assert.equal(options.status, 200);
  assert.equal(options.cors, '*');
  assert.ok((options.methods || '').includes('GET'), 'CORS must allow GET for the battery route');
  const noToken = await callHandler({ method: 'GET', path: '/battery' });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.error.code, 'UNAUTHENTICATED');
  const badToken = await callHandler({ method: 'GET', path: '/battery', token: 'token-nope' });
  assert.equal(badToken.status, 401);
  assert.equal(badToken.json.error.code, 'UNAUTHENTICATED');
});

bundleTest('Edge HTTP: GET /battery returns the GAA protocol to an authenticated user', async () => {
  installFake();
  const res = await callHandler({ method: 'GET', path: '/battery', token: 'token-coach-marcus' });
  assert.equal(res.status, 200);
  assert.equal(res.cors, '*');
  assert.equal(res.json.battery, BATTERY_ID);
  assert.equal(res.json.protocolVersion, PROTOCOL_VERSION);
  assert.equal(res.json.retestDays, RETEST_DAYS);
  assert.equal(res.json.tests.length, 8);
  assert.equal(res.json.tests[0].id, '10yd-sprint');
  const slash = await callHandler({ method: 'GET', path: '/battery/', token: 'token-coach-marcus' });
  assert.equal(slash.status, 200, 'a trailing slash still serves the battery');
  const other = await callHandler({ method: 'GET', path: '/other', token: 'token-coach-marcus' });
  assert.equal(other.status, 405, 'unknown GET paths are rejected, not served');
});

bundleTest('Edge HTTP: POST rejects bad auth and bad input before any workflow call', async () => {
  installFake();
  const noToken = await callHandler({ method: 'POST', body: { method: 'listAthletes', params: {} } });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.error.code, 'UNAUTHENTICATED');
  const badToken = await callHandler({ method: 'POST', token: 'token-nope', body: { method: 'listAthletes', params: {} } });
  assert.equal(badToken.status, 401);
  const unknown = await callHandler({ method: 'POST', token: 'token-coach-marcus', body: { method: 'nope', params: {} } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, 'INVALID_INPUT');
  const malformed = await callHandler({ method: 'POST', token: 'token-coach-marcus', body: '{not json' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.error.code, 'INVALID_INPUT');
});

bundleTest('Edge HTTP: the client is built with the anon key, never a service-role key', async () => {
  installFake();
  await callHandler({ method: 'GET', path: '/battery', token: 'token-coach-marcus' });
  assert.equal(globalThis.__createClientCalls.length, 1);
  assert.equal(globalThis.__createClientCalls[0].key, 'anon-key-test', 'user-scoped client: RLS applies, no bypass');
  assert.equal(globalThis.__createClientCalls[0].url, 'https://test.supabase.co');
  for (const file of ['index.ts', 'api.ts', 'directory.ts', 'store.ts', 'workflow.ts']) {
    const src = fs.readFileSync(path.join(FN_DIR, file), 'utf8');
    assert.ok(!src.includes('SERVICE_ROLE'), `${file} must never reference a service-role key`);
    assert.ok(!src.includes('service_role_key'), `${file} must never reference a service-role key`);
  }
});

bundleTest('Edge HTTP: listAthletes is scoped to the caller’s cohorts', async () => {
  installFake();
  const coach = await callHandler({ method: 'POST', token: 'token-coach-marcus', body: { method: 'listAthletes', params: {} } });
  assert.equal(coach.status, 200);
  assert.equal(coach.json.ok, true);
  assert.deepEqual(coach.json.data.map((a) => a.id).sort(), [W, Y].sort());
  const other = await callHandler({ method: 'POST', token: 'token-coach-other', body: { method: 'listAthletes', params: {} } });
  assert.equal(other.status, 200);
  assert.deepEqual(other.json.data, [], 'a coach with no cohorts in the directory sees nobody');
});

bundleTest('Edge HTTP: full assessment flow through the real handler, with cross-athlete access refused', async () => {
  const fake = installFake();
  const done = await callHandler({
    method: 'POST', token: 'token-coach-marcus',
    body: { method: 'completeAssessment', params: { athleteId: W, entries: Wingback.baseline.entries, idempotencyKey: 'http-key-1', now: Wingback.baseline.recordedAt } },
  });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.data.idempotentReplay, false);
  assert.equal(fake.db.assessment_sessions.length, 1, 'exactly one session recorded');
  assert.equal(fake.db.assessment_results.length, 9, 'nine measured results (movement is observation-only)');
  const replay = await callHandler({
    method: 'POST', token: 'token-coach-marcus',
    body: { method: 'completeAssessment', params: { athleteId: W, entries: Wingback.baseline.entries, idempotencyKey: 'http-key-1', now: Wingback.baseline.recordedAt } },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.data.idempotentReplay, true);
  assert.equal(fake.db.assessment_sessions.length, 1, 'the replay inserted nothing');

  const parentOther = await callHandler({ method: 'POST', token: 'token-parent-youth', body: { method: 'athleteAssessmentView', params: { athleteId: W } } });
  assert.equal(parentOther.status, 403);
  assert.equal(parentOther.json.error.code, 'FORBIDDEN');
  const athleteOther = await callHandler({ method: 'POST', token: 'token-athlete-wingback', body: { method: 'athleteAssessmentView', params: { athleteId: Y } } });
  assert.equal(athleteOther.status, 403);
  const athleteSelf = await callHandler({ method: 'POST', token: 'token-athlete-wingback', body: { method: 'athleteAssessmentView', params: { athleteId: W } } });
  assert.equal(athleteSelf.status, 200);
  assert.equal(athleteSelf.json.data.history.length, 1);
  const parentOwn = await callHandler({ method: 'POST', token: 'token-parent-youth', body: { method: 'athleteAssessmentView', params: { athleteId: Y } } });
  assert.equal(parentOwn.status, 200, 'a parent views their own athlete');
  assert.equal(parentOwn.json.data.history.length, 0, 'the youth has no sessions yet');
});

bundleTest('Edge HTTP: modified/capped flags survive the PostgREST round-trip end to end', async () => {
  const fake = installFake();
  const entries = Wingback.baseline.entries.map((e) => {
    if (e.assessmentId === 'push-ups') return { ...e, modified: true, notes: 'Incline push-ups, hands on bench.' };
    if (e.assessmentId === 'side-plank-r') return { ...e, attempts: [120], capped: true };
    return e;
  });
  const done = await callHandler({
    method: 'POST', token: 'token-coach-marcus',
    body: { method: 'completeAssessment', params: { athleteId: W, entries, idempotencyKey: 'http-flags-key', now: Wingback.baseline.recordedAt } },
  });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const pushups = fake.db.assessment_results.find((r) => r.assessment_id === 'push-ups');
  assert.equal(pushups.modified, true, 'modified is stored as its own column in Postgres');
  assert.deepEqual(pushups.attempts, [18], 'attempts stay the preserved numeric attempts');
  const plank = fake.db.assessment_results.find((r) => r.assessment_id === 'side-plank-r');
  assert.equal(plank.capped, true);
  assert.equal(plank.result, 120);
  const view = await callHandler({ method: 'POST', token: 'token-coach-marcus', body: { method: 'athleteAssessmentView', params: { athleteId: W } } });
  const byId = {};
  for (const r of view.json.data.history[0].results) byId[r.assessmentId] = r;
  assert.equal(byId['push-ups'].modified, true, 'the flag reads back through the view');
  assert.equal(byId['side-plank-r'].capped, true);
  // Regression: loadData used to drop capped/attempts/unit, so the
  // view showed capped results without "(capped)" and values with
  // no unit (Phase 3, 2026-11-14). The history rows must carry them.
  assert.deepEqual(byId['push-ups'].attempts, [18], 'attempts survive into history');
  assert.equal(byId['push-ups'].unit, 'reps', 'units survive into history');
  assert.deepEqual(byId['side-plank-r'].attempts, [120]);
  assert.equal(byId['side-plank-r'].unit, 'sec');
});

bundleTest('Edge HTTP: plan finalization refuses an unready plan without an override; advisory never writes', async () => {
  const fake = installFake();
  const created = await callHandler({ method: 'POST', token: 'token-coach-marcus', body: { method: 'createPlan', params: { athleteId: W } } });
  assert.equal(created.status, 200);
  const planId = created.json.data.id;
  const refused = await callHandler({ method: 'POST', token: 'token-coach-marcus', body: { method: 'finalizePlan', params: { planId } } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, 'PLAN_NOT_READY');
  assert.equal(fake.db.development_plans.length, 1, 'the refused plan was not finalized or duplicated');
  const advisory = await callHandler({ method: 'POST', token: 'token-coach-marcus', body: { method: 'advisoryPriorities', params: { athleteId: W } } });
  assert.equal(advisory.status, 200);
  assert.equal(fake.db.development_plans.length, 1, 'advisory priorities write nothing');
});

// --- bundle failure modes (temp copy, no repo writes) -------------------

test('Edge bundle: a missing bundle fails loudly with WORKFLOW_BUNDLE_MISSING', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-fn-missing-'));
  try {
    fs.cpSync(FN_DIR, tmp, { recursive: true });
    fs.rmSync(path.join(tmp, 'vendor'), { recursive: true, force: true });
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, "import { loadBattery } from './workflow.ts';\ntry { await loadBattery(); console.log('NO_ERROR'); } catch (e) { console.log('CODE:' + (e.code || 'none')); }\n");
    const out = spawnSync(process.execPath, [probe], { cwd: tmp, encoding: 'utf8' });
    assert.match(out.stdout, /CODE:WORKFLOW_BUNDLE_MISSING/, `loadBattery must fail loudly without a bundle (got: ${out.stdout} ${out.stderr})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Edge bundle: a stale bundle without the battery exports fails loudly too', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-fn-stale-'));
  try {
    fs.cpSync(FN_DIR, tmp, { recursive: true });
    fs.rmSync(path.join(tmp, 'vendor'), { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'vendor'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'vendor', 'workflow.bundle.mjs'),
      'export const createAssessmentWorkflow = () => ({});\nexport const createAccessDirectory = () => ({});\n',
    );
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, "import { loadBattery } from './workflow.ts';\ntry { await loadBattery(); console.log('NO_ERROR'); } catch (e) { console.log('CODE:' + (e.code || 'none')); }\n");
    const out = spawnSync(process.execPath, [probe], { cwd: tmp, encoding: 'utf8' });
    assert.match(out.stdout, /CODE:WORKFLOW_BUNDLE_MISSING/, `a stale bundle must be reported, not served half a protocol (got: ${out.stdout} ${out.stderr})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
