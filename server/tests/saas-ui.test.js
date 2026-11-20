/* SaaS UI tests (frontend slice).
 * Run: node --test server/tests/saas-ui.test.js
 *
 * Tests the browser UI modules (saas-ui/saas-ui.js +
 * saas-ui/saas-client.js) in Node: pure helpers, HTML renderers
 * with stub helpers, install() wrapping of the prototype views,
 * and the full controller flow against a stub client backed by
 * the REAL SaaS API + billing over memory stores (the same code
 * the dev server hosts). Role scoping over HTTP is covered in
 * dev-server-saas.test.js; here the stub models the dev server's
 * header-derived auth with a mutable auth the test sets before a
 * role switch.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const UI = require('../../saas-ui/saas-ui');
const SaasClient = require('../../saas-ui/saas-client');
const { MemorySaasStore, PLANS } = require('../saas-store');
const { createSaasApi } = require('../saas-api');
const { FakeBillingAdapter } = require('../billing');

function h(overrides) {
  return {
    esc: UI.esc, lbl: null, games: null,
    athleteName: (id) => 'Athlete ' + id,
    devRoles: null, role: { role: 'director', user: 'dev-director-marcus' },
    ...(overrides || {}),
  };
}

/* Fake document: element values by id + game checkbox list. */
function makeDoc() {
  const els = new Map();
  const doc = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, { value: '', checked: false });
      return els.get(id);
    },
    querySelectorAll(sel) {
      if (sel !== '.sui-game') return [];
      return doc._games || [];
    },
    addEventListener() {},
    set(id, value, checked) { els.set(id, { value: value == null ? '' : String(value), checked: !!checked }); },
    setGames(ids) { doc._games = ids.map((id) => ({ value: id, checked: true })); },
    _games: [],
  };
  return doc;
}

/* Stub client: the real SaaS API + fake billing over memory
 * stores, with mutable auth (models the dev server deriving auth
 * from request headers). */
function makeStubClient() {
  const store = new MemorySaasStore();
  const billing = new FakeBillingAdapter(store);
  const api = createSaasApi({ store, billing });
  let auth = { authUserId: 'dev-director-marcus', role: 'director' };
  const stub = {
    store, billing, api,
    setAuth(next) { auth = next; },
    probe() { return Promise.resolve(true); },
    getPlans() { return Promise.resolve().then(() => api.listPlans(auth)); },
  };
  for (const m of SaasClient.METHODS) {
    stub[m] = (params) => Promise.resolve().then(() => api[m](auth, params || {}));
  }
  for (const m of SaasClient.BILLING_METHODS) {
    stub[m] = (params) => Promise.resolve().then(() => {
      if (m === 'confirmCheckout') return billing.confirmCheckout((params || {}).sessionId, params || {});
      return billing[m](params || {});
    });
  }
  return stub;
}

function makeRoot(doc) {
  let renders = 0;
  return {
    root: {
      SaasClient: { createSaasClient: () => { throw new Error('injected client is used in tests'); } },
      vDashboard: () => '<div class="orig-dash">DASH</div>',
      vCoach: () => '<div class="orig-coach">COACH</div>',
      vAthleteMode: () => '<div class="orig-athlete-mode">ATHLETE MODE</div>',
      vAthlete: () => '<div class="orig-athlete">PROFILE</div>',
      render: () => { renders++; },
      toast: () => {},
      document: doc,
    },
    renders: () => renders,
  };
}

/* ---------------- pure helpers ---------------- */

test('fmtMoney / fmtDate / tierLabel / errorText', () => {
  assert.equal(UI.fmtMoney(0), '$0');
  assert.equal(UI.fmtMoney(1499), '$14.99');
  assert.equal(UI.fmtMoney(2900), '$29');
  assert.equal(UI.fmtMoney(null), '—');
  assert.equal(UI.fmtDate('2027-01-10T12:00:00Z'), 'Jan 10, 2027');
  assert.equal(UI.tierLabel({ tier: 'member' }).text.includes('$149'), true);
  assert.equal(UI.tierLabel({ tier: 'sponsored' }).text.includes('Sponsored'), true);
  assert.equal(UI.tierLabel({ tier: 'free' }).cls, 'assume');
  assert.ok(UI.errorText({ code: 'GAME_NOT_ASSIGNABLE', message: 'Game TP2-084 is Safety Review' }).includes('Safety Review'));
  assert.ok(UI.errorText({ code: 'CONSENT_REQUIRED', message: 'x' }).includes('Guardian consent'));
});

