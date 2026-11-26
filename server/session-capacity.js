/* THE PROGRAM OS — Session capacity adapter (operational foundation V1)
 *
 * Purpose: derive a SESSION reservation cap from the prototype's own
 * session architecture — never from a hard-coded universal athlete limit.
 *
 * The prototype (THE PROGRAM OS.html) already encodes the rules this
 * adapter mirrors; it does not replace them:
 *   - buildConfigs(tpl, n, emph, coaches): stations at once never exceed
 *     available coaches; preferred station size 4-6 (STATION_DEFAULT);
 *     BUILD slot minutes 5..14 (slotMath, MIN_SLOT=8 preferred, MAX_SLOT=14).
 *   - coachesFor(cohort): small-group format = 1 coach, otherwise 3
 *     (an ASSUMPTION in the prototype, flagged NEEDS DEFINITION).
 *   - checkGame/sizeFor: a game only runs when the playing group fits its
 *     group range and per-copy size; equipment is checked per basis.
 *   - sessionWarnings(): stations at once > coaches is a CRIT warning;
 *     self-directed stations are not designed or approved.
 *
 * This module INVERTS buildConfigs: instead of "given n athletes, what
 * station layout?", it answers "given coaches, template, facility and
 * equipment, what is the largest n that still fits a coached layout?"
 * The prototype's draftSession/human-approval flow is untouched; this
 * adapter only supplies the capacity number the reservation engine
 * enforces, and flags sessions that are not operationally feasible.
 *
 * No universal limit is hard-coded anywhere in this file. Every cap is
 * computed from the inputs supplied for that session. Where an input is
 * missing (e.g. a space with no stated max occupancy), the adapter says
 * so explicitly instead of inventing a number.
 */
'use strict';

const PREFERRED_STATION = [4, 6]; // STATION_DEFAULT in the prototype
const MIN_SLOT = 8;               // prototype MIN_SLOT (preferred minimum BUILD slot)
const MAX_SLOT = 14;              // prototype MAX_SLOT
const MIN_ROUNDS = 3;
const MAX_ROUNDS = 6;

/* Prototype slotMath, verbatim semantics: split B BUILD minutes into
 * `rounds` slots with `t` minutes of changeover between them. Returns
 * the first exact integer split with slot >= 5 min, else the closest
 * short split. */
function slotMath(B, rounds) {
  for (let t = 0; t <= 3; t++) {
    const m = (B - (rounds - 1) * t) / rounds;
    if (Number.isInteger(m) && m >= 5) return { m, t };
  }
  const t = 1, m = Math.floor((B - (rounds - 1) * t) / rounds);
  return { m, t, short: true, leftover: B - (rounds * m + (rounds - 1) * t) };
}

/* Prototype buildConfigs semantics, reduced to feasibility for a given
 * athlete count n: is there a station layout (k stations at once, r
 * rotations) that fits the BUILD minutes with the available coaches? */
function layoutFor(n, buildMinutes, coachesAvailable, oneGroup) {
  const B = +buildMinutes || 0;
  const C = Math.max(1, Math.floor(+coachesAvailable || 1));
  if (oneGroup || n <= 5) {
    // Prototype: one group, no rotation; BUILD split into 3 slots.
    const m = Math.floor(B / 3);
    return { id: 'one', k: 1, r: 1, rounds: 3, size: n, minSize: n,
      slotMin: m, coachesNeeded: 1, feasible: m >= 5, oneGroup: true,
      reason: `${n} athletes: one group, no rotation.` };
  }
  const out = [];
  for (let k = 1; k <= Math.min(C, 6); k++) {
    for (let r = 1; r <= 6; r++) {
      const rounds = k * r;
      if (rounds < MIN_ROUNDS || rounds > MAX_ROUNDS) continue;
      if (k === 1 && r !== 3 && r !== 6) continue;
      const sm = slotMath(B, rounds);
      if (sm.m < 5 || sm.m > MAX_SLOT) continue;
      const size = Math.ceil(n / k), minSize = Math.floor(n / k);
      out.push({ id: `${k}x${r}`, k, r, rounds, size, minSize,
        slotMin: sm.m, changeoverMin: sm.t, coachesNeeded: k,
        short: sm.m < MIN_SLOT, feasible: true,
        withinPreferred: minSize >= PREFERRED_STATION[0] && size <= PREFERRED_STATION[1],
        reason: `${n} athletes ÷ ${k} station${k > 1 ? 's' : ''} = ` +
          (minSize === size ? `${size}` : `${minSize}–${size}`) +
          ` per station; ${rounds} rounds × ${sm.m} min` });
    }
  }
  if (!out.length) return { id: 'none', k: 0, r: 0, rounds: 0, size: n, minSize: n,
    slotMin: 0, coachesNeeded: 0, feasible: false,
    reason: 'No rotation fits this length and staffing.' };
  // Cheapest = prototype pickConfig (first after cost sort). Cost here
  // mirrors the prototype: penalise deviation from 4-6 per station,
  // short slots, and extra rotations.
  for (const c of out) {
    const dev = Math.max(0, PREFERRED_STATION[0] - c.minSize) +
      Math.max(0, c.size - PREFERRED_STATION[1]);
    c.cost = 2 * dev + (c.short ? MIN_SLOT - c.slotMin : 0) + (c.r - 1) * 1.5 - 0.3 * c.rounds;
  }
  out.sort((a, b) => a.cost - b.cost || a.k - b.k);
  return out[0];
}

