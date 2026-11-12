# Overnight Handoff — THE PROGRAM OS Operational Foundation V1

**Date:** 2026-11-11 (overnight) · **Branch:** `feature/program-operational-foundation-v1`
**Baseline:** `main` @ `dc5d42d` · **Status:** work complete, reviewed, tests green, not merged.

## 1. Executive summary

THE PROGRAM OS is a static, client-side prototype with no backend, no
database, no auth, and no reservations — all athlete data in it is
generated demo data. This night built the operational machinery behind
it without touching the application: a per-session capacity adapter
derived from the prototype's own station-rotation rules, a
concurrency-safe reservation engine (eligibility, duplicates, conflicts,
coach/facility availability, waitlists with auto-promotion, attendance,
audit trails), PostgreSQL migrations for the full operational data model
(unapplied), an assessment persistence adapter, fixtures, and 47 passing
tests including UI-preservation hash checks. The headline finding for
planning: the existing 7 cohorts supply **205 bookable seats/week**
against **150 bookings/week** of demand from 75 members at 2
sessions/week — the model fits at 73% utilization, **conditional on the
prototype's assumed 3-coach staffing** (see §8 and MORNING_DECISIONS #6).
Ten owner decisions are recorded in `docs/MORNING_DECISIONS.md`; nothing
was deployed, merged, billed, or applied to any live system.

## 2. Existing functionality discovered and preserved

- **Whole prototype preserved byte-for-byte.** `THE PROGRAM OS.html`
  (633 KB), `index.html`, the three patch scripts, and the assessment
  engine are unmodified — verified by SHA-256 snapshot
  (`tests/ui-preservation.snapshot.json`, enforced by
  `server/tests/ui-preservation.test.js`).
- **Modes/surfaces intact:** Director, Coach (live session, rotation,
  report submit), Athlete/Parent (mobile-first), Program Builder,
  Training Library (130 `TP2-xxx` games), The Lab (8 seed candidates),
  Assessments view, plus Dashboard/Sessions/Cohorts/Athletes/Coaches/
  Locations/Equipment/Reports/Audit/Settings.
- **Session-planning engine untouched:** `draftSession` /
  `checkGame` (7-stage gate) / `rankGame` / `buildConfigs` / `slotMath`
  (stations ≤ coaches, preferred 4–6/station, BUILD slots 5–14 min),
  `rollingEmphasis`, exposure tracking, equipment schema, human approval
  ("Draft → approved by Marcus"). The new capacity adapter *mirrors*
  these rules; it does not replace them.
- **Cohort system reused as the foundation:** 7 cohorts (caps
  20/20/16/20/16/14/5 = 111), 3 locations with spaces + inventory,
  4 coaches, 5 templates (p60/p90/p45/sg45/pp50).
- **Attendance + development history:** schedule generation, present/
  attended tracking, coach report fan-out, per-athlete exposure gaps —
  all demo-grade, all preserved as-is.
- **Assessment engine (branch `feature/assessment-engine-v1`):** found
  to be **already fully merged in content** — `main` @ `dc5d42d` contains
  the same 4 files byte-for-byte (`git diff` empty). No merge needed;
  branch can be deleted after this work merges. Its smoke test passes.
- **No functionality removed.** Nothing was deleted; no file was removed
  for appearing unused.

Full findings, dependencies, and risks: `docs/OPERATIONAL_AUDIT.md`.

## 3. New functionality actually implemented

Implemented (code + tests, on the branch — not designs):

- **`server/session-capacity.js`** — computes a session's reservation cap
  from coaches available, template BUILD minutes, cohort cap, facility
  occupancy (when the operator sets it — never inferred from dimensions),
  and equipment vs inventory. Inverts the prototype's `buildConfigs`:
  largest athlete count that still fits a coached 4–6-per-station layout.
  Flags infeasible sessions (no coach, equipment shortfall); never
  auto-raises capacity; `recalculateCapacity()` reports changes and never
  silently cancels existing bookings.