test('planFeatures / planPrice present the seeded catalogue honestly', () => {
  const starter = PLANS.coach_starter;
  assert.equal(UI.planPrice(starter, 'month'), '$29 / month');
  assert.equal(UI.planPrice(starter, 'year'), '$290 / year');
  const feats = UI.planFeatures(starter);
  assert.ok(feats.some((f) => f.includes('15 athletes')));
  assert.ok(feats.some((f) => f.includes('14-day free trial')));
  assert.ok(feats.some((f) => f.includes('GAA assessment battery')));
  const free = PLANS.free_athlete;
  assert.equal(UI.planPrice(free, 'month'), '$0');
  assert.ok(UI.planFeatures(free).some((f) => f.includes('90-day history')));
});

test('buildAssignmentParams shapes dose + dedupes games; validation catches bad input', () => {
  const params = UI.buildAssignmentParams({
    athleteId: 'a1', title: ' Speed day ', instructions: ' Go fast ',
    gameIds: ['tp2-001', 'TP2-001', ' TP2-002 '], build: 'LEARN',
    dose: { rounds: '3', workSec: '30', restSec: '', reps: '8', distance: '20 yd', note: 'clean reps' },
    dueAt: '2027-01-15T00:00:00.000Z',
  });
  assert.deepEqual(params.gameIds, ['TP2-001', 'TP2-002']);
  assert.deepEqual(params.dose, { rounds: 3, workSec: 30, reps: 8, distance: '20 yd', note: 'clean reps' });
  assert.equal(params.title, 'Speed day');
  assert.deepEqual(UI.validateAssignmentForm({ athleteId: '', title: '' }).length, 2);
  assert.deepEqual(UI.validateAssignmentForm({ athleteId: 'a', title: 't', dose: { rounds: 'x' } }).length, 1);
  assert.deepEqual(UI.validateAssignmentForm({ athleteId: 'a', title: 't', build: 'WRONG' }).length, 1);
  assert.deepEqual(UI.validateAssignmentForm({ athleteId: 'a', title: 't' }), []);
});

test('completion params + validation (RPE 1-10 integer)', () => {
  assert.deepEqual(UI.buildCompletionParams({ assignmentId: 'x', durationMin: '25', effortRpe: '7', athleteNote: ' good ' }),
    { assignmentId: 'x', durationMin: 25, effortRpe: 7, athleteNote: 'good' });
  assert.equal(UI.validateCompletionForm({ assignmentId: 'x', effortRpe: '11' }).length, 1);
  assert.equal(UI.validateCompletionForm({ assignmentId: 'x', effortRpe: '7.5' }).length, 1);
  assert.deepEqual(UI.validateCompletionForm({ assignmentId: 'x', effortRpe: '7', durationMin: '20' }), []);
});

test('gameOptions marks Safety Review / Retired blocked; rosterCap labels overage', () => {
  const opts = UI.gameOptions(null);
  assert.equal(opts.length, 130);
  assert.equal(opts.find((g) => g.id === 'TP2-084').blocked, true);
  assert.equal(opts.find((g) => g.id === 'TP2-125').blocked, true);
  assert.equal(opts.find((g) => g.id === 'TP2-001').blocked, false);
  const fromG = UI.gameOptions([{ id: 'TP2-001', name: 'Mirror', tier: 'Launch ready' }, { id: 'TP2-090', name: 'X', tier: 'Safety review' }]);
  assert.equal(fromG[1].blocked, true);
  const cap = UI.rosterCap({ limits: { maxAthletes: 15 } }, 17);
  assert.equal(cap.over, true);
  assert.ok(cap.label.includes('2 over'));
  assert.equal(UI.rosterCap({ limits: { maxAthletes: null } }, 3).label.includes('no roster cap'), true);
});

/* ---------------- renderers ---------------- */

test('renderPlans shows test-mode banner, prices, and checkout only for paid plans', () => {
  const state = { plans: Object.values(PLANS), interval: 'month', checkout: null };
  const html = UI.renderPlans(state, h());
  assert.ok(html.includes('Test mode'), 'test-mode banner present');
  assert.ok(html.includes('$29 / month'));
  assert.ok(html.includes('$14.99 / month'));
  assert.ok(html.includes('Free forever'));
  assert.ok(html.includes('data-sui="checkout" data-plan="coach_starter"'));
  assert.ok(!html.includes('data-plan="free_athlete"'), 'no checkout for the free plan');
  const annual = UI.renderPlans({ ...state, interval: 'year' }, h());
  assert.ok(annual.includes('$290 / year'));
});