/**
 * computeSessionCapacity(input) -> capacity decision for one session.
 *
 * input:
 *   template: { id, dur, phases:{build}, oneGroup? }  (prototype TEMPLATE_SEED row)
 *   coachesAvailable: number of coaches actually available for this session
 *   cohortCap: enrollment cap of the cohort this session belongs to (may be null)
 *   cohortEnrolled: athletes currently enrolled in the cohort (may be null)
 *   location: { spaces: [{name, maxAthletes?}] } — maxAthletes is operator-
 *     supplied; the prototype records dimensions only, so absence is flagged.
 *   equipment: [{ item, have, needPerAthlete }] — inventory vs per-athlete need
 *     for the session's planned games (prototype equipCheck/qtyFor basis).
 *   gameGroupMax: largest per-copy group size among the session's planned
 *     games (prototype sizeFor / group[1]); null when no games are planned yet.
 *   sessionMinutes: planned total minutes (prototype sessionMinutes); checked
 *     against the template target when supplied.
 *
 * Returns { feasible, preferredCap, hardCap, effectiveCap, limitingFactors[],
 *           infeasibleReasons[], layout, warnings[] }.
 * effectiveCap is the reservation cap the engine must enforce. It is the
 * minimum of every binding constraint — never a universal constant.
 */