- **`server/reservation-engine.js`** — `reserve` / `cancel` /
  `availableSeats` / `recordAttendance` / `reconcileAttendance`.
  Enforces: active membership covering the session date; age band and
  cohort eligibility; readiness restrictions; duplicate prevention;
  overlapping-session conflicts; coach availability (no silent
  substitution); facility/space conflicts; capacity. Full sessions go to
  a waitlist; cancellation auto-promotes the first still-eligible
  waitlisted athlete (conflicted/expired candidates are skipped and
  audited). Every mutation writes an audit event. A session with no
  computed capacity cannot be booked — capacity is never guessed.
- **`server/reservation-stores.js`** — `MemoryStore` (tests/dev) and
  `SqliteStore` (Node built-in `node:sqlite`, zero dependencies) with
  `BEGIN IMMEDIATE` transactions and a partial unique index so duplicate
  confirmed reservations are impossible even if two writers race.
- **`server/migrations/001_operational_foundation.sql`** — PostgreSQL
  schema for users/roles, guardians, athletes, memberships ($149 =
  14900¢ default), locations/spaces, coaches/availability, cohorts/
  enrollments, templates, sessions, reservations, waitlists, attendance,
  audit events; atomic `reserve_seat()` (row lock + capacity re-check);
  RLS enabled on all athlete tables. **Not applied to any database.**
- **`server/migrations/002_assessment_persistence.sql`** — assessment
  definitions/sessions/results/derived records, seeded with the exact
  engine V1 definitions.
- **`server/assessment-store.js`** — persistence adapter: measured
  results (all attempts preserved), coach observations (text only), and
  system interpretations (derived, labelled, with caveats) are separate
  record kinds; baselines are derived from the first valid result and
  history is never overwritten; asymmetry "monitor" stored with its
  not-a-diagnosis caveat; Smart Draft evidence labelled as evidence only.
- **`server/fixtures/`** — fictional test fixtures transcribed from the
  prototype, plus `generate-75-scenario.js` → `scenario-75-athletes.json`.
- **Docs:** `docs/OPERATIONAL_AUDIT.md`, `docs/INTEGRATION_STRATEGY.md`,
  `docs/MORNING_DECISIONS.md`, `server/README.md`.

Designs / placeholders / proposed future work (NOT implemented): the
backend itself (no Supabase/Postgres project created), the authenticated
API layer, any UI integration (booking surfaces, Director capacity view),
any data import, billing, deployment. See §9.

## 4. Test results

Command: `node --test server/tests/*.test.js assessment-engine/assessment-engine.test.js`
(also run as `node --test` per file; Node built-in runner, zero dependencies)

- **47 tests, 47 passed, 0 failed, 0 skipped.**
- Pre-existing assessment-engine smoke test: **passed** (unchanged).
- New tests: reservation engine run against **both** stores (Memory +
  SQLite) — final-seat booking, two simultaneous attempts for one seat
  (exactly one confirms, one waitlists), duplicates, cancellation +
  waitlist promotion with a conflicted candidate skipped, expired
  membership, age/readiness ineligibility, coach unavailability, facility
  conflict, session conflict, attendance + reconciliation, audit trail,
  no-capacity session refused, migration-001 SQL invariants.
- Capacity tests: coach-count derivation (1 coach = 6, 3 coaches = 18),
  prototype layout parity (p60/16 athletes/3 coaches → 4–6/station),
  cohort-cap binding, equipment binding, zero-coach infeasibility,
  facility occupancy flagging, recalculation semantics, 75-athlete
  scenario arithmetic, prototype behaviour-presence checks.
- Assessment-store tests: measured/observation/interpretation separation,
  derived baselines, asymmetry caveat, rejection of bad input, draft
  evidence labelling, migration-002 seed parity with the engine.
- UI-preservation tests: byte-identical hashes, mode/surface presence,
  no backend/billing code in UI files.

