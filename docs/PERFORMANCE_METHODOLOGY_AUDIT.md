# THE PROGRAM OS — Additive Athletic Performance Methodology Audit

**Date:** 2026-11-15
**Mission:** Evaluate how to integrate a comprehensive, sport-agnostic athletic
performance methodology (six integrated training qualities) into The Program
**without modifying or disrupting any existing functionality.**
**Scope:** READ-ONLY discovery and planning. No code, migration, UI, merge,
deploy, or production-data change was made in this audit.
**Branch inspected:** `feature/universal-assessment-reassessment-v1`, head
`fd3678d` (tree clean). Test baseline re-run for this audit: **250/250 pass,
0 fail** (`npm test`).
**Backend:** Supabase project TheProgramOS (`rkgdwqgmldznczikrjip`) is the sole
backend (Marcus decision, final 2026-11-12). Migrations 001–005 applied +
verified live (26 tables / 15 definitions / 72 policies / 0 rows). Neon is
unused and untouched.

## The methodology under evaluation

Six **integrated training qualities**, not separate sports or standalone
programs:

1. **M1** — Linear speed and acceleration
2. **M2** — Multidirectional movement and reactive agility
3. **M3** — Plyometrics and explosive power
4. **M4** — Strength and stability
5. **M5** — Movement competency and mobility
6. **M6** — Energy-system development and conditioning

## Headline findings

1. **THE PROGRAM OS already has a real drill library of its own — 130
   coach-led movement games (TP2-001–TP2-130), embedded in the prototype
   HTML.** It is a *game* library (constraints-led play), not an isolated
   exercise/drill list. There is **no drill/exercise table in the
   database** and no server-side drill store. (Not Strike Zoners: its
   455 drills, Daily 100, and Player Passport live in a different repo
   and play no part in this audit.)
2. **Coverage is uneven and coarse.** The games carry Primary/Secondary
   Quality tags, so every modality is *touched* — but only M2 (reactive
   agility / change of direction) is deeply covered. M3 (plyometrics),
   M4 (strength), and M6 (conditioning) are thin: 9, 8, and 6
   primary-quality games respectively, all play-based, with **no
   structured dose anywhere** (no sets, reps, distances, intensity, or
   recovery fields — dose exists only in prose).
3. **There is no session-generation or prescription system to disrupt —
   and nothing to plug into yet.** The server has no code that generates
   session content and no recommendation/prescription logic. The only
   recommendation-like code is `smart-draft-adapter.js`, which is
   advisory-only by construction and writes nothing. The prototype HTML
   does contain a real game-selection engine (`draftSession` /
   `checkGame` / `rankGame` / `pickBuild`), but it is prototype-only,
   gated to Launch Ready games, and only 38 of 130 games carry the
   phase-fit data it consumes.
4. **The smallest viable extension is metadata + shadow mode, not a new
   program.** Five new tables (plus one lookup), all additive, all
   referencing existing records — plus a shadow-mode recommendation log
   that records outputs without ever writing to a plan, session, or
   reservation. No existing table, column, policy, workflow, or test
   needs to change.
5. **The binding constraint is not engineering — it is evidence.**
   The GAA battery is unvalidated in the field (decision §8), there are
   no validated thresholds, and no assessment maps to strength at all.
   Any recommendation engine must therefore stay in shadow mode behind
   coach oversight until field validation exists. That is a decision
   sequence, not a build sequence.

---

## 1. Current architecture inventory

### 1.1 Repository shape

| Area | Path | What it is |
|---|---|---|
| Prototype app (the product surface) | `THE PROGRAM OS.html` (2,752 lines) | Static single-file app: UI, game library (`TP_DATA`), session builder / Smart Draft prototype (`draftSession`, `checkGame`, `rankGame`, `pickBuild`, `rollingEmphasis`), demo data, Lab proposals |
| App entry | `index.html` (30 lines) | Loads the prototype + assessment scripts (`assessment-ui.js`, `assessment-client.js`) before `boot()`; applies `launch60-overrides.js`, `launch60-corrections.js`, `field-tested-drills.js` |
| Assessment engine (calculations) | `assessment-engine/assessment-engine.js` (v1.1.0) | Pure functions: 14 definitions, 3 batteries, `result/change/asymmetry/interpret/generatePriorities/buildSession`. No production state mutation |
| Assessment server modules | `server/assessment-workflow.js`, `assessment-api.js`, `assessment-access.js`, `assessment-store.js`, `assessment-battery.js`, `baseline-gating.js`, `progress.js`, `reassessment.js`, `smart-draft-adapter.js` | Full coach workflow, authenticated API, RLS-shaped access, persistence, GAA protocols, baseline gating, progress, 28-day scheduling, advisory priorities |
| Operations server modules | `server/session-capacity.js`, `reservation-engine.js`, `reservation-stores.js`, `schedule-session.js`, `postgres-store.js`, `api.js` | Capacity computation, reservations/waitlist/attendance, session scheduling (capacity only), Postgres store, reservation API |
| Dev server | `server/dev-server.js` | Localhost-only static server + `POST /api/assessments` dispatch; synthetic data; memory stores |
| Edge Function (UNDEPLOYED) | `supabase/functions/assessment-api/` (`index.ts`, `api.ts`, `directory.ts`, `store.ts`, `workflow.ts`, `build.mjs`, `entry.mjs`) | Mirrors `server/assessment-api.js`; `verify_jwt = true`; `GET …/battery` route; anon key only, no service role |
| Assessment UI | `assessment-ui/assessment-ui.js`, `assessment-client.js` | Live Assessments section, athlete profiles, run form, history/PBs, deferral form, plan controls, dev-only role switcher, idempotent-retry client |
| Migrations | `server/migrations/001–005` | 001 foundation (18 tables), 002 assessment persistence (+4), 003 auth/RLS (+0 tables, 58 policies), 004 reassessment (+4), 005 unified athlete (+0 tables, 2 columns) |
| Tests | `server/tests/*.test.js` + `assessment-engine/assessment-engine.test.js` | 250 tests, 250 pass, 0 fail (re-run for this audit) |
| Docs | `docs/MORNING_DECISIONS.md` (§§1–16), `docs/RELEASE_READINESS.md`, `docs/ASSESSMENT_INTEGRATION_COMPLETION.md`, `docs/OPERATIONAL_AUDIT.md`, `docs/INTEGRATION_STRATEGY.md`, `docs/PHASE4_TEST_REPORT.md` | Decisions, release state, completion record |

### 1.2 Athlete assessments and results — EXISTS, complete

- **Engine:** `assessment-engine/assessment-engine.js` — 14 definitions
  (see §2.1), 3 batteries (`generalAthlete` 7 ids,
  `generalAthleticAssessment` 9 ids, `baseball` 3 ids).
- **Protocols:** `server/assessment-battery.js` — GAA v1 (`gaa-v1`,
  `RETEST_DAYS = 28`): 8 tests / 9 definition ids, each with
  instructions, conditions, warm-up, safety, valid/invalid criteria,
  youth/adult alternatives + accommodations, caps (side plank 120s,
  balance 60s), maintenance bands. No population norms, percentiles,
  rankings, or medical thresholds anywhere (deliberate).
- **Workflow:** `server/assessment-workflow.js` (446 lines) — select
  athlete, start, record (incl. modified/capped), save/resume drafts,
  complete + baseline, history + PBs, compare, due dates,
  reassess/defer, plan readiness + finalize (baseline or recorded
  override only).
- **API:** `server/assessment-api.js` — 13 methods (`listAthletes`,
  `startAssessment`, `recordAttempts`, `getDraft`, `discardDraft`,
  `completeAssessment`, `athleteAssessmentView`, `coachDashboard`,
  `recordDeferral`, `planReadiness`, `createPlan`, `finalizePlan`,
  `advisoryPriorities`); role table in `server/assessment-access.js`
  (director/coach/parent/athlete scoping; client-supplied actor ignored).
- **Tables:** `assessment_definitions` (seeded 10 V1 + 5 GAA in 004;
  `kind` measured/observation, `direction` nullable, `aggregation`
  incl. `none`), `assessment_sessions` (idempotency key + partial
  unique index), `assessment_results` (`UNIQUE (session_id,
  assessment_id)`, `modified`/`capped` BOOLEAN from 005),
  `assessment_derived_records` (baselines, trends, asymmetries as
  derived records with mandatory caveats), `assessment_schedules`
  (`next_due_at` = last + 28d; statuses never-assessed / not-due /
  approaching / due / overdue / deferred), `assessment_deferrals`
  (deferral / exclusion / modification, coach-approved, reason
  required), `assessment_drafts` (coach working state; never a
  baseline).
