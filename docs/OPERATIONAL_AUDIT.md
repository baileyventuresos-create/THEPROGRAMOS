# THE PROGRAM OS — Operational Audit (V1)

**Date:** 2026-11-11 (overnight) · **Branch:** `feature/program-operational-foundation-v1`
**Baseline:** `main` @ `dc5d42d` ("Add Assessment Engine V1 foundation", 2026-10-18)
**Scope:** full repository on `main` and `feature/assessment-engine-v1`.
No UI file was modified in this work; see §9 and `tests/ui-preservation.snapshot.json`.

## 1. What the repository actually is

A **static, client-side prototype** — not an application with a backend.

| File | Size | Role |
|---|---|---|
| `THE PROGRAM OS.html` | 633 KB, 2,757 lines | The entire OS: data, coaching engine, all views, in one file |
| `index.html` | 30 lines | Loader: fetches `THE PROGRAM OS.html`, injects the three patch scripts before `boot()`, `document.write`s the result |
| `launch60-overrides.js` | 95 lines | Patches workbook-derived game records to Launch Ready (V2.4 authorship) before boot |
| `launch60-corrections.js` | 89 lines | Corrections applied before boot |
| `field-tested-drills.js` | 152 lines | Injects field-tested / candidate drills (incl. "Pace & Tap", "Stack & Roll", "Lift & Shift", "Cone Carry", "4-Gate Chaos") |
| `assessment-engine/` | 4 files | Assessment Engine V1 (pure JS + smoke test + README + integration plan) |
| `README.md` | 2 lines | Title only |
| `.gitignore` | — | Generic Node template; no project-specific entries |

There is **no `package.json`, no build, no linter, no CI, no deployment
config, no backend, no database, and no test runner** configured in the
repo. The only test that existed is the assessment-engine smoke test
(`node assessment-engine/assessment-engine.test.js`), which passes.
There are **zero network calls** in the prototype (`fetch(` count: 0 in
`THE PROGRAM OS.html`; the only fetch is `index.html` loading the local
HTML file). No Supabase, no Stripe, no API of any kind.

## 2. What is implemented (verified by reading the code)

**Modes / surfaces (all present, all preserved):** Director Mode,
Coach Mode (incl. live session + rotation + report submit), Athlete/Parent
Mode (mobile-first phone view), Program Builder, Training Library
(130 distinct `TP2-xxx` game records), The Lab (8 seed candidates,
stages CANDIDATE → RETIRED), Assessments view (`vAssess`), plus
Dashboard, Sessions, Cohorts, Athletes, Coaches, Locations, Equipment,
Reports, Audit, Settings views (23 `v*` render functions).

**Session-planning engine (the core asset — do not replace):**
- `draftSession()` — picks games per phase/role through the 7-stage
  `checkGame()` gate (Launch Ready/coach test → phase fit → age → group
  size → equipment → space → not-already-used), ranks with `rankGame()`
  (emphasis, fit, variety, recent use, field feedback, open issues).
- `architecture()` / `buildConfigs()` / `slotMath()` — station layouts:
  stations at once never exceed available coaches; preferred station size
  **4–6** (`STATION_DEFAULT`); BUILD slot minutes 5–14 (`MIN_SLOT` 8
  preferred, `MAX_SLOT` 14); 3–6 rounds; one-group path for ≤5 athletes.
- `coachesFor()` — small-group format = 1 coach, otherwise **3 coaches
  (assumption)**.
- `sessionWarnings()` — CRIT when stations at once > coaches; "self-directed
  stations are not designed or approved"; COMPETE/IGNITE multi-field warnings.
- Human approval is structural: plans carry `by: 'Draft → approved by
  Marcus'`; the DECISIONS register locks "Generated sessions are drafts.
  A human approves every session."
