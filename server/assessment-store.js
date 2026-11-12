/* THE PROGRAM OS — Assessment persistence adapter (operational foundation V1)
 *
 * Bridges the pure assessment engine (assessment-engine/assessment-engine.js,
 * branch feature/assessment-engine-v1, squash-merged to main as dc5d42d)
 * to persistent athlete records WITHOUT changing the engine or the UI.
 *
 * Separation preserved (prototype LOCKED decision: "No invented athlete
 * ratings. Measured data, coach observation and system interpretation
 * stay separate."):
 *   - measured: attempts + engine-derived result, stored verbatim with
 *     protocol version, unit, method, equipment/surface context.
 *   - observation: coach notes, free text only — never a number presented
 *     as a measurement.
 *   - interpretation: engine output (change/interpret/asymmetry/priorities),
 *     stored as DERIVED records labelled system-generated, with the
 *     engine version attached. An interpretation is never stored as a
 *     measurement and never overwrites one.
 *
 * Baselines are DERIVED, not overwritten: the first valid result for an
 * athlete+assessment becomes the baseline; later results never rewrite
 * history. A baseline policy change creates a new derived record.
 *
 * Safety: the engine's asymmetry "monitor" label is a product signal,
 * not a medical threshold (see assessment-engine/README.md). This adapter
 * stores it with that caveat attached and never renders it as a diagnosis.
 * No population percentile/ranking claims are produced. Nothing here is
 * clinically or scientifically validated — the battery itself is still
 * NEEDS VALIDATION in the prototype (TESTS[].st).
 *
 * Store interface: a minimal subset — insertSession(sessionRow),
 * insertResult(resultRow), insertDerived(derivedRow), listResults(athleteId,
 * assessmentId), listSessions(athleteId). MemoryAssessmentStore (below)
 * implements it for tests; the PostgreSQL tables are migrations/002.
 */
'use strict';

const Engine = require('../assessment-engine/assessment-engine.js');

const RECORD_KINDS = ['measured', 'observation', 'interpretation'];
const ASYMMETRY_CAVEAT = 'Product signal only (engine V1: >=15% bilateral difference = "monitor"). Not a medical threshold, diagnosis, or clearance.';

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

