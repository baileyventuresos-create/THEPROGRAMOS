/* Assessment UI tests (Phase 2 wiring).
 * Run: node --test server/tests/assessment-ui.test.js
 *
 * Tests the browser UI module (assessment-ui/assessment-ui.js) in Node:
 * pure helpers, entry building/validation, HTML renderers with stub
 * helpers, install() wrapping of the prototype views, and the full
 * controller flow against a stub client backed by the REAL workflow +
 * API over memory stores (the same code the dev server hosts). Role
 * scoping over HTTP is covered in dev-server.test.js; here the stub
 * models the dev server's header-derived auth with a mutable auth
 * the test sets before a role switch.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const UI = require('../../assessment-ui/assessment-ui');
const { GAA_TESTS } = require('../assessment-battery');
const { MemoryAssessmentStore } = require('../assessment-store');
const { MemoryReassessmentStore } = require('../reassessment');
const { createAccessDirectory } = require('../assessment-access');
const { createAssessmentWorkflow, MemoryPlanStore } = require('../assessment-workflow');
const { createAssessmentApi } = require('../assessment-api');
const Youth = require('../fixtures/synthetic-youth-12');
const Wingback = require('../fixtures/synthetic-wingback-48');

const Y = Youth.athlete.id;
const W = Wingback.athlete.id;

const NAMES = {
  [Y]: 'Synthetic Youth (12)', [W]: 'Synthetic Wingback (48)',
  'dev-ath-01': 'Dev Athlete 01', 'dev-ath-02': 'Dev Athlete 02',
  'dev-ath-03': 'Dev Athlete 03', 'dev-ath-04': 'Dev Athlete 04',
  'dev-ath-05': 'Dev Athlete 05', 'dev-ath-06': 'Dev Athlete 06',
};

function slots() { return UI.entrySlots(GAA_TESTS); }

function h(overrides) {
  return {
    esc: UI.esc, lbl: null, slots: slots(),
    athleteName: (id) => NAMES[id] || id,
    canAssess: true, devRoles: null, role: { role: 'director', user: 'dev-director-marcus' },
    ...(overrides || {}),
  };
}

/* Fake document: element values by id, plus a form filler from entries. */
function makeDoc() {
  const els = new Map();
  const doc = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, { value: '', checked: false });
      return els.get(id);
    },
    addEventListener() {},
    set(id, value, checked) { els.set(id, { value: value == null ? '' : String(value), checked: !!checked }); },
    setForm(entries, movement) {
      for (const e of entries) {
        if (e.assessmentId === 'movement-assessment') { this.set('aui-movement', e.observations || ''); continue; }
        (e.attempts || []).forEach((v, i) => this.set(`aui-att-${e.assessmentId}-${i}`, v));
        if (e.modified) this.set(`aui-mod-${e.assessmentId}`, '', true);
        if (e.capped) this.set(`aui-cap-${e.assessmentId}`, '', true);
      }
      if (movement !== undefined) this.set('aui-movement', movement);
    },
  };
  return doc;
}

/* Stub client: the real workflow/API over memory stores, with mutable
 * auth (models the dev server deriving auth from request headers). */