test('renderPlans confirm button carries data-sui-session, never data-session (prototype collision guard)', () => {
  /* Regression (validation defect, 2026-11-20): the prototype's
   * global click handler treats data-session as "open session
   * drawer" (ds.session in THE PROGRAM OS.html). A billing session
   * id in data-session set S.drawer to a nonexistent session and
   * froze every subsequent app render after a test checkout. */
  const state = {
    plans: Object.values(PLANS), interval: 'month',
    checkout: { sessionId: 'fake_cs_1', priceCents: 1499, interval: 'month', planCode: 'athlete_remote' },
  };
  const html = UI.renderPlans(state, h());
  assert.ok(html.includes('data-sui="confirm-checkout" data-sui-session="fake_cs_1"'),
    'confirm button carries the namespaced session attribute');
  assert.ok(!html.includes('data-session="'), 'no bare data-session attribute (prototype collision)');
});

test('renderAthlete shows honest tier, assignments, completion form, truncated history', () => {
  const state = {
    entitlements: { kind: 'athlete', athleteId: 'a1', entitlements: { tier: 'free', historyDays: 90, fullHistory: false, maxCoachLinks: 1, trainingDaysPerWeek: 1 } },
    assignments: [
      { id: 'as1', title: 'Speed day', gameIds: ['TP2-001'], build: 'LEARN', dose: { rounds: 3 }, status: 'assigned', dueAt: '2027-01-15T00:00:00Z' },
      { id: 'as2', title: 'Done day', gameIds: [], status: 'completed' },
    ],
    completingId: 'as1',
    history: {
      truncated: true, historyWindowDays: 90,
      completions: [{ assignmentId: 'as2', completedAt: '2027-01-10T00:00:00Z', durationMin: 20, effortRpe: 6, athleteNote: 'ok' }],
      assignments: [], assessments: [{ completedAt: '2027-01-01T00:00:00Z' }],
    },
  };
  const html = UI.renderAthlete(state, h());
  assert.ok(html.includes('Athlete Free'));
  assert.ok(html.includes('Speed day'));
  assert.ok(html.includes('data-sui="complete-save"'));
  assert.ok(html.includes('Nothing was deleted'), 'truncated window never implies deletion');
  assert.ok(html.includes('coach-recorded measurements'));
  const member = UI.renderAthlete({
    ...state, completingId: null,
    entitlements: { kind: 'athlete', athleteId: 'a1', entitlements: { tier: 'member', fullHistory: true } },
  }, h());
  assert.ok(member.includes('never be double-charged'), 'member tier states the no-double-charge rule');
});

test('renderCoach shows cap, roster actions, and composer disables blocked games', () => {
  const state = {
    entitlements: { kind: 'coach', coachId: 'c1', entitlements: { active: true, planCode: 'coach_starter', limits: { maxAthletes: 15 } } },
    roster: { count: 1, athletes: [{ athlete: { id: 'a1', name: 'Athlete One', age: 14 }, links: [{}] }] },
    assigningTo: 'a1', assignGames: [], subscription: null, history: null, progressFor: null, inviteToken: null,
  };
  const html = UI.renderCoach(state, h());
  assert.ok(html.includes('1 of 15 athletes'));
  assert.ok(html.includes('Athlete One'));
  assert.ok(html.includes('data-sui="assign-save"'));
  assert.ok(html.includes('value="TP2-084" disabled'), 'Safety Review game disabled in the picker');
  assert.ok(html.includes('not assignable'));
  assert.ok(html.includes('data-sui="invite-athlete"') && html.includes('data-sui="link-athlete"'));
});

test('renderOrg + renderHub tabs + role buttons carry no data-role (prototype collision guard)', () => {
  const state = {
    connected: true, tab: 'org', role: { role: 'director', user: 'dev-director-marcus' },
    organizationId: 'org-1', orgOverview: {
      organization: { name: 'River City Academy' }, entitlements: { active: true, planCode: 'team_academy' },
      coaches: [{ coach: { name: 'Coach A' }, athleteCount: 3 }], athleteCount: 3,
      athletes: [{ id: 'a1', name: 'Athlete One' }], pendingInvitations: 1,
    },
    orgInviteToken: null,
  };
  const html = UI.renderHub(state, h({ devRoles: UI.DEV_ROLES }));
  assert.ok(html.includes('River City Academy'));
  assert.ok(html.includes('data-sui-role="coach"'), 'role buttons carry data-sui-role');
  assert.ok(!html.includes('data-role="'), 'no data-role attribute in the hub');
  assert.ok(html.includes('<div class="r" style="flex-wrap:wrap">'), 'panel header actions wrap on narrow screens');
  assert.ok(html.includes('data-sui="tab" data-tab="plans"'));
});