- `rollingEmphasis()` / `cohortHist()` / `exposureOf()` — development
  history drives emphasis from programmed exposure; individual attendance
  gaps are recorded, explicitly **not** acted on ("Individual planning
  NEEDS DEFINITION").
- Equipment: canonical schema (game → item → quantity → basis →
  required → substitute), `equipCheck()` / `qtyFor()` with bases
  session/field/station/athlete/pair/team; phantom-equipment detection.

**Cohorts (existing definitions — the reservation model builds on these):**
7 cohorts, enrollment caps 20/20/16/20/16/14/5 (total **111**), demo
enrolled 16/14/9/14/11/12/4 (total **80**, generated data). Locations
Yakima (rented middle-school gym), Ellensburg (shared facility),
Cle Elum (community gym), each with spaces (dimensions only — **no max
occupancy recorded**) and equipment inventory counts. Coaches: Marcus
(Director, CLE), Kayla Ostrander (Lead, YAK), Jordan Reyes (ELL),
Tyler Haugen (Sub, ELL/CLE, Onboarding). Templates: p60/p90/p45/sg45/pp50.

**Attendance tracking (implemented, demo-grade):** `buildWorld()` generates
a schedule 2027-04-19 → 2027-06-18 for every cohort's days; past sessions
get `present` (78–98% of cohort size, random) and a random `attended[]`
subset; Coach Mode has per-athlete present toggles and a report submit
that fans attendance/ratings/flags out to athlete records, game field
records, and the Lab inbox. Athlete profiles show attendance vs. cohort
programming exposure gaps.

**Athlete development history (implemented, demo-grade):** `athMetrics()`
generates per-athlete JAN/MAR/MAY series (10-yd sprint, broad jump,
5-10-5, balance) from seeded randomness (one hand-authored athlete,
Ava Martinez); `TESTS` records mark every test NEEDS VALIDATION or
NEEDS DEFINITION, with method notes (hand-timing noise, no reaction
measure, etc.). No ratings, no XP, no coins — by design.

**Browser persistence:** `localStorage` key `tp_os_v24`; `save()` persists
the whole state minus builder/coach; `load()` restores it. The code itself
labels this "per-viewer convenience only". There is no auth, no accounts,
no server sync.

**Assessment engine (branch `feature/assessment-engine-v1`):**
4 commits (2026-10-18) adding the engine, docs, smoke tests, integration
plan. **Finding: the branch is already fully merged in content** — `main`
head `dc5d42d` is a squash commit containing the same 4 files byte-for-byte
(`git diff main origin/feature/assessment-engine-v1 -- assessment-engine/`
is empty). The branch can be deleted after this work; no merge is needed.
The engine is pure and UI-agnostic: 10 definitions (7 General Athlete +
3 Baseball), best-result aggregation, baseline/trend, bilateral asymmetry
(≥15% = "monitor", labelled a product signal, not a diagnosis),
`buildSession()`, `generatePriorities()` evidence for Smart Draft. It has
**no dependency on the prototype HTML and no persistence** — that gap is
what `server/assessment-store.js` now closes (see §7).

**Training-library data and overrides:** game records are workbook-derived
(V2.3) with Phase Fit structured data, equipment schema rows, coach-test
(`CARD`) reads, and issue/audit systems (`autoIssues`,
`systemicFindings`). The three patch scripts are load-order sensitive:
`index.html` injects overrides → corrections → field-tested drills before
`boot()`. The overrides file mutates the "immutable" V2.3 objects in place
by design ("source decisions remain visible/auditable").

## 3. What is simulated or demo-only

- **All athletes, names, metrics, attendance, feedback, and history are
  generated demo data** (seeded RNG; scenario date is fixed at Tue Jun 8,
  2027; the DECISIONS register and several views carry explicit
  DEMO DATA labels). Nothing is a real record.
- The schedule, plans, feedback, and Lab test reports are generated at
  boot by `buildWorld()`; a "demo reset" wipes localStorage and rebuilds.
- Assessment test values in the Athlete view are synthetic; the prototype
  itself says "THE PROGRAM does not collect any of these measurements today."
- Coach staffing of 3 per group session is an **assumption**, flagged
  NEEDS DEFINITION ("who the second and third coaches are at launch —
  hired, parent volunteers, Marcus — is open").

## 4. What is incomplete or missing (the reason this work exists)

1. **No backend, no database, no auth, no accounts.** No users/roles,
   no parent/guardian relationships, no memberships, no reservations,
   no waitlists, no payments. Settings view states it plainly: "Not here
   on purpose: revenue, billing and enrollment funnels. Out of scope
   until the product works."
2. **No reservations or capacity enforcement of any kind.** A cohort's
   `cap` is an enrollment number; nothing books a seat, nothing stops
   overbooking, nothing waitlists. Flexible attendance (members booking
   any eligible session) is not modelled anywhere.
3. **No membership model.** The only pricing anywhere is one DECISIONS
   line: "Ages approx. 8–18 · launch target January 2027 · markets
   Yakima, Ellensburg, Cle Elum · **$149 / $179 memberships**" (ASSUMPTION).
   The overnight brief fixes membership at **$149/athlete/month** — the
   $179 tier in that line is a discrepancy, recorded as an owner decision
   (docs/MORNING_DECISIONS.md).
4. **No facility occupancy.** Spaces have dimensions, not max athletes;
   capacity cannot be derived from the facility until the operator sets it.
5. **Assessment engine has no persistence** and is not wired into any
   athlete profile (its own INTEGRATION.md lists this as step 3–4 of 8).
6. **No deployment story.** No hosting config; the app only runs by
   opening `index.html` (which fetches the sibling HTML file — needs a
   static server or file access, not a deployed pipeline).
7. **No tests beyond the assessment smoke test**, no lint, no CI.
8. **Open NEEDS DEFINITION items in the prototype** that the reservation
   model touches: readiness (how a coach decides an athlete/group is ready
   for PRESSURE or CHAOS), coach permissions, progression across weeks,
   how individual attendance gaps feed athlete plans, cohort moves for
   non-age reasons, injury/restriction storage and visibility, growth and
   maturation recording.

## 5. Risks

- **Public repository.** `THEPROGRAMOS` is PUBLIC on GitHub while The
  Program is non-public (known flag since 2026-11-07). The prototype
  contains no real athlete data today, but any real record committed here
  would be public. Visibility change is an owner decision; do not change
  it unilaterally. (docs/MORNING_DECISIONS.md #1.)
- **Demo data looks real.** 80 named athletes with attendance and
  measurements could be mistaken for real minors' data. It is seeded RNG
  output — but nothing in the repo says so except in-app DEMO DATA labels.
- **localStorage as the only persistence** means any future real record
  stored there would be device-local, unencrypted, and un-auditable.
  Real athlete data must never go there.
- **Load-order fragility:** the app depends on `index.html` string-splicing
  three scripts before `boot();`. A rename or reorder silently breaks boot.
- **No concurrency story** existed before this work — the first multi-user
  deployment would have overbooked by construction. (Now addressed in
  `server/`, not in the UI.)
- **Single-file scale:** 633 KB / 2,757 lines with data, logic, and views
  interleaved. The overnight approach (additive backend modules, no
  rewrite) is the correct one; a rewrite would risk the coaching logic.
- **Migrations are unvalidated against PostgreSQL** (no `psql` in this
  environment and no project exists). They are version-controlled and
  reviewed, but must be applied to a scratch database and exercised
  before any real use. (docs/MORNING_DECISIONS.md #3.)

## 6. Dependencies

- Runtime: any static file server (or file open) for the prototype;
  Node ≥22.5 for the new server modules/tests (`node:sqlite` built in).
- Zero npm dependencies in the new code (deliberate: no install step,
  no supply chain for an overnight foundation).
- The assessment engine is dependency-free and unchanged.

## 7. Recommended architecture (what was built, and what comes next)

**Built this night (see `server/README.md`):**
- `server/session-capacity.js` — per-session cap derived from the
  prototype's own rules (coaches × preferred 4–6/station, template BUILD
  minutes, cohort cap, facility occupancy when set, equipment). No
  universal limit. Flags infeasible sessions; never auto-raises capacity.
- `server/reservation-engine.js` + `reservation-stores.js` (Memory +
  SQLite) — reservations, cancellations, waitlist + auto-promotion with
  eligibility re-check, duplicate/conflict/coach/facility guards,
  attendance + reconciliation, audit trail. Concurrency enforced by a
  per-session mutex **and** store transactions.
- `server/migrations/001` + `002` — PostgreSQL schema for the full
  operational model (users/roles, guardians, athletes, memberships,
  locations/spaces, coaches/availability, cohorts/enrollments, templates,
  sessions, reservations, waitlists, attendance, audit events,
  assessments) with `reserve_seat()` (row lock + capacity re-check +
  partial unique index) and RLS enabled on athlete tables.
- `server/assessment-store.js` — persistence adapter preserving the
  measured / observation / interpretation separation; derived baselines.
- Tests: 47 passing (46 new + the pre-existing assessment smoke test).

**Next (not built — needs owner decisions first):**
1. Owner picks the backend (recommended: Supabase/PostgreSQL — see
   `docs/INTEGRATION_STRATEGY.md`) and a hosting target; apply migrations
   to a **scratch** project and run the test suite against it.
2. Thin authenticated API in front of the engine (the engine is
   transport-agnostic by design); role-scoped RLS policies completed.
3. Read-only adapter from the prototype's generated state to the new
   schema for a migration rehearsal — **no live import of demo data as
   real records** (demo athletes are fictional).
4. UI integration behind a feature flag, in the athlete context only
   (per the assessment INTEGRATION.md pattern): session booking from the
   athlete/parent view; Director capacity view. UI files themselves stay
   untouched until that work is separately approved.
5. Billing only after the membership decision is confirmed — Stripe or
   equivalent is a separate owner approval; nothing in this work activates it.

## 8. Preservation baseline

- UI snapshot: `tests/ui-preservation.snapshot.json` (SHA-256 of the six
  shipped UI/source files at `main` @ `dc5d42d`).
- `server/tests/ui-preservation.test.js` fails the suite if any of those
  files changes byte-for-byte, and asserts the modes/surfaces and the
  absence of backend/billing code in the HTML.
- All 47 tests pass at handoff (see docs/OVERNIGHT_HANDOFF.md §4).

## 9. Files changed by this work

None of the pre-existing files were modified. All new files live under
`server/`, `tests/`, and `docs/`. Full list in docs/OVERNIGHT_HANDOFF.md §5.