function makeStubClient() {
  const directory = createAccessDirectory({
    athletes: [
      { ...Wingback.athlete, name: NAMES[W], cohort: 'CLE-B', coachIds: ['marcus'], guardianUserIds: [], authUserId: null },
      { ...Youth.athlete, name: NAMES[Y], cohort: 'YAK-B', coachIds: ['kayla'], guardianUserIds: ['dev-parent-youth'], authUserId: 'dev-athlete-youth' },
      { id: 'dev-ath-01', synthetic: true, name: NAMES['dev-ath-01'], age: 10, cohort: 'YAK-A', coachIds: ['kayla'], guardianUserIds: [] },
      { id: 'dev-ath-02', synthetic: true, name: NAMES['dev-ath-02'], age: 11, cohort: 'YAK-A', coachIds: ['kayla'], guardianUserIds: [] },
      { id: 'dev-ath-03', synthetic: true, name: NAMES['dev-ath-03'], age: 13, cohort: 'YAK-C', coachIds: ['kayla'], guardianUserIds: [] },
      { id: 'dev-ath-04', synthetic: true, name: NAMES['dev-ath-04'], age: 9, cohort: 'ELL-A', coachIds: ['jordan'], guardianUserIds: [] },
      { id: 'dev-ath-05', synthetic: true, name: NAMES['dev-ath-05'], age: 14, cohort: 'ELL-B', coachIds: ['jordan'], guardianUserIds: [] },
      { id: 'dev-ath-06', synthetic: true, name: NAMES['dev-ath-06'], age: 8, cohort: 'CLE-A', coachIds: ['marcus'], guardianUserIds: [] },
    ],
    coachAuth: { 'dev-coach-kayla': 'kayla', 'dev-coach-jordan': 'jordan', 'dev-coach-marcus': 'marcus' },
  });
  const wf = createAssessmentWorkflow({
    store: new MemoryAssessmentStore(),
    reassessmentStore: new MemoryReassessmentStore(),
    planStore: new MemoryPlanStore(),
    directory,
  });
  const api = createAssessmentApi({ workflow: wf });
  let auth = { authUserId: 'dev-director-marcus', role: 'director' };
  const stub = {
    setAuth(next) { auth = next; },
    probe() { return Promise.resolve(true); },
    getBattery() { return Promise.resolve({ battery: 'generalAthleticAssessment', protocolVersion: 'gaa-v1', retestDays: 28, tests: GAA_TESTS }); },
  };
  for (const m of ['listAthletes', 'startAssessment', 'recordAttempts', 'getDraft', 'discardDraft',
    'completeAssessment', 'athleteAssessmentView', 'coachDashboard', 'recordDeferral',
    'planReadiness', 'createPlan', 'finalizePlan', 'advisoryPriorities']) {
    stub[m] = (params) => Promise.resolve().then(() => api[m](auth, params || {}));
  }
  return stub;
}

function makeRoot(doc) {
  let renders = 0;
  return {
    root: {
      AssessmentClient: { createAssessmentClient: () => { throw new Error('injected client is used in tests'); } },
      vAssess: () => '<div class="orig-assess">DRAFT BATTERY</div>',
      vAthlete: () => '<div class="orig-athlete">PROFILE</div>',
      render: () => { renders++; },
      toast: () => {},
      document: doc,
    },
    renders: () => renders,
  };
}

/* ---------------- pure helpers ---------------- */

test('esc / fmtDate / fmtResult / statusLabel', () => {
  assert.equal(UI.esc('<a>&"'), '&lt;a&gt;&amp;&quot;');
  assert.equal(UI.fmtDate('2027-01-10T12:00:00Z'), 'Jan 10, 2027');
  assert.equal(UI.fmtDate(null), '—');
  assert.equal(UI.fmtResult(2.31, 'sec'), '2.31 sec');
  assert.equal(UI.fmtResult(120, 'sec', { capped: true }), '120.00 sec (capped)');
  assert.equal(UI.fmtResult(null, 'sec'), '—');
  assert.deepEqual(UI.statusLabel('overdue'), { text: 'Overdue', cls: 'crit' });
  assert.deepEqual(UI.statusLabel('never-assessed'), { text: 'Never assessed', cls: 'needdef' });
  assert.equal(UI.signed(1.5), '+1.50');
  assert.equal(UI.signed(-0.25), '-0.25');
  assert.equal(UI.signed(null), '—');
});

test('entrySlots expands the 8 protocol tests to 10 recordable slots', () => {
  const s = slots();
  assert.equal(s.length, 10);
  assert.deepEqual(s.map((x) => x.defId), [
    '10yd-sprint', 'broad-jump', '5-10-5-shuttle', 'push-ups',
    'side-plank-r', 'side-plank-l', 'single-leg-balance-r', 'single-leg-balance-l',
    '6min-walk-run', 'movement-assessment',
  ]);
  assert.equal(s.find((x) => x.defId === 'side-plank-r').name, 'Side Plank (Left / Right) — Right');
  assert.equal(s.find((x) => x.defId === 'side-plank-r').capSeconds, 120);
  assert.equal(s.find((x) => x.defId === 'movement-assessment').kind, 'observation');
});

