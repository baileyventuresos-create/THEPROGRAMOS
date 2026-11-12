# THE PROGRAM OS — Supabase Backend Handoff (2026-11-12)

Backend-completion mission, branch `feature/program-operational-foundation-v1`.
Supabase-only backend DECIDED by Marcus 2026-11-12 (FINAL); dual-database
directive cancelled; Neon TheProgramOS project is UNUSED — preserve without
modification. Nothing in this mission was merged or deployed.
Migrations 001 + 002 + 003 were APPLIED to TheProgramOS on 2026-11-12
with Marcus's approval (see "Applied to TheProgramOS" below). No Neon
project was touched. No UI file was touched.

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
  read-only own record). Applied to TheProgramOS 2026-11-12 (see below).
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
  the final atomic gate (waitlisted race → `RACE_WAITLISTED` with the
  entry attached, so the engine returns the waitlist outcome instead of
  erroring the race loser; unique violation → clean `DUPLICATE`). `package.json` added (private,
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
| _(verification commit — see `git log`)_ | Coordinator verification: cross-process race fix (`RACE_WAITLISTED`), `reserve_seat()` `position` → `waitlist_position` rename + duplicate-confirmed guard, local-Postgres validation (below) |

## Tests

`node --test server/tests/*.test.js assessment-engine/assessment-engine.test.js`
— all green (47 pre-existing + 44 new = 91 total; see commit messages
for the per-file counts). `node --check` passes on every JS file touched
or created. New coverage: zero-coach / equipment-shortfall / stored-cap-0
refusals (no waitlist entry), cancel-on-infeasible, bulk promotion,
empty-array ineligibility, legacy undefined eligibility, 001 SQL
invariants (citext, `session_not_bookable` guard, duplicate guard),
003 SQL invariants,
PostgresStore hydration + `reserve_seat()` gate + error mapping +
transactions (fake injected Pool, no live DB), API role checks + actor
integrity + cancel promotion + attendance (MemoryStore), cross-process
race at the atomic gate (`RACE_WAITLISTED` returns waitlisted, no second
entry; `ALREADY_WAITLISTED` propagates).

## Verified against real PostgreSQL (throwaway local, 2026-11-12)

Migrations 001 + 002 + 003 were executed against a THROWAWAY local
Postgres 18.6 (binaries at `~/bin/local-stack/`, data dir in `/tmp`,
port 54399, loopback only; Big Whiff local stack untouched). All three
applied cleanly, re-apply is idempotent (22 tables, 58 policies after
re-apply), and the server + data dir were removed afterwards. Results:
- 22 tables (18 from 001 + 4 from 002); assessment seed 10 rows;
  membership default price 14900; 58 RLS policies.
- 8-spot / 6-registered rule: 6 books → 2 seats free; 2 more confirm;
  9th/10th waitlist at positions 1/2; confirmed never exceeds 8.
- SQL concurrency: two simultaneous `reserve_seat()` calls for one seat
  → exactly 1 confirmed + 1 waitlisted. Two-process Node race through
  the real engine + `PostgresStore` (cap-1 session) → exactly 1
  confirmed + 1 waitlisted at position 1, no error, no duplicate entry.
- Cap-0 session: `reserve_seat()` raises `session_not_bookable`.
- Cancel + promotion through the API: cancelling a confirmed seat
  promotes the first waitlisted athlete; confirmed stays at cap.
- Session scheduled through `scheduleSession()` (cap 18) then booked
  through the engine: 2 confirmed, `availableSeats` = 16.
- RLS (stub `auth` schema standing in for Supabase Auth): parent sees
  only their 1 athlete / 1 membership / own reservations, never others;
  coach sees all 10 cohort athletes; director sees everything; `anon`
  sees nothing; parent INSERT for own athlete allowed.
- Assessment tables (002): one session + measured result (attempts
  preserved) + derived interpretation insert cleanly.
- API role checks against the live store: athlete `recordAttendance`
  → `FORBIDDEN`; null auth → `UNAUTHENTICATED`.

Two defects were found ONLY by this run and fixed in the verification
commit (they are not in the 87-test baseline above — the string-assertion
tests could not have caught them):
1. `reserve_seat()` output column `position` is a reserved word —
   `CREATE FUNCTION` failed on first apply. Renamed to
   `waitlist_position` in 001 + `postgres-store.js` + tests.
2. `reserve_seat()` had no duplicate-confirmed check: on a FULL session
   an athlete who already held a seat was waitlisted (phantom entry).
   Explicit guard added before the cap check; the store maps its
   `duplicate:` exception to clean `DUPLICATE`.
3. Cross-process race: the store used to throw `SESSION_NOT_BOOKABLE`
   when the gate returned waitlisted, so a race loser got an error
   instead of a waitlist spot. Now `RACE_WAITLISTED` (entry attached)
   and the engine returns the waitlist outcome.

Caveats: the local rehearsal ran on Postgres 18.6; Supabase runs
15.8.1.50. The migrations have now also executed successfully on live
Supabase PG 15.8 (see "Applied to TheProgramOS" below), so DDL-level
PG15 compatibility is proven by execution, not just review. The RLS
behaviour checks still used a stub `auth` schema (one-row `auth._uid`
impersonation), not real Supabase Auth / JWTs.

## Applied to TheProgramOS (2026-11-12)

Marcus approved applying 001 + 002 + 003 to TheProgramOS as the dev
target. Applied in order via the dashboard SQL editor, same signed-in
session throughout (GitHub OAuth, `baileyventuresos-create`; no
email/password sign-in used). Verified after each step with count
queries run in the editor:
- **001:** "Success. No rows returned" — 18 public tables, 18
  RLS-enabled tables, `reserve_seat()` present.
- **002:** "Success. No rows returned" — 22 public tables, 10
  assessment definitions seeded.
- **003:** "Success. No rows returned" (Supabase showed its standard
  "Potential issue detected" confirmation because the script contains
  DROP POLICY statements; confirmed with "Run query" — the script is
  the approved idempotent migration) — 22 public tables, 58 RLS
  policies, 10 assessment definitions, `app_users.auth_user_id` and
  `athletes.app_user_id` columns present.
- **Transcription catch:** the 003 script as handed to the browser
  contained one mistyped line (`DROP POLICY IF EXISTS adef_read ON
  adef_read ON assessment_definitions;` — a duplicated phrase
  introduced while copying, not present in the repo file). It was
  caught and corrected to `DROP POLICY IF EXISTS adef_read ON
  assessment_definitions;` BEFORE the script ran (corrected line
  visually confirmed in the editor). The repo file was already correct;
  no file change was needed.

## Still unverified — do not claim otherwise

- Migrations 001 + 002 + 003 ARE applied to TheProgramOS (see above).
  Structural counts are verified, but the live behaviour checks have
  NOT run yet. Before any real athlete record is stored, repeat the
  checks against TheProgramOS:
  1. Two concurrent `reserve_seat()` calls for one seat: exactly one
     confirms (same test the SQLite suite runs).
  2. `reserve_seat()` on a cap-0 session raises `session_not_bookable`.
  3. As an `authenticated` parent user: can read own athletes, cannot
     read other athletes; as a coach: can read only their cohorts'
     athletes; as `anon`: nothing.
  4. Confirm the double-`RESERVED` audit rows (one from
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

1. DONE 2026-11-12: migrations 001 + 002 + 003 applied to TheProgramOS
   as the dev target (verified above). Next: repeat the live
   verification checks (concurrency, cap-0, RLS scoping) against
   TheProgramOS — step 3 of the deployment sequence.
2. Confirm the RLS policy set is acceptable before any real athlete
   record is stored (see verification list above).
3. Decide the API transport (Supabase Edge Function / server route)
   and how the JWT-derived auth context is supplied — not built here.
