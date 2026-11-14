# §5 live functional checks for migration 004 — The Program OS

Run order (paste each file, in order, into the Supabase dashboard SQL editor):

1. `01-setup-synthetic-data.sql`
2. `02-checks.sql`
3. `03-cleanup.sql`

Live project only: **TheProgramOS** (`rkgdwqgmldznczikrjip`), Postgres 15.8.1.50.
These scripts write test rows by design and are for this project only,
with Marcus's approval for this §5 run (given 2026-11-13). They must
not be run against any other project, and 03-cleanup must be run in
the same session after the checks.

## What the checks prove

All five checks come from `docs/MIGRATION_EXECUTION_PLAN.md` §5.
Every check ASSERTS: it writes a row into a temp results table and
raises a NOTICE, and 02 ends with a summary SELECT. A check that fails
records FAIL and the script continues — no exception ever escapes a
check block, so one failure cannot hide the rest.

| Check | One-line expected result |
|---|---|
| 1a first insert | Session inserted under key `TEST-004-IDEMPOTENCY-001` (also proves the coach-write policy) |
| 1b duplicate rejected | Same key, different session id → rejected with `23505` unique_violation |
| 1c retry no-op | `ON CONFLICT … DO NOTHING` inserts 0 rows; the key still resolves to the ORIGINAL session |
| 2a out-of-cohort denied | Coach inserts a session for athlete B (different cohort) → denied with `42501` insufficient_privilege |
| 2b own-cohort insert | Same coach inserts a session for athlete A (own cohort) → succeeds |
| 2c own-cohort result | Coach inserts a 10yd-sprint result on that session → succeeds |
| 2d own-cohort derived | Coach inserts a derived observation on that session → succeeds |
| 3a athlete own | Athlete A sees own 2 sessions / 1 result / 1 derived, and 0 of athlete B's |
| 3b parent own | Parent (guardian of A only) sees A's 2 sessions and A, 0 of B's |
| 3c anon nothing | Anonymous sees 0 sessions / 0 results / 0 derived / 0 athletes |
| 4a override inserts | Finalized plan with baseline NULL + override_reason set → inserts (the 004 CHECK fix) |
| 4b neither rejected | Finalized plan with neither baseline nor override → rejected with `23514` check_violation |
| 5a draft created | Coach creates a draft for athlete A and can see it (proves it exists for the invisibility checks) |
| 5b athlete no draft | Athlete A sees 0 drafts |
| 5c parent no draft | Parent sees 0 drafts |
| 5d draft not a session | Draft id appears in 0 `assessment_sessions` rows (absolute count, no RLS) |
| SANITY absolute counts | Absolute (RLS-bypassed): athlete A has 2 sessions / 1 result / 1 derived / 1 draft / 1 plan — so the zeros above are RLS, not missing data |

All 17 rows in the summary must be PASS.

## Method — JWT-claim impersonation (same as checks A/B/C)

