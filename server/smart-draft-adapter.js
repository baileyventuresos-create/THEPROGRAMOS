/* THE PROGRAM OS — Smart Draft advisory adapter
 * server/smart-draft-adapter.js
 *
 * Connects assessment evidence to development priorities WITHOUT
 * letting an assessment rewrite a program. The contract is advisory
 * only, and it is enforced in the shape of the output itself:
 *
 *   - Every result carries advisoryOnly: true,
 *     requiresCoachApproval: true, autoRewrite: false.
 *   - There is NO function here that writes, edits, or applies a
 *     training plan. A coach reads the priorities and decides; Smart
 *     Draft (the prototype drawer) remains responsible for
 *     programming, and a human approves the draft before anything is
 *     assigned (server/schedule-session.js).
 *   - One poor result produces at most one flagged priority at LOW
 *     confidence, labelled as single-result evidence. It never
 *     becomes a program change on its own.
 *   - Priorities are ranked by evidence score (decline magnitude),
 *     not by a single test. A test that improved creates no need.
 *
 * Priority names are the mission's development priorities. Mapping is
 * by assessment id (most precise), covering both the GAA battery and
 * the legacy engine definitions.
 */
'use strict';

const { progressForAthlete } = require('./progress');

const PRIORITY_NAMES = {
  acceleration: 'Acceleration',
  agility: 'Agility',
  power: 'Power',
  strength: 'Strength',
  muscular_endurance: 'Muscular endurance',
  cardiovascular_conditioning: 'Cardiovascular conditioning',
  mobility_movement_control: 'Mobility and movement control',
};

/* assessmentId -> mission priority. */
const ASSESSMENT_TO_PRIORITY = {
  '10yd-sprint': 'acceleration',
  'broad-jump': 'power',
  '5-10-5-shuttle': 'agility',
  'push-ups': 'muscular_endurance',
  'side-plank-r': 'muscular_endurance',
  'side-plank-l': 'muscular_endurance',
  'single-leg-balance-r': 'mobility_movement_control',
  'single-leg-balance-l': 'mobility_movement_control',
  '6min-walk-run': 'cardiovascular_conditioning',
  'rotational-scoop-r': 'power',
  'rotational-scoop-l': 'power',
  'throw-velo': 'power',
  'throw-accuracy': 'power',
  'exit-velo': 'power',
};

const ADVISORY_CONTRACT = Object.freeze({
  advisoryOnly: true,
  requiresCoachApproval: true,
  autoRewrite: false,
  caveat: 'Assessment evidence for a human coach to consider. It must not become an automatic program rewrite: one poor result never rewrites a training program, and the coach retains control over every prescription.',
});

/* Build advisory priorities from per-test progress (server/progress.js
 * output). progressByTest: { assessmentId: progressForTest result }.
 * goals: optional array of priority keys the athlete is working
 * toward — used only to flag goal alignment, never to change scores. */
function developmentPriorities({ athleteId, progressByTest, goals = [] } = {}) {
  if (!athleteId) throw new Error('athleteId is required.');
  const byPriority = {};
  let trendTests = 0;
  for (const [assessmentId, p] of Object.entries(progressByTest || {})) {
    const priority = ASSESSMENT_TO_PRIORITY[assessmentId];
    if (!priority || !p || !p.vsBaseline) continue;
    // A trend needs at least two valid results (vsPrevious exists).
    // A lone baseline is not a trend and creates no evidence.
    if (p.vsPrevious != null) trendTests++;
    const need = Math.max(0, -(p.vsBaseline.improvementPercent == null ? 0 : p.vsBaseline.improvementPercent));
    // A zero-baseline percent is undefined; fall back to the absolute
    // direction-corrected change scaled by the maintenance band so a
    // real decline still registers without inventing a percent.
    const fallbackNeed = p.vsBaseline.improvementPercent == null
      ? Math.max(0, -(p.vsBaseline.absolute * (p.direction === 'lower' ? -1 : 1)))
      : 0;
    const score = need + fallbackNeed;
    if (score <= 0) continue;
    const bucket = byPriority[priority] || (byPriority[priority] = { priority, evidenceScore: 0, sources: [] });
    bucket.evidenceScore += score;
    bucket.sources.push({ assessmentId, baseline: p.baseline, current: p.current,
      improvementPercent: p.vsBaseline.improvementPercent, absolute: p.vsBaseline.absolute,
      status: p.vsBaseline.status });
  }
  const priorities = Object.values(byPriority)
    .map(b => {
      const singleSource = b.sources.length === 1;
      return {
        priority: b.priority,
        displayName: PRIORITY_NAMES[b.priority],
        evidenceScore: Number(b.evidenceScore.toFixed(2)),
        sources: b.sources,
        goalAligned: goals.includes(b.priority),
        confidence: singleSource ? 'low' : 'moderate',
        note: singleSource
          ? 'Based on a single assessment result — coach review required; do not rewrite the program on this alone.'
          : 'Based on more than one assessment result; still coach-reviewed, never automatic.',
      };
    })
    .sort((a, b) => b.evidenceScore - a.evidenceScore);
  return { athleteId, ...ADVISORY_CONTRACT, priorities,
    insufficientEvidence: trendTests === 0,
    note: trendTests === 0
      ? 'No trend yet: fewer than two assessments, or no baseline. Record a baseline and a reassessment before using assessment evidence for programming.'
      : undefined };
}

/* Convenience: build priorities straight from stored result rows
 * [{ assessmentId, recordedAt, result }]. */
function prioritiesFromResults(athleteId, resultRows, { age, goals } = {}) {
  const byAssessment = {};
  for (const r of resultRows || []) {
    if (r.result == null) continue;
    (byAssessment[r.assessmentId] = byAssessment[r.assessmentId] || [])
      .push({ recordedAt: r.recordedAt, result: r.result });
  }
  const { tests } = progressForAthlete(athleteId, byAssessment, { age });
  return developmentPriorities({ athleteId, progressByTest: tests, goals });
}

/* Human-readable summary for the coach. Advisory text only. */
function summarizeForCoach(advisory) {
  if (!advisory) return 'No assessment evidence available.';
  if (advisory.insufficientEvidence) return 'Assessment evidence: insufficient — no trend yet. ' + (advisory.note || '');
  if (!advisory.priorities.length) return 'Assessment evidence: no declining priorities. All tracked tests are at or above baseline.';
  const lines = advisory.priorities.map(p =>
    `- ${p.displayName} (evidence ${p.evidenceScore}, confidence ${p.confidence}${p.goalAligned ? ', goal-aligned' : ''}): ${p.sources.map(s => `${s.assessmentId} ${s.baseline} → ${s.current}`).join('; ')}.`);
  return ['Assessment evidence (advisory only — coach approval required, never an automatic rewrite):', ...lines].join('\n');
}

module.exports = {
  PRIORITY_NAMES, ASSESSMENT_TO_PRIORITY, ADVISORY_CONTRACT,
  developmentPriorities, prioritiesFromResults, summarizeForCoach,
};
