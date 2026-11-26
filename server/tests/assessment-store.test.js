/* Assessment persistence adapter tests.
 * Run: node --test server/tests/assessment-store.test.js
 * Pins the separation the prototype locks in: measured results, coach
 * observations, and system interpretations are different records.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { recordAssessmentSession, evidenceForDraft, MemoryAssessmentStore } = require('../assessment-store');
const Engine = require('../../assessment-engine/assessment-engine.js');

const META = { battery: 'generalAthlete', recordedAt: '2027-06-08T12:00:00Z',
  context: { equipment: 'hand-timed stopwatch', surface: 'gym floor', protocolVersion: 'v1' } };

test('recording a session stores measured attempts + result, verbatim', async () => {
  const store = new MemoryAssessmentStore();
  const out = await recordAssessmentSession(store, { athleteId: 'ath-test-01', coachId: 'kayla',
    entries: [{ assessmentId: '10yd-sprint', attempts: [2.11, 2.06, 2.08] }], meta: META });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].kind, 'measured');
  assert.deepEqual(out.results[0].attempts, [2.11, 2.06, 2.08], 'every attempt preserved');
  assert.equal(out.results[0].result, 2.06, 'engine-derived best (lower is better)');
  assert.equal(out.results[0].unit, 'sec');
});

test('first valid result derives a baseline; later results trend against it without overwriting history', async () => {
  const store = new MemoryAssessmentStore();
  await recordAssessmentSession(store, { athleteId: 'ath-test-01', coachId: 'kayla',
    entries: [{ assessmentId: 'broad-jump', attempts: [58, 60, 59] }],
    meta: { ...META, recordedAt: '2027-01-10T12:00:00Z' } });
  const second = await recordAssessmentSession(store, { athleteId: 'ath-test-01', coachId: 'kayla',
    entries: [{ assessmentId: 'broad-jump', attempts: [63, 61, 62] }],
    meta: { ...META, recordedAt: '2027-02-10T12:00:00Z' } });
  const baselines = second.interpretations.filter(i => i.derivedType === 'baseline');
  const trends = second.interpretations.filter(i => i.derivedType === 'trend-vs-baseline');
  assert.equal(baselines.length, 0, 'baseline is not re-derived on the second session');
  assert.equal(trends.length, 1);
  assert.equal(trends[0].value.status, 'improved');
  assert.equal(trends[0].kind, 'interpretation');
  assert.match(trends[0].caveat, /Review context/);
  const all = await store.listResults('ath-test-01', 'broad-jump');
  assert.equal(all.length, 2, 'both sessions preserved; history never overwritten');
  assert.equal(all[0].result, 60, 'first session result intact');
});

test('coach notes are observations, never measurements', async () => {
  const store = new MemoryAssessmentStore();
  const out = await recordAssessmentSession(store, { athleteId: 'ath-test-01', coachId: 'kayla',
    entries: [{ assessmentId: 'push-ups', attempts: [22], notes: 'Good form, stopped at first break.' }],
    meta: META });
  assert.equal(out.observations.length, 1);
  assert.equal(out.observations[0].kind, 'observation');
  assert.equal(out.observations[0].value, undefined);
  assert.equal(out.results[0].result, 22);
});

test('bilateral asymmetry is stored as an interpretation with the medical caveat', async () => {
  const store = new MemoryAssessmentStore();
  const out = await recordAssessmentSession(store, { athleteId: 'ath-test-01', coachId: 'kayla',
    entries: [
      { assessmentId: 'rotational-scoop-r', attempts: [21, 20, 21] },
      { assessmentId: 'rotational-scoop-l', attempts: [17, 16, 17] },
    ], meta: META });
  const asym = out.interpretations.find(i => i.derivedType === 'bilateral-asymmetry');
  assert.ok(asym, 'asymmetry record exists');
  assert.equal(asym.value.label, 'monitor', '21 vs 17 ft is >=15%');
  assert.match(asym.caveat, /Not a medical threshold/);
  assert.equal(asym.kind, 'interpretation');
});

test('unknown assessment ids and empty entries are rejected, not stored', async () => {
  const store = new MemoryAssessmentStore();
  await assert.rejects(recordAssessmentSession(store, { athleteId: 'ath-test-01',
    entries: [{ assessmentId: 'not-a-test', attempts: [1] }], meta: META }), /Unknown assessment/);
  await assert.rejects(recordAssessmentSession(store, { athleteId: 'ath-test-01', entries: [], meta: META }), /At least one/);
  assert.equal(store.sessions.length, 0);
});

test('evidence for Smart Draft is derived evidence only, labelled as such', async () => {
  const store = new MemoryAssessmentStore();
  await recordAssessmentSession(store, { athleteId: 'ath-test-01', coachId: 'kayla',
    entries: [{ assessmentId: 'broad-jump', attempts: [63] }],
    meta: { ...META, recordedAt: '2027-01-10T12:00:00Z' } });
  await recordAssessmentSession(store, { athleteId: 'ath-test-01', coachId: 'kayla',
    entries: [{ assessmentId: 'broad-jump', attempts: [58] }],
    meta: { ...META, recordedAt: '2027-02-10T12:00:00Z' } });
  const ev = await evidenceForDraft(store, 'ath-test-01');
  assert.equal(ev.source, 'assessment-trend');
  assert.match(ev.caveat, /[Mm]ust not become an automatic/);
  assert.ok(ev.evidence.length >= 1);
  assert.equal(ev.evidence[0].domain, 'horizontal_power');
});

test('migration 002 seeds exactly the engine V1 definitions', () => {
  const fs = require('node:fs');
  const sql = fs.readFileSync(require('node:path').join(__dirname, '..', 'migrations', '002_assessment_persistence.sql'), 'utf8');
  for (const id of Object.keys(Engine.definitions)) {
    assert.ok(sql.includes(`('${id}'`), `migration seeds ${id}`);
  }
  assert.match(sql, /kind TEXT NOT NULL CHECK \(kind IN \('observation','interpretation'\)\)/);
  assert.match(sql, /attempts JSONB NOT NULL/);
});