class MemoryAssessmentStore {
  constructor() { this.sessions = []; this.results = []; this.derived = []; }
  async insertSession(row) { this.sessions.push(clone(row)); return clone(row); }
  async insertResult(row) { this.results.push(clone(row)); return clone(row); }
  async insertDerived(row) { this.derived.push(clone(row)); return clone(row); }
  async listResults(athleteId, assessmentId) {
    return this.results.filter(r => r.athleteId === athleteId && (!assessmentId || r.assessmentId === assessmentId))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map(clone);
  }
  async listSessions(athleteId) {
    return this.sessions.filter(s => s.athleteId === athleteId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map(clone);
  }
}

/* Validate + persist one engine buildSession() output.
 * input: { athleteId, coachId, entries:[{assessmentId, attempts, notes}],
 *          meta:{battery, recordedAt, notes, context:{equipment, surface, protocolVersion}} }
 * Coach notes go to an OBSERVATION record; numeric attempts/results go to
 * MEASURED records; engine interpretation goes to INTERPRETATION records. */
async function recordAssessmentSession(store, input) {
  if (!input || !input.athleteId) throw new Error('athleteId is required.');
  if (!Array.isArray(input.entries) || !input.entries.length) throw new Error('At least one assessment entry is required.');
  const session = Engine.buildSession(input.athleteId, input.entries, input.meta || {});
  const sessionRow = {
    id: uid('asess'), athleteId: String(input.athleteId), coachId: input.coachId || null,
    battery: session.battery, recordedAt: session.recordedAt,
    context: (input.meta && input.meta.context) || null, engineVersion: Engine.version,
  };
  await store.insertSession(sessionRow);
  const stored = { session: sessionRow, results: [], observations: [], interpretations: [] };
  for (const r of session.results) {
    const def = Engine.definitions[r.assessmentId];
    const prior = await store.listResults(session.athleteId, r.assessmentId);
    const isFirstValid = r.result != null && prior.filter(p => p.result != null).length === 0;
    const resultRow = { id: uid('ares'), sessionId: sessionRow.id, athleteId: session.athleteId,
      assessmentId: r.assessmentId, kind: 'measured', attempts: r.attempts, result: r.result,
      unit: def.unit, direction: def.direction, protocolVersion: def.retestDays ? `v1-retest-${def.retestDays}d` : 'v1',
      recordedAt: session.recordedAt };
    await store.insertResult(resultRow);
    stored.results.push(resultRow);
    if (r.notes) {
      const obs = { id: uid('aobs'), sessionId: sessionRow.id, athleteId: session.athleteId,
        assessmentId: r.assessmentId, kind: 'observation', text: String(r.notes), recordedAt: session.recordedAt };
      await store.insertDerived(obs); stored.observations.push(obs);
    }
    if (isFirstValid) {
      const base = { id: uid('ader'), sessionId: sessionRow.id, athleteId: session.athleteId,
        assessmentId: r.assessmentId, kind: 'interpretation', derivedType: 'baseline',
        value: r.result, source: 'derived-first-valid-result', engineVersion: Engine.version,
        recordedAt: session.recordedAt,
        caveat: 'Baseline = first valid result for this athlete and assessment. Derived, not measured; history is never overwritten.' };
      await store.insertDerived(base); stored.interpretations.push(base);
    } else if (r.result != null && prior.length) {
      const baseline = prior.find(p => p.result != null);
      if (baseline) {
        const interp = Engine.interpret(r.assessmentId, baseline.result, r.result);
        const row = { id: uid('ader'), sessionId: sessionRow.id, athleteId: session.athleteId,
          assessmentId: r.assessmentId, kind: 'interpretation', derivedType: 'trend-vs-baseline',
          value: interp, source: 'assessment-engine', engineVersion: Engine.version,
          recordedAt: session.recordedAt,
          caveat: 'System interpretation of measured change. Review context (fatigue, conditions, technique) before changing training.' };
        await store.insertDerived(row); stored.interpretations.push(row);
      }
    }
  }
  // Bilateral pairs recorded in the same session get an asymmetry signal.
  const byPair = {};
  for (const r of session.results) {
    const def = Engine.definitions[r.assessmentId];
    if (def && def.pairId && r.result != null) (byPair[def.pairId] = byPair[def.pairId] || {})[def.side] = r.result;
  }
  for (const [pairId, sides] of Object.entries(byPair)) {
    if (sides.left != null && sides.right != null) {
      const asym = Engine.asymmetry(sides.left, sides.right);
      const row = { id: uid('ader'), sessionId: sessionRow.id, athleteId: session.athleteId,
        assessmentId: pairId, kind: 'interpretation', derivedType: 'bilateral-asymmetry',
        value: asym, source: 'assessment-engine', engineVersion: Engine.version,
        recordedAt: session.recordedAt, caveat: ASYMMETRY_CAVEAT };
      await store.insertDerived(row); stored.interpretations.push(row);
    }
  }
  if (session.notes) {
    const obs = { id: uid('aobs'), sessionId: sessionRow.id, athleteId: session.athleteId,
      assessmentId: null, kind: 'observation', text: session.notes, recordedAt: session.recordedAt };
    await store.insertDerived(obs); stored.observations.push(obs);
  }
  return stored;
}

/* Development-priority evidence for Smart Draft (future): derived only,
 * explicitly labelled, never an automatic programming override. */
async function evidenceForDraft(store, athleteId) {
  const results = await store.listResults(athleteId);
  const byAssessment = {};
  for (const r of results) (byAssessment[r.assessmentId] = byAssessment[r.assessmentId] || []).push(r);
  const records = [];
  for (const [assessmentId, rows] of Object.entries(byAssessment)) {
    const valid = rows.filter(r => r.result != null);
    if (valid.length < 2) continue;
    records.push({ assessmentId, baseline: valid[0].result, current: valid[valid.length - 1].result });
  }
  const priorities = Engine.generatePriorities(records);
  return { athleteId, evidence: priorities, source: 'assessment-trend',
    caveat: 'Evidence for a human coach / Smart Draft to consider. Must not become an automatic one-signal workout override (INTEGRATION.md).' };
}

module.exports = { recordAssessmentSession, evidenceForDraft, MemoryAssessmentStore,
  RECORD_KINDS, ASYMMETRY_CAVEAT, engineVersion: Engine.version };
