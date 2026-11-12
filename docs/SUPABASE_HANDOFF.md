# THE PROGRAM OS — Supabase Backend Handoff (2026-11-12)

Backend-completion mission, branch `feature/program-operational-foundation-v1`.
Supabase-only backend DECIDED by Marcus 2026-11-12 (FINAL); dual-database
directive cancelled; Neon TheProgramOS project is UNUSED — preserve without
modification. Nothing in this mission was merged, deployed, or applied to
any database. No Neon project was touched. No UI file was touched.

## What this mission did

- **Migration 001 fixed** (`server/migrations/001_operational_foundation.sql`):
  stale header corrected (TheProgramOS `rkgdwqgmldznczikrjip` inspected
  empty 2026-11-12; Supabase-only decision recorded); `CREATE EXTENSION
  IF NOT EXISTS citext;` added (CITEXT columns failed on a fresh Postgres
  without it); `reserve_seat()` now raises `session_not_bookable` when
  the cap is <= 0 instead of waitlisting; `eligible_cohort_ids`
  documented as a snapshot of `cohort_enrollments`. Verified by reading
  both migrations: no PG16+ features (gen_random_uuid, JSONB, partial
  indexes, plpgsql FOR UPDATE are all PG15-compatible with the project's
  Postgres 15.8.1.50). No table definitions, defaults ($14900 stays), or
  other `reserve_seat()` semantics changed.
- **New migration 003** (`server/migrations/003_auth_rls.sql`): links
  `app_users.auth_user_id` to `auth.users(id)` (unique, nullable — no
  auth users exist yet); adds `athletes.app_user_id` so an athlete-role
  login can read only its own record; minimum role-scoped RLS policies
  via `auth.uid()` + the `app_users` role mapping (director full;
  coach reads athletes in cohorts they head + writes
  attendance/reservations for their sessions; parent/guardian read-only
  own athletes via `athlete_guardians` + book/cancel for them; athlete
  read-only own record). NOT applied anywhere.
- **Infeasible-session defect fixed** (`server/reservation-engine.js`):
  `capacityFor()` / `reserve()` throw `SESSION_NOT_BOOKABLE` when the
  computed capacity is infeasible or the effective cap is 0 (zero
  coaches, equipment shortfall) instead of silently waitlisting.
  `cancel()` still succeeds if a session has become infeasible.
  New `promoteWaitlist(sessionId)` bulk-promotes after a capacity
  increase (cancel promotes only one).
- **Eligibility ambiguity resolved**: the SINGLE source of truth is the
  `cohort_enrollments` join table. `athletes.eligible_cohort_ids` is a
  hydrated snapshot; `PostgresStore.getAthlete()` builds it from
  `cohort_enrollments` (status='enrolled'). Engine rule: an array —
  including empty — requires inclusion (empty = eligible for no cohort);
  the check is skipped only when the field is undefined/null (legacy
  in-memory fixtures). Never grant eligibility by editing the array.
- **Postgres store + API** (new, `pg` installable: YES, 8.23.1):
  `server/postgres-store.js` (PostgresStore on an injected `pg` Pool;
  `fromEnv()` reads `DATABASE_URL` at call time; no credentials in the
  repo) and `server/api.js` (exactly `reserve`, `cancel`,
  `availableSeats`, `recordAttendance`, `reconcileAttendance`,
  `capacityFor`, `promoteWaitlist`; auth context `{ authUserId, role }`
  injected per call; actor is always the auth UID — client-supplied
  actor is ignored). `insertReservation()` calls `reserve_seat()` as
  the final atomic gate (waitlisted race → `SESSION_NOT_BOOKABLE`;
  unique violation → clean `DUPLICATE`). `package.json` added (private,
  `pg` only, no scripts/build).
- **Session-scheduling link** (new): `server/schedule-session.js`
  (`scheduleSession()`) turns a human-approved draft into the
  `training_sessions` row payload (`capacity_effective`,
  `capacity_inputs`, `plan_id`, `plan_approved_by`) + `{ feasible,
  flaggedInfeasible }`. Over-cap drafts are flagged, never auto-raised.
  Drafts without `planApprovedBy` are refused. No DB write.
- **Docs**: `docs/MORNING_DECISIONS.md` #2 records the Supabase-only
  decision as DECIDED and #3 corrects "no project exists";
  `docs/INTEGRATION_STRATEGY.md` rewritten Supabase-only (dev target =
  TheProgramOS itself; API + scheduling link marked BUILT);
  stale "no project exists" lines fixed in `docs/OPERATIONAL_AUDIT.md`
  §5, `docs/OVERNIGHT_HANDOFF.md` §4, `server/README.md` (001 row).

## Files changed (this mission)

| Commit | What |
|---|---|
| `0957f6b` | Migrations: 001 fixes + new 003 |
| `3a7aaed` | Engine: infeasible-session fix, eligibility source of truth, `promoteWaitlist` + tests |
| `6475421` | Postgres store + API + tests, `package.json` |
| `ff5f9bf` | Session-scheduling link + tests |
| _(docs commit — this commit, see `git log`)_ | Docs above + this handoff |

## Tests

`node --test server/tests/*.test.js assessment-engine/assessment-engine.test.js`
— all green (47 pre-existing + 40 new = 87 total; see commit messages
for the per-file counts). `node --check` passes on every JS file touched
or created. New coverage: zero-coach / equipment-shortfall / stored-cap-0
refusals (no waitlist entry), cancel-on-infeasible, bulk promotion,
empty-array ineligibility, legacy undefined eligibility, 001 SQL
invariants (citext, `session_not_bookable` guard), 003 SQL invariants,
PostgresStore hydration + `reserve_seat()` gate + error mapping +
transactions (fake injected Pool, no live DB), API role checks + actor
integrity + cancel promotion + attendance (MemoryStore).

## Still unverified — do not claim otherwise

- Migrations 001 + 002 + 003 have NEVER been executed against any
  PostgreSQL. No `psql`/server was available here, and nothing was
  applied to TheProgramOS.
- The RLS policies in 003 are the minimum viable set and have NOT been
  exercised against live Supabase. Before any real athlete record is
  stored, verify against TheProgramOS (after approval to apply):
  1. Apply 001 + 002 + 003 in order via the dashboard SQL editor.
  2. Two concurrent `reserve_seat()` calls for one seat: exactly one
     confirms (same test the SQLite suite runs).
  3. `reserve_seat()` on a cap-0 session raises `session_not_bookable`.
  4. As an `authenticated` parent user: can read own athletes, cannot
     read other athletes; as a coach: can read only their cohorts'
     athletes; as `anon`: nothing.
  5. Confirm the double-`RESERVED` audit rows (one from
     `reserve_seat()`, one from the engine) are acceptable, or reconcile
     by action + reservation id.
- No live Supabase connection has been made from this code (no
  credentials exist in the repo); `PostgresStore` against real Supabase
  is untested. The API has no transport yet (no Edge Function / server
  route) — it is a library the transport will call with a verified JWT.
- No browser / real-device check (UI untouched, so none needed).
- Bulk promotion after a capacity raise is now available
  (`promoteWaitlist`); nothing calls it automatically — a Director
  triggers it after `recalculateCapacity()`.

## What needs Marcus

1. Approve applying migrations 001 + 002 + 003 to TheProgramOS as the
   dev target (production use is a separate decision).
2. Confirm the RLS policy set is acceptable before any real athlete
   record is stored (see verification list above).
3. Decide the API transport (Supabase Edge Function / server route)
   and how the JWT-derived auth context is supplied — not built here.
