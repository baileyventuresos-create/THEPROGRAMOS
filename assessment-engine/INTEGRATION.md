# Assessment Engine V1 — Integration Plan

## Decision: no new top-level page yet
THE PROGRAM OS is already UI-dense. V1 should enter through the athlete context rather than add permanent navigation.

### Coach surface
Add an **Assessment** card to an athlete profile/detail surface:
- Last assessed date
- 3–5 key current metrics
- change from baseline (value + percent)
- bilateral signal when applicable
- `Run assessment` action

`Run assessment` opens a focused overlay/drawer. Steps:
1. Choose battery: General Athlete / Baseball / Custom.
2. Show protocol for each test.
3. Enter every attempt, not just the best result.
4. Engine calculates result live.
5. Coach can add context/notes.
6. Review summary before save.
7. Save creates one immutable assessment-session record.

### Athlete surface
Athletes should primarily see progress, not programming diagnostics:
- latest result
- personal baseline
- personal best
- trend
- next reassessment date when scheduled

Avoid exposing raw priority scoring or labels that can be misread as diagnoses.

## Future persistence model
Suggested logical entities (names can adapt to existing schema):

### assessment_definitions
`id, name, domain, unit, direction, attempt_count, aggregation, module, pair_id, protocol_version, active`

### assessment_sessions
`id, athlete_id, coach_id, battery, recorded_at, notes, context_json`

### assessment_results
`id, session_id, assessment_id, attempts_json, result, protocol_version`

Baselines and PRs can initially be derived from history instead of stored as mutable truth.

## Smart Draft contract
Assessment Engine should eventually provide evidence like:

```js
[
  { domain: 'acceleration', evidenceScore: 4.2, source: 'assessment-trend' },
  { domain: 'rotational_power', evidenceScore: 2.1, source: 'assessment-trend' }
]
```

Smart Draft may combine this with athlete goals, age, session history, equipment, time, safety constraints and coach choices. Assessment evidence must not become an automatic one-signal workout override.

## Integration order
1. Approve assessment definitions and protocols.
2. Map the current athlete/profile UI and existing persistence model.
3. Add database tables/migration with access controls.
4. Add repository/service adapter around the pure engine.
5. Add coach assessment overlay.
6. Add athlete progress card.
7. Feed assessment evidence into Smart Draft behind a feature flag.
8. Add onboarding/tutorial steps only after the workflow is stable.

## Explicit non-goals for V1
- medical screening or diagnosis
- injury clearance
- population percentile/ranking claims
- automatic exercise prescription from one test
- deleting/replacing existing demo data
- redesigning global navigation