test('buildEntries keeps only slots with attempts; flags round-trip', () => {
  const form = {
    attempts: { '10yd-sprint': [2.31, 2.28], 'push-ups': [12], 'broad-jump': [] },
    modified: { 'push-ups': true }, capped: {},
    movement: 'Squat: knees track inward.', context: {},
  };
  const entries = UI.buildEntries(form, slots());
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { assessmentId: '10yd-sprint', attempts: [2.31, 2.28] });
  assert.deepEqual(entries[1], { assessmentId: 'push-ups', attempts: [12], modified: true });
  assert.deepEqual(entries[2], { assessmentId: 'movement-assessment', observations: 'Squat: knees track inward.' });
  assert.deepEqual(UI.buildEntries({ attempts: {}, modified: {}, capped: {}, movement: '  ', context: {} }, slots()), []);
});

test('validateEntries mirrors the server protocol checks client-side', () => {
  const s = slots();
  assert.deepEqual(UI.validateEntries([
    { assessmentId: 'side-plank-r', attempts: [130] },
  ], s), ['Side Plank (Left / Right) — Right: attempt exceeds the 120s cap — record 120 and tick Capped.']);
  assert.equal(UI.validateEntries([{ assessmentId: '10yd-sprint', attempts: [2.3, 2.2, 2.1, 2.0] }], s).length, 1);
  assert.equal(UI.validateEntries([{ assessmentId: 'push-ups', attempts: [12.5] }], s).length, 1);
  assert.equal(UI.validateEntries([{ assessmentId: 'push-ups', attempts: [-1] }], s).length, 1);
  assert.equal(UI.validateEntries([{ assessmentId: 'nope', attempts: [1] }], s).length, 1);
  assert.equal(UI.validateEntries([{ assessmentId: 'movement-assessment', observations: '' }], s).length, 1);
  assert.deepEqual(UI.validateEntries(Youth.baseline.entries, s), [], 'the fixture baseline is valid');
});

test('readRunForm reads attempt inputs, flags, movement and context', () => {
  const doc = makeDoc();
  doc.setForm(Youth.baseline.entries.slice(0, 2));
  doc.set('aui-ctx-timing', 'hand-timed stopwatch');
  doc.set('aui-att-10yd-sprint-0', 'not-a-number');
  const { form, problems } = UI.readRunForm(doc, slots());
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('10-Yard Sprint'));
  assert.deepEqual(form.attempts['broad-jump'], [62, 64, 63]);
  assert.equal(form.context.timingMethod, 'hand-timed stopwatch');
});

/* ---------------- renderers ---------------- */

test('renderRoster shows due buckets, status labels, and scoped actions', () => {
  const state = {
    connected: true, view: 'roster',
    roster: [
      { id: Y, name: NAMES[Y], age: 12, cohort: 'YAK-B' },
      { id: 'dev-ath-01', name: NAMES['dev-ath-01'], age: 10, cohort: 'YAK-A' },
    ],
    dashboard: { reminders: {
      neverAssessed: [{ athleteId: 'dev-ath-01', status: 'never-assessed' }],
      approaching: [], due: [{ athleteId: Y, status: 'due' }], overdue: [], deferred: [], notDue: [],
    } },
  };
  const html = UI.renderRoster(state, h());
  assert.ok(html.includes('Synthetic Youth (12)'));
  assert.ok(html.includes('Due · 1'));
  assert.ok(html.includes('Never assessed · 1'));
  assert.ok(html.includes('data-aui="run"'), 'coach gets a Start button');
  assert.ok(!UI.renderRoster(state, h({ canAssess: false })).includes('data-aui="run"'),
    'a parent/athlete never gets a Start button');
});

test('renderRunForm prefills the draft, lists what is missing, and flags caps', () => {
  const state = {
    view: 'run', athleteId: 'dev-ath-06',
    roster: [{ id: 'dev-ath-06', name: NAMES['dev-ath-06'], age: 8, cohort: 'CLE-A' }],
    draft: {
      entries: Youth.baseline.entries.slice(0, 3),
      missing: ['5-10-5-shuttle', 'push-ups', 'side-plank-r', 'side-plank-l',
        'single-leg-balance-r', 'single-leg-balance-l', '6min-walk-run', 'movement-assessment'],
      isReassessment: false, lastCompletedAt: null, nextDueAt: null, context: { timingMethod: 'gates' },
    },
  };
  const html = UI.renderRunForm(state, h());
  assert.ok(html.includes('Dev Athlete 06'));
  assert.ok(html.includes('value="2.35"'), 'draft attempts prefill');
  assert.ok(html.includes('5-10-5 Shuttle'), 'missing tests are named');
  assert.ok(html.includes('capped at 120s'), 'cap is shown');
  assert.ok(html.includes('data-aui="save"') && html.includes('data-aui="complete"') && html.includes('data-aui="discard"'));
  assert.ok(html.includes('id="aui-movement"'), 'movement observations textarea');
});

