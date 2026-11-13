# THE PROGRAM OS — Operational Foundation V1 (server/)

Backend operational modules for THE PROGRAM OS. These are **new, additive
modules** — the prototype (`THE PROGRAM OS.html`, loaded by `index.html`)
is untouched. No UI file was modified; see `tests/ui-preservation.snapshot.json`.

## What is here

| File | Purpose |
|---|---|
| `session-capacity.js` | Derives a per-session reservation cap from coaches, template, facility and equipment, mirroring the prototype's `buildConfigs`/`slotMath` rules. No universal athlete limit anywhere. |
| `reservation-engine.js` | Backend reservation engine: eligibility, duplicates, conflicts, coach/facility availability, capacity, waitlists + auto-promotion, attendance, audit trail. Concurrency-safe (per-session mutex + store transactions). |
| `reservation-stores.js` | `MemoryStore` (tests/dev) and `SqliteStore` (Node's built-in `node:sqlite`, no dependencies) implementing the engine's store interface. |
| `assessment-store.js` | Persistence adapter for the assessment engine: measured results, coach observations, and system interpretations stored as separate record kinds; baselines derived, never overwritten. Extended 2026-11-12: idempotency keys (retries cannot duplicate a session), movement-assessment observations, modified/capped flags, GAA protocol validation on recording. |
| `assessment-battery.js` | GAA battery protocol (v `gaa-v1`): standardized instructions, conditions, warm-up + safety, valid/invalid criteria, precision, maintenance bands, and youth/adult alternatives + accommodations for all 8 tests. The movement assessment is observation-only here. |
| `reassessment.js` | 28-day reassessment engine: due-date math, due/approaching/overdue/deferred/never-assessed statuses, coach reminder lists, athlete reminders, baseline completeness, and coach-approved deferrals/exclusions/modifications. Derivative scheduling — no cron, no paid scheduler. |
| `baseline-gating.js` | Baseline gate for development-plan finalization ONLY. A plan finalizes after a complete baseline, or by an explicit recorded coach override. Nothing else is gated. |
| `progress.js` | Progress calculator: baseline / previous / personal best, absolute + percentage change, direction-correct, maintenance bands, zero-baseline safe (percent null), youth-growth caveat for under-18s. |
| `smart-draft-adapter.js` | Advisory-only Smart Draft input: assessment evidence ranked into development priorities (acceleration, agility, power, strength, muscular endurance, cardiovascular conditioning, mobility/movement control). Advisory only — no function here writes or rewrites a plan. |
| `postgres-store.js` | `PostgresStore`: the engine's store interface on a `pg` Pool (Supabase Postgres). Hydrates cohort age band + capacity fields and `eligibleCohortIds` from `cohort_enrollments`; `insertReservation()` calls `reserve_seat()` as the atomic gate. |
| `postgres-store.js` | `PostgresStore`: the engine's store interface on a `pg` Pool (Supabase Postgres). Hydrates cohort age band + capacity fields and `eligibleCohortIds` from `cohort_enrollments`; `insertReservation()` calls `reserve_seat()` as the atomic gate. |
| `api.js` | Thin authenticated API over the engine: `reserve`, `cancel`, `availableSeats`, `recordAttendance`, `reconcileAttendance`, `capacityFor`, `promoteWaitlist`. Auth context `{ authUserId, role }` injected per call; actor is always the auth UID. |
| `schedule-session.js` | `scheduleSession()`: human-approved draft → `training_sessions` row payload (`capacity_effective`, `capacity_inputs`, `plan_id`, `plan_approved_by`) + `{ feasible, flaggedInfeasible }`. No DB write. |
| `migrations/001_operational_foundation.sql` | PostgreSQL schema for the full operational model + atomic `reserve_seat()` function. **APPLIED 2026-11-12** to TheProgramOS with Marcus's approval. |
| `migrations/002_assessment_persistence.sql` | PostgreSQL schema for assessment definitions/sessions/results/derived records, seeded with the engine V1 definitions. **APPLIED 2026-11-12** to TheProgramOS with Marcus's approval. |
| `migrations/003_auth_rls.sql` | Supabase Auth link (`app_users.auth_user_id`) + minimum role-scoped RLS policies (director/coach/parent/athlete). **APPLIED 2026-11-12** to TheProgramOS with Marcus's approval. |
| `migrations/004_assessment_reassessment.sql` | GAA battery definitions (5 new, incl. observation-only movement assessment), assessment schedules, deferrals/exclusions/modifications, development-plan gate table, session idempotency key + unique index, RLS mirroring 003. **NOT APPLIED** — applying it needs Marcus's approval (see docs/MORNING_DECISIONS.md §11). |
| `fixtures/seed-operational.json` | Fictional test fixtures transcribed from the prototype (7 cohorts, 4 coaches, 3 locations, 5 templates). No real athlete data. |
| `fixtures/generate-75-scenario.js` | Computes the 75-athlete weekly seat model; writes `scenario-75-athletes.json`. |
| `fixtures/synthetic-wingback-48.js` | SYNTHETIC test fixture only: a 48-year-old recreational soccer wingback (baseline + 28-day reassessment values) + a 12-year-old synthetic youth athlete. Invented values for automated tests; never a real person's results; never written to a live database. |
| `tests/*.test.js` | 140 tests (Node built-in runner) + the pre-existing assessment-engine smoke test, counted in the 140. Postgres tests use an injected fake Pool (no live DB); `pg` is the only npm dependency (see repo-root `package.json`). |

## Run the tests

```sh
node --test server/tests/*.test.js assessment-engine/assessment-engine.test.js
```

Install step (only for the Postgres store): `npm install` at the repo
root installs `pg` (see `package.json` — private, `pg` only, no scripts
or build step). Node 22.5+ only (`node:sqlite` is built in). Without
`pg`, everything except `server/postgres-store.js` still runs with zero
dependencies.

## Rules these modules enforce (owner-fixed)

- Membership is **$149/athlete/month**. This code reads membership status;
  it never sets prices or touches billing.
- A cohort's **enrollment cap ≠ a session's reservation cap**.
- Capacity is **never guessed**: a session without a computed capacity
  cannot be booked.
- Generated training sessions still require **human approval** — this
  engine books seats; it never generates or approves session content.
- No athlete PII in browser storage. The prototype's `localStorage`
  (`tp_os_v24`) holds demo state only and must not be used for real records.