- **Progression:** `server/progress.js` (baseline / previous / PB,
  direction-correct, zero-baseline safe, maintenance bands, under-18
  youth-growth caveat); `server/reassessment.js` (pure/derived, no
  cron: `nextDueDate`, `dueStatus`, `baselineStatus`,
  `reassessmentReminders`, `validateDeferral`/`recordDeferral`);
  `server/baseline-gating.js` (`GATE_SCOPE =
  'plan-finalization-only'`).

### 1.3 Drill storage and classification — EXISTS (prototype-embedded only)

- **Canonical library:** `THE PROGRAM OS.html:402`, `window.TP_DATA` —
  130 games, TP2-001–TP2-130, each a 31-column row: ID, Game, Category,
  Primary Quality, Secondary Qualities, Age Range, Group Size,
  Duration, Equipment, Athletic Problem, Setup, Quick Explainer,
  Score/Win, Cue 1–3, Build 1–4 (LEARN → COMPETE → PRESSURE → CHAOS),
  Regression, Progression, Coach Watches, Safety/Guardrail, Value
  Filter, Filter Rationale, Origin, Source/Inspiration, Primary/Secondary
  Source URL, Status. All 130 have stable IDs (`GI` object keys),
  referenced by session blocks, feedback, audit issues, Launch 60.
- **Patches:** `launch60-corrections.js` (rewrites 4 cards, retires 2
  into TP2-042), `launch60-overrides.js` (authors 3 V2.4 cards, marks
  ready, computes `LAUNCH60_STATUS`), `field-tested-drills.js` (5
  authored cards — **currently dead code**: an ID-collision guard
  returns from the whole IIFE because TP2-068–072 are already taken;
  contributes 0 drills — see §3.5).
- **Supporting data in `TP_DATA`:** `D.launch` (60-row Launch 60
  roster), `D.phasefit` (phase-fit records for **38 games only**),
  `D.eqs` / `D.eqsV22` (equipment tables, 134/145 rows), `LAB_SEED`
  (8 candidate proposals, not library entries), governance tables
  (`standard` 40 rows, `crosswalk` 41, `method` 13).
- **Database: NO drill/exercise/session-content table exists.**
  Verified by grep across all migrations and `server/*.js`: zero hits
  for "drill". `session_templates.phases` holds phase *minutes* only;
  `training_sessions` holds only an opaque `plan_id TEXT` pointer.
  There is nothing in Supabase for a TP2- ID to reference.

### 1.4 Training-session generation and planning — PARTIAL (prototype only; server: capacity only)

- **Prototype (HTML):** `draftSession(opt)` (line 971) builds a session
  from template + athletes + age band + inventory + location + cohort +
  date + emphasis (default `rollingEmphasis`, line 892) + coaches;
  `checkGame(g, blk, total, o)` (line 932, 7-stage eligibility gate:
  Launch Ready + coach test → phase/role fit → age → group size →
  equipment → space/wall → not already used); `rankGame()` (line 948:
  emphasis match, phase fit, diversity, COMPETE overlap, recency,
  coach feedback, audit issues, small random tiebreak);
  `pickBuild()` (line 912: LEARN/COMPETE/PRESSURE/CHAOS, max one CHAOS
  per session); `PHASES` (ARRIVE & PLAY, IGNITE, BUILD, COMPETE,
  RESET, CLOSE) and `TEMPLATE_SEED` (line 756) → `architecture()`
  (line 797) builds phase/role blocks (BUILD roles MOVE/SOLVE/CONTROL).
  Human override via builder picker (Launch Ready only) and REPLACE GAME.
- **Server:** `server/schedule-session.js` — `scheduleSession(draft)`
  is a **pure function, no DB write**. It **throws unless
  `draft.planApprovedBy` is non-empty** ("sessions are never
  auto-approved"). It derives capacity from the draft and returns the
  `training_sessions` row payload. It generates **no content**.
  `server/session-capacity.js` — `computeSessionCapacity(input)`
  (preferred station size 4–6; `preferredCap = coaches × 6`; hard cap
  from game group max; `effectiveCap = min(...)`; 0 if coaches < 1 or
  no BUILD minutes) and `layoutFor`/`slotMath` (stations ≤ coaches,
  BUILD split 3–6 rounds of 5–14 min). It *inverts* the prototype's
  `buildConfigs` to answer "largest n that fits a coached layout".
- **A "training session" in this codebase is a time-slot/capacity
  reservation** (cohort + location + space + template + date/start/
  duration + computed cap + `plan_id` + `plan_approved_by` +
  `emphasis TEXT[]`). It contains no drills, exercises, sets, or phase
  activities.
- **Development plans:** `development_plans` (004) is a **status/gate
  record only** — `id, athlete_id, status (draft/finalized),
  baseline_session_id, finalized_by/at, override_reason,
  override_approved_by`. **No content columns**: no exercises, drills,
  sets, reps, or program text. `createPlan()` (`assessment-workflow.js:410–416`)
  creates an empty draft; `finalizePlan()` only flips draft → finalized.

### 1.5 Cohort scheduling and attendance — EXISTS, complete

- **Tables:** `locations` (YAK/ELL/CLE), `training_spaces`
  (`max_athletes` operator-supplied, never inferred), `coaches`,
  `coach_availability`, `cohorts` (`age_min/max`, `days`, `start_time`,
  `enrollment_cap`, `format`, `emphasis TEXT[]`, `head_coach_id`),
  `cohort_enrollments` (**source of truth** for eligibility;
  `athletes.eligible_cohort_ids` is a denormalized snapshot, never
  read for decisions), `session_templates` (p60/p90/p45/sg45/pp50),
  `training_sessions`, `session_coaches`, `reservations` (partial
  unique index: one confirmed row per athlete+session), `waitlist_entries`,
  `attendance_records` (`attended/late/no_show/excused`; `UNIQUE
  (session_id, athlete_id)`), `operational_audit_events` (append-only).
- **Engine:** `server/reservation-engine.js` (`ReservationEngine`:
  per-session mutex + store transaction; eligibility = membership
  active/trialing covering the date + age band + enrollment +
  `athlete.restrictions` vs session emphasis; duplicate/overlap/coach-
  availability/facility-conflict/capacity checks; waitlist promotion
  re-checks eligibility; walk-ins recorded explicitly, never silently
  become reservations; `reconcileAttendance`, `availableSeats`).
- **Atomic gate:** `reserve_seat(p_session_id, p_athlete_id, p_actor)`
  (001:274, plpgsql, `SELECT … FOR UPDATE`, duplicate guard, cap guard,
  waitlist-or-confirm + audit in one transaction).
- **Stores:** `server/reservation-stores.js` (`MemoryStore`,
  `SqliteStore` — local stand-ins, "Neither store is production");
  `server/postgres-store.js` (`PostgresStore` on `pg` Pool; covers the
  reservation-engine domain only). Known documented duplication: a
  Postgres reservation gets two `RESERVED` audit rows (audit noise,
  not a correctness problem).
- **API:** `server/api.js` — exactly 7 methods (`reserve`, `cancel`,
  `availableSeats`, `recordAttendance`, `reconcileAttendance`,
  `capacityFor`, `promoteWaitlist`), injected-auth-first, role table
  `ALLOWED`. No HTTP layer for reservations exists in `server/`; the
  dev server serves the prototype statically + `POST /api/assessments`.

### 1.6 Athlete-specific training recommendations — DOES NOT EXIST (advisory evidence ranking only)

- **Server:** the grep `recommend|prescri|workout.*plan|training.*plan|
  session.*plan` across `server/*.js` returns only comments and the
  Smart Draft caveat text. **There is no `recommend*` or `prescri*`
  function, no workout-plan generator, and no prescription logic
  anywhere in `server/*.js`.**
- **`server/smart-draft-adapter.js`** is the only recommendation-like
  code, and it is **advisory-only by construction**:
  - Input: `developmentPriorities({athleteId, progressByTest, goals})`
    / `prioritiesFromResults(athleteId, resultRows, {age, goals})`.
  - Mapping: 14 assessment ids → 7 priorities
    (`ASSESSMENT_TO_PRIORITY`): 10yd-sprint→acceleration,
    broad-jump/scoops/throw/exit-velo→power, 5-10-5-shuttle→agility,
    push-ups/side-planks→muscular_endurance, single-leg-balance→
    mobility_movement_control, 6min-walk-run→cardiovascular_conditioning.
    **`strength` exists in `PRIORITY_NAMES` but no assessment maps to
    it** — modality M4 has no assessment signal at all.
  - Logic: only *declines* vs baseline create need; improvements create
    nothing; a lone baseline creates no evidence
    (`insufficientEvidence`); single-source = `confidence: 'low'`,
    multi-source = `'moderate'`; ranked by `evidenceScore`.
  - Output: `{athleteId, advisoryOnly: true, requiresCoachApproval:
    true, autoRewrite: false, caveat, priorities[], insufficientEvidence}`.
    **No function writes, edits, or applies a training plan.**
  - Callers (verified): `assessment-workflow.js:365` (inside
    `athleteAssessmentView`, as `advisory:`) and `:441`
    (`advisoryPriorities()`), exposed via `assessment-api.js:152`
    and bundled into the Edge Function. **No caller feeds its output
    into any plan, session, or reservation write.**
- **Prototype:** the HTML Smart Draft *does* pick games
  (`draftSession`/`rankGame`, §1.4), but it is prototype-only and its
  "recommendations" are game selections for a session draft that still
  requires human approval (`schedule-session.js` refuses a draft
  without `planApprovedBy`). The server-side "Smart Draft" and the
  prototype "Smart Draft" are different things sharing a name — see
  §7.3.
- **Memberships/pricing:** `memberships` table (`price_cents INT NOT
  NULL DEFAULT 14900` = $149/athlete/month, owner-fixed; statuses
  active/trialing/past_due/paused/expired/cancelled). **No billing,
  charge, payment, or Stripe table exists anywhere.**

### 1.7 What does not exist (explicit)

No drill/exercise table; no session-content table; no workout-plan
generator; no prescription/recommendation engine; no training-load,
readiness, or wellness table; no normative/threshold table; no billing
tables; no feature-flag table; no recommendation-output table; no
HTTP layer for reservations; no cron/scheduler (reassessment is
pure/derived).

---

## 2. Six-modality coverage matrix

### 2.1 Assessment coverage (what the GAA battery measures)

The engine holds 14 definitions; the GAA battery uses 9 of them (8
tests). The other 5 are legacy: `rotational-scoop-r/l` (rotational
power — in the legacy `generalAthlete` battery, not GAA) and the
baseball module (`throw-velo`, `throw-accuracy`, `exit-velo` —
sport-specific, excluded from any sport-agnostic mapping).

| Modality | GAA test(s) | Engine domain(s) | Verdict |
|---|---|---|---|
| M1 Linear speed / acceleration | 10-Yard Sprint | `acceleration` | **Direct.** One test, 3 attempts, best. |
| M2 Multidirectional / reactive agility | 5-10-5 Shuttle | `agility` | **Partial.** Pre-planned COD only. No reactive/choice test exists; the prototype's own `TESTS` list marks the reaction test `NEEDS DEFINITION` ("No field test chosen"). |
| M3 Plyometrics / explosive power | Standing Broad Jump | `horizontal_power` (engine) / `power` (battery) | **Partial.** One horizontal jump. No vertical jump, no reactive/elastic test, no repeated-jump test. Rotational scoop is legacy-only. |
| M4 Strength / stability | Push-Ups (muscular endurance); Side Plank L/R (trunk endurance) | `relative_strength`, `trunk_control` (engine) / `muscular_endurance` (battery) | **Partial — endurance, not strength.** No maximal or submaximal strength measure. No assessment maps to the `strength` priority (§1.6). |
| M5 Movement competency / mobility | Single-Leg Balance L/R; Movement Assessment (observation-only, 5 patterns, no score) | `balance`, `mobility_movement_control` | **Partial.** Balance measured; mobility observed only, never scored. No flexibility/ROM measure. |
| M6 Energy-system / conditioning | 6-Minute Walk/Run | `cardiovascular` (engine) / `cardiovascular_conditioning` (battery) | **Partial.** Submaximal aerobic distance only. No anaerobic, repeated-sprint, or interval measure. |

**Assessment-to-modality summary:** 2 of 6 modalities have a direct test
(M1; M3 via broad jump with caveats). 4 of 6 are partial. 0 have
validated norms or thresholds — the battery is unvalidated in the field
(decision §8) and athletes are compared only to their own baseline/PB.

### 2.2 Training-content coverage (the 130-game library)

Counting method: parsed `window.TP_DATA` (`THE PROGRAM OS.html:402`) —
130 rows, 130 distinct IDs, zero duplicates; Primary Quality is one
value per game; Secondary Qualities are a uniform 2–3 item list per
category. "Primary" = the game's designed quality. "Touch" = the
quality appears in the game's Primary or Secondary list (a coarse tag,
not a dosed protocol — see the verdict column).

