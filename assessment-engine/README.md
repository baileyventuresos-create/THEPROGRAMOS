# THE PROGRAM Assessment Engine V1

## Purpose
A sport-agnostic assessment layer for THE PROGRAM OS. It converts repeatable test attempts into results, baselines, trend calculations, bilateral asymmetry signals, and structured development-priority evidence for later Smart Draft consumption.

## V1 principles
- Assessments measure; they do not diagnose.
- Preserve every attempt and derive the best result according to the test definition.
- Know whether higher or lower is better.
- Compare the athlete to their own baseline first.
- Avoid normative labels (weak, dysfunctional, injured, below normal) without validated reference data.
- Assessment Engine identifies evidence; Smart Draft remains responsible for programming.
- UI is intentionally separate from calculation logic.

## Included batteries
### General Athlete
10-yard sprint, standing broad jump, rotational scoop throw L/R, quality push-ups, side plank L/R.

### Baseball module
Throwing velocity, throwing accuracy, exit velocity.

## Data flow
`assessment definition -> assessment session -> result -> baseline/trend -> interpretation -> development-priority evidence -> Smart Draft (future integration)`

## UI recommendation
Do **not** add another permanent top-level navigation item in V1. The existing OS is already information-dense. Surface assessments contextually:

1. **Athlete profile:** compact Assessment/Development card showing latest metrics, change from baseline, last tested date, and `Run assessment`.
2. **Coach workflow:** `Run assessment` opens a focused modal/drawer/temporary workspace for selecting a battery and recording attempts.
3. **Progress/report view:** assessment trends can appear alongside existing athlete history when that UI is integrated.
4. A dedicated assessment page should only be added later if coaches need team-wide testing administration, bulk entry, or assessment scheduling often enough to justify permanent navigation.

## Storage contract (future DB integration)
An assessment session should preserve:
- athlete id
- assessment id
- all attempts
- derived result
- recorded timestamp
- battery/module
- coach notes
- optional context (equipment, surface, test protocol version)

The first valid result can establish an athlete baseline. Do not overwrite historical sessions when a new baseline policy is introduced; baseline selection should be explicit/derivable.

## Safety / interpretation
`asymmetry()` uses a simple percentage difference and returns `monitor` at >=15% in V1. This is a **product signal**, not a medical threshold or diagnosis. It should prompt observation/context, not treatment claims.

Declining metrics likewise should prompt review of fatigue, testing conditions, training exposure, technique and context rather than automatically rewriting a program.

## Integration boundary
`assessment-engine.js` currently has no dependency on the prototype HTML, drill library, Supabase, Smart Draft, or production state. That is intentional. Integration should happen only after the UI/data contract is approved.
