# Assessment Integration Audit — 2026-11-12

Scope: is the Universal Athletic Assessment & 4-Week Reassessment
Engine (branch `feature/universal-assessment-reassessment-v1`,
PR #3) ready to be used end-to-end? This audit reviews the prototype
application, the foundation branch, PR #3's contents, and Supabase
migrations 001–004 (files read in the repo; nothing was queried live
in this session). It builds on `docs/ASSESSMENT_AUDIT.md` (the engine
audit) and does not repeat it.

## 1. What already existed (reused, not rebuilt)

- **Assessment engine V1.1.0** (`assessment-engine/`): 10 definitions
  plus the three GAA additions (5-10-5 shuttle, single-leg balance
  L/R, 6-minute walk/run), `generalAthleticAssessment` battery,
  `change` / `interpret` / `asymmetry` / `generatePriorities`.
- **GAA battery protocols** (`server/assessment-battery.js`): all 8
  tests with instructions, conditions, warm-up + safety, valid/invalid
  criteria, precision, maintenance bands, youth/adult alternatives.
  No norms, no medical thresholds.
- **Reassessment engine** (`server/reassessment.js`): 28-day due math,
  never-assessed / not-due / approaching / due / overdue / deferred,
  coach reminder buckets, athlete reminders, baseline completeness,
  coach-approved deferrals/exclusions/modifications. Derivative
  scheduling — no cron, no paid scheduler, none in the repo.
- **Baseline gating** (`server/baseline-gating.js`): plan-finalization
  only; explicit recorded coach override. No other feature is gated.
- **Progress calculator** (`server/progress.js`): baseline / previous /
  PB, absolute + percent, direction-correct, maintenance bands,
  youth-growth caveat.
- **Smart Draft adapter** (`server/smart-draft-adapter.js`):
  advisory-only by construction (`advisoryOnly`, `requiresCoachApproval`,
  `autoRewrite: false`); no function writes a plan.
- **Assessment store** (`server/assessment-store.js`): measured /
  observation / interpretation separation, derived baselines, GAA
  protocol validation, idempotency keys.
- **Authenticated API** (`server/api.js`): reservation workflow with
  the auth model this integration copies (auth context first, actor
  always the auth UID, role table, JS checks + RLS backstop).
- **Migrations 001–003, APPLIED** to Supabase project TheProgramOS
  (verified live 2026-11-12: 22 tables, 58 policies, 10 definitions):
  operational model + `reserve_seat()`, assessment persistence,
  auth/RLS helpers (`app_role()`, `is_my_athlete()`,
  `is_my_cohort_athlete()`).
- **Prototype UI surfaces**: Director/Coach/Athlete-Parent modes, an
  Assessments view (`vAssess()` in `THE PROGRAM OS.html`), athlete
  profiles (`vAthlete()`), a dashboard "due for re-testing" card.
  These are presentation + demo data; they hold no assessment logic.

## 2. Missing application connections (found by this audit)

### 2a. No way to save an incomplete assessment — FIXED
Migration 002's `assessment_sessions` has no status/draft concept
and `recordAssessmentSession()` only stores completed sessions.
There was nowhere to persist a half-recorded battery. Fixed by
adding `assessment_drafts` (migration 004, one draft per athlete +
battery) and draft methods on the memory store. A draft is working
state, never history: it counts toward nothing and is deleted on
completion.

### 2b. Migration 004's plan CHECK rejected coach overrides — FIXED
004 shipped with
`CHECK (status <> 'finalized' OR baseline_session_id IS NOT NULL)`.
But `baseline-gating.js` finalizes an override plan with
`baselineSessionId: null` and an `overrideReason`. The database
would have rejected exactly the override rows the service layer
produces. Fixed in 004 (unapplied, safe to edit): the CHECK now
accepts a finalized plan when it names a baseline session **or**
carries a recorded `override_reason`. Pinned by
`server/tests/migration-004.test.js`.

### 2c. Coaches could read assessment history but not write it — FIXED
Migration 003 gave coaches SELECT-only policies on
`assessment_sessions`, `assessment_results`, and
`assessment_derived_records`. A coach calling PostgREST directly
could not record a session at all; only the director (or a
service-role caller) could write. Fixed in 004 with scoped,
insert-only coach policies (`WITH CHECK app_role()='coach' AND
is_my_cohort_athlete(athlete_id)`), mirroring the reservations
pattern but narrower: INSERT only, no UPDATE/DELETE — history stays
immutable. The service API remains the primary writer; the policies
are the backstop that makes a scoped coach call behave the same way
through PostgREST.

### 2d. No workflow orchestration — FIXED
The engine, store, reassessment, gating, progress, and draft modules
existed as separate pieces with no single caller driving the
10-step coach workflow (select → start → record → save/resume →
complete → baseline → history/PBs → compare → status/due → reassess
or defer), and no authorization layer deciding who may assess or
view whom. Fixed by `server/assessment-workflow.js` (service) +
`server/assessment-access.js` (scope) + `server/assessment-api.js`
(authenticated API, same conventions as `server/api.js`).

### 2e. No persisted development-plan object — FIXED (service layer)
There was no plan record for the gate to act on. Added
`MemoryPlanStore` in the workflow module and `development_plans`
in migration 004 (draft → finalized, override fields, the fixed
CHECK above).

## 3. Assessment interfaces already implemented

- Coach: start/record/save/resume/complete/discard, defer/exclude/
  modify (coach-approved, reason required), plan create/finalize
  (gated, override recorded), coach dashboard reminder buckets,
  advisory priorities (read-only).
- Athlete/parent: own-results view only — baseline, history, personal
  bests, progress vs baseline/previous/PB, schedule + next due date,
  athlete reminder message, advisory priorities (read-only).
- Both views are served by `server/assessment-workflow.js` +
  `server/assessment-api.js`; the API transport (Edge Function or
  server route) is still to be chosen — see §5.

## 4. Schema dependencies (migrations 001–004)

- 004 depends on 001 (`athletes`, `coaches`), 002
  (`assessment_definitions`, `assessment_sessions`), and 003
  (`app_role()`, `is_my_cohort_athlete()`, `is_my_athlete()`).
  Correct order is 001 → 002 → 003 → 004. 001–003 are applied;
  004 is written/reviewed only.
- 004's only alterations to existing tables: `assessment_definitions`
  gains a `kind` column and two CHECKs are dropped and re-issued
  (direction/aggregation) so the observation-only movement
  assessment may have NULL direction and aggregation `'none'`;
  `assessment_sessions` gains a nullable `idempotency_key` column
  + partial unique index. No data is deleted or rewritten.
- Postgres 15 compatible (live project runs 15.8.1.50):
  `gen_random_uuid()`, no MERGE, no generated columns.
- RLS: enabled on every 004 table; policies mirror 003
  (director full / coach scoped / owner read-only), plus the
  coach INSERT policies in §2c and draft policies (director +
  coach only — drafts are never visible to parents/athletes).
- No destructive operations in the applied body of any migration:
  the only DROP statements are `DROP POLICY IF EXISTS` (idempotent
  re-run pattern) and `DROP CONSTRAINT` on two auto-named CHECKs in
  004 (re-issued immediately after); commented rollback notes are
  documentation, not executable intent. Full finding in
  `docs/MIGRATION_EXECUTION_PLAN.md`.

## 5. Remaining gaps (not blockers for this branch, recorded as decisions)

1. **API transport undecided.** The workflow + API modules are
   transport-agnostic (same as the reservation API). Somebody must
   still choose Edge Function vs server route and host
   `createAssessmentApi` behind a verified JWT. No code in this
   branch assumes one.
2. **Prototype Assessments view text is stale.** `vAssess()` in
   `THE PROGRAM OS.html` still says the battery is a proposal,
   "nothing here is approved, and these numbers are not being
   collected today", and lists a "~12 weeks" retest interval as an
   ASSUMPTION. The engine now implements the 28-day GAA battery.
   The HTML was deliberately NOT edited in this branch (UI
   preservation); refreshing that view's copy is a separate,
   owner-approved UI decision — see `docs/MORNING_DECISIONS.md`.
3. **Dashboard "due for re-testing" card** reads prototype demo
   data (`ATHLETES`), not the reassessment engine. Wiring it to
   `coachDashboard()` is a UI-integration step for the transport
   work above, not a backend gap.
4. **Battery field validation is still open** (carried from
   `docs/MORNING_DECISIONS.md` §8): the GAA v1 protocol is written
   but unvalidated with real athletes in the field.
5. **No scheduled-job infrastructure exists** (confirmed again in
   this audit: no cron, no scheduler in the repo). Reassessment
   reminders are derived on demand by `coachDashboard()` /
   `athleteReminder()`; nothing pushes them. If Marcus wants push
   reminders, that is a new decision — not a gap in the engine.
