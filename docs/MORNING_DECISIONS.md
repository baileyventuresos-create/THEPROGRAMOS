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

## 2. Backend choice: no backend project exists yet

- **Context:** The prototype has no backend, database, or auth. This
  work adds version-controlled PostgreSQL migrations (`server/migrations/
  001` + `002`), a reservation engine, and local SQLite/Memory stores —
  but no live database was created and none was assumed.
- **Decision needed:** Approve a backend, and which one? Recommendation
  in `docs/INTEGRATION_STRATEGY.md`: Supabase/PostgreSQL (same pattern
  already used for Big Whiff). If approved: create a **scratch/dev**
  project first; production comes later as a separate decision.
- **Blocked until decided:** applying migrations anywhere; building the
  API layer; any UI integration with live data.

## 3. Migrations are unvalidated against real PostgreSQL

- **Context:** No `psql` or Postgres server was available in the overnight
  environment, and no project exists. The migrations were written and
  reviewed, and their key invariants are asserted in tests (row lock,
  unique index, RLS enabled, price default), but the SQL has not been
  executed against PostgreSQL.
- **Decision needed:** None — this is a sequencing note, not an approval
  ask. Once #2 is approved, apply to scratch and run the concurrency
  checks before any real use.
- **Blocked until decided:** any claim that the migrations are proven
  against Postgres (they are currently "reviewed, not executed").

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
  scientifically validated.
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

## 10. Assessment branch cleanup (no approval needed, for awareness)

- **Context:** `feature/assessment-engine-v1` is fully contained in
  `main` @ `dc5d42d` (same files, byte-identical). The branch is redundant.
- **Action proposed:** delete the branch after this work merges, to avoid
  confusion. No approval required to note it; deletion itself can wait
  for the merge decision.
