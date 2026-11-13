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
 *
 * GAA extensions (universal assessment, 2026-11-12):
 *   - Idempotency: meta.idempotencyKey makes a recording retry-safe.
 *     A second call with the same key for the same athlete returns
 *     the originally stored session (idempotentReplay: true) and
 *     inserts nothing. Postgres enforces the same rule with the
 *     unique index in migration 004.
 *   - Movement assessment: the entry 'movement-assessment' is
 *     observation-only. It is stored as an observation record (coach
 *     words), never as a measured result; the engine never sees it.
 *   - Modified results: an entry may carry modified: true (an
 *     age-appropriate alternative or accommodation was used). The flag
 *     is stored on the result row so a modified result is never
 *     silently compared against a standard-protocol baseline.
 *   - GAA protocol validation: sessions with battery
 *     'generalAthleticAssessment' have their attempts validated
 *     against server/assessment-battery.js before anything is stored.
 */
'use strict';

const Engine = require('../assessment-engine/assessment-engine.js');
const { validateAttempts } = require('./assessment-battery');

const RECORD_KINDS = ['measured', 'observation', 'interpretation'];
const ASYMMETRY_CAVEAT = 'Product signal only (engine V1: >=15% bilateral difference = "monitor"). Not a medical threshold, diagnosis, or clearance.';

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

class MemoryAssessmentStore {
  constructor() { this.sessions = []; this.results = []; this.derived = []; this.drafts = []; }
  async insertSession(row) { this.sessions.push(clone(row)); return clone(row); }
  async insertResult(row) { this.results.push(clone(row)); return clone(row); }
  async insertDerived(row) { this.derived.push(clone(row)); return clone(row); }
  /* Drafts (incomplete assessments): one per athlete + battery.
   * A draft is working state, not history — it never counts toward a
   * baseline, progress, or a due date, and it is deleted when the
   * assessment is completed. Postgres side: assessment_drafts in
   * migration 004 (UNIQUE athlete_id + battery). */
  async upsertDraft(row) {
    const i = this.drafts.findIndex(d => d.athleteId === row.athleteId && d.battery === row.battery);
    const saved = clone(row);
    if (i >= 0) this.drafts[i] = saved; else this.drafts.push(saved);
    return clone(saved);
  }
  async getDraft(athleteId, battery) {
    const d = this.drafts.find(d => d.athleteId === athleteId && d.battery === battery);
    return d ? clone(d) : null;
  }
  async deleteDraft(athleteId, battery) {
    const i = this.drafts.findIndex(d => d.athleteId === athleteId && d.battery === battery);
    if (i >= 0) this.drafts.splice(i, 1);
    return true;
  }
  async listResults(athleteId, assessmentId) {
    return this.results.filter(r => r.athleteId === athleteId && (!assessmentId || r.assessmentId === assessmentId))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map(clone);
  }
  async listSessions(athleteId) {
    return this.sessions.filter(s => s.athleteId === athleteId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map(clone);
  }
  async findSessionByIdempotencyKey(athleteId, key) {
    if (!key) return null;
    const s = this.sessions.find(s => s.athleteId === athleteId && s.idempotencyKey === key);
    return s ? clone(s) : null;
  }
  async listDerivedBySession(sessionId) {
    return this.derived.filter(d => d.sessionId === sessionId).map(clone);
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
  const idempotencyKey = (input.meta && input.meta.idempotencyKey) || null;
  if (idempotencyKey && typeof store.findSessionByIdempotencyKey === 'function') {
    const existing = await store.findSessionByIdempotencyKey(String(input.athleteId), idempotencyKey);
    if (existing) {
      const results = (await store.listResults(existing.athleteId)).filter(r => r.sessionId === existing.id);
      const derived = typeof store.listDerivedBySession === 'function'
        ? await store.listDerivedBySession(existing.id) : [];
      return { session: existing, results, observations: derived.filter(d => d.kind === 'observation'),
        interpretations: derived.filter(d => d.kind === 'interpretation'), idempotentReplay: true };
    }
  }
  // Split observation-only entries (movement assessment) from measured
  // entries. The engine only ever sees measured entries.
  const observationEntries = [];
  const measuredEntries = [];
  for (const e of input.entries) {
    if (e.assessmentId === 'movement-assessment') {
      const text = e.observations || e.text || e.notes;
      if (!text) throw new Error('Movement assessment requires written observations.');
      observationEntries.push({ ...e, text: String(text) });
    } else measuredEntries.push(e);
  }
  if (measuredEntries.length) {
    // GAA protocol validation runs before anything is stored.
    const battery = (input.meta && input.meta.battery) || '';
    if (battery === 'generalAthleticAssessment') {
      for (const e of measuredEntries) {
        const check = validateAttempts(e.assessmentId, e.attempts);
        if (!check.ok) throw new Error(`Invalid attempts for ${e.assessmentId}: ${check.reasons.join(' ')}`);
      }
    }
  }
  const session = Engine.buildSession(input.athleteId, measuredEntries, input.meta || {});
  const sessionRow = {
    id: uid('asess'), athleteId: String(input.athleteId), coachId: input.coachId || null,
    battery: session.battery, recordedAt: session.recordedAt,
    context: (input.meta && input.meta.context) || null, engineVersion: Engine.version,
    idempotencyKey,
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
      recordedAt: session.recordedAt,
      modified: measuredEntries.find(e => e.assessmentId === r.assessmentId)?.modified === true,
      capped: measuredEntries.find(e => e.assessmentId === r.assessmentId)?.capped === true };
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
  // Movement assessment observations: coach words, stored as
  // observations — never as measurements, never scored.
  for (const e of observationEntries) {
    const obs = { id: uid('aobs'), sessionId: sessionRow.id, athleteId: session.athleteId,
      assessmentId: 'movement-assessment', kind: 'observation', text: e.text,
      recordedAt: session.recordedAt };
    await store.insertDerived(obs); stored.observations.push(obs);
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
