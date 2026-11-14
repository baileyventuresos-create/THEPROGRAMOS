# Assessment Audit — Universal Athletic Assessment & 4-Week Reassessment

**Date:** 2026-11-12 · **Branch:** `feature/universal-assessment-reassessment-v1`
**Base:** `feature/program-operational-foundation-v1` @ `e4da6cc` · **Status:** audit + build complete, tests green, migration 004 NOT applied.

This audit records what existed before this mission, what was partial,
and what was missing — and what this mission changed. It was written
from the repository itself (code, migrations, docs), not from memory.

## 1. What was already implemented (reused, not rebuilt)

### Assessment engine V1 (`assessment-engine/`)
- **Pure calculation module** (`assessment-engine.js`, v1.0.0): 10
  definitions with unit, direction, attempts, aggregation, and
  `retestDays: 28` on every definition. Functions: `result()`
  (best attempt), `change()` (absolute + percent, direction-correct),
  `asymmetry()` (bilateral %, `monitor` at >=15%), `interpret()`
  (improved/stable/declined with a 1% stability band),
  `generatePriorities()` (decline-magnitude evidence per domain),
  `buildSession()`. Smoke test passing.
- **Batteries:** `generalAthlete` (7 tests: 10yd sprint, broad jump,
  rotational scoop L/R, push-ups, side plank L/R) and `baseball`
  (throw velo, accuracy, exit velo).
- **Principles locked in README.md:** assessments measure, they do
  not diagnose; preserve every attempt; compare to the athlete's own
  baseline first; no normative labels; Smart Draft owns programming.
- **INTEGRATION.md:** UI entry points (athlete-profile card, coach
  `Run assessment` overlay, athlete progress view), the future
  persistence model, and the Smart Draft evidence contract. Explicit
  non-goals: medical screening, injury clearance, percentiles,
  automatic prescription, deleting demo data, redesigning navigation.

### Persistence (`server/assessment-store.js`, migration 002 — APPLIED)
- `recordAssessmentSession()` + `MemoryAssessmentStore`: measured
  results (attempts preserved verbatim, engine-derived result),
  coach observations (text only), system interpretations (derived,
  labelled, with caveats) stored as separate record kinds. Baselines
  derived from the first valid result; history never overwritten.
- Migration 002 (applied 2026-11-12 to TheProgramOS):
  `assessment_definitions` (10 seeded, matching the engine exactly),
  `assessment_sessions`, `assessment_results` (unique per
  session+assessment, attempts JSONB), `assessment_derived_records`.
  RLS enabled; 003 added director/coach/owner policies.

### Backend around it (migrations 001 + 003 — APPLIED)
- 22 public tables, 58 RLS policies, auth link (`app_users.auth_user_id`,
  `athletes.app_user_id`). Live-verified 2026-11-12 (checks A/B/C;
  honest limits recorded in `docs/SUPABASE_HANDOFF.md`).
- Thin authenticated API (`server/api.js`) for reservations only —
  no assessment methods yet. `PostgresStore` does not implement the
  assessment store interface (its header says 002 is "not used").
- `schedule-session.js`: human-approved draft → session row payload.
  Plans are session drafts, not persisted development plans.

### Prototype (`THE PROGRAM OS.html`, `index.html`)
- Assessments view exists; the coach dashboard shows "N athletes due
  for re-testing" and the note "Assessment battery still requires
  program validation before results are shared."
- Athletes are generated demo data (`ATHLETES`, 80 athletes, `sprint` /
  `bj` / `due` fields). No onboarding flow; no persisted athlete
  profiles beyond the demo array.
- **Smart Draft** is a working prototype drawer (`drawerDraft()`):
  it builds a session draft from builder input + `rollingEmphasis`
  and requires human approval ("Save & assign"). It does NOT consume
  assessment evidence yet, and there is no persisted individualized
  development plan object anywhere in the prototype.

## 2. What was partially implemented

| Area | State before this mission |
|---|---|
| Reassessment timing | `retestDays: 28` on every definition and a `due` flag on demo athletes — but no code computed due dates, no approaching/overdue states, no reminders, no schedule state. |
| Progress tracking | `change()` / `interpret()` compare baseline vs current only. No previous-vs-current, no personal-best tracking, no maintenance band beyond the 1% interpret band, no zero-baseline handling (`change()` returns null when baseline is 0 — e.g. 0 push-ups). |
| Smart Draft evidence | `evidenceForDraft()` in assessment-store + `generatePriorities()` in the engine, both labelled advisory. But no mapping to the mission's priority names, no confidence labelling, no insufficient-evidence state, and no connection to the prototype drawer. |
| Baseline gating | No concept of a "required baseline" or a plan-finalization gate existed. No `development_plans` table. |
| Assessment definitions vs mission battery | 5 of the 8 mission tests existed (10yd, broad jump, push-ups, side plank L/R). Missing: 5-10-5 shuttle, single-leg balance, 6-minute walk/run, movement assessment. The engine's `generalAthlete` battery includes rotational scoop, which is NOT in the mission's universal battery. |
| Idempotency | No idempotency key on sessions; a retried recording would insert a duplicate session. No unique constraint beyond (session, assessment). |
| Scheduled jobs | None in the repo. No cron, no pg_cron, no Edge Function, no scheduler of any kind. `~/workspace/cron.d` is the agent runtime's own directory, not application infrastructure. |