**Untested:** the migrations against real PostgreSQL (no `psql`/server
in this environment and no project exists — see MORNING_DECISIONS #3);
the engine against a live Postgres via `reserve_seat()` (same reason);
any browser/rendered-UI check beyond the hash/presence tests (no UI
changes were made, so there is nothing rendered to re-verify); real-device
or production behaviour (nothing deployed).

**Bug found and fixed by the suite:** eligibility-rejection audit rows
were first written *inside* the reservation transaction; SQLite rolled
them back when the transaction failed, so rejections were unaudited on
that store. The engine now writes rejection audits outside the
transaction (commit `e2f055f`).

## 5. Files changed

All new files; **no pre-existing file was modified** (18 files, +2,674 lines).

| File | What it is |
|---|---|
| `server/session-capacity.js` | Per-session capacity adapter (see §3) |
| `server/reservation-engine.js` | Reservation engine |
| `server/reservation-stores.js` | MemoryStore + SqliteStore |
| `server/assessment-store.js` | Assessment persistence adapter |
| `server/migrations/001_operational_foundation.sql` | Operational Postgres schema + `reserve_seat()` |
| `server/migrations/002_assessment_persistence.sql` | Assessment Postgres schema + V1 seed |
| `server/fixtures/seed-operational.json` | Fictional fixtures from prototype data |
| `server/fixtures/generate-75-scenario.js` | 75-athlete scenario generator |
| `server/fixtures/scenario-75-athletes.json` | Generated scenario output (205 vs 150 seats) |
| `server/README.md` | Server module guide |
| `server/tests/reservation-engine.test.js` | Engine tests, both stores |
| `server/tests/session-capacity.test.js` | Capacity + scenario + preservation-behaviour tests |
| `server/tests/assessment-store.test.js` | Assessment adapter tests |
| `server/tests/ui-preservation.test.js` | UI hash/presence/leak tests |
| `tests/ui-preservation.snapshot.json` | SHA-256 snapshot of UI files at `dc5d42d` |
| `docs/OPERATIONAL_AUDIT.md` | Full repository audit |
| `docs/INTEGRATION_STRATEGY.md` | Backend/API/UI integration sequence |
| `docs/MORNING_DECISIONS.md` | Ten owner decisions needed |

## 6. Branch and commit IDs

- **Branch:** `feature/program-operational-foundation-v1` (from `main` @ `dc5d42d`)
- **Commits:**
  - `7bbee2aba266e774c891c1f81bc72c993315e529` — backend modules, migrations, fixtures
  - `e2f055fcd376156adeb08fcd5aecc73ff9284c31` — automated tests (incl. the audit-rollback fix)
  - `5f78f2b11d70ebb94045c8b5a6baa07c072176c2` — audit, integration strategy, morning decisions
  - *(this handoff — commit ID added after push; see note below)*
- **Push / PR:** branch pushed to origin; draft PR opened, **not merged**.
  PR link and final handoff commit ID are recorded in the closing report
  to the parent agent (this file was written before the push so its
  commit ID could not be self-referenced; `git log` on the branch is
  authoritative).
- **Working tree:** clean at handoff (`git status` clean, no uncommitted work).

## 7. UI preservation

- **No interface file or rendered appearance changed.** `git diff main
  --stat` shows zero changes to `*.html` / `*.js` UI files; all changes
  are new files under `server/`, `tests/`, `docs/`.
- Enforced going forward by `server/tests/ui-preservation.test.js` +
  `tests/ui-preservation.snapshot.json` (fails loudly on any byte change
  to the six shipped UI/source files).
- Director/Coach/Athlete-Parent modes, Program Builder, Training Library,
  The Lab, Assessments, and all session-planning behaviour are intact
  (presence checks in the test suite; full audit in §2 above).

## 8. Capacity model: how 75 paying athletes fit through flexible attendance

Model (computed by `server/fixtures/generate-75-scenario.js`, output in
`server/fixtures/scenario-75-athletes.json` — arithmetic, not a promise):

- **Supply:** each cohort runs its prototype days/week (13 sessions/week
  across 7 cohorts). Per-session reservation cap = min(cohort enrollment
  cap, coaches × 6 preferred/station): YAK-A 18, YAK-B 18, YAK-C 16,
  ELL-A 18, ELL-B 16, CLE-A 14, CLE-B 5 (small group, 1 coach).
  Weekly seats = 2×(18+18+16+18+16+14) + 1×5 = **205 seats/week**.
- **Demand (planning assumption):** 75 members × 2 sessions/week =
  **150 bookings/week** (twice-weekly cadence from the prototype).
- **Result:** 205 ≥ 150 — fits at **73.2% utilization**, 55 seats/week
  headroom. Monthly revenue at full membership: 75 × $149 = **$11,175**.
- **Why flexible attendance matters:** total enrollment caps sum to 111,
  so 75 members fit inside cohort enrollment — but a member is not locked
  to one cohort's two slots. The reservation engine lets any eligible
  member book any session with a free seat, so demand spreads across all
  13 weekly sessions instead of stacking onto one cohort's nights.
- **Conditions (read before treating this as a commitment):**
  1. **3 coaches per group session.** With 1 coach/session the same
     cohorts supply only 77 seats/week and the model does *not* fit
     (2 coaches supply 149 — just short of the 150 demand).
     Who the 2nd/3rd coaches are is still open in the prototype
     (MORNING_DECISIONS #6).
  2. Members spread across sessions; if everyone wants Tuesday 5 PM in
     Yakima, that session waitlists while others sit empty — the engine
     handles that with waitlists, it does not fix it.
  3. Facility occupancy and equipment are currently unbinding in the
     model (unspecified in the prototype); setting them can only lower
     caps (MORNING_DECISIONS #7).
  4. Cohort enrollment caps still bind: a cohort cannot exceed its cap
     even if its sessions have seats — enrollment growth beyond 111 total
     needs new cohorts/sessions, not bigger sessions.

## 9. Remaining work (prioritized)

1. **Owner decisions** (`docs/MORNING_DECISIONS.md` #1–#9) — repo
   visibility, backend choice, pricing confirmation, staffing, facility
   occupancy, assessment validation, merge/deploy. Nothing below starts
   without #2 (backend) at minimum.
2. **Scratch backend + migration validation** — apply 001+002 to a scratch
   Postgres/Supabase project; run the concurrency checks against
   `reserve_seat()`; complete role-scoped RLS policies.
3. **API layer** — thin authenticated service over the engine (reserve,
   cancel, seats, attendance, capacity); the engine is transport-agnostic.
4. **Session-scheduling link** — store `capacityInput` on each scheduled
   session; flag drafts whose expected attendance exceeds the computed cap.
5. **Feature-flagged UI integration** — booking in the athlete/parent
   context first, Director capacity view second; no redesign.
6. **Data rehearsal** — map prototype state to the new schema on scratch;
   discard demo data; real enrollment starts from real sign-ups.
7. **Assessment UI integration** — coach overlay + athlete progress card
   per INTEGRATION.md steps 5–7; Smart Draft evidence behind a flag.
8. **Billing** — separate approval, provider choice, subscription mapping.
9. **Housekeeping** — delete redundant `feature/assessment-engine-v1`
   branch after merge; add a `package.json` formalising the test commands
   if the repo grows a build step (no behaviour change).

## 10. Owner decisions

See `docs/MORNING_DECISIONS.md` in full. Headlines: (1) repo is public
vs The Program non-public — make private or confirm public; (2) approve a
backend (Supabase/Postgres recommended) — none exists yet; (3) migrations
are reviewed but unexecuted against Postgres; (4) confirm $149 flat vs
the prototype's "$149 / $179"; (5) billing activation is a separate
decision — nothing activated; (6) who the 2nd/3rd coaches are — the
75-athlete model depends on it; (7) facility max-occupancy numbers;
(8) assessment battery validation before parent-facing trends or Smart
Draft use; (9) merge of this branch and (separately) any deployment;
(10) delete the redundant assessment branch after merge.
