# Handoff — Universal Athletic Assessment & 4-Week Reassessment Engine

**Date:** 2026-11-12 · **Branch:** `feature/universal-assessment-reassessment-v1`
**Base:** `feature/program-operational-foundation-v1` @ `e4da6cc` · **Status:** work complete, tests green, not merged. Migration 004 NOT applied.

## 1. Executive summary

Every athlete in The Program now has a real, standardized assessment
system behind the prototype: a universal 8-test General Athletic
Assessment (GAA v1) with written protocols, a baseline requirement
that gates development-plan finalization, a 28-day reassessment
schedule with approaching/due/overdue/deferred states, progress
calculation against baseline/previous/personal-best, and an
advisory-only Smart Draft input that can never rewrite a program on
its own. All of it is built on the existing assessment engine (now
v1.1.0, additive only) and the already-applied Supabase schema — no
existing functionality was rebuilt, no UI file was touched, and
nothing was written to the live database. The adult validation case
(a synthetic 48-year-old recreational soccer wingback) runs end to
end in tests. Full audit: `docs/ASSESSMENT_AUDIT.md`.

## 2. Existing functionality discovered and preserved

- **Assessment engine V1** (10 definitions, `generalAthlete` +
  `baseball` batteries, `result`/`change`/`asymmetry`/`interpret`/
  `generatePriorities`/`buildSession`): untouched in behavior. The
  V1 smoke test passes unchanged. Only additions: 4 new definitions
  (5-10-5 shuttle, single-leg balance L/R, 6-minute walk/run) and
  the `generalAthleticAssessment` battery.
- **Persistence adapter** (`server/assessment-store.js`): measured /
  observation / interpretation separation, derived baselines, history
  never overwritten — all preserved and extended (idempotency,
  movement observations, modified/capped flags).
- **Supabase schema** (migrations 001+002+003, applied 2026-11-12):
  22 tables, 58 policies, 10 definitions. Untouched by this mission;
  migration 004 is additive only and unapplied.
- **Prototype + Smart Draft drawer:** byte-identical. Smart Draft
  still builds drafts from builder input and requires human approval;
  this mission adds an advisory evidence input for it, not a change
  to how it works.
- **Reservation engine, capacity adapter, API, schedule-session:**
  untouched; full suite green.
- **No functionality removed.** Nothing deleted; no file removed for
  appearing unused.

## 3. New functionality actually implemented

Implemented (code + tests, on the branch — not designs):

- **`assessment-engine/assessment-engine.js` → v1.1.0** — new
  definitions `5-10-5-shuttle` (sec, lower, 2 attempts),
  `single-leg-balance-r/l` (sec, higher, 1 attempt, pair),
  `6min-walk-run` (m, higher, 1 attempt), all `retestDays: 28`;
  new battery `generalAthleticAssessment` (9 definition ids for the
  8 mission tests). All 10 V1 definitions byte-identical in behavior.
- **`server/assessment-battery.js` (GAA v1)** — the standardized
  protocol for all 8 tests: instructions, testing conditions,
  warm-up + safety, valid/invalid criteria, units + precision,
  improvement direction, maintenance bands, youth (<18) and adult
  (>=18) alternatives + accommodations. Movement assessment is
  observation-only (no direction, no score). No population norms,
  percentiles, or medical thresholds anywhere.
- **`server/reassessment.js`** — 28-day due math; statuses
  never-assessed / not-due / approaching (within 7 days) / due /
  overdue / deferred; coach reminder buckets; athlete reminders;
  baseline completeness (recorded, modified, excluded, or deferred);
  coach-approved deferrals/exclusions/modifications with validation
  (approver + reason + future date required). Derivative scheduling:
  no cron, no paid scheduler. Legacy `generalAthlete` sessions do
  not count toward the GAA baseline (documented decision, audit §4).
- **`server/baseline-gating.js`** — plan-finalization gate ONLY.
  A plan finalizes after a complete baseline, or by an explicit
  recorded coach override (reason + approver on the plan). No other
  feature is gated; there is no athlete-level block.
- **`server/progress.js`** — per-test progress: baseline, previous,
  current, personal best; absolute + percentage change (percent is
  null when the baseline is 0 — e.g. 0 push-ups — instead of an
  invented number); direction-correct improvement/maintained/
  regressed using the maintenance band; youth-growth caveat on
  under-18 records.
- **`server/smart-draft-adapter.js`** — assessment evidence mapped
  to the mission priorities (acceleration, agility, power, strength,
  muscular endurance, cardiovascular conditioning, mobility and
  movement control). Every output carries `advisoryOnly: true`,
  `requiresCoachApproval: true`, `autoRewrite: false`. A single poor
  result flags one priority at low confidence. There is no function
  in this module that writes or rewrites a plan.
- **`server/assessment-store.js` (extended)** — `meta.idempotencyKey`:
  a retried recording returns the original session
  (`idempotentReplay: true`) and inserts nothing. Movement
  assessment entries are stored as observations. Entries may carry
  `modified` / `capped` flags, stored on the result row. GAA
  sessions have their attempts validated against the protocol
  before anything is stored.