## 3. What was missing (built by this mission)

- **Standardized protocols** for all 8 tests (instructions, conditions,
  warm-up + safety, valid/invalid criteria, precision, maintenance
  bands, youth/adult alternatives + accommodations) — none existed in
  any form; the engine had numbers only.
- **Universal battery** `generalAthleticAssessment` (GAA v1) as a
  distinct battery from the legacy `generalAthlete` battery.
- **Baseline requirement + plan gate** (`server/baseline-gating.js`,
  `development_plans` table in migration 004).
- **28-day schedule engine + reminders** (`server/reassessment.js`,
  `assessment_schedules` table in migration 004).
- **Deferral / exclusion / modification records** (coach-approved,
  reasoned, auditable) — `assessment_deferrals` in migration 004.
- **Progress calculator** (`server/progress.js`): previous + PB +
  zero-baseline-safe percentages + youth-growth caveat.
- **Smart Draft advisory adapter** (`server/smart-draft-adapter.js`):
  mission priority names, confidence, goal alignment, insufficient
  evidence, and an explicit no-rewrite contract.
- **Migration 004** (written, NOT applied).

## 4. Deliberate decisions (recorded, not accidental)

1. **Legacy `generalAthlete` sessions do NOT count toward the GAA
   baseline.** The universal battery is a different, standardized set
   of tests (it drops rotational scoop and adds shuttle, balance,
   6-minute walk/run, movement). Counting a legacy session as a GAA
   baseline would misrepresent what was tested.
2. **Movement assessment is observation-only.** It has no engine
   definition (no number to aggregate), no direction, and no score.
   It is stored as coach observations. Migration 004 adds a `kind`
   column so it can still be listed as a definition for the battery.
3. **No norms, no medical thresholds.** The protocol and progress
   modules contain none. "Maintenance bands" are labelled product
   thresholds for reading change, not measurement-error science.
4. **Reassessment is derivative, not scheduled.** Due dates are
   computed from completed sessions whenever anyone asks. A future
   cron/Edge Function can call `reassessmentReminders()`; no paid
   scheduler was introduced.
5. **The plan gate has one explicit override path** (recorded coach
   override with reason). There is no silent bypass.
6. **Engine v1.1.0 is additive only.** All 10 V1 definitions are
   byte-identical in behavior; 4 new definitions + 1 new battery
   were added. The V1 smoke test passes unchanged.
7. **Adult and youth share one battery and one protocol version.**
   Alternatives change how a test is performed, never what the
   numbers mean; modified results are flagged and never silently
   compared to a standard-protocol baseline.
8. **Youth growth is a caveat, not an adjustment.** Progress records
   for under-18s carry the caveat that growth can change results
   independently of training. Nothing auto-attributes youth change
   to training (or to growth).

## 5. Risks and open items

- **Battery validation (unchanged, MORNING_DECISIONS §8):** the GAA
  protocol is written but the battery is still NEEDS VALIDATION in
  the prototype (hand-timed sprints, no agreed reaction test).
  Field validation by Marcus/coaches is still required before
  results are shown to parents as more than coach-recorded
  measurements.
- **Migration 004 unapplied and unexecuted:** reviewed only, plus
  SQL-invariant tests. It has not run against any Postgres (no
  throwaway local Postgres was available in this session — see
  handoff §4). Apply + verify is a separate owner decision.
- **PostgresStore still has no assessment methods:** recording
  assessments against live Supabase goes through the dashboard SQL
  editor today, not through `server/postgres-store.js`. Wiring the
  assessment store interface onto PostgresStore (including the
  idempotency lookup) is remaining work.
- **API has no assessment methods yet:** `server/api.js` covers
  reservations only. Assessment recording, reminders, and plan
  finalization have no authenticated API methods yet (design: same
  injected-auth pattern as reservations).
- **No UI integration yet:** coach `Run assessment` overlay, athlete
  progress card, and dashboard reminders exist only as server
  modules + the integration guidance in INTEGRATION.md. Any UI work
  is a separate, designed step — not started here, per the mission's
  no-redesign constraint.
- **Dashboard estimate quirk (pre-existing):** the Supabase Users
  page footer can show a stale "Total: 10 users (estimated)" while
  the exact count is 0. Noted 2026-11-12; unrelated to this mission.