test('renderHistory shows baseline, PBs, comparisons, sessions, and plan controls', () => {
  const state = {
    view: 'history', athleteId: Y,
    roster: [{ id: Y, name: NAMES[Y], age: 12, cohort: 'YAK-B' }],
    athleteView: {
      athleteId: Y, age: 12,
      baseline: { complete: true, completedAt: '2027-01-10T12:00:00Z', missing: [] },
      schedule: { status: 'due', nextDueAt: '2027-02-07T12:00:00Z', lastCompletedAt: '2027-01-10T12:00:00Z' },
      reminder: { message: 'Your reassessment is due today.' },
      history: [{ sessionId: 's1', recordedAt: '2027-01-10T12:00:00Z', results: [
        { assessmentId: '10yd-sprint', result: 2.3, unit: 'sec', modified: false, capped: false },
        { assessmentId: 'push-ups', result: 12, unit: 'reps', modified: true, capped: false },
        { assessmentId: 'side-plank', result: 120, unit: 'sec', modified: false, capped: true },
      ] }],
      personalBests: { '10yd-sprint': { value: 2.3, unit: 'sec' } },
      progress: { tests: { '10yd-sprint': {
        unit: 'sec', baseline: 2.35, previous: null, current: 2.3, personalBest: 2.3,
        isPersonalBest: true, status: 'baseline-only',
        vsBaseline: { absolute: -0.05, improvementPercent: 2.13, status: 'improved' },
        vsPrevious: null, vsBest: { absolute: 0, improvementPercent: 0, status: 'maintained' },
        caveats: ['Athlete is under 18: growth and maturation can change results independently of training. Do not read change as training effectiveness alone.'],
      } } },
      advisory: { insufficientEvidence: false, priorities: [] },
    },
    readiness: { ready: true, missing: [] },
    plan: { id: 'dplan_1', status: 'draft' },
  };
  const html = UI.renderHistory(state, h());
  assert.ok(html.includes('Baseline complete Jan 10, 2027'));
  assert.ok(html.includes('2.30 sec ★') || html.includes('2.30 sec'), 'current best is shown');
  assert.ok(html.includes('growth and maturation'), 'youth caveat is shown');
  assert.ok(html.includes('(modified)'), 'modified flag is shown on the session');
  assert.ok(html.includes('120.00 sec (capped)'), 'capped result is shown with its unit (bed566d display path)');
  assert.ok(html.includes('Plan is ready to finalize'));
  assert.ok(html.includes('data-aui="plan-finalize"'));
});

test('renderAthleteSection is empty off-roster and live on-roster', () => {
  const state = { connected: true, roster: [{ id: Y }], athleteView: null };
  assert.equal(UI.renderAthleteSection(state, h(), 'dev-ath-99'), '');
  const on = UI.renderAthleteSection(state, h(), Y);
  assert.ok(on.includes('Loading live assessment history'));
  assert.ok(on.includes('data-aui="history"'));
  const off = UI.renderAthleteSection({ connected: false, roster: [{ id: Y }] }, h(), Y);
  assert.equal(off, '');
});

/* ---------------- controller ---------------- */

test('install wraps the prototype views and refresh loads roster + dashboard', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createAssessmentUI({ root, doc, client });
  assert.equal(ui.install(), true);
  assert.equal(ui.install(), true, 'install is idempotent');
  await ui.refresh();
  assert.equal(ui.state.connected, true);
  assert.equal(ui.state.roster.length, 8);
  assert.equal(ui.state.dashboard.reminders.neverAssessed.length, 8);
  const wrapped = root.vAssess();
  assert.ok(wrapped.includes('Live assessments'), 'live section is prepended');
  assert.ok(wrapped.includes('DRAFT BATTERY'), 'prototype output is preserved below');
  assert.ok(wrapped.includes('Dev Athlete 01'), 'roster renders inside the wrapped view');
  const profile = root.vAthlete(Y);
  assert.ok(profile.includes('PROFILE'), 'prototype profile preserved');
  assert.ok(profile.includes('Loading live assessment history'), 'live section appended on-roster');
  assert.ok(!root.vAthlete('dev-ath-99').includes('Live assessments'), 'off-roster profile unchanged');
});