| Modality | Primary-quality games | Touch (primary or secondary) | Verdict |
|---|---|---|---|
| M1 Linear speed / acceleration | **2** — `Acceleration` (TP2-034 Bound & Break, TP2-087 Get-Up Race) | **71** (secondary Acceleration in Chase 15, Reaction 12, Invasion 10, Striking 8, Strength 8, Coordination 8, Competitive 8) | **Thin at the core, broad at the edges.** Only 2 games are *designed* for acceleration; 69 more merely tag it. No linear sprint drills, no acceleration technique progressions, no start mechanics. |
| M2 Multidirectional / reactive agility | **30** — `Reaction & Decision` 20 + `Deceleration & COD` 10 | **122** (nearly every category tags Reaction & Decision or Decel & COD; only Cooperative Challenge's 8 games touch neither) | **Strongest modality.** Genuinely decision-based games (chase, invasion, reaction). Gap is measurement, not content: no reactive *test* (§2.1). |
| M3 Plyometrics / explosive power | **9** — `Jump & Land` | **9** (no category lists Power as a secondary quality) | **Thin.** Jump/land play only. No structured plyo dose (no ground-contact counts, box heights, landing volume), no vertical/reactive power, no power progressions. The one horizontal-power card (Cone Carry, field-tested-drills.js) is orphaned (§3.5). |
| M4 Strength / stability | **15** — `Strength Through Play` 8 + `Balance & Body Control` 7 | **24** strength-touch (primary 8 + secondary in Balance 8 + Cooperative 8); **49** stability-touch (Balance primary 7 + Balance as secondary in Jump 10, Strength 8, Coordination 8, Obstacle 8, Cooperative 8) | **Thin and constrained.** Bodyweight play only; safety text forbids maximal resistance ("No maximal resistance, neck contact…"). 3 of the 8 strength games are in Safety Review (TP2-092, 093, 098). No loaded strength, no sets/load/reps structure, no strength assessment signal. |
| M5 Movement competency / mobility | **22** — `Coordination & Rhythm` 15 + `Balance & Body Control` 7 | **~55** (Coordination/Balance as secondary across Jump, Throw, Target, Balance, Strength, Obstacle, Cooperative) | **Coordination covered; mobility absent.** No mobility/flexibility content, no joint-specific ROM work, no corrective content. The Movement Assessment observes 5 patterns but prescribes nothing. |
| M6 Energy-system / conditioning | **6** — `Competitive Conditioning` (+2 Decel & COD in-category) | **6** (no category lists conditioning as a secondary quality) | **Weakest modality.** 6 games, no intervals, no HR zones, no work:rest structure, no aerobic/anaerobic differentiation. The one dosed conditioning card (4-Gate Chaos: 4×90-sec rounds, 45–60-sec recovery, field-tested 2026-10-12) is orphaned (§3.5). |

Primary-quality totals (130): Hand-Eye & Object Control 28 · Spatial
Awareness 25 · Reaction & Decision 20 · Coordination & Rhythm 15 ·
Deceleration & COD 10 · Jump & Land 9 · Strength Through Play 8 ·
Balance & Body Control 7 · Competitive Conditioning 6 · Acceleration 2.
Age ranges are per-category, not per-game (8–18 for most; 9–18 for
Invasion/Territory, Net/Wall, Competitive Conditioning; 10–18 for
Strength Through Play). By tier (post-patch, as loaded): Launch Ready
39 · Priority Authoring 20 · Backlog 63 · Safety Review 5 · Retired 3.
Launch 60 roster: 60 rows (38 Launch Ready + 22 Priority Authoring).

### 2.3 Multi-modality games

Because Secondary Qualities are uniform per category, multi-modality
support is a property of *categories*, not individual games: every
Chase/Escape game touches Reaction & Decision + Acceleration +
Deceleration & COD + Spatial Awareness; every Invasion game touches
Reaction & Decision + Acceleration + Deceleration & COD. True
multi-modality *design* (a game whose primary quality serves two
modalities) is rare: the only clear cases are games whose primary
quality is itself cross-modal — e.g. TP2-034 Bound & Break (Jump &
Land primary, Acceleration-tagged) and TP2-087 Get-Up Race (Balance
primary, Acceleration-tagged). **The library has no per-game
multi-modality weighting** — a game is either in a modality (via its
tags) or not; there is no "primary 70% / secondary 30%" or
dose-per-modality. Any modality-aware session planning will need that
weighting as new metadata (§5), not as a re-reading of the tags.

---

## 3. Existing drill reuse opportunities

Everything in this section reuses existing identities and
classifications. Nothing is renamed, re-tiered, or re-scored.

### 3.1 Directly reusable now (no new metadata needed)

| Asset | What it already provides | Reuse for the methodology |
|---|---|---|
| 130 TP2 games with stable IDs | Identity, category, primary/secondary qualities, age range, group size, duration, equipment | The modality mapping in §2.2 is computable from existing tags; IDs are the join keys for all new metadata (§5) |
| 3 coaching cues on all 130 games | Short, coach-usable cues (e.g. "See the Next Island", "Stick Then Go") | Already satisfy the "coaching cues" requirement at the cue level; what is missing is *technical checkpoints* (§4) |
| Build 1–3 (LEARN/COMPETE/PRESSURE) on all 130; Build 4 (CHAOS) on 89 | A 4-stage progression scaffold, already the library's own progression language | The methodology's progressions can be expressed *as* Builds 1–4 per modality, instead of inventing a parallel ladder |
| Regression + Progression free-text on all 130 | Per-game easier/harder variants | Seed material for structured progressions (§5, `game_progressions`) |
| Safety/Guardrail free-text on all 130; Coach Watches on all 130 | Guardrails + observation points | Seed material for structured contraindications and technical checkpoints |
| Equipment tables (`D.eqs`/`D.eqsV22`, 134/145 rows) | Per-game equipment demand | Capacity/equipment checks already consume equipment (`session-capacity.js`); modality work inherits this |
| Phase-fit records (38 games) | ARRIVE/IGNITE/MOVE/SOLVE/CONTROL/COMPETE fit (0/1/2) + athlete counts | The exact shape the methodology needs for session-phase placement; the gap is coverage (92 games), not format |
| `rollingEmphasis` + `draftSession`/`checkGame`/`rankGame`/`pickBuild` | Emphasis-driven, constraint-aware game selection with diversity, recency, coach-feedback, and audit-issue handling | The selection engine is a ready-made *consumer* for modality metadata — it already ranks on emphasis and fit; modality becomes another emphasis dimension |
| `smart-draft-adapter.js` priorities | 7 priorities, 6 of which map 1:1 onto the six modalities (acceleration, agility, power, muscular_endurance, cardiovascular_conditioning, mobility_movement_control) | The assessment→priority bridge already exists; the methodology only needs to extend it from *priorities* to *content* (via §5 links), and to add the missing `strength` mapping |
| GAA battery protocols | Full per-test instructions, safety, valid/invalid criteria, alternatives, caps | The assessment→training link (§5) can cite protocol safety/alternatives directly instead of re-authoring them |
| `development_plans` gate + `training_sessions.plan_id`/`plan_approved_by` | Human approval is mandatory and already enforced in code and schema | Any future recommendation output has a *mandatory* human-approval choke point already built — shadow mode can publish into it without changing the gate |

### 3.2 Reusable with a small, additive fix

- **The 5 orphaned `field-tested-drills.js` cards** (§3.5): the only
  field-tested conditioning content (4-Gate Chaos, 7/10 coach rating,
  2026-10-12) and the only horizontal-power card (Cone Carry) in the
  repo. Reuse requires resolving the ID collision (re-issue as new
  TP2 IDs or as a `TP3-` series — a *new* namespace, never overwriting
  TP2-068–072).
- **The 22 Priority Authoring Launch-60 games without phase-fit
  records** (TP2-002, 004, 016, 018, 019, 020, 050, 051, 068, 069,
  076, 077, 083, 091, 099, 100, 107, 108, 115, 123, 124, 126):
  authoring phase-fit for these is the single highest-leverage
  backfill — it unlocks them for Smart Draft and for any modality
  work, with no code change.
- **The 41 games missing a CHAOS build:** authoring the 4th build
  completes the progression scaffold for the games most likely to be
  drafted at higher levels.

---

## 4. Missing drill and metadata requirements

### 4.1 Missing exercise classifications

- **No modality/submodality classification exists.** Primary/Secondary
  Quality tags are the only classification, and they are not the six
  modalities (e.g. there is no "Power" primary; "Strength Through
  Play" is a play format, not a strength classification; "Competitive
  Conditioning" conflates format and energy system).
- **No submodalities.** Examples of what cannot be expressed today:
  M1 acceleration vs max velocity; M2 pre-planned COD vs reactive
  agility vs perceptual decision speed; M3 bilateral vs unilateral
  jumps, horizontal vs vertical, extensive vs intensive plyometrics;
  M4 maximal strength vs strength-endurance vs trunk stability vs
  single-leg stability; M5 mobility (joint-specific) vs motor control
  vs balance; M6 aerobic base vs repeated-sprint ability vs
  anaerobic capacity.
- **No movement objectives.** No field states *what the game trains*
  in training terms (e.g. "decelerate from 80% sprint into a 45°
  cut"). The `Athletic Problem` field is a game narrative, not an
  objective.
- **No drill/exercise type distinction.** The library cannot say
  "game" vs "drill" vs "exercise" vs "assessment" — everything is a
  game. The methodology's M3/M4/M6 work will mostly need *drills*
  (dosed, repeatable, low-decision), which do not exist as a content
  type yet.

### 4.2 Missing progression and regression options

- **41 of 130 games lack a CHAOS build** (Build 4 empty); 89 have all
  four. No game has a *leveled* progression (e.g. Level 1→3 with
  entry/exit criteria); Builds are variants, not a ladder with
  criteria.
- **No age- or experience-appropriate progression paths.** Age Range
  is per-category (8–18 / 9–18 / 10–18), never per-game; there is no
  experience level, no "first exposure → competent → advanced"
  staging, and no rule for when an athlete moves up a level.
- **No load progression** for M4 (no resistance, no bodyweight
  lever progressions expressed as data) and no plyometric progression
  (no extensive→intensive staging, no volume caps by age).

### 4.3 Missing coaching cues and safety metadata

- Cues exist (3 per game) but are **short phrases, not technical
  checkpoints** — there is no "watch for X / correct with Y"
  checkpoint list, no common-error list, and no coaching-point
  hierarchy (safety-critical vs performance).
- Safety text exists on all 130 but is **free text with no structure**:
  only 15 safety texts mention pain/injury-type words; there is no
  contraindication field, no "do not use if…" list, no
  readiness/return-from-injury flag, and no severity. The 5 Safety
  Review games (TP2-084, 090, 092, 093, 098) are unresolved.
- No per-game **readiness consideration** (fatigue, soreness,
  previous injury, growth-spurt flag) exists anywhere.

### 4.4 Gaps requiring genuinely new drills

These cannot be met by re-tagging the 130 games, because no existing
game is that content:

| Modality | Genuinely new content needed (minimum viable set) |
|---|---|
| M1 | Linear sprint technique drills (wall drills, falling starts, 10–20yd build-ups); acceleration progressions with start positions. ~6–10 drills. |
| M2 | Reactive agility drills with a *measured* stimulus (light/partner-call choice sprints, mirror-reactive COD); pre-planned COD ladders with cut angles. ~6–8 drills. (Note: a reactive *test* is also missing, §2.1.) |
| M3 | Structured plyometrics: extensive (low-intensity hops/skips, landing mechanics) → intensive (depth jumps, single-leg bounds) with volume caps; vertical jump series. ~8–12 drills. This is the largest content gap. |
| M4 | Loaded and bodyweight strength: hinge/squat/push/pull/carry progressions with load guidance, trunk-stability series, single-leg stability series. ~10–14 drills. Must respect the current "no maximal resistance" guardrail until a coach decision changes it. |
| M5 | Mobility series: joint-specific ROM (ankle/hip/thoracic/shoulder), movement-competency flows (squat/hinge/lunge patterns as *training*, distinct from the observation-only Movement Assessment). ~8–10 drills. |
| M6 | Conditioning prescriptions: interval runs, repeated-sprint sets, tempo circuits, work:rest templates by energy system. ~6–8 drills. (4-Gate Chaos, if rescued, is one.) |

Estimated new-drill floor: **~44–62 drills**, authored in the TP2
schema (or its DB successor) with full metadata (§5). All of them need
field testing before Launch Ready status — the library's own rule
("Launch Ready games are the only ones in Smart Draft") must apply to
them too.

### 4.5 Other missing metadata

- **Dose:** no sets/reps/distance/intensity/recovery fields (dose in
  prose only; a numeric dose appears in only 7 of 130 Score/Win
  fields). No intensity scale (RPE, % max, speed zone), no rest
  interval, no total-volume guidance.
- **Assessment-to-training link:** no record connects an assessment
  result (or a Smart Draft priority) to a game/drill. The link today
  is a human coach's judgment, unrecorded.
- **Contraindications:** none structured (§4.3).
- **Recommendation outputs:** no table, no run record, no audit trail
  for any suggestion ever made (§1.7).

---

## 5. Proposed additive database architecture

**Principle:** new tables only; no `ALTER` of any existing table in
Phase 1; new tables reference existing records (never the reverse);
the HTML library stays the source of truth until the import is
verified, then the DB becomes the source and the HTML becomes a
generated view (a later, separately approved step — not this audit's
proposal).

### 5.1 Tables (all new, all `IF NOT EXISTS`)

```sql
-- Lookup: the six modalities + submodalities. Seeded, coach-reviewed.
CREATE TABLE IF NOT EXISTS training_modalities (
  id TEXT PRIMARY KEY,                       -- 'linear_speed', 'multidirectional_agility',
                                             -- 'plyometrics_power', 'strength_stability',
                                             -- 'movement_mobility', 'energy_system'
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES training_modalities(id),  -- NULL for the six; set for submodalities
  description TEXT NOT NULL,
  sort_order INT NOT NULL
);

-- The game library, mirrored from the HTML canonical data (TP2-001..130).
-- One row per game; content columns mirror the 31 HTML columns that are
-- structured (prose fields stay as TEXT; see game_metadata below).
CREATE TABLE IF NOT EXISTS training_games (
  id TEXT PRIMARY KEY,                       -- 'TP2-001' — the existing stable ID, preserved
  name TEXT NOT NULL,
  category TEXT NOT NULL,                    -- existing Category value, verbatim
  age_min INT NOT NULL, age_max INT NOT NULL, -- parsed from the existing Age Range
  group_size_min INT, group_size_max INT,
  duration_min INT,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN
    ('launch_ready','priority_authoring','backlog','safety_review','retired')),
  source_html_hash TEXT,                     -- hash of the source row; import verification
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- (New drills in §4.4 take TP2-131+ or a TP3- series — a decision, §8.)

-- Game <-> modality, with role and weight. The core of the methodology.
CREATE TABLE IF NOT EXISTS game_modalities (
  game_id TEXT NOT NULL REFERENCES training_games(id) ON DELETE CASCADE,
  modality_id TEXT NOT NULL REFERENCES training_modalities(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('primary','secondary')),
  weight NUMERIC NOT NULL DEFAULT 1.0 CHECK (weight > 0 AND weight <= 1),
  PRIMARY KEY (game_id, modality_id)
);

-- Movement objectives, one row per objective (a game can have several).
CREATE TABLE IF NOT EXISTS game_objectives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id TEXT NOT NULL REFERENCES training_games(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,                   -- training-terms objective, e.g. 'decelerate from 80% sprint into a 45-degree cut'
  modality_id TEXT REFERENCES training_modalities(id) ON DELETE SET NULL,
  UNIQUE (game_id, objective)
);

-- Structured progressions: the Builds 1-4 scaffold, made leveled and dosed.
CREATE TABLE IF NOT EXISTS game_progressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id TEXT NOT NULL REFERENCES training_games(id) ON DELETE CASCADE,
  level INT NOT NULL CHECK (level BETWEEN 1 AND 4),  -- 1 LEARN, 2 COMPETE, 3 PRESSURE, 4 CHAOS
  name TEXT NOT NULL,                        -- mirrors the existing Build name where one exists
  instruction TEXT NOT NULL,
  entry_criteria TEXT,                       -- when an athlete may use this level
  exit_criteria TEXT,                        -- when an athlete moves up
  age_min INT, age_max INT,                  -- level-specific band (NULL = inherits game band)
  experience TEXT CHECK (experience IN ('first_exposure','developing','competent','advanced')),
  UNIQUE (game_id, level)
);

-- Dose guidance per game (and per level where it differs).
CREATE TABLE IF NOT EXISTS game_dose (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id TEXT NOT NULL REFERENCES training_games(id) ON DELETE CASCADE,
  progression_id UUID REFERENCES game_progressions(id) ON DELETE CASCADE,
  sets INT, reps INT, distance_m NUMERIC, duration_sec INT,
  intensity TEXT,                            -- e.g. 'RPE 7-8', '80% max sprint', 'submaximal'
  intensity_scale TEXT,                      -- 'rpe' | 'pct_max' | 'speed_zone' | 'qualitative'
  rest_sec INT,
  volume_note TEXT,                          -- caps, e.g. 'max 40 ground contacts/session (youth)'
  UNIQUE (game_id, progression_id)
);

-- Coaching cues + technical checkpoints (cues exist in HTML; checkpoints are new).
CREATE TABLE IF NOT EXISTS game_coaching (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id TEXT NOT NULL REFERENCES training_games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cue','checkpoint','common_error')),
  text TEXT NOT NULL,
  is_safety_critical BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL DEFAULT 0
);

-- Contraindications and readiness considerations (structured; new).
CREATE TABLE IF NOT EXISTS game_contraindications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id TEXT NOT NULL REFERENCES training_games(id) ON DELETE CASCADE,
  contraindication TEXT NOT NULL,            -- e.g. 'acute ankle sprain', 'lower-back pain on loaded hinge'
  severity TEXT NOT NULL CHECK (severity IN ('do_not_use','coach_decision','monitor')),
  note TEXT,
  UNIQUE (game_id, contraindication)
);

-- Assessment -> training link (coach-curated, never auto-generated).
CREATE TABLE IF NOT EXISTS assessment_training_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id TEXT NOT NULL REFERENCES assessment_definitions(id) ON DELETE RESTRICT,
  modality_id TEXT NOT NULL REFERENCES training_modalities(id) ON DELETE RESTRICT,
  game_id TEXT REFERENCES training_games(id) ON DELETE CASCADE,  -- NULL = modality-level link (no specific game)
  link_type TEXT NOT NULL CHECK (link_type IN ('develops','supports','contraindicated_by')),
  evidence_note TEXT NOT NULL,               -- why this link exists; who curated it and when
  curated_by TEXT NOT NULL,
  curated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, modality_id, game_id, link_type)
);

-- Shadow-mode recommendation runs (the audit trail; see §6).
CREATE TABLE IF NOT EXISTS recommendation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','pilot')),
  input_snapshot JSONB NOT NULL,             -- assessment results + priorities + flags used
  output JSONB NOT NULL,                     -- ranked suggestions (game/drill ids + rationale)
  coach_reviewed_by TEXT,
  coach_reviewed_at TIMESTAMPTZ,
  coach_verdict TEXT CHECK (coach_verdict IN ('agree','partial','disagree','not_reviewed')),
  applied_to_plan BOOLEAN NOT NULL DEFAULT false,  -- MUST stay false in shadow mode (enforced by check, §6.3)
  CHECK (mode = 'shadow' AND applied_to_plan = false OR mode <> 'shadow')
);

-- (No table for session content yet. Session plans remain human-authored
--  outside the schema until a later, separately approved phase. The
--  existing training_sessions.plan_id TEXT pointer is left untouched.)
```

### 5.2 What this deliberately does NOT include

- No changes to any existing table (no new columns on
  `assessment_results`, `training_sessions`, `development_plans`, etc.).
- No `training_sessions` content columns — session content stays
  human-authored; the methodology adds *metadata about content*, not a
  content store for sessions.
- No normative/threshold table — thresholds do not exist yet (§7.2);
  inventing one would launder unvalidated numbers into the schema.
- No athlete readiness/wellness table — readiness is a Phase-2
  consideration, and only as *inputs* to shadow runs, not as a new
  athlete record.
- No duplication of assessment data: links reference
  `assessment_definitions(id)` and `athletes(id)`; runs snapshot
  *inputs* as JSONB for audit, they do not copy result rows.

### 5.3 RLS and migration safeguards

- RLS enabled on all new tables; policies mirror the existing pattern
  (003/004): director full; coach scoped to own-cohort athletes for
  `recommendation_runs` (via `athletes` → enrollments); parent/athlete
  read-only on runs about themselves; no `anon` policies.
  `training_modalities`, `training_games`, and the metadata tables are
  reference data: read for all authenticated roles, write director-only.
- Migration is one additive file (`006_training_methodology.sql`):
  all `CREATE TABLE IF NOT EXISTS`, no `ALTER TABLE` on existing
  tables, no data backfill of existing rows, idempotent re-runs safe.
  Rollback = `DROP TABLE` (new tables only, in reverse dependency
  order) + disable the feature flag (§7.4). No rollback migration for
  existing tables is needed because none are touched.
- Import verification: after import, assert row counts (130 games;
  cue/checkpoint counts; progression counts) and per-row
  `source_html_hash` equality against the HTML source before any
  consumer reads the tables. A mismatch fails the import, loudly, and
  the tables stay empty.

---

## 6. Assessment and session-planning integration points

### 6.1 Assessment → training (the link that does not exist yet)

| From (exists) | Via (new) | To (exists) | Notes |
|---|---|---|---|
| `assessment_results` / `progress.js` (per-test baseline/previous/PB, direction-correct) | `assessment_training_links` (§5.1) | `training_games` + `game_modalities` | Links are **coach-curated rows**, never auto-generated from scores. A link says "this assessment informs this modality/game", with a written evidence note. |
| `smart-draft-adapter.js` priorities (7, incl. unmapped `strength`) | extend `ASSESSMENT_TO_PRIORITY` only by adding a mapping **after** a strength assessment exists (§4, §8) | `game_modalities` (modality = priority, 1:1 for 6 of 7) | The priority names already match the modality names closely enough to join on; the join key should be an explicit `modality_id`, not a string match. |
| `assessment_schedules` (28-day due dates) | `recommendation_runs.input_snapshot` | shadow outputs | Due/overdue status is a legitimate *trigger* for a shadow run (a reassessment just landed → recompute suggestions), never an automatic prescription. |
| Movement Assessment observations | `game_objectives` (M5) | M5 games/drills | Observations are qualitative; the link must be a coach's reading of the notes, recorded as `evidence_note`, not a computed mapping. |

### 6.2 Session planning (prototype engine → modality-aware, additively)

The prototype selection engine is the integration point — it already
consumes exactly the kind of data the methodology adds:

| Engine input today | Methodology addition | Change needed |
|---|---|---|
| `emphasis` (from `rollingEmphasis` / coach) | Modality as an emphasis dimension | None to the engine's shape: emphasis values gain modality ids alongside existing tags. The engine ranks on emphasis match already. |
| `D.phasefit` (38 games) | Phase-fit backfill for the other 92 games (§3.2) + phase-fit for new drills (§4.4) | Data authoring only; the engine's "no record fits nothing" rule is preserved and is a *feature* for the methodology (no guessing). |
| `checkGame` 7-stage gate (ready → fit → age → group → equipment → space → not-used) | Add a modality-eligibility stage **after** the existing stages, as an additional filter — never replacing one | One additive stage; the existing seven stages and their order are untouched. |
| `rankGame` (emphasis, fit, diversity, recency, feedback) | Modality weight from `game_modalities.weight` as an additional ranking term | One additive term; existing terms and weights untouched. |
| `pickBuild` (LEARN–CHAOS) | `game_progressions` levels 1–4 as the data source for build choice | The engine reads the same four levels; the data moves from HTML prose to queryable rows. |
| `training_sessions.emphasis TEXT[]` | Modality ids recorded in `emphasis` alongside existing tags | No schema change (`TEXT[]` already); a convention, recorded in docs. |

**Server-side session planning does not exist** (§1.4), so there is no
server integration point to wire yet. If/when a server-side planner is
built (a separate decision), it should consume `game_modalities` and
`game_progressions` through the same read-only queries the prototype
uses — it must not re-implement selection logic.

### 6.3 Shadow-mode recommendation design (opt-in, no athlete-facing effect)

```
Assessment results (existing)
  → progress.js (existing: baseline/previous/PB, direction-correct)
  → smart-draft-adapter.js (existing: advisory priorities, declines-only)
  → NEW shadow ranker (read-only): priorities + assessment_training_links
        + game_modalities + game_progressions + game_contraindications
  → recommendation_runs row (mode='shadow', applied_to_plan=false)
  → coach-only review view (new read-only UI, director/coach roles)
  → coach verdict (agree / partial / disagree / not_reviewed)
  → NOTHING ELSE. No plan write, no session write, no reservation write.
```

Rules that make shadow mode safe:

1. **No write path exists.** The ranker has no import of any
   plan/session/reservation writer, and `recommendation_runs` carries a
   `CHECK (mode='shadow' AND applied_to_plan = false OR mode <>
   'shadow')` so a shadow run *cannot* be marked applied.
2. **Feature flag, default off.** A single flag (e.g. a row in a
   future `app_settings` table or an Edge Function env var —
   implementation detail for Phase 1; the audit requires only that
   there be *one* flag and that its default is off). Flag off = the
   ranker never runs; zero behavior change, provable by test (§7.4).
3. **Coach review is the only exit.** A suggestion reaches a human
   only as a *review item*; applying it still requires the existing
   human-approval path (`planApprovedBy` → `schedule-session.js`).
   Shadow mode adds no new approval bypass.
4. **No automatic decisions from scores.** The ranker consumes only
   the existing declines-only evidence (`smart-draft-adapter.js`) plus
   coach-curated links. It never thresholds a raw score (no norms
   exist), never uses a single result (insufficient-evidence rule
   inherited), and never overrides a coach's `restrictions` on the
   athlete record.
5. **Agreement metric, not adoption metric.** Success in shadow mode
   is measured as coach agreement rate (agree/partial/disagree) and
   coverage (what fraction of runs produced any suggestion), *not* as
   how many suggestions were applied — because in shadow mode the
   answer to "applied" is always zero by design.
6. **Kill switch.** Flag off + (if needed) `DROP TABLE
   recommendation_runs` — the audit trail is disposable by design; no
   production data depends on it.

### 6.4 What "opt-in" means, concretely

- **Phase 1–2:** shadow mode, no UI beyond a coach-only review list,
  no athlete/parent visibility at all. Opt-in is at the *organization*
  level (Marcus enables the flag).
- **Phase 3 (pilot):** one cohort, coach sees suggestions inside the
  existing builder as *suggestions* (visually distinct, never
  pre-selected), still requiring the existing human-approval step.
  Opt-in is per-cohort, by the Director.
- **No phase** makes suggestions default-on, athlete-facing, or
  automatic without a separate owner decision and field validation
  (§8). That is a policy line, not a technical limitation.

---

## 7. Compatibility and regression risks

### 7.1 Risk register

| # | Risk | Likelihood / impact | Mitigation (in the proposal) |
|---|---|---|---|
| R1 | **Modality tags are coarse and partly wrong.** Secondary qualities are uniform per category; a game tagged "Acceleration" may involve 2 seconds of jogging. A ranker built on tags alone will suggest irrelevant games. | High / Medium | Weight field in `game_modalities` (coach-set, not inherited from tags); phase-fit backfill as a second signal; shadow-mode agreement rate exposes bad tags before any pilot. |
| R2 | **No validated thresholds.** The GAA battery is unvalidated (§8); any score→prescription rule would launder unvalidated numbers into training decisions. | High / High | Shadow mode consumes declines-only evidence, never raw scores; no threshold table is proposed (§5.2); graduation requires field validation as a separate decision. |
| R3 | **The prototype is the only session planner, and it is a static file.** Any DB-backed modality data must be *read* by the HTML app, which today has no DB read path (the server workflow is the only DB-connected code, and it does not touch games). | Medium / High | Phase 1 is metadata-only; the HTML keeps working from `TP_DATA` untouched. The DB read path is a Phase-2/3 integration decision, not assumed here. |
| R4 | **Two Smart Drafts, one name.** Server `smart-draft-adapter.js` (assessment→priority advice) vs prototype Smart Draft (game selection). A reader or implementer can wire the wrong one. | Medium / Medium | Naming discipline in docs and code comments (§9); the audit uses "advisory adapter" vs "prototype game selector" throughout. |
| R5 | **`field-tested-drills.js` ID collision.** Any import that trusts file order or IDs will silently drop 5 cards (or, worse, overwrite TP2-068–072). | Medium / Medium | Import asserts distinct IDs and fails loudly on collision; orphaned cards get new IDs in a new namespace (§3.2, §5.1). |
| R6 | **The 5 Safety Review games + 41 missing CHAOS builds.** Drafting a game with an unresolved safety flag, or progressing an athlete to a CHAOS build that does not exist, are both live failure modes for any modality-aware selection. | Medium / Medium | `checkGame` already excludes non-Launch-Ready games; the new modality stage must run *after* that gate, never before; CHAOS backfill is a Phase-1 data task. |
| R7 | **Schema drift between HTML source and DB mirror.** If both are edited, they diverge silently (the 004/005 header drift is the precedent: file headers said NOT APPLIED after live application). | Medium / Medium | `source_html_hash` per row + import verification (§5.3); one declared source of truth at a time (HTML until import verified, then DB). |
| R8 | **Scope creep into prescription.** The methodology's natural endpoint is automatic programming; each phase's success makes the next phase's automation tempting before validation exists. | Medium / High | The advisory contract is enforced in output shape (as `smart-draft-adapter.js` already does) and by the `applied_to_plan` CHECK; graduation is a separate owner decision (§8). |
| R9 | **Athlete `restrictions` vs contraindications.** `athletes.restrictions TEXT[]` already blocks booking by emphasis; a new contraindication system could contradict it or be ignored by it. | Low / High | Contraindications are *advisory to the coach* in shadow mode; they do not gate booking. Any future gating must reconcile with `restrictions` explicitly — flagged as a Phase-3 design question, not decided here. |
| R10 | **Performance: the game library is a 2,752-line HTML file with multi-KB single lines.** Parsing it for import is a one-off, but any runtime DB read path must not re-parse the HTML per request. | Low / Low | Import is a one-off script with hash verification; runtime reads go to the DB tables, never to the HTML. |

### 7.2 Compatibility assessment

- **Assessments:** fully compatible — the methodology consumes
  existing outputs (`progress.js`, `smart-draft-adapter.js`) read-only.
  No assessment workflow, protocol, or result changes.
- **Session planning (prototype):** compatible additively — emphasis,
  phase-fit, and build choice are already data-driven; modality is one
  more data dimension. The 7-stage `checkGame` gate is preserved by
  adding a stage after it, not inside it.
- **Scheduling/capacity/attendance:** unaffected — the methodology
  touches no capacity input, no reservation rule, no attendance
  status. (Capacity already warns when "planned games" are absent;
  modality data does not change that warning.)
- **Memberships/pricing/billing:** unaffected — no table, no price,
  no billing flow is touched or referenced.
- **API contracts:** unaffected — no existing method signature
  changes. New read-only queries (if any) are additive.
- **Athlete records:** unaffected — no new columns on `athletes`; no
  backfill; `restrictions` semantics unchanged.

### 7.3 Naming collisions to resolve before implementation

1. **Two "Smart Drafts"** (§1.6, R4): rename in docs (and, when code
   is touched, in comments) to *advisory adapter* (server) vs
   *prototype game selector* (HTML).
2. **`kind` means different things** on `assessment_results` (locked
   to `'measured'`) vs `assessment_definitions` (`measured|observation`)
   — noted in the server inventory; new code must qualify which table
   it means.
3. **`training_sessions.plan_id` (TEXT, no FK) vs
   `development_plans.id` (UUID):** the "link to the human-approved
   session plan" cannot reference `development_plans`. Do not "fix"
   this by altering the column in Phase 1 — record it as a known
   untyped pointer; resolving it is a separate schema decision.

### 7.4 Regression protection

**Baseline established for this audit: 250 tests, 250 pass, 0 fail**
(`npm test`, re-run 2026-11-15 on branch
`feature/universal-assessment-reassessment-v1` at `fd3678d`).
Typecheck/lint/build scripts do not exist in the repo (n/a, confirmed
in prior phases); `tsc --noEmit --strict` is clean on the five Edge
Function `.ts` files (Phase 3).

**Tests to add with any implementation (recommendations, not code):**

| Area | Recommended tests (proving no regression) |
|---|---|
| Existing workflows | Full suite stays green (250 baseline + new). No existing test is modified, weakened, or removed; new tests are additive files only. |
| API contracts | Contract tests asserting the 13 assessment-api methods and 7 reservation-api methods keep their exact signatures, role tables, and error codes after the methodology lands. |
| Database operations | Migration tests: `006` applies cleanly to a scratch Postgres 15/18, is idempotent on re-run, and creates *only* the new tables (assert no existing table gained/lost a column, no existing policy changed — a schema-snapshot test). |
| Athlete records | Round-trip tests: existing athlete/assessment/reservation rows are byte-identical before/after the migration; `reserve_seat` behavior unchanged (duplicate guard, cap guard, waitlist). |
| Game library preservation | Hash test: the 130 TP2 rows in the HTML are byte-identical after any implementation (the existing UI-preservation hash test already does this for the file; extend it to assert the `TP_DATA` row count and IDs). Import tests: 130 rows imported, 0 collisions, hash equality per row. |
| Shadow-mode safety | Flag-off test: with the flag off, no `recommendation_runs` row is created and no existing output changes. Flag-on test: a shadow run creates exactly one run row and zero plan/session/reservation writes. CHECK-constraint test: inserting a shadow run with `applied_to_plan = true` fails. |
| Selection-engine preservation | Prototype tests: `draftSession` output for a fixed seed is identical before/after the modality addition (when the new stage is disabled); with the stage enabled, previously eligible games stay eligible and previously ineligible games stay ineligible. |
| Advisory contract | Tests asserting every recommendation output carries `advisoryOnly: true, requiresCoachApproval: true, autoRewrite: false` and that no code path from the ranker imports a plan/session writer. |

**Feature-flag, rollback, migration safeguards:**

- **Flag:** one flag, default off, single choke point (§6.3 rule 2).
  Flag off is the shipped state until Marcus enables shadow mode.
- **Rollback:** (a) flag off — instant, no data change; (b) drop the
  new tables in reverse dependency order — no production data depends
  on them; (c) redeploy the previous commit — the HTML and server
  code are untouched by Phase 1, so the previous commit *is* the
  rollback. No rollback migration for existing tables is needed.
- **Migration:** one additive file, `IF NOT EXISTS` throughout,
  idempotent, no `ALTER` on existing tables, no backfill of existing
  rows, no seed data that affects existing behavior (the modality
  lookup seed is reference data only). Applied to a scratch DB first,
  verified by the schema-snapshot test, then — only on separate
  approval — to TheProgramOS via the dashboard SQL editor, following
  the 004/005 pattern (pre-check → apply verbatim → verify counts →
  cleanup).
- **Canary:** shadow mode *is* the canary. There is no production
  rollout of suggestions before a pilot decision, and no pilot before
  field validation (§8).

---

## 8. Phased implementation roadmap

Each phase needs its own explicit approval. One approval covers one
phase only. No phase changes production prescriptions.

| Phase | Scope | Exit criteria | Owner decision needed |
|---|---|---|---|
| **0 — Decisions** | Resolve the open questions in §8.1 before any build. Field-validation plan for the GAA battery (§8, decision §8). Game-library source-of-truth decision (HTML vs DB). New-drill ID namespace (TP2-131+ vs TP3-). Resolve the 5 Safety Review games and the `field-tested-drills.js` collision. | Written decisions recorded in `docs/MORNING_DECISIONS.md` (§17+). No code. | Yes — the decisions themselves. |
| **1 — Metadata foundation** | Migration `006_training_methodology.sql` (§5.1) on a scratch DB first, then (separately approved) live. Import the 130 games + cues + builds + safety text + equipment; author modality/submodality mappings (coach-curated); backfill phase-fit for the 22 Launch-60 games and CHAOS builds for the 41 missing; import/adopt the 5 orphaned cards under new IDs. Tests per §7.4. Flag stays off. | Scratch + live schema verified; import hash-verified; suite green (250 + new tests); zero behavior change (flag-off test passes). | Yes — migration application (live), as with 004/005. |
| **2 — Shadow mode** | Build the shadow ranker (read-only) + `recommendation_runs` logging + coach-only review list. Run on a schedule or on reassessment completion. Collect coach verdicts for 4–8 weeks. No athlete/parent visibility. No session/plan writes. | Agreement rate + coverage reported; no production behavior change; no applied runs (CHECK-enforced). | Yes — enable the flag (shadow only). |
| **3 — Opt-in pilot** | One cohort, Director-selected. Suggestions surface inside the existing builder as visually distinct, never pre-selected suggestions. Human approval still mandatory (`planApprovedBy`). Contraindication display (advisory) in the builder. Reconcile `restrictions` vs contraindications (R9) as a design question first. | Pilot cohort runs a full 28-day cycle with coach verdicts; agreement rate and any safety flags reported. | Yes — pilot cohort + suggestion surfacing. |
| **4 — Evaluate & decide** | Field validation of the GAA battery (§8) + pilot results + agreement rates. Decide: graduate any suggestion to default-on? Add a strength assessment (to map the `strength` priority)? Author the new drills in §4.4? Each is a separate decision. | Written evaluation; no automatic graduation. | Yes — each graduation/extension separately. |
| **5 — New drills (parallel, content track)** | Author the ~44–62 new drills in §4.4 (M3 largest), each with full §5 metadata, field-tested before Launch Ready status under the library's own rule. Can run in parallel with Phases 1–3 (content authoring needs no code). | New drills imported with metadata; field-test records attached; none drafted before Launch Ready. | Yes — content authoring scope + field-test plan. |

**Explicitly not in any phase:** automatic training prescriptions in
production; athlete-facing recommendations; any change to pricing,
billing, cohorts, capacity, attendance, or the assessment workflows;
any merge or deploy (each remains a separate approval under the
release sequence in `docs/RELEASE_READINESS.md` §7).

### 8.1 Open questions for Marcus (Phase 0)

1. **Field validation of the GAA battery (decision §8):** what does
   validation look like, who runs it, and what threshold of evidence
   graduates the battery from "coach-recorded measurements" to
   something recommendations may rely on?
2. **Game-library source of truth:** does the DB mirror become the
   source (HTML generated from it) or does the HTML stay canonical
   with the DB as a read mirror? (Recommendation: DB becomes the
   source after import verification — but that is a decision, not a
   default.)
3. **New-drill ID namespace:** TP2-131+ (continuation) or TP3-
   (new series, preserving TP2 as the V2.1 game set)?
4. **Strength guardrail:** does "no maximal resistance" stay in force
   for M4, and if so, what is the ceiling for loaded strength work
   (bodyweight levers only? light implements?)?
5. **The 5 Safety Review games:** authorize, rework, or retire
   (TP2-084, 090, 092, 093, 098)?
6. **The orphaned field-tested cards:** rescue 4-Gate Chaos and Cone
   Carry (and the 3 candidates) under new IDs, or leave them orphaned?
7. **Shadow-mode flag ownership:** who enables it, and what agreement
   rate over what window would justify a pilot?

---

## 9. Components that must remain untouched

The following must not be modified, renamed, deleted, or behaviorally
changed by any methodology implementation, except where a later,
separately approved decision explicitly names the item.

**User interface**
- `THE PROGRAM OS.html` — UI, navigation, styling, layout, and the
  `TP_DATA` game rows (byte-identical; the UI-preservation hash test
  enforces this). New metadata lives in the DB, not in the HTML, until
  a separately approved source-of-truth migration.
- `index.html` — script load order and the `launch60-*.js` /
  `field-tested-drills.js` application order.
- `assessment-ui/assessment-ui.js`, `assessment-client.js` — the
  Assessments experience as released (250/250, walkthrough 22/22).

**Assessment system**
- `assessment-engine/assessment-engine.js` — definitions, batteries,
  calculations (v1.1.0). No new definitions, no re-domain-ing, no
  norm/threshold additions.
- `server/assessment-battery.js` — GAA v1 protocols, caps, maintenance
  bands, alternatives. (Field validation may *add* evidence; it must
  not rewrite protocols without a decision.)
- `server/assessment-workflow.js`, `assessment-api.js`,
  `assessment-access.js`, `assessment-store.js`, `baseline-gating.js`,
  `progress.js`, `reassessment.js` — the workflow, API, access rules,
  persistence, gating, progress, and scheduling as released.
- `supabase/functions/assessment-api/` — the Edge Function as verified
  (UNDEPLOYED). No behavior change; the methodology adds no routes.

**Drill / game library**
- All 130 TP2 IDs, names, categories, Primary/Secondary Qualities,
  statuses, and tiers — preserved verbatim. No drill deleted, renamed,
  overwritten, or re-tiered. `field-tested-drills.js` collision guards
  stay in place until the namespace decision (§8.1.3) is made.
- `launch60-corrections.js`, `launch60-overrides.js` — patch order and
  content.
- The prototype selection engine's 7-stage `checkGame` gate and
  `draftSession`/`rankGame`/`pickBuild` behavior — additive stages and
  ranking terms only (§6.2), never reordering or replacing.

**Scheduling, capacity, attendance, memberships**
- `server/session-capacity.js`, `reservation-engine.js`,
  `reservation-stores.js`, `schedule-session.js`, `postgres-store.js`,
  `server/api.js` — capacity rules, reservation/eligibility/waitlist/
  attendance logic, the human-approval gate, and the reservation API.
- `training_sessions.plan_id` / `plan_approved_by` semantics and the
  `development_plans` gate — human approval stays mandatory and
  never auto-approved.
- `memberships` (`price_cents` 14900) and all pricing/billing behavior.
  No billing tables are to be created as part of this work.

**Data and schema**
- All 26 existing tables, their columns, constraints, and RLS policies
  (72 policies). No `ALTER` on existing tables in Phase 1.
- All existing athlete, assessment, reservation, and attendance rows.
  No backfill, no re-typing, no deletion.
- `athletes.restrictions TEXT[]` semantics (booking gate) — see R9.

**Recommendation contract**
- `server/smart-draft-adapter.js` — the advisory-only contract
  (`advisoryOnly: true, requiresCoachApproval: true, autoRewrite:
  false`, declines-only evidence, single-source low confidence). Any
  new ranker must carry the same contract in its output shape.
- The rule that no assessment output writes or rewrites a training
  plan — including via the new shadow ranker (§6.3 rule 1).

**Process**
- No merge of PR #2 / PR #3, no Edge Function deploy, no production
  app deploy, no production migration, no production data change —
  each remains a separate owner approval under
  `docs/RELEASE_READINESS.md` §7. No Neon, Taskmill, or MARVIN
  involvement.

---

## Appendix — Evidence and counting methods

- **Test baseline:** `npm test` re-run 2026-11-15 on
  `feature/universal-assessment-reassessment-v1` at `fd3678d`:
  250 tests, 250 pass, 0 fail.
- **Game counts:** parsed `window.TP_DATA` JSON from
  `THE PROGRAM OS.html:402` with Node/Python — 130 rows, 31 columns
  each, 130 distinct IDs, zero duplicates. Tier counts computed by the
  HTML's own tier logic (lines 464–468) plus the `launch60-*.js`
  patches as loaded by `index.html:19`.
- **Table counts:** enumerated `CREATE TABLE` statements in
  `server/migrations/001–005` (18 + 4 + 0 + 4 + 0 = 26). Policy counts
  (58 in 003, 72 total) from the migration files and prior verified
  live state.
- **"No drill table" verification:** `grep -rn -i "drill"
  server/migrations/ server/*.js` (excluding tests) returns zero hits.
- **"No prescription logic" verification:** `grep -rn -i
  "recommend|prescri|workout.*plan|training.*plan|session.*plan"
  server/*.js` (excluding tests) returns only comments and the Smart
  Draft caveat text.
- **Migration headers vs applied state:** the 004/005 SQL file headers
  still say "NOT APPLIED" (stale file text). Both were applied live
  via the dashboard on 2026-11-13 and verified (004: 26/15/72/0,
  §5 checks 17/17 PASS; 005: behavioral re-check 6/6 PASS) — see
  `server/live-checks/004/RESULTS.md` and
  `server/live-checks/005/RESULTS.md`. The headers were left untouched
  as the applied artifacts; this audit relies on the verified live
  record, not the headers.
- **What this audit could NOT establish:** live-database schema state
  was not re-queried (read-only audit; no live access used — the
  applied state rests on the recorded 2026-11-13 verification);
  whether the prototype's `draftSession` Smart Draft is exercised in
  the deployed app beyond the static file (the app *is* the static
  file served with the assessment scripts); real-world field validity
  of the GAA battery (decision §8, open); per-game modality weights
  (do not exist yet — they are a Phase-1 authoring task, not a
  finding).