- **`server/migrations/004_assessment_reassessment.sql` (NOT
  applied)** — 5 GAA definitions (incl. observation-only movement
  assessment via a new `kind` column + relaxed direction/aggregation
  CHECKs); `assessment_schedules`, `assessment_deferrals`,
  `development_plans` (CHECK: a finalized plan must name its
  baseline session); `assessment_sessions.idempotency_key` + partial
  unique index; RLS enabled on all new tables with 003-mirroring
  policies. Postgres 15 compatible, idempotent, no destructive
  statements.
- **Adult validation case** — synthetic 48-year-old recreational
  soccer wingback (fixture `server/fixtures/synthetic-wingback-48.js`,
  clearly labelled synthetic): baseline → due in 28 days → plan
  finalization → reassessment with improvement on all 9 measured
  tests → progress + PBs + advisory output. Plus a synthetic
  12-year-old for youth-accommodation checks.

Designs / placeholders / proposed future work (NOT implemented):
the authenticated API methods for assessments (recording, reminders,
plan finalization) — same injected-auth pattern as `server/api.js`,
not yet written; wiring `PostgresStore` to the assessment store
interface; any UI integration (coach `Run assessment` overlay,
athlete progress card, dashboard reminders) — server modules only,
per the no-redesign constraint; applying migration 004; any live
verification against TheProgramOS.

## 4. Test results

Command: `node --test server/tests/*.test.js assessment-engine/assessment-engine.test.js`
(Node built-in runner, zero new dependencies.)

- **140 tests, 140 passed, 0 failed, 0 skipped.** (91 at base
  `e4da6cc`; +49 new in this mission.)
- New tests: battery protocol completeness + directions + no-norms,
  28-day due/approaching/overdue/deferred transitions, baseline
  completeness + exclusion path, plan gating (not finalizable without
  baseline; exclusion path; explicit override; refusal cases),
  duplicate-recording prevention (idempotent replay), progress in
  both directions + percentage math + zero baseline + PB tracking +
  maintenance bands + youth caveat, Smart Draft advisory-only
  behavior + priority mapping + insufficient evidence, adult
  synthetic-athlete end-to-end, youth-vs-adult accommodations,
  migration-004 SQL invariants, preservation of existing
  assessment-engine behavior (V1 smoke test unchanged).
- Two test bugs found and fixed during the run (not product bugs):
  a progress-test expectation that contradicted the maintenance
  band, and a deferral test that used a 2027 "past" date which is
  still in the future relative to the real clock. Both fixed in the
  tests; the implementation was correct in both cases.
- **Untested:** migration 004 against any Postgres (no throwaway
  local Postgres was available in this session, and live application
  is a separate owner decision); the engine against live Supabase
  via the new tables; any browser/rendered-UI check beyond the
  hash/presence tests (no UI changes were made, so there is nothing
  rendered to re-verify); real-device or production behavior
  (nothing deployed).

## 5. Files changed

This mission only, vs base `e4da6cc` (19 files, +1,939 / −11):

| File | What it is |
|---|---|
| `assessment-engine/assessment-engine.js` | v1.1.0: 4 new definitions + `generalAthleticAssessment` battery |
| `server/assessment-battery.js` | GAA v1 protocol module (8 tests) |
| `server/reassessment.js` | 28-day schedule engine, reminders, baseline completeness, deferrals |
| `server/baseline-gating.js` | Plan-finalization gate (only) |
| `server/progress.js` | Baseline/previous/PB progress calculator |
| `server/smart-draft-adapter.js` | Advisory-only Smart Draft input |
| `server/assessment-store.js` | Idempotency, movement observations, modified/capped, GAA validation |
| `server/migrations/004_assessment_reassessment.sql` | New migration (NOT applied) |
| `server/fixtures/synthetic-wingback-48.js` | Synthetic adult + youth test fixture |
| `server/tests/assessment-battery.test.js` | Protocol tests |
| `server/tests/reassessment.test.js` | Schedule + deferral tests |
| `server/tests/baseline-gating.test.js` | Gate tests |
| `server/tests/progress.test.js` | Progress tests |
| `server/tests/smart-draft-adapter.test.js` | Advisory-contract tests |
| `server/tests/adult-validation.test.js` | Synthetic wingback end-to-end |
| `server/tests/migration-004.test.js` | Migration SQL invariant tests |
| `server/tests/assessment-store.test.js` | Updated: 002+004 seed parity (was 002-only) |
| `server/tests/ui-preservation.test.js` | Comment records the intentional snapshot update |
| `tests/ui-preservation.snapshot.json` | Engine hash updated for v1.1.0 (reviewed; HTML hashes unchanged) |
| `server/README.md` | New module rows; corrected migration/test-count status lines |
| `docs/ASSESSMENT_AUDIT.md` | Audit (implemented / partial / missing, decisions, risks) |
| `docs/ASSESSMENT_REASSESSMENT_HANDOFF.md` | This file |
| `docs/MORNING_DECISIONS.md` | New §§11–12 (apply 004; merge/deploy this branch) |