Identical to the method checks A/B/C used for 001–003
(`docs/SUPABASE_HANDOFF.md`). The dashboard SQL editor connects as
superuser `postgres`, which bypasses RLS, so each impersonated block is
an explicit transaction:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub": "<test auth UUID>", "role": "authenticated", "aud": "authenticated"}';
-- ...checks...
COMMIT;
```

The RLS helpers (migration 003) resolve role and identity from
`auth.uid()`, which reads `request.jwt.claims` — the claim is exactly
what Supabase sets for a real authenticated session, so the policies
execute the same code path. Honest limit (same as A/B/C): this proves
the policy logic against the claim, not the end-to-end login → JWT
issue path, and the checks run sequentially in one editor session, so
they do not prove a two-connection race. The one true race (the
idempotency unique index) is proven by the database constraint itself
in check 1b.

`COMMIT`, not `ROLLBACK`, ends every impersonated block: a write
check's row must persist for the later checks, and the verdict rows
in the temp table only survive a commit. The anon block commits
nothing.

## Test fixtures (synthetic only)

Created by `01-setup-synthetic-data.sql`; deleted by `03-cleanup.sql`.
Every identity is obviously synthetic — fixed UUIDs, `TEST-` names,
`test-programos.test` emails. No real athlete, coach, parent, or auth
data is created, read, or touched.

- Coach: heads cohort **TST-A** only.
- Athlete A: enrolled in TST-A; parent is guardian of A only.
- Athlete B: enrolled in **TST-B** (headless). Same age band (12–14)
  as TST-A, so the only difference between A and B is cohort
  membership — the coach-scope check proves cohort membership, not
  "the athlete has any coach at all".
- Both athletes are 12 (inside migration 001's `age_years` 5–19 CHECK;
  migration 005, which relaxes the max, is NOT applied).
- `auth.users` rows exist only because `app_users.auth_user_id` is a
  foreign key to `auth.users(id)`; their passwords are a disabled
  placeholder and nobody logs in with them.

Fixed UUIDs (full list in each file's header):

| What | UUID |
|---|---|
| Auth: coach / parent / athlete A / athlete B | `a0000000-…-0001` … `a0000000-…-0004` |
| App users: coach / parent / athlete A / athlete B | `b0000000-…-0001` … `b0000000-…-0004` |
| Coach row | `c0000000-…-0001` |
| Athletes A / B | `d0000000-…-0001` / `d0000000-…-0002` |
| Guardian | `e0000000-…-0001` |
| Location / cohort TST-A / cohort TST-B | `f0000000-…-0001` / `-0002` / `-0003` |
| Sessions (check 1 / check 2) | `10000000-…-0001` / `10000000-…-0003` |
| Attempted sessions (rejected/denied) | `10000000-…-0002` / `10000000-…-0004` |
| Result / derived / draft / override plan | `20000000-…-0001` / `30000000-…-0001` / `40000000-…-0001` / `50000000-…-0001` |
| Attempted plan (rejected) | `50000000-…-0002` |

## Stop conditions

- **Setup pre-flight fails** (not 26 tables / 15 definitions / 72
  policies / 0 app rows / 0 test auth users): STOP. Do not run setup
  into an unexpected state — the project has changed since 004 was
  verified, or a previous run left test data behind. Run
  `03-cleanup.sql` first, then re-check the state.
- **Any check FAILs**: finish reading the summary, then run
  `03-cleanup.sql` before diagnosing. Do not proceed to a later check
  that depends on the failed row existing (e.g. check 3 counts assume
  checks 1–2 created their rows).
- **Grants pre-flight fails** (a table grant is missing for
  `authenticated` or `anon`): STOP. The run cannot distinguish an
  RLS denial (42501) from a missing grant (also 42501), so no check
  runs. The fix is a `GRANT` — a live access-control change to the
  project — which needs Marcus's SEPARATE approval (not covered by
  the §5 check approval). Report the exact missing grants the
  pre-flight lists and wait for that decision.
- **Checks pre-flight fails** (fixtures missing): STOP. Run
  `01-setup-synthetic-data.sql` first.

## Grants — read this before running

RLS policies and table grants are separate layers, and both deny
with SQLSTATE 42501. Supabase changed its platform default on
**30 Oct 2026**: new tables in `public` no longer automatically get
`SELECT`/`INSERT`/`UPDATE`/`DELETE` for `anon`/`authenticated`/
`service_role`; existing tables keep their grants. Migrations
001–004 were applied 12–13 Nov 2026, after that change, and no
migration grants table privileges. Check B (12 Nov 2026) proved
live `SELECT` works as `authenticated`, so this project's tables
appear to carry grants — but `INSERT` was never exercised live.

`02-checks.sql` therefore starts with a **grants pre-flight**
(`has_table_privilege` checks, run as postgres) covering every
`SELECT`/`INSERT` the checks need, for both `authenticated` and
`anon`. If any grant is missing it raises and stops before any
check runs. The pre-flight grants nothing itself: a missing grant
is fixed by a `GRANT`, a live access-control change needing
Marcus's separate approval.

## Cleanup guarantee

`03-cleanup.sql` deletes every test row by its fixed synthetic UUID,
in dependency order (children first, so RESTRICT foreign keys cannot
block a delete). It is safe to run even if a check failed midway
(a DELETE that matches nothing deletes nothing) and safe to run twice.
It ends with verification queries that must show the pre-check state:

- 26 public tables
- 15 assessment definitions
- 72 public RLS policies
- 0 rows in every application table (per-table counts listed)
- 0 test `auth.users` rows

and a `CLEANUP PASS` notice. If it reports `CLEANUP FAIL`, inspect the
per-table counts, delete the remaining test rows by their fixed UUIDs,
and re-run the verification queries.

## What was validated locally (and what was not)

- The three scripts were rehearsed end-to-end against a throwaway
  local Postgres 18.6 (loopback only, removed afterward) with
  migrations 001–004 applied and a stub `auth` schema (`auth.users`
  minimal table + `auth.uid()` reading `request.jwt.claims`) plus
  `authenticated`/`anon` roles. The local bootstrap applied the
  Supabase-style table grants explicitly (`GRANT SELECT, INSERT,
  UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated,
  anon`) to mirror the live project's observed grants — check B
  proved live `SELECT` works as `authenticated`; the grants
  pre-flight re-verifies the live state at run time instead of
  assuming it.
- The rehearsal caught three real script bugs before the live run:
  (1) the local DB had no table grants, so every impersonated write
  failed with 42501 — fixed by adding the grants pre-flight to
  `02-checks.sql`, which now stops the run with the exact missing
  grants listed instead of producing misleading FAILs (verified: on
  the no-grant database the pre-flight raises, no check runs, zero
  rows created); (2) two invented column names —
  `development_plans.created_by` and `assessment_drafts.draft_data`
  do not exist in migration 004 — fixed to the real columns
  (`finalized_by` + `override_approved_by`; `entries` + `context` +
  `idempotency_key`); (3) `min(uuid)` does not exist — fixed with
  `LIMIT 1` on a count-proven single row.
- After the fixes, a clean rebuild ran 01 → 02 → 03 with **all 17
  verdicts PASS** and **CLEANUP PASS** (back to 26 tables / 15
  definitions / 72 policies / 0 rows). Setup's pre-flight was also
  verified to refuse a re-run into a non-empty state (14 rows
  present), and the node suite guards the real column names and the
  grants pre-flight so these bugs cannot regress silently.
- Local is Postgres 18.6; live is 15.8.1.50. The DDL already proved
  compatible live for 001–004, and the checks use only standard SQL.
- NOT validated locally: the actual dashboard SQL editor's handling
  of multi-statement scripts (notices, `SET LOCAL`), the live
  project's current state at run time (setup's pre-flight re-checks
  it live; the grants pre-flight re-checks the live grants), and the
  end-to-end login → JWT issue path (see Method).