function computeSessionCapacity(input) {
  const inp = input || {};
  const tpl = inp.template || {};
  const buildMinutes = (tpl.phases && +tpl.phases.build) || 0;
  const coaches = Math.max(0, Math.floor(+inp.coachesAvailable || 0));
  const limiting = [];
  const infeasible = [];
  const warnings = [];

  if (coaches < 1) infeasible.push('No coach available for this session.');
  if (!buildMinutes || buildMinutes <= 0) infeasible.push('Template has no BUILD minutes; station layout cannot be derived.');

  // Preferred cap: every station at the preferred maximum (6 athletes).
  // Stations at once never exceed available coaches (prototype LOCKED rule).
  const preferredCap = coaches * PREFERRED_STATION[1];

  // Hard cap: the largest group the planned games can actually run.
  // Without planned games there is no evidence for a larger group, so the
  // hard cap falls back to the preferred cap and says so.
  let hardCap = preferredCap;
  let hardCapBasis = `preferred station size (${PREFERRED_STATION[1]} × ${coaches} coach${coaches === 1 ? '' : 'es'})`;
  if (inp.gameGroupMax != null && Number.isFinite(+inp.gameGroupMax) && +inp.gameGroupMax > 0) {
    hardCap = Math.min(coaches * +inp.gameGroupMax, preferredCap * 4);
    hardCapBasis = `largest planned game group (${+inp.gameGroupMax} per copy × ${coaches} station${coaches === 1 ? '' : 's'})`;
    if (hardCap > preferredCap) warnings.push(`Hard cap (${hardCap}) exceeds preferred cap (${preferredCap}); reservations above preferred need Director sign-off (prototype station-size flag).`);
  } else {
    warnings.push('No planned games supplied: hard cap falls back to preferred cap. Plan the session (human-approved draft) before raising capacity.');
  }

  // Cohort enrollment cap binds reservations for cohort sessions.
  let cohortCap = null;
  if (inp.cohortCap != null && Number.isFinite(+inp.cohortCap)) {
    cohortCap = +inp.cohortCap;
    limiting.push({ constraint: 'cohort enrollment cap', value: cohortCap });
  }

  // Facility: operator-supplied max occupancy per space. The prototype
  // records dimensions only — never infer occupancy from square footage.
  let facilityCap = null;
  if (inp.location && Array.isArray(inp.location.spaces) && inp.location.spaces.length) {
    const known = inp.location.spaces.filter(s => s && Number.isFinite(+s.maxAthletes));
    if (known.length === inp.location.spaces.length) {
      facilityCap = known.reduce((a, s) => a + (+s.maxAthletes), 0);
      limiting.push({ constraint: 'facility max occupancy', value: facilityCap });
    } else {
      warnings.push(`Facility occupancy not fully specified (${known.length}/${inp.location.spaces.length} spaces have a maxAthletes value); facility does not bind this cap. Operator must set occupancy before it can constrain reservations.`);
    }
  } else {
    warnings.push('No location/spaces supplied; facility does not bind this cap.');
  }

  // Equipment: per-athlete need vs inventory on hand.
  let equipmentCap = null;
  if (Array.isArray(inp.equipment) && inp.equipment.length) {
    const caps = [];
    for (const e of inp.equipment) {
      if (!e || !(+e.needPerAthlete > 0)) continue;
      const cap = Math.floor((+e.have || 0) / +e.needPerAthlete);
      caps.push({ item: e.item, cap });
      if (cap === 0) infeasible.push(`Equipment shortfall: ${e.item} — need ${e.needPerAthlete} per athlete, have ${+e.have || 0}.`);
    }
    if (caps.length) {
      equipmentCap = Math.min(...caps.map(c => c.cap));
      limiting.push({ constraint: 'equipment', value: equipmentCap,
        detail: caps.map(c => `${c.item}: ${c.cap}`).join(', ') });
    }
  }

  // Layout feasibility at the preferred cap, and the largest n that keeps
  // every station inside the preferred 4-6 band with the available coaches.
  let layout = layoutFor(Math.max(1, preferredCap), buildMinutes, Math.max(1, coaches), !!tpl.oneGroup);
  let preferredFeasible = layout.feasible && (layout.oneGroup || layout.withinPreferred);
  if (coaches >= 1 && buildMinutes > 0 && !preferredFeasible) {
    warnings.push(`Preferred cap ${preferredCap} does not fit a preferred 4–6-per-station layout (${layout.reason}); effective cap is reduced to the largest fitting count.`);
  }

  // Largest n with a feasible layout whose stations stay in 4-6.
  let maxFitting = 0;
  if (coaches >= 1 && buildMinutes > 0) {
    for (let n = 1; n <= Math.max(preferredCap, hardCap, 40); n++) {
      const l = layoutFor(n, buildMinutes, coaches, !!tpl.oneGroup);
      if (l.feasible && (l.oneGroup || l.withinPreferred)) maxFitting = n;
      else if (n > preferredCap && l.feasible && !l.withinPreferred) {
        // Above preferred: layout exists but stations exceed 6 — stop;
        // larger groups only get worse without more coaches.
        if (n > maxFitting + 6) break;
      }
    }
  }

  const candidates = [preferredCap, hardCap, maxFitting || preferredCap];
  if (cohortCap != null) candidates.push(cohortCap);
  if (facilityCap != null) candidates.push(facilityCap);
  if (equipmentCap != null) candidates.push(equipmentCap);
  let effectiveCap = Math.max(0, Math.min(...candidates));
  if (coaches < 1 || buildMinutes <= 0) effectiveCap = 0;

  limiting.unshift(
    { constraint: 'coached stations (preferred)', value: preferredCap,
      detail: `${coaches} coach${coaches === 1 ? '' : 'es'} × ${PREFERRED_STATION[1]} athletes/station` },
    { constraint: 'hard cap', value: hardCap, detail: hardCapBasis },
    { constraint: 'largest fitting preferred layout', value: maxFitting || 0 });
  if (effectiveCap < preferredCap) {
    const binding = limiting.filter(l => l.value === effectiveCap).map(l => l.constraint).join(', ') || 'layout fit';
    warnings.push(`Effective cap ${effectiveCap} is below preferred ${preferredCap}; binding constraint: ${binding}. Do not raise it without adding coaches, space, or equipment.`);
  }

  if (inp.sessionMinutes != null && tpl.dur != null && +inp.sessionMinutes !== +tpl.dur) {
    warnings.push(`Planned session is ${+inp.sessionMinutes} min vs ${+tpl.dur}-min ${tpl.id || 'template'} target (prototype sessionWarnings rule).`);
  }

  return {
    feasible: infeasible.length === 0 && effectiveCap > 0,
    preferredCap, hardCap, effectiveCap,
    limitingFactors: limiting,
    infeasibleReasons: infeasible,
    warnings,
    layout: layoutFor(Math.max(1, effectiveCap), buildMinutes, Math.max(1, coaches), !!tpl.oneGroup),
    stationPreferred: PREFERRED_STATION.slice(),
  };
}

/* Recalculate after a change (coach called out, equipment lost, cohort cap
 * changed). Returns the new decision plus what changed, for the audit trail. */
function recalculateCapacity(previous, input) {
  const next = computeSessionCapacity(input);
  return { previousEffectiveCap: previous ? previous.effectiveCap : null,
    next, changed: !previous || previous.effectiveCap !== next.effectiveCap,
    note: !previous ? 'First calculation.'
      : previous.effectiveCap === next.effectiveCap ? 'Capacity unchanged.'
      : `Capacity ${previous.effectiveCap} → ${next.effectiveCap}. Existing confirmed reservations above the new cap are NOT cancelled automatically; they are flagged for Director review.` };
}

module.exports = { computeSessionCapacity, recalculateCapacity, layoutFor, slotMath,
  PREFERRED_STATION, MIN_SLOT, MAX_SLOT };