## 6. Branch and commit IDs

- **Branch:** `feature/universal-assessment-reassessment-v1` (from
  `feature/program-operational-foundation-v1` @ `e4da6cc`)
- **Commits:**
  - `2a02d96f02a7cc8ea908134973d8153fb3c20c09` — Engine v1.1.0: add 5-10-5 shuttle, single-leg balance L/R, 6-min walk/run + generalAthleticAssessment battery
  - `3a871dbe47c51c28ac1666625c33bbd84508b5f7` — Add GAA battery protocol module (gaa-v1)
  - `f7da76a4a21dcb5c6e25b76058fc159b4ae4ec41` — Add 28-day reassessment engine + baseline gating for plan finalization
  - `eebd2fd56545a9681b81eedcd70c0b7d9ae853b5` — Add progress calculator + advisory-only Smart Draft adapter
  - `a16ae8a9e03f9e7b4b0a1f88b26a51a95faa9a19` — Assessment store: idempotency keys, movement-assessment observations, modified/capped flags; migration 004
  - `7c2f5662516e21b2446c271fd16f416b0bf696a9` — Fix migration-004 test regex (unique index spans two lines)
  - `bcb952e6ad5ecd8d0e86ff4befa2f00390090556` — Tests: GAA battery, reassessment, baseline gating, progress, Smart Draft adapter, adult synthetic validation, migration 004
  - `843336bbf5250db4420d383a16490453f94ef52e` — Update preservation snapshot for intentional engine v1.1.0 extension (HTML files byte-identical)
  - `0ae2597ef40caac7164632c5c4fb6256c755b3c5` — Docs: assessment audit, reassessment handoff, morning decisions 11–12, server README
  - `a43ec0e49b21ee30aead8fb96b75247196ae5ab8` — Record docs commit ID in handoff section 6
- **Push / PR:** branch pushed to origin; draft PR opened, **not merged**.
- **Working tree:** clean at handoff (`git status` clean, no uncommitted work).

## 7. UI preservation

- **No interface file or rendered appearance changed.** `git diff
  e4da6cc...HEAD` shows zero changes to `*.html` files; the only
  "UI-adjacent" change is the assessment engine's calculation
  module (new definitions, no existing definition changed) and its
  preservation-snapshot hash, updated in a reviewed commit with the
  reason recorded in the test file. All HTML files remain
  byte-identical to `dc5d42d` (verified by hash).
- Director/Coach/Athlete-Parent modes, Program Builder, Training
  Library, The Lab, Assessments, Smart Draft drawer, and all
  session-planning behavior are intact (presence checks in the test
  suite; audit §1 above).

## 8. Remaining work (prioritized)

1. **Owner decisions** (`docs/MORNING_DECISIONS.md` §§11–12) —
   apply migration 004, merge/deploy. Nothing below starts without
   the 004 decision at minimum.
2. **Apply + verify migration 004** — against TheProgramOS (or a
   scratch copy first): apply in order, verify 27 tables / 15
   definitions / new policies, run the concurrency + idempotency
   checks live, confirm the `kind` CHECK relaxation behaves.
3. **Wire `PostgresStore` to the assessment store interface** —
   insertSession/insertResult/insertDerived/listResults/listSessions
   + `findSessionByIdempotencyKey`, so recording works against live
   Supabase instead of only the dashboard SQL editor.
4. **Assessment API methods** — same injected-auth pattern as
   `server/api.js`: record session, reminders, plan finalization
   (director/coach only), athlete progress read (owner-scoped).
5. **UI integration (designed, not started)** — coach `Run
   assessment` overlay + athlete progress card + dashboard
   reminders, per INTEGRATION.md steps 5–7; behind the existing
   athlete-profile/coach surfaces, no new top-level navigation.
6. **Battery field validation** (MORNING_DECISIONS §8) — Marcus /
   coaches validate the GAA v1 protocols and timing method in the
   field before results are shown to parents as more than
   coach-recorded measurements.
7. **Smart Draft wiring** — feed the advisory priorities into the
   prototype drawer behind a flag, coach-reviewed, never automatic.
8. **First real athlete assessment** — only after 004 is applied and
   the API/UI path exists; the synthetic wingback stays a test
   fixture and is never written to a real profile.

## 9. Owner decisions

See `docs/MORNING_DECISIONS.md` §§11–12 in full. Headlines:
(11) approve applying migration 004 to TheProgramOS (additive,
reviewed, unexecuted — or direct a scratch-first apply); (12)
review/merge this branch and (separately) any deployment. Still
open from before: repo visibility (§1), $149 vs $149/$179 (§4),
billing (§5), coach staffing (§6), facility occupancy (§7),
battery validation (§8), foundation-branch merge/deploy (§9).
