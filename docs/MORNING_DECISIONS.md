# Morning Decisions — items needing Marcus's approval

Nothing below was decided overnight. Each item states the context, the
exact decision needed, and what is blocked until it is made. Work
continued around every item; nothing is stalled except the item itself.

## 1. Repository visibility: THEPROGRAMOS is PUBLIC, The Program is not

- **Context:** `baileyventuresos-create/THEPROGRAMOS` is a public GitHub
  repo (confirmed 2026-11-11) although The Program is a non-public
  venture. Known flag since 2026-11-07. The prototype currently contains
  no real athlete data — only generated demo athletes — but any real
  record committed here would be public by default.
- **Decision needed:** Make the repo private, or keep it public
  deliberately (and if so, confirm what may ever be committed to it)?
- **Blocked until decided:** committing anything beyond demo/fixture data
  to this repo; any future UI integration work that touches real records.
- **Overnight action:** visibility NOT changed; recorded here only.

## 2. Backend choice: DECIDED — Supabase is the SOLE backend (2026-11-12, FINAL)

- **Decision (2026-11-12, FINAL, by Marcus):** Supabase is the sole
  backend for The Program OS. The dual-database directive is CANCELLED.
  The Neon project TheProgramOS (winter-poetry-05133966) is UNUSED —
  preserve it without modification; do not connect the application to
  it. The backend-completion mission (2026-11-12) built the Postgres
  store (`server/postgres-store.js`, `pg`), the thin authenticated API
  (`server/api.js`), migration 003 (auth link + RLS), and the
  session-scheduling link (`server/schedule-session.js`) against
  Supabase only. Migrations 001 + 002 + 003 were APPLIED to
  TheProgramOS on 2026-11-12 with Marcus's approval (dashboard SQL
  editor; verified: 22 tables, 58 policies, 10 assessment definitions).
  No Neon project was touched.
- **Context (corrected 2026-11-11, inspected 2026-11-12):** A Supabase
  project named **TheProgramOS** DOES exist — ref
  `rkgdwqgmldznczikrjip`, organization **BigWiffWiffleBallLeague** (Pro
  plan), region **us-east-2**, created **13 Oct 2026**, status ACTIVE.
  Read-only dashboard inspection on 2026-11-12 found it **EMPTY**: 0
  tables in the `public` schema (exact count), 0 auth users (exact
  count), no storage buckets, no edge functions, no connected repo.
  Postgres 15.8.1.50, Micro compute, Healthy. Only Supabase's own system
  tables exist (auth/realtime/storage/vault). No real athlete data, no
  prototype data — nothing for migrations 001 + 002 to collide with
  (all `CREATE TABLE IF NOT EXISTS`, standard SQL, no Postgres 16+
  features). Migrations 001 + 002 + 003 were applied 2026-11-12 (see
  below); before that, none had been applied.