test('install returns false without AssessmentClient and leaves the prototype alone', () => {
  const doc = makeDoc();
  const root = { vAssess: () => 'ORIG', document: doc };
  const ui = UI.createAssessmentUI({ root, doc, client: null });
  assert.equal(ui.install(), false);
  assert.equal(root.vAssess(), 'ORIG');
});

test('controller: run, partial save, resume, complete, history — end to end', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createAssessmentUI({ root, doc, client });
  ui.install();
  await ui.refresh();

  await ui.openRun('dev-ath-06');
  assert.equal(ui.state.view, 'run');
  assert.equal(ui.state.draft.missing.length, 10);

  doc.setForm(Youth.baseline.entries.slice(0, 3));
  await ui.saveRun();
  assert.equal(ui.state.error, null);
  assert.equal(ui.state.draft.entries.length, 3);
  assert.equal(ui.state.draft.missing.length, 7);
  assert.ok(ui.renderLiveSection().includes('value="2.35"'), 'saved draft prefills the form');

  doc.setForm(Youth.baseline.entries);
  await ui.completeRun();
  assert.equal(ui.state.view, 'history');
  assert.equal(ui.state.error, null);
  assert.equal(ui.state.athleteView.baseline.complete, true);
  assert.equal(ui.state.athleteView.history.length, 1);
  assert.equal(ui.state.athleteView.progress.tests['10yd-sprint'].personalBest, 2.3);
  assert.equal(ui.state.readiness.ready, true);
  const html = ui.renderLiveSection();
  assert.ok(html.includes('Baseline complete'), 'history renders after completion');
});

test('controller: incomplete completion surfaces the server error, nothing stored', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createAssessmentUI({ root, doc, client });
  ui.install();
  await ui.refresh();
  await ui.openRun('dev-ath-01');
  doc.setForm(Youth.baseline.entries.slice(0, 1));
  await ui.completeRun();
  assert.equal(ui.state.error.code, 'INCOMPLETE_ASSESSMENT');
  assert.equal(ui.state.view, 'run', 'stays on the run form so the coach can finish it');
});

test('controller: plan finalize refuses without override, accepts with one', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createAssessmentUI({ root, doc, client });
  ui.install();
  await ui.refresh();
  await ui.openHistory('dev-ath-03');
  await ui.createPlan('dev-ath-03');
  assert.equal(ui.state.plan.status, 'draft');
  await ui.finalizePlan(ui.state.plan.id);
  assert.equal(ui.state.error.code, 'PLAN_NOT_READY');
  doc.set('aui-override-reason', 'Coach judgement: baseline tests not safe this week');
  await ui.finalizePlan(ui.state.plan.id);
  assert.equal(ui.state.error, null);
  assert.equal(ui.state.plan.status, 'finalized');
  assert.equal(ui.state.plan.overrideReason, 'Coach judgement: baseline tests not safe this week');
});

test('controller: switching to the parent role narrows the roster and hides recording', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createAssessmentUI({ root, doc, client });
  ui.install();
  await ui.refresh();
  assert.equal(ui.state.roster.length, 8);
  client.setAuth({ authUserId: 'dev-parent-youth', role: 'parent' });
  await ui.switchRole({ role: 'parent', user: 'dev-parent-youth', label: 'Parent' });
  assert.equal(ui.state.roster.length, 1);
  assert.equal(ui.state.roster[0].id, Y);
  assert.equal(ui.state.dashboard, null, 'parents have no coach dashboard');
  const html = ui.renderLiveSection();
  assert.ok(!html.includes('data-aui="run"'), 'no Start button for a parent');
  assert.ok(html.includes('data-aui="history"'), 'history is still available');
});

test('controller: disconnected service leaves the prototype output plus a note', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const offline = makeStubClient();
  offline.probe = () => Promise.resolve(false);
  const ui = UI.createAssessmentUI({ root, doc, client: offline });
  ui.install();
  await ui.refresh();
  assert.equal(ui.state.connected, false);
  const wrapped = root.vAssess();
  assert.ok(wrapped.includes('not connected'), 'offline note is shown');
  assert.ok(wrapped.includes('DRAFT BATTERY'), 'prototype output is intact');
});
