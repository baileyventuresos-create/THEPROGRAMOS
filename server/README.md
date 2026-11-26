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
| `assessment-store.js` | Persistence adapter for the assessment engine: measured results, coach observations, and system interpretations stored as separate record kinds; baselines derived, never overwritten. |
| `postgres-store.js` | `PostgresStore`: the engine's store interface on a `pg` Pool (Supabase Postgres). Hydrates cohort age band + capacity fields and `eligibleCohortIds` from `cohort_enrollments`; `insertReservation()` calls `reserve_seat()` as the atomic gate. |
| `api.js` | Thin authenticated API over the engine: `reserve`, `cancel`, `availableSeats`, `recordAttendance`, `reconcileAttendance`, `capacityFor`, `promoteWaitlist`. Auth context `{ authUserId, role }` injected per call; actor is always the auth UID. |
| `schedule-session.js` | `scheduleSession()`: human-approved draft → `training_sessions` row payload (`capacity_effective`, `capacity_inputs`, `plan_id`, `plan_approved_by`) + `{ feasible, flaggedInfeasible }`. No DB write. |
| `migrations/001_operational_foundation.sql` | PostgreSQL schema for the full operational model + atomic `reserve_seat()` function. **Not applied anywhere** — target is TheProgramOS (ref `rkgdwqgmldznczikrjip`, inspected empty 2026-11-12); applying it needs Marcus's approval. |
| `migrations/002_assessment_persistence.sql` | PostgreSQL schema for assessment definitions/sessions/results/derived records, seeded with the engine V1 definitions. **Not applied.** |
| `migrations/003_auth_rls.sql` | Supabase Auth link (`app_users.auth_user_id`) + minimum role-scoped RLS policies (director/coach/parent/athlete). **Not applied anywhere** — needs Marcus's approval. |
| `fixtures/seed-operational.json` | Fictional test fixtures transcribed from the prototype (7 cohorts, 4 coaches, 3 locations, 5 templates). No real athlete data. |
| `fixtures/generate-75-scenario.js` | Computes the 75-athlete weekly seat model; writes `scenario-75-athletes.json`. |
| `tests/*.test.js` | 87 tests (Node built-in runner) + the pre-existing assessment-engine smoke test, counted in the 87. Postgres tests use an injected fake Pool (no live DB); `pg` is the only npm dependency (see repo-root `package.json`). |

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