- **APPLIED 2026-11-12 (Marcus's approval, dev target):** 001 + 002 +
  003 applied in order via the dashboard SQL editor; verified after
  each step (001: 18 tables, 18 RLS-enabled, `reserve_seat()` present;
  002: 22 tables, 10 assessment definitions; 003: 22 tables, 58
  policies, auth-link columns present). Production use of this project
  is still a separate decision.
- **Blocked until decided:** production use; any UI integration with
  live data until the API transport decision is made. (Building the API
  layer is DONE — see above; it runs against injected stores in tests
  and has never touched live Supabase.)

## 3. Migrations are unvalidated against real PostgreSQL

- **Context:** No `psql` or Postgres server was available in the overnight
  environment. A project DOES exist (TheProgramOS, inspected empty
  2026-11-12 — see #2). The migrations were written and reviewed, and
  their key invariants are asserted in tests (row lock, unique index,
  RLS enabled, price default, citext extension, infeasible-session
  guard). The SQL was executed against a throwaway local Postgres 18.6
  (2026-11-12, all checks passed) and applied to TheProgramOS itself
  (Postgres 15.8.1.50) on 2026-11-12 with structural verification
  (22 tables, 58 policies, 10 definitions). The live behaviour checks
  then ran against TheProgramOS on 2026-11-12 and passed (gate logic,
  cap-0, parent/coach/anon RLS scoping; see docs/SUPABASE_HANDOFF.md
  "Live verification"). Still open: a live two-connection race, the
  director path, and a real-login JWT flow.
- **Decision needed:** None — this is a sequencing note, not an approval
  ask. The remaining live checks (above) run before any real use.
- **Blocked until decided:** any claim that the migrations are proven
  against live Supabase behaviour beyond what the 2026-11-12 live
  verification actually covered (see its honest limits).

## 4. Membership price: $149 fixed vs the prototype's "$149 / $179"

- **Context:** The overnight brief fixes membership at **$149/athlete/
  month**. The prototype's DECISIONS register says "$149 / $179
  memberships" (ASSUMPTION). This work implements $149 only
  (`price_cents` default 14900) and does not implement the $179 tier.
- **Decision needed:** Confirm $149 flat for all athletes, or define the
  $179 tier (who qualifies, what differs)? Confirm the 75-athlete
  planning demand assumption (2 sessions/week per member) is the right
  one to plan against.
- **Blocked until decided:** any billing work; any pricing display.

## 5. Billing activation

- **Context:** Nothing in this work activates billing. The schema stores
  membership *status* only. The prototype's Settings view says billing
  is out of scope until the product works.
- **Decision needed (when ready):** Payment provider (e.g. Stripe),
  who the merchant is, and when to activate real subscriptions.
- **Blocked until decided:** all payments, subscriptions, charges.

## 6. Coach staffing: who are the 2nd and 3rd coaches?

- **Context:** The prototype assumes 3 coaches per group session
  (`coachesFor()`) but flags it NEEDS DEFINITION: "who the second and
  third coaches are at launch — hired, parent volunteers, Marcus — is
  open." The 75-athlete capacity model (205 weekly seats vs 150 demand)
  is **conditional on 3-coach staffing**; with 1 coach per session the
  same cohorts supply only 77 weekly seats and the model does not fit (2 coaches supply 149 — just short of the 150 demand).
- **Decision needed:** Staffing plan per location (hired coaches, subs,
  volunteers) and how coach unavailability is covered (the engine blocks
  booking when a scheduled coach is unavailable — it never silently
  substitutes).
- **Blocked until decided:** treating the 75-athlete model as a commitment
  rather than a conditional plan.

## 7. Facility occupancy numbers

- **Context:** Prototype spaces record dimensions only (e.g. "84 × 50 ft
  hardwood"). The capacity adapter refuses to infer occupancy from
  square footage; facility caps only bind once the operator sets
  `maxAthletes` per space.
- **Decision needed:** Max athletes per space for Yakima Main gym,
  Ellensburg Turf strip / Court, Cle Elum Gym (and any new space).
- **Blocked until decided:** facility-constrained capacity (the adapter
  currently flags this as unspecified rather than blocking).

## 8. Assessment battery validation

- **Context:** The assessment engine is built and now has a persistence
  adapter, but the battery itself is NEEDS VALIDATION in the prototype
  (hand-timed sprints, no agreed reaction test, vertical jump method
  undecided). Nothing here represents any assessment as clinically or
  scientifically validated. Update 2026-11-12: the universal GAA v1
  protocol (`server/assessment-battery.js`, protocol `gaa-v1`) is now
  written with standardized instructions, safety, and validity
  criteria — but it is still unvalidated in the field and this
  decision is unchanged.
- **Decision needed:** Approve the battery/protocols/timing method and
  retest interval before assessment results are shown to parents as
  anything more than coach-recorded measurements; approve the athlete
  profile / coach overlay UI integration (per INTEGRATION.md steps 5–7).
- **Blocked until decided:** showing assessment trends to parents,
  feeding assessment evidence into Smart Draft.

## 9. Merge and deployment

- **Context:** Branch `feature/program-operational-foundation-v1` is
  pushed and a draft PR is opened (see handoff §6). It touches no UI
  files and no production system, but it is **not merged**.
- **Decision needed:** Review and approve the merge into `main`; any
  deployment is a separate decision after that (there is currently no
  deployment pipeline for this repo at all).
- **Blocked until decided:** merge; any deployment.

## 11. Apply migration 004 (assessment + reassessment) to TheProgramOS

- **Context:** Migration `server/migrations/004_assessment_reassessment.sql`
  was written and reviewed 2026-11-12 on branch
  `feature/universal-assessment-reassessment-v1`. It is ADDITIVE:
  5 GAA assessment definitions (incl. observation-only movement
  assessment), `assessment_schedules`, `assessment_deferrals`,
  `development_plans` (CHECK: a finalized plan must name its baseline
  session), `assessment_sessions.idempotency_key` + partial unique
  index, and RLS policies mirroring 003. It does not alter or delete
  any existing table except two additive changes to
  `assessment_definitions` (a `kind` column + relaxed direction/
  aggregation CHECKs) and one nullable column on
  `assessment_sessions`. It has NOT been applied anywhere and has NOT
  run against any Postgres in this session (SQL-invariant tests only).
  The target project is EMPTY of real athlete data (verified
  2026-11-12: 0 tables in public before 001–003, 0 auth users).
- **Decision needed:** Approve applying 004 to TheProgramOS (directly,
  or to a scratch copy first), and whether to run the live
  verification checks after (tables/definitions/policies counts,
  idempotency + concurrency checks, RLS scoping).
- **Blocked until decided:** any live use of the GAA battery,
  reassessment schedules, deferrals, or plan gating; API methods for
  assessments; any UI integration with live assessment data.

## 12. Merge and deployment — universal-assessment branch

- **Context:** Branch `feature/universal-assessment-reassessment-v1`
  is pushed and a draft PR is opened (see
  `docs/ASSESSMENT_REASSESSMENT_HANDOFF.md` §6). It touches no HTML
  files and no production system, but it is **not merged**. It extends
  the assessment engine to v1.1.0 (additive only) and updates the
  UI-preservation snapshot hash for the engine file in a reviewed
  commit; all HTML files remain byte-identical.
- **Decision needed:** Review and approve the merge into `main`
  (note: `main` is at `dc5d42d`; the foundation branch it builds on
  is itself unmerged — merging order is Marcus's call); any
  deployment is a separate decision after that.
- **Blocked until decided:** merge; any deployment.

## 10. Assessment branch cleanup (no approval needed, for awareness)

- **Context:** `feature/assessment-engine-v1` is fully contained in
  `main` @ `dc5d42d` (same files, byte-identical). The branch is redundant.
- **Action proposed:** delete the branch after this work merges, to avoid
  confusion. No approval required to note it; deletion itself can wait
  for the merge decision.

## 13. API transport for the assessment workflow (new, from integration)

- **Context:** The assessment workflow (`server/assessment-workflow.js`)
  and its authenticated API (`server/assessment-api.js`) are
  transport-agnostic, exactly like the reservation API: they take an
  injected auth context derived from a verified Supabase Auth JWT and
  never parse tokens themselves. Nothing in this branch hosts them.
  The two candidate hosts are a Supabase Edge Function or a server
  route on the application's host (when one exists — there is
  currently no deployment pipeline for this repo at all).
- **Decision needed:** Edge Function or server route (or another host
  Marcus prefers), and who wires the JWT verification.
- **Blocked until decided:** any live use of the assessment API;
  UI integration with live assessment data.

## 14. Prototype Assessments view copy is stale (new, from integration)

- **Context:** `THE PROGRAM OS.html` `vAssess()` still describes the
  assessment battery as an unapproved proposal ("nothing here is
  approved, and these numbers are not being collected today") with a
  "~12 weeks" retest interval listed as an ASSUMPTION. The engine
  now implements the standardized GAA battery on a 28-day cycle.
  The HTML was deliberately NOT edited during integration (UI
  preservation); the dashboard "due for re-testing" card also still
  reads prototype demo data instead of the reassessment engine.
- **Decision needed:** Approve refreshing the Assessments view copy
  (and wiring the dashboard due-card to `coachDashboard()`) as a
  minimal, additive UI update — no redesign, no layout change.
- **Blocked until decided:** any HTML change to the Assessments view
  or dashboard card.