/* ---------------- client ---------------- */

test('saas-client: unknown method rejected; envelope errors carry code + coveringSource', async () => {
  const client = SaasClient.createSaasClient({
    fetchImpl: () => Promise.resolve({
      status: 200,
      json: () => Promise.resolve({ ok: false, error: { code: 'ALREADY_COVERED', message: 'covered', coveringSource: 'sponsorship' } }),
    }),
  });
  await assert.rejects(client.call('nope', {}), (e) => e.code === 'INVALID_METHOD');
  await assert.rejects(client.createCheckoutSession({ ownerType: 'athlete', ownerId: 'a', planCode: 'athlete_remote' }),
    (e) => e.code === 'ALREADY_COVERED' && e.coveringSource === 'sponsorship');
  const okClient = SaasClient.createSaasClient({
    fetchImpl: () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, data: { plans: [] } }) }),
  });
  assert.deepEqual(await okClient.getPlans(), { plans: [] });
  assert.equal(await okClient.probe(), true);
});

/* ---------------- controller ---------------- */

test('install wraps the prototype views and refresh loads plans', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createSaasUI({ root, doc, client });
  assert.equal(ui.install(), true);
  assert.equal(ui.install(), true, 'install is idempotent');
  await ui.refresh();
  assert.equal(ui.state.connected, true);
  assert.equal(ui.state.plans.length, 6);
  const wrapped = root.vDashboard();
  assert.ok(wrapped.includes('The Program — remote coaching'), 'hub prepended to dashboard');
  assert.ok(wrapped.includes('DASH'), 'prototype output preserved below');
  assert.ok(root.vCoach().includes('COACH'));
  assert.ok(root.vAthleteMode().includes('ATHLETE MODE'));
  assert.ok(root.vAthlete('x').includes('PROFILE'));
});

test('install returns false without SaasClient and leaves the prototype alone', () => {
  const doc = makeDoc();
  const root = { vDashboard: () => 'ORIG', document: doc };
  const ui = UI.createSaasUI({ root, doc, client: null });
  assert.equal(ui.install(), false);
  assert.equal(root.vDashboard(), 'ORIG');
});

test('controller: coach registers (trial), links athlete, assigns, athlete completes, history joins', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createSaasUI({ root, doc, client });
  ui.install();
  await ui.refresh();

  // Register a coach as a fresh dev identity.
  client.setAuth({ authUserId: 'dev-coach-new', role: 'coach' });
  await ui.switchRole({ role: 'coach', user: 'dev-coach-new', label: 'New Coach' });
  doc.set('sui-reg-coach-name', 'New Coach');
  doc.set('sui-reg-coach-email', 'new@dev.invalid');
  await ui.registerCoach();
  assert.equal(ui.state.error, null);
  assert.equal(ui.state.registration.kind, 'coach');
  assert.ok(ui.state.organizationId, 'solo org id captured');
  assert.equal(ui.state.entitlements.entitlements.active, true, 'trial grants access');

  // Register an adult athlete under their own identity, then link.
  client.setAuth({ authUserId: 'dev-ath-new', role: 'athlete' });
  await ui.switchRole({ role: 'athlete', user: 'dev-ath-new', label: 'New Athlete' });
  doc.set('sui-reg-ath-name', 'New Athlete');
  doc.set('sui-reg-ath-email', 'ath@dev.invalid');
  doc.set('sui-reg-ath-age', '24');
  await ui.registerAthlete();
  assert.equal(ui.state.error, null);
  const athleteId = ui.state.entitlements.athleteId;
  assert.ok(athleteId);
  assert.equal(ui.state.entitlements.entitlements.tier, 'free');

  // Back to the coach: link + assign.
  client.setAuth({ authUserId: 'dev-coach-new', role: 'coach' });
  await ui.switchRole({ role: 'coach', user: 'dev-coach-new', label: 'New Coach' });
  doc.set('sui-link-athlete', athleteId);
  await ui.linkAthlete();
  assert.equal(ui.state.error, null);
  assert.equal(ui.state.roster.count, 1);

  // Blocked game surfaces the stable code cleanly.
  doc.set('sui-asn-title', 'Blocked day');
  doc.setGames(['TP2-084']);
  await ui.saveAssignment(athleteId);
  assert.equal(ui.state.error.code, 'GAME_NOT_ASSIGNABLE');

  doc.set('sui-asn-title', 'Speed day');
  doc.setGames(['TP2-001']);
  doc.set('sui-asn-rounds', '3');
  await ui.saveAssignment(athleteId);
  assert.equal(ui.state.error, null);

  // Athlete completes it.
  client.setAuth({ authUserId: 'dev-ath-new', role: 'athlete' });
  await ui.switchRole({ role: 'athlete', user: 'dev-ath-new', label: 'New Athlete' });
  assert.equal(ui.state.assignments.length, 1);
  const assignmentId = ui.state.assignments[0].id;
  doc.set('sui-comp-duration', '25');
  doc.set('sui-comp-rpe', '7');
  await ui.saveCompletion(assignmentId);
  assert.equal(ui.state.error, null);
  assert.equal(ui.state.history.completions.length, 1);

  // Double completion refused with the stable code.
  await ui.saveCompletion(assignmentId);
  assert.equal(ui.state.error.code, 'ALREADY_COMPLETED');
});

test('controller: test checkout activates paid tier; covered athlete refused ALREADY_COVERED', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const { store, api } = client;
  // Seed: a free athlete + a $149 member athlete.
  const free = api.registerAthlete({ authUserId: 'dev-ath-free', role: 'athlete' },
    { email: 'f@dev.invalid', name: 'Free Athlete', age: 22 });
  const member = api.registerAthlete({ authUserId: 'dev-ath-member', role: 'athlete' },
    { email: 'm@dev.invalid', name: 'Member Athlete', age: 30 });
  store.memberships.push({
    id: 'mem-1', athleteId: member.athlete.id, status: 'active', priceCents: 14900,
    startDate: new Date(Date.now() - 86400000).toISOString(), endDate: null,
  });
  const ui = UI.createSaasUI({ root, doc, client });
  ui.install();

  client.setAuth({ authUserId: 'dev-ath-member', role: 'athlete', athleteId: member.athlete.id });
  await ui.switchRole({ role: 'athlete', user: 'dev-ath-member', athleteId: member.athlete.id, label: 'Member' });
  assert.equal(ui.state.entitlements.entitlements.tier, 'member');
  await ui.checkout('athlete_remote', 'athlete');
  assert.equal(ui.state.error.code, 'ALREADY_COVERED');
  assert.equal(ui.state.error.coveringSource, 'in_person_membership');

  client.setAuth({ authUserId: 'dev-ath-free', role: 'athlete', athleteId: free.athlete.id });
  await ui.switchRole({ role: 'athlete', user: 'dev-ath-free', athleteId: free.athlete.id, label: 'Free' });
  await ui.checkout('athlete_remote', 'athlete');
  assert.equal(ui.state.error, null);
  assert.ok(ui.state.checkout.sessionId);
  await ui.confirmCheckout(ui.state.checkout.sessionId);
  assert.equal(ui.state.error, null);
  assert.equal(ui.state.entitlements.entitlements.tier, 'paid');
});

test('controller: org creation + overview; disconnected service leaves prototype intact', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createSaasUI({ root, doc, client });
  ui.install();
  await ui.refresh();
  client.setAuth({ authUserId: 'dev-coach-org', role: 'coach' });
  await ui.switchRole({ role: 'coach', user: 'dev-coach-org', label: 'Org Coach' });
  doc.set('sui-reg-coach-name', 'Org Coach');
  doc.set('sui-reg-coach-email', 'org@dev.invalid');
  await ui.registerCoach();
  doc.set('sui-org-name', 'River City Academy');
  doc.set('sui-org-kind', 'academy');
  /* createOrganization promotes the founder to org_admin; the
   * stub auth mirrors the next JWT carrying the new role. */
  client.setAuth({ authUserId: 'dev-coach-org', role: 'org_admin' });
  await ui.createOrg();
  assert.equal(ui.state.error, null);
  assert.ok(ui.state.orgOverview);
  assert.equal(ui.state.orgOverview.organization.name, 'River City Academy');

  const offline = makeStubClient();
  offline.probe = () => Promise.resolve(false);
  const doc2 = makeDoc();
  const root2 = makeRoot(doc2).root;
  const ui2 = UI.createSaasUI({ root: root2, doc: doc2, client: offline });
  ui2.install();
  await ui2.refresh();
  assert.equal(ui2.state.connected, false);
  const wrapped = root2.vDashboard();
  assert.ok(wrapped.includes('not connected'));
  assert.ok(wrapped.includes('DASH'), 'prototype output intact');
});
