# THE PROGRAM — SaaS Expansion: Architecture & Data Model

**Date:** 2026-11-20
**Mission:** RESEARCH, BUILD & VALIDATE SAAS EXPANSION (Marcus, 2026-11-20) — architecture-audit worker deliverable
**Branch:** `feature/the-program-saas-commercialization` (based at `fd3678d`, the assessment-branch head)
**Status: DESIGN ONLY.** No code, schema, UI, billing, merge, deploy, or live-data change is made by this document. Every migration named here is branch-only and unapplied until Marcus approves its application as a separate step.

**Dependency that governs everything below:** `main` (`dc5d42d`) contains only the static prototype and the assessment engine. The operational backend, the assessment workflow, migrations 001–005, and the Edge Function scaffold all live on the unmerged foundation + assessment branches (`feature/program-operational-foundation-v1`, `feature/universal-assessment-reassessment-v1`, PR #2 then PR #3 — see `docs/RELEASE_READINESS.md` §7). The SaaS branch sits on top of that stack. Nothing in this design can merge or deploy before that sequence is approved; the design assumes the stack lands first, in order.

**Test baseline at design time:** 250/250 passing (`npm test`, re-run 2026-11-20 on this branch). Every phase below must keep that baseline green and add tests additively; no existing test is modified, weakened, or removed.

---

## 1. Audit — what exists today (verified by inspection)

### 1.1 Repository shape

| Area | Path | What it is |
|---|---|---|
| Prototype app (the product surface) | `THE PROGRAM OS.html` (2,752 lines, ~621 KB) | Static single-file app: UI, the 130-game library in `window.TP_DATA` (TP2-001–TP2-130, 31 columns each), session builder + prototype Smart Draft (`draftSession`, `checkGame`, `rankGame`, `pickBuild`, `rollingEmphasis`), demo data in `localStorage` (`tp_os_v24`), THE LAB proposals. Views: `vDashboard`, `vLibrary`, `vGame`, `vBuilder`, `vSessions`, `vLab`, `vQueue`, `vAudit`, `vAthletes`, `vAthlete`, `vCohorts`, `vCohort`, `vAssess`, `vCoaches`, `vLocations`, `vEquip`, `vReports`, `vSettings`, `vArch`, `vReview`, `vCoach`, `vAthleteMode`. Role switcher in the topbar (`data-role` director/coach/athlete) is a demo mode switch, not authentication. |
| App entry | `index.html` | Fetches `THE PROGRAM OS.html`, injects `launch60-overrides.js`, `launch60-corrections.js`, `field-tested-drills.js`, `assessment-ui/assessment-client.js`, `assessment-ui/assessment-ui.js` before `boot()`. This runtime-injection pattern is how the live Assessments section was added without redesigning the prototype (the one authorized HTML edit, 2026-11-14, removed the obsolete prototype Assessments copy from `vAssess()`; preservation hash updated in `f90dd11`). |
| Assessment engine | `assessment-engine/assessment-engine.js` | Pure calculation source of truth: 14 definitions (incl. the `baseball` module: `throw-velo`, `throw-accuracy`, `exit-velo`), batteries `generalAthlete`, `generalAthleticAssessment`, `baseball`. No norms, percentiles, or rankings. |
| Assessment UI | `assessment-ui/assessment-ui.js`, `assessment-ui/assessment-client.js` | Live assessment section injected at runtime. Client speaks `{method, params}` to `/api/assessments` (dev) or the Edge Function URL (production shape), with retries and idempotency keys. Dev-only "View as" switcher sends `X-Dev-Role` / `X-Dev-User` / `X-Dev-Athlete` headers. |
| Server modules | `server/*.js` | See §1.3. CommonJS, zero dependencies except `pg` (Postgres store only). |
| Dev server | `server/dev-server.js` (`npm run dev`, port 8123) | Localhost-only (127.0.0.1), memory stores, synthetic seed data. Serves static files + `GET /api/assessments/battery` + `POST /api/assessments`. No real auth (header-named dev roles), no persistence (restart wipes data), never writes to Supabase. |
| Edge Function scaffold | `supabase/functions/assessment-api/` (`index.ts`, `api.ts`, `directory.ts`, `store.ts`, `workflow.ts`, `build.mjs`) + `supabase/config.toml` (`verify_jwt = true`) | Verified in Node (27 tests), **UNDEPLOYED**. JWT verification + `auth.getUser`, role/directory built from the database, user-scoped Supabase client (RLS applies), no service-role key anywhere. Deploy steps: `docs/EDGE_FUNCTION_DEPLOY_STEPS.md`. |
| Migrations | `server/migrations/001–005` | Applied live to TheProgramOS (`rkgdwqgmldznczikrjip`, us-east-2, Postgres 15.8): **26 tables / 15 definitions / 72 policies / 0 rows** (verified 2026-11-13). See §1.4. |
| Fixtures / tests | `server/fixtures/`, `server/tests/` (26 test files), `tests/ui-preservation.snapshot.json` | Synthetic-only data (48-year-old wingback, 12-year-old youth, dev roster of 8). 250 tests via Node's built-in runner. UI-preservation hash test guards `THE PROGRAM OS.html` and asserts no billing code (`checkout`/`Stripe`/`payment`) exists in the UI. |
| Key docs | `docs/RELEASE_READINESS.md`, `docs/MORNING_DECISIONS.md` (§§1–16), `docs/ASSESSMENT_INTEGRATION_COMPLETION.md`, `docs/EDGE_FUNCTION_DEPLOY_STEPS.md` | Release sequence, owner decisions, integration record, deploy steps. |
| Methodology audits (other branches) | `audit/performance-methodology-2026-11-15` (`docs/PERFORMANCE_METHODOLOGY_AUDIT.md`), `audit/drill-suitability-2026-11-15` (`docs/DRILL_SUITABILITY_REVIEW.md`, `docs/DRILL_SUITABILITY_MATRIX.csv`) | Read via `git show` for this design. Conclusions carried into §2.7: **no new drill library**; the 130 games support the six modalities through coaching/programming; migration 006 is not implemented and only its reduced 2-table shadow form (`game_modalities` / `recommendation_runs`) is ever justified, and only if shadow-mode recommendations are in scope; prefer static ratings metadata keyed by TP2 ID. |

### 1.2 Authentication and roles — how sign-in works today

There is **no production sign-in flow in the repo yet**. What exists is the complete authorization substrate a sign-in flow would plug into:

- **Identity provider (design):** Supabase Auth. `app_users.auth_user_id` (migration 003, nullable + unique) links an app role row to `auth.users`. At inspection the live project held 0 auth users; no account-creation code exists anywhere in the repo.
- **App roles** (`app_users.role` CHECK): `director`, `coach`, `parent`, `athlete`, `admin`. In practice the code uses four: `director` (everything), `coach` (own cohort athletes only), `parent` (own athletes, read-only; books sessions for minors), `athlete` (self only). `admin` is in the CHECK but no code path distinguishes it from `director`. There is **no `org_admin` and no distinct `super_admin`** — `director` is the de facto super admin (Marcus).
- **Coach records** (`coaches` table): `role` CHECK `director` / `lead_coach` / `coach` / `sub_coach`, `user_id` → `app_users`, `home_location_ids`, `status`. These are The Program's internal coaching staff (Marcus, Kayla, Jordan, Tyler in fixtures). There is no concept of an external/SaaS coach account, no coach self-registration, and no coach billing identity.
- **Athlete identity:** `athletes.app_user_id` (migration 003) links an athlete record to its own login; `athlete_guardians` + `guardians` link parents. An athlete record can exist with no login at all (the normal in-person case today).
- **Service-layer enforcement:** every API method takes an injected auth context `{authUserId, role, coachId?, athleteId?}` as its first argument; `actor` is always the auth UID (client-supplied actors are ignored); role tables in `server/api.js` and `server/assessment-api.js`; athlete scoping in `server/assessment-access.js` (`canAssess` / `canView` / `listAthletes` over a directory built from cohort membership + guardian links). The modules never parse tokens.
- **Database backstop:** RLS helpers in migration 003 — `app_user_id()`, `app_role()`, `my_coach_id()`, `is_my_athlete()`, `is_my_cohort_athlete()`, `is_my_session()` (all `SECURITY DEFINER`) — and 72 policies. No `anon` policies exist at all. The Edge Function mirrors the same helpers in `directory.ts` and runs every query on the caller's own JWT.
- **Dev auth (not production):** the dev server trusts `X-Dev-Role` / `X-Dev-User` headers (default `director`). This must never ship; production derives auth from a verified JWT in the Edge Function.

**What does not exist:** self-registration for any role; email/password or OAuth sign-in UI; password reset; email verification; invitations; organization membership; any notion of tenant. A SaaS coach or remote athlete cannot create an account today — accounts would have to be created by hand in the Supabase dashboard and linked by SQL.

### 1.3 API surface

| Surface | Transport | Methods | Notes |
|---|---|---|---|
| Reservation API (`server/api.js`) | **None** — transport-agnostic module; no HTTP host, no Edge Function | `reserve`, `cancel`, `availableSeats`, `recordAttendance`, `reconcileAttendance`, `capacityFor`, `promoteWaitlist` (7) | Role table: reserve/cancel = director/coach/parent (athletes never book directly; a parent books for a minor); attendance/capacity/waitlist = director/coach. Over `ReservationEngine` + store (Memory/SQLite/Postgres). Session *creation* is separate: `server/schedule-session.js` builds the `training_sessions` row from a human-approved draft (`planApprovedBy` mandatory); it writes nothing itself. |
| Assessment API (`server/assessment-api.js`) | Dev server `POST /api/assessments` + `GET /api/assessments/battery`; Edge Function scaffold (undeployed) with identical contract | `listAthletes`, `startAssessment`, `recordAttempts`, `getDraft`, `discardDraft`, `completeAssessment`, `athleteAssessmentView`, `coachDashboard`, `recordDeferral`, `planReadiness`, `createPlan`, `finalizePlan`, `advisoryPriorities` (13) + battery protocol route | Recording = director/coach (scoped); reading = director/coach (scoped)/parent (own)/athlete (self). Error codes pass through (`UNAUTHENTICATED`, `FORBIDDEN`, `ATHLETE_NOT_FOUND`, `INCOMPLETE_ASSESSMENT`, `PLAN_NOT_READY`, …). |
| Assessment workflow (`server/assessment-workflow.js`) | Behind the assessment API | 10-step coach workflow: select → start/resume draft → record → save/resume → complete+validate → baseline → history/PBs → compare → status/due → reassess or defer; athlete/parent own-results views; plan create/finalize | Drafts are working state (deleted on completion, never history). Completion requires every GAA test validly recorded, modified, excluded, or actively deferred. |
| Supporting modules | Library calls only | `assessment-store.js` (measured/observation/interpretation separation, idempotency, drafts), `assessment-battery.js` (GAA v1 protocol: 8 tests, 9 measured definition IDs + observation-only movement assessment, 28-day cycle), `reassessment.js` (due math, buckets, deferrals), `baseline-gating.js` (plan-finalization gate + recorded override — gates *only* plan finalization, nothing else), `progress.js` (baseline/previous/PB, direction-correct, under-18 growth caveat), `smart-draft-adapter.js` (advisory-only priorities; `advisoryOnly: true, requiresCoachApproval: true, autoRewrite: false`; no write path), `session-capacity.js`, `reservation-engine.js`, `reservation-stores.js`, `postgres-store.js` | Naming hazard (recorded in the methodology audit): server `smart-draft-adapter.js` (assessment → priority advice) is **not** the prototype Smart Draft (game selection in the HTML). This document calls them *advisory adapter* and *prototype game selector* respectively. |

**What does not exist:** any HTTP transport for reservations; any SaaS API (registration, roster, assignments, subscriptions, org admin); any webhook endpoint; any public/anonymous endpoint (the homepage will be the first anonymous surface — see §2.5).

### 1.4 Database schema — the 26 tables (migrations 001–005, applied live)

**Migration 001 — operational foundation (18 tables):**
`app_users` (email CITEXT, role) · `guardians` · `athletes` (dob, `age_years` — floor 5 after 005, no maximum; `sports TEXT[]`; `eligible_cohort_ids` denormalized snapshot, source of truth is the join table; `restrictions TEXT[]`; coach notes) · `athlete_guardians` · `memberships` (athlete, status `active/trialing/past_due/paused/expired/cancelled`, `price_cents` default **14900** = $149/month, dates — *status only, no billing*) · `locations` (YAK/ELL/CLE) · `training_spaces` (`max_athletes` operator-supplied, never inferred) · `coaches` · `coach_availability` · `cohorts` (code, age band, days, `enrollment_cap` — *not* a session cap, format, emphasis, head coach) · `cohort_enrollments` (source of truth for eligibility) · `session_templates` (p60/p90/p45/sg45/pp50, phase minutes JSONB) · `training_sessions` (`capacity_effective` computed, `capacity_inputs` JSONB auditable, `plan_id` TEXT untyped pointer, `plan_approved_by`) · `session_coaches` · `reservations` (partial unique index: one confirmed per athlete+session) · `waitlist_entries` · `attendance_records` (unique per athlete+session) · `operational_audit_events` (append-only). Plus `reserve_seat()` — the atomic, row-locking reservation gate (duplicate guard, cap-0 refusal, waitlist insertion, audit).

**Migration 002 — assessment persistence (4 tables):**
`assessment_definitions` (15 rows after 004: 10 engine V1 incl. 3 baseball-module + 5 GAA) · `assessment_sessions` (athlete, coach, battery, context JSONB, engine version) · `assessment_results` (attempts JSONB preserved, engine-derived result, `kind='measured'` locked; `modified`/`capped` BOOLEAN added by 005) · `assessment_derived_records` (observation vs interpretation, caveat mandatory, never a measurement).

**Migration 003 — auth link + RLS (no new tables):** `app_users.auth_user_id`, `athletes.app_user_id`, 6 helper functions, minimum role-scoped policies on all 22 tables.

**Migration 004 — reassessment (4 tables):**
`assessment_schedules` (one derived row per athlete+battery: last completed, next due +28d, status) · `assessment_deferrals` (deferral/exclusion/modification, coach-approved, reason mandatory) · `assessment_drafts` (one per athlete+battery, coach working state, director+coach only) · `development_plans` (draft→finalized; CHECK: finalized requires `baseline_session_id` **or** recorded `override_reason`). Plus `assessment_definitions.kind` (measured/observation), `assessment_sessions.idempotency_key` + partial unique index, scoped coach INSERT policies (insert-only; history immutable).

**Migration 005 — unified athlete system (no new tables):** removes the 19-year-old maximum (`age_years >= 5` floor kept as a data-sanity guard); adds `modified`/`capped` to `assessment_results`. Age is an attribute; there are no youth/adult divisions, no new membership categories, no pricing change (Marcus correction, `docs/MORNING_DECISIONS.md` §15).

**SaaS-relevant observations:**
- `athletes`, `coaches`, `cohorts`, `training_sessions`, `reservations`, `memberships`, and the assessment tables are exactly the records a SaaS layer must relate to — and none of them carries an organization or tenant column today.
- `memberships` is the in-person $149 membership *status* record. It is not a subscription, has no plan, no provider IDs, no billing cycle beyond dates, and the reservation engine reads it (`active`/`trialing` covering the session date) without ever setting price or charging.
- `development_plans` is a gate record (draft/finalized + baseline link), not a training program: it has no content columns, no assignments, no schedule.
- `training_sessions.plan_id` is TEXT with no foreign key and cannot reference `development_plans.id` (UUID) — a known untyped pointer, recorded in the methodology audit; this design does not "fix" it by altering the column.

### 1.5 Assessment workflow (what the SaaS coach/athlete experiences build on)

- **Battery:** GAA v1 (`server/assessment-battery.js`, protocol `gaa-v1`): 10-yard sprint, broad jump, 5-10-5 shuttle, push-ups, side plank L/R, single-leg balance L/R, 6-minute walk/run (9 measured IDs) + observation-only movement assessment. Full protocols: instructions, conditions, warm-up/safety, valid/invalid criteria, precision, maintenance bands (product thresholds, not measurement-error claims), youth/adult alternatives + accommodations (modified results flagged, never compared as standard). **The battery is unvalidated in the field** (decision §8): results are coach-recorded measurements, never norms, percentiles, rankings, or diagnoses.
- **Cycle:** baseline on first completed GAA session; reassessment due +28 days; statuses never-assessed / not-due / approaching (≤7d) / due / overdue / deferred; deferrals/exclusions/modifications are coach-approved and never fabricate a completion.
- **Progress:** vs baseline / vs previous / personal best, absolute + percent (percent null on zero baseline), direction-correct, under-18 growth caveat on every youth record.
- **Advisory adapter:** declines-only evidence ranked into 7 development priorities (acceleration, agility, power, strength, muscular endurance, cardiovascular conditioning, mobility/movement control). One poor result = at most one low-confidence priority. No function writes a plan. Note: no assessment maps to *strength* — that priority is currently unmeasurable (methodology audit §2).
- **Plan gate:** a development plan finalizes only after a complete baseline, or by an explicit recorded coach override (reason + approver). Nothing else in the system is gated by assessments.

### 1.6 Prototype session/programming tools (what SaaS programming reuses)

- **Library:** 130 games with Category, Primary/Secondary Qualities, age/group ranges, equipment, Athletic Problem, rules, cues, Builds 1–4 (LEARN/COMPETE/PRESSURE/CHAOS), regression/progression, safety text, tier (Launch Ready / Priority Authoring / Backlog / Safety Review / Retired). Only Launch Ready games enter the builder and Coach Mode. 5 Safety Review games (TP2-084, 090, 092, 093, 098) and 1 Retired (TP2-125) must not be programmed. 41 games lack a CHAOS build. Only 38 games carry phase-fit data. `field-tested-drills.js` holds 5 orphaned cards colliding with TP2-068–072 (runtime contribution: 0 drills; resolution = re-issue as TP2-131–135 — a content decision, not part of this design's build).
- **Builder (`vBuilder`):** cohort/date/template/station configuration (`buildConfigs`, `slotMath`), game picker gated by the 7-stage `checkGame` (ready → fit → age → group → equipment → space → not-used), exposure/coverage bars, session warnings. **Prototype-only** — there is no server-side session planner, and session content remains human-authored with mandatory human approval (`planApprovedBy` → `schedule-session.js`).
- **Coach Mode (`vCoach`) / Athlete Mode (`vAthleteMode`):** demo flows over `localStorage` state. Athlete Mode today shows demo schedule/attendance; it is not connected to reservations, assessments (except via the injected Assessments section), or any account.
- **Capacity & reservations (server):** `session-capacity.js` inverts the prototype's `buildConfigs` (stations ≤ coaches, preferred 4–6 per station, BUILD slots 5–14 min) into a per-session reservation cap — never a universal constant, never guessed; missing inputs (e.g. facility occupancy) are flagged, not invented. `reservation-engine.js` enforces eligibility (membership covering date, cohort enrollment via `cohort_enrollments`, age band, restrictions), duplicates, conflicts, coach availability (unavailable coach blocks booking; never silently substituted), facility conflicts, capacity, waitlists + auto-promotion, attendance, audit — serialized per session in-process *and* by `reserve_seat()` in Postgres. Cohort enrollment cap ≠ session reservation cap, throughout.

### 1.7 What does NOT exist (explicit gaps the SaaS design must fill)

1. **No organizations, no tenants, no org memberships, no org roles.** One implicit operator (The Program) owns everything.
2. **No subscriptions, plans, entitlements, or billing of any kind.** No Stripe (or any provider) integration, no checkout, no webhooks, no invoices. The UI-preservation test actively asserts their absence. Billing activation is owner decision §5, unmade.
3. **No self-registration or account creation** for athletes, coaches, or organizations; no invitations; no public homepage; no marketing/pricing surface.
4. **No coach–athlete roster relationship for remote coaching.** The only coach→athlete link is cohort head-coach membership (`cohorts.head_coach_id` + `cohort_enrollments`). A remote coach cannot have a roster, and an athlete cannot be coached outside a cohort.
5. **No training assignments, completions, or athlete training history** outside in-person session attendance. `development_plans` carries no content. There is no way for a coach to assign work to an athlete or for an athlete to record doing it.
6. **No sponsorship concept.** Nothing prevents (or enables) double-charging a sponsored athlete, because nothing charges anyone.
7. **No guardian consent record.** Guardians exist as people (`guardians`, `athlete_guardians`) and parents can view/book, but there is no consent capture, versioning, or gate. Minors' data (`athletes.dob`) is protected by RLS least-privilege only.
8. **No sport verticals beyond data fields.** `athletes.sports TEXT[]` and the `baseball` assessment module exist; there are no soccer/basketball modules, no sport configurations, no sport-specific programming. (Per the standing constraints, v1 must not manufacture sport-specific prescriptions — see §2.7.)
9. **No drill/exercise table in the database, no server-side drill store, no dose fields.** Dose exists only in prose inside the HTML game records. Per the suitability review this is *acceptable*: programming (round structures, distances, late cues, clean-rep targets) is the lever, and static ratings metadata keyed by TP2 ID is preferred over new tables.
10. **No recommendation/prescription system** (by design — advisory-only adapter + shadow-mode design on paper only), **no server-side session generation**, **no athlete-facing recommendations**.
11. **No reservation HTTP transport** (no Edge Function for `server/api.js`), **no production deployment of anything** (app or Edge Function), **no production sign-in exercised** (dev "View as" only; production sign-in is covered only by the future smoke test in `docs/RELEASE_READINESS.md` §7).
12. **No persistent athlete history surface** combining assessments + attendance + (future) assignments. Assessment history exists (`athleteAssessmentView`); attendance history exists in tables; nothing unifies them for the athlete.

---

## 2. Design — the smallest complete SaaS slice

### 2.0 Design principles (inherited, non-negotiable)

- **Supabase is the sole backend** (project `rkgdwqgmldznczikrjip`). Neon is unused and is never connected. Nothing touches Taskmill or MARVIN.
- **Reuse before expansion.** The 130 games suffice via coaching/programming (suitability review). **No new drill library.** Migration 006 (methodology) is not implemented; only its reduced 2-table shadow form is ever justified, and only if shadow-mode recommendations are in scope. This design prefers **static ratings metadata keyed by TP2 ID** (suitability review Layer 1) and does not require the methodology tables.
- **No automatic prescriptions from assessment scores.** The advisory adapter stays advisory-only. The GAA battery is unvalidated in the field; results are presented only as coach-recorded measurements with their caveats.
- **Unified athlete system.** Age is an attribute (floor 5, no maximum, no divisions). Cohort age bands remain per-cohort eligibility, not divisions.
- **In-person operation preserved exactly:** $149/month membership (`memberships`, price 14900), cohort/capacity rules, reservation engine, existing coach/admin tools. The SaaS layer is additive around it.
- **Migrations additive, branch-only, unapplied without approval.** No merges, no deploys, no live writes in any phase without its own approval.
- **Relationships over duplication.** New tables reference `athletes`, `coaches`, `app_users`, `memberships`, assessment tables — never copy them.
- **Server-side enforcement, always.** Entitlements and tenancy are checked in the API layer *and* mirrored in RLS. Client-side hiding is a convenience, never the control. Unauthorized access to another coach's athletes is release-blocking.

### 2.1 Accounts, roles, and tenants

**Tenant model.** Every SaaS coach operates inside exactly one **tenant**. A tenant is an `organizations` row with `kind` = `solo` (a single independent coach — created automatically at coach registration), `team`, `academy`, or `program_internal` (The Program's own in-person operation). This gives solo coaches and academies one code path: a solo coach is an organization of one. The Program's existing operation becomes the `program_internal` organization so its cohorts, locations, and coaches can be scoped by the same rules without a special case.

**Roles.** Keep the existing vocabulary and extend it by exactly one role:

| Role | Source | Meaning |
|---|---|---|
| `director` (super admin) | Existing | Marcus / platform operator. Everything, across all tenants. This *is* the super admin; no separate `super_admin` role is introduced (avoids a second all-powerful path to audit). |
| `org_admin` | **New** | Administers one organization: invites/removes coaches, sees all athletes linked within the org, manages the org subscription. Cannot see other orgs. |
| `coach` | Existing | Coaches athletes linked to them (directly, or via their org). Administers assessments, assigns training, monitors progress — for linked athletes only. |
| `parent` | Existing | Guardian of one or more athletes: views own athletes, books in-person sessions, grants/withdraws consent. Never records assessments, never assigns training. |
| `athlete` | Existing | Own record only: dashboard, assignments + completion, assessment results + progress, history. |

`app_users.role` CHECK gains `org_admin` (additive migration; existing rows unaffected). `coaches.role` (`director/lead_coach/coach/sub_coach`) is unchanged — it describes coaching seniority inside a tenant, orthogonal to app role. A SaaS coach gets both: an `app_users` row (`role='coach'`, or `'org_admin'` if they administer their org) and a `coaches` row linked by `coaches.user_id`, exactly as internal coaches do today.

**Registration (auto account creation).** Supabase Auth sign-up (email/password first; OAuth is a later, separately approved addition) → `app_users` row created on first authenticated call (the Edge Function's directory build already resolves role from the database; registration adds the one missing step: *provisioning* the `app_users` + role-specific record). Three entry points, one mechanism:

- **Athlete:** sign up → `app_users(role='athlete')` + `athletes` row linked via `athletes.app_user_id` → free tier (§2.3) → guardian-consent gate if a minor (§2.8) → dashboard.
- **Coach:** sign up → `app_users(role='coach')` + `coaches` row + solo `organizations(kind='solo')` + `organization_memberships(org_admin)` → plan selection (test-mode, §2.6) → roster.
- **Organization:** sign up (or upgrade a solo tenant) → `organizations(kind='team'|'academy')` with the founder as `org_admin` → invite coaches by email (`invitations`, §2.2).

An existing in-person athlete who later creates a remote account is *linked*, not duplicated: a director/coach (or a verified guardian claim flow) sets `athletes.app_user_id` on the existing record. The athlete keeps one record, one history, one set of assessments. Duplicate-athlete merging is explicitly out of scope for v1 (flagged in §3).

### 2.2 Data model additions

Three additive, branch-only migrations. **Numbering note:** the methodology audit proposed `006_training_methodology.sql`. To avoid a collision, the SaaS migrations take 006–008 and the methodology shadow form, if ever approved, becomes 009. All three follow the established pattern: `IF NOT EXISTS` / guarded re-issue, Postgres 15 compatible, RLS enabled on every new table, no `ALTER` that rewrites existing data, idempotent re-runs.

#### Migration 006 — SaaS foundation: organizations, rosters, consent

```sql
-- Tenants. A solo coach is an organization of one.
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('solo','team','academy','program_internal')),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who belongs to an org, in what capacity. (Coaches also keep their
-- coaches row; this table is the tenancy link.)
CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  org_role TEXT NOT NULL CHECK (org_role IN ('org_admin','coach')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, app_user_id)
);

-- The SaaS roster: coach <-> athlete, tenant-scoped. Distinct from
-- cohort_enrollments (in-person). A coach sees an athlete iff an
-- ACTIVE link exists (or via org_admin over the org's links).
CREATE TABLE IF NOT EXISTS coach_athlete_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  source TEXT NOT NULL CHECK (source IN ('coach_invite','athlete_request','org_assignment','program_internal')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_by TEXT,  -- auth UID of the actor (audit convention)
  UNIQUE (coach_id, athlete_id, organization_id, status)  -- one live link per trio; history rows kept
);
-- Partial unique index for the live link (same pattern as reservations):
CREATE UNIQUE INDEX IF NOT EXISTS uq_link_active
  ON coach_athlete_links (coach_id, athlete_id, organization_id) WHERE status = 'active';

-- Invitations (coach -> athlete/guardian, org -> coach). Token stored hashed.
CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  invite_role TEXT NOT NULL CHECK (invite_role IN ('coach','athlete','parent')),
  coach_id UUID REFERENCES coaches(id) ON DELETE SET NULL,  -- set when a coach invites an athlete
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guardian consent (mechanism only; legal text is counsel's — §2.8).
CREATE TABLE IF NOT EXISTS guardian_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  guardian_id UUID NOT NULL REFERENCES guardians(id) ON DELETE RESTRICT,
  consent_version TEXT NOT NULL,  -- version of the terms presented (text owned by counsel)
  status TEXT NOT NULL CHECK (status IN ('granted','withdrawn')),
  method TEXT NOT NULL DEFAULT 'in_app',  -- how consent was captured (audit)
  granted_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consent_athlete ON guardian_consents (athlete_id, status);

-- Additive columns (nullable; existing rows unaffected):
ALTER TABLE coaches  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE cohorts  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE training_sessions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
-- app_users.role gains 'org_admin' (CHECK re-issue, guarded).
```

The `program_internal` organization row is seeded by the migration (name/slug fixed), and existing internal coaches/cohorts/locations *may* be backfilled to it — but the backfill is a separate, separately approved data step, not part of the schema migration. Until backfilled, NULL `organization_id` means "The Program internal, pre-tenancy" and the API treats NULL as the internal tenant for director/coach access (preserving today's behavior exactly). This is what keeps the 250-test baseline green: no existing query changes meaning.

**Athlete ownership.** `athletes` stays tenant-neutral — no `organization_id` on the athlete record. An athlete owns their record and history; coaches and orgs hold *links* to it. Ending a link ends access, never the athlete's data. An athlete may hold links to multiple coaches/orgs over time (e.g. in-person + remote), each independently revocable. This is the data-ownership rule the mission requires, expressed as schema.

#### Migration 007 — Training assignments & completions (remote training)

```sql
-- A coach-assigned unit of remote training. References games by TP2 ID
-- (TEXT, validated server-side against the static library list) —
-- there is no games table and this design does not create one.
CREATE TABLE IF NOT EXISTS training_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  development_plan_id UUID REFERENCES development_plans(id) ON DELETE SET NULL,  -- optional link to the gated plan
  title TEXT NOT NULL,
  instructions TEXT,
  game_ids TEXT[] NOT NULL DEFAULT '{}',   -- TP2-xxx ids from the 130-game library
  build TEXT CHECK (build IS NULL OR build IN ('LEARN','COMPETE','PRESSURE','CHAOS')),
  dose JSONB,  -- coach-set programming: {rounds, workSec, restSec, distance, reps, note} — the suitability review's levers, as data
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','completed','skipped','cancelled')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_assign_athlete ON training_assignments (athlete_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_assign_coach ON training_assignments (coach_id, status);

-- Athlete-recorded completion. Append-only history; never edited in place.
CREATE TABLE IF NOT EXISTS training_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES training_assignments(id) ON DELETE RESTRICT,
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_min INT,
  effort_rpe INT CHECK (effort_rpe IS NULL OR effort_rpe BETWEEN 1 AND 10),
  athlete_note TEXT,
  coach_note TEXT,  -- coach may annotate after the fact (separate column; athlete's record untouched)
  UNIQUE (assignment_id)  -- one completion per assignment; re-dos are new assignments
);
```

**Persistent history** is then a read model, not a new store: athlete history = `assessment_sessions/results` (existing) + `attendance_records` (existing) + `training_completions` (new), unified in the athlete view. Nothing is copied; the view joins by `athlete_id`. Coach progress monitoring reads the same join, scoped by link.

Assignments deliberately reference the *existing* game library by ID and carry the coach's programming (`dose`, `build`) as data — this is the suitability review's Layer 0/1 conclusion (programming over proliferation) expressed in the SaaS schema. Safety Review / Retired games are rejected at assignment time by the API (server-side list), mirroring `checkGame`'s Launch-Ready gate. No assessment score ever creates an assignment: assignments are coach-authored, always. The advisory adapter may *inform* a coach (existing `advisoryPriorities`), and that is where its role ends.

#### Migration 008 — Subscriptions, sponsorships, billing events (test-mode shape)

```sql
-- Plan catalogue (seeded; limits are data so tiers can be tuned without code).
CREATE TABLE IF NOT EXISTS subscription_plans (
  code TEXT PRIMARY KEY,  -- 'free_athlete','athlete_remote','coach_starter','coach_pro','team_academy'
  audience TEXT NOT NULL CHECK (audience IN ('athlete','coach','organization')),
  name TEXT NOT NULL,
  limits JSONB NOT NULL,  -- {maxAthletes, maxCoaches, historyDays, canAssess, canAssign, ...} — see §2.3
  active BOOLEAN NOT NULL DEFAULT true
);

-- A subscription belongs to an athlete, a coach, or an organization.
-- SEPARATE from memberships (in-person $149 status). Never overloaded.
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_code TEXT NOT NULL REFERENCES subscription_plans(code) ON DELETE RESTRICT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('athlete','coach','organization')),
  owner_id UUID NOT NULL,  -- athletes.id | coaches.id | organizations.id (app-layer checked; no polymorphic FK)
  status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','cancelled','expired','incomplete')),
  billing_interval TEXT CHECK (billing_interval IS NULL OR billing_interval IN ('month','year')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  provider TEXT NOT NULL DEFAULT 'none' CHECK (provider IN ('none','stripe_test')),
  provider_customer_id TEXT,       -- test-mode ids only in this design's scope
  provider_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_owner ON subscriptions (owner_type, owner_id, status);

-- Sponsorship: a coach/org covers an athlete's paid access.
CREATE TABLE IF NOT EXISTS sponsorships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  sponsor_type TEXT NOT NULL CHECK (sponsor_type IN ('coach','organization')),
  sponsor_id UUID NOT NULL,  -- coaches.id | organizations.id
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,  -- the sponsor's covering subscription
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  UNIQUE (athlete_id, sponsor_type, sponsor_id, status)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sponsor_active
  ON sponsorships (athlete_id, sponsor_type, sponsor_id) WHERE status = 'active';

-- Provider webhook log (idempotent processing; test-mode only).
CREATE TABLE IF NOT EXISTS billing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Entitlements are computed, not stored.** A single server module (`server/entitlements.js`, proposed) resolves an athlete's effective access from, in priority order: (1) active in-person `memberships` row → full access (the $149 member is never asked to also buy remote); (2) active `sponsorships` row whose sponsor subscription is active → paid access at the sponsor's tier; (3) the athlete's own active `subscriptions` row → paid access; (4) otherwise the free tier. Coach/org limits resolve from the coach's or org's subscription. Every resolution is auditable via `operational_audit_events` (existing table, new action strings — no schema change needed there). Storing a denormalized "current tier" column is explicitly rejected: it drifts, and the sponsorship/expiry rules below need the derivation to be live.

### 2.3 Entitlement design (server-side enforcement points)

| Tier | Who | Can | Cannot / limits |
|---|---|---|---|
| **Free athlete** | Any registered athlete without paid access | Own dashboard; view own assessment results + progress (coach-recorded measurements, with caveats); view assignments from a linked coach; record completions; full history *retained* | No coach link beyond **1** active coach (free athletes can be coached, but not by many); history *display* window limited (e.g. last 90 days — data retained, display gated); cannot self-administer assessments (recording stays coach/director-only, as today); no priority features. Limits are meaningful but the record is never held hostage: downgrading never deletes history. |
| **Paid remote athlete** (`athlete_remote`, monthly/annual) | Athlete's own subscription | Everything in free, plus: unlimited coach links, full history display, reassessment reminders, assignment notifications (when notifications exist) | Still cannot record assessments (coach-only rule is a *role* rule, not a tier rule — it does not change with payment). |
| **Sponsored athlete** | Covered by a coach/org sponsorship | Paid access at the sponsor's tier, for as long as the sponsorship + sponsor subscription are active | **Never double-charged:** the billing flow checks sponsorship *before* offering an athlete subscription; an athlete with active sponsorship is never presented a checkout for the same access. If the athlete also holds their own subscription, the sponsor's coverage takes precedence and the athlete's own subscription is flagged for pause/cancel (surfaced to the athlete, never silently charged twice). |
| **In-person member** ($149 `memberships`) | Existing operation | Everything the in-person operation grants today (session booking via the reservation engine, cohort training) **plus** paid remote access (no second charge) | Unchanged cohort/capacity rules. Membership expiry returns the athlete to free remote tier; in-person booking already refuses expired memberships (`MEMBERSHIP` rejection) — no change. |
| **Coach Starter** (`coach_starter`) | Solo coach | Roster up to plan limit (e.g. 15 active linked athletes); assessment administration for linked athletes; training assignment/programming; progress monitoring | Athlete cap enforced at link creation (`ENTITLEMENT_LIMIT`); single coach (no org invites); no org admin features. |
| **Coach Pro** (`coach_pro`) | Solo coach, higher tier | Higher roster cap (e.g. 50); everything in Starter | Still single-tenant (solo org); multi-coach requires Team/Academy. |
| **Team / Academy** (`team_academy`) | Organization | Multiple coaches under one org (cap by plan, e.g. 10 coaches / 200 athletes — final numbers are Marcus's pricing decision, stored in `subscription_plans.limits`); org_admin role; org-wide roster visibility for org_admins; sponsorship pool (org sponsors its athletes) | Coaches inside the org still see only their own linked athletes unless they are org_admins (see §2.4). |

**Enforcement points (all server-side, all with stable error codes):**
1. **Link creation** (`coach_athlete_links` insert): coach roster cap + athlete free-tier link cap + consent gate (§2.8). Over limit → `ENTITLEMENT_LIMIT` (409).
2. **Assessment recording** (existing `completeAssessment` path): role + scope (existing) **plus** coach subscription active (a lapsed coach can still *view* history but cannot record new assessments — `SUBSCRIPTION_INACTIVE`). Athlete-side: assessment *visibility* follows the athlete's tier (free window vs full).
3. **Assignment creation**: coach subscription active + athlete linked + game IDs valid/assignable. Athlete completion recording: assignment belongs to the athlete; no tier gate on *completing* work already assigned (an athlete whose tier lapses mid-assignment can still finish it — access changes never strand in-flight work).
4. **History reads**: display-window filter applied in the workflow layer by tier; the underlying rows are untouched.
5. **In-person booking**: unchanged — `memberships` check in the reservation engine. SaaS subscriptions never grant session seats, and session capacity is never affected by remote tiers. The two money systems meet only at the entitlement *resolution* (member ⇒ remote access), never at the capacity computation.

**Expiration / cancellation behavior.** Subscription `cancelled`/`expired` (or `past_due` beyond a grace window — a Marcus decision, default: grace = until `current_period_end`) ⇒ effective tier falls to free (athlete) or read-only (coach: roster/history visible, no new assessments/assignments/links). Sponsorship ends when the sponsor cancels it, the link ends, or the sponsor subscription lapses — the athlete falls back to their own subscription if any, else free. **No data is ever deleted on lapse.** Reactivation restores full access to the retained history. This is enforced by the derivation in `entitlements.js`, not by row mutation, so there is no "downgrade job" to fail.

### 2.4 Tenant isolation (release-blocking)

**Rule:** Coach A can never see, assess, assign to, or infer the existence of Coach B's athletes — across solo tenants and across organizations — except where an org_admin legitimately administers their own org, or the director administers the platform. Athletes see only themselves; parents only their own athletes. Every layer below must hold independently (defence in depth, same pattern as today):

1. **API layer (primary contract).** `server/assessment-access.js`'s directory is extended (additively — existing cohort/guardian/self rules unchanged) with link-based scoping: `canView`/`canAssess` gain "coach with an *active* `coach_athlete_links` row for this athlete" and "org_admin of the org that link belongs to". `listAthletes` for a coach returns cohort athletes ∪ linked athletes, deduplicated. New SaaS API methods (§2.5) take the same injected auth context, `actor` = auth UID, and check scope *before* touching data. Out-of-scope athlete IDs return `FORBIDDEN` (or `ATHLETE_NOT_FOUND` where existence itself must not leak — the existing code already returns `ATHLETE_NOT_FOUND` for unknown IDs; cross-tenant IDs are treated as not-found for reads to avoid enumeration).
2. **RLS layer (backstop).** New helpers mirroring migration 003's style: `my_org_ids()` (orgs where the caller is an active member), `is_my_linked_athlete(p_athlete_id)` (active link to caller's coach row, or link in an org the caller admins), `is_my_org(p_org_id)`. Policies on every new table: director full; org_admin scoped to their org; coach scoped to own links/assignments; athlete/parent read-own. Existing assessment/reservation policies gain the link-based scope *additively* (new policies alongside the cohort ones — Postgres ORs permissive policies, so cohort access is preserved while link access is added; no existing policy is weakened or removed). No `anon` policies on any athlete-data table, ever.
3. **Edge Function layer.** Directory build (`directory.ts` pattern) resolves org memberships + links from the database per request, on the caller's JWT. The client never supplies tenant IDs that are trusted; any `organizationId` in params is checked against the caller's memberships.
4. **Billing layer.** Subscriptions/sponsorships are readable only by their owner (athlete/coach/org_admin/director). A coach cannot see another coach's subscription, roster size, or sponsored athletes.

**Proof obligation:** validation journey J7 (§2.9) is the release-blocking test — two coaches in different tenants, each with athletes, every read/write path attempted cross-tenant at both the API and RLS layers. It must pass before any SaaS surface ships, and it joins the permanent regression suite.

### 2.5 API / transport design (consistent with the existing stack)

The existing convention is preserved exactly: transport-agnostic service modules taking an injected auth context; thin API layers with role tables; dev server locally; Edge Functions for production shape. **Nothing is deployed by this design.**

| New surface | Local (dev) | Production shape (future, separately approved) |
|---|---|---|
| SaaS API (`server/saas-api.js`, proposed): `registerAthlete`, `registerCoach`, `createOrganization`, `inviteToOrg`, `acceptInvitation`, `linkAthlete`, `unlinkAthlete`, `myRoster`, `createAssignment`, `listAssignments`, `completeAssignment`, `athleteHistory`, `myEntitlements`, `sponsorAthlete`, `endSponsorship`, `grantConsent`, `withdrawConsent`, `orgOverview` | Dev server gains `POST /api/saas` (same `{method, params}` dispatch, same dev-header auth, memory stores) | New Edge Function `supabase/functions/saas-api/` (`verify_jwt = true`, user-scoped client, directory built from DB) — sibling of `assessment-api`, reusing its auth/dispatch pattern. |
| Reservation API transport | Dev server gains `POST /api/reservations` over `server/api.js` (today it has no HTTP host at all) | New Edge Function `supabase/functions/reservation-api/` — required before any production booking UI; flagged as a pre-existing gap (§1.7.11), not created by the SaaS work but on its critical path for the in-person member journey (J10). |
| Billing (`server/billing.js`, proposed abstraction) | Fake/test adapter in memory; `POST /api/billing` for checkout-session creation against the abstraction | Edge Function `supabase/functions/billing-webhook/` — the **only** function permitted a service-role key (webhooks have no user JWT), isolated to writing `billing_events` + subscription status. User-facing billing calls (checkout, portal) go through `saas-api` on the caller's JWT. |
| Assessment API | Unchanged | Unchanged (existing scaffold). Gains only the additive link-scope in its directory + entitlement checks in the workflow layer. |

All new service modules follow the house rules: auth context first, `actor` always the auth UID, stable error codes (`UNAUTHENTICATED`, `FORBIDDEN`, `ENTITLEMENT_LIMIT`, `SUBSCRIPTION_INACTIVE`, `CONSENT_REQUIRED`, `ATHLETE_NOT_FOUND`, `INVALID_INPUT`), store interfaces with memory implementations for tests, no network at import time, no secrets in code.

### 2.6 Billing — feasibility finding (test-mode only)

**Finding (verified 2026-11-20): the Stripe connector in this environment is `not_connected`** (`/opt/hatch/bin/stripe status` → `{"auth_status":"not_connected","authenticated":false}`; `list-tools` refuses until reconnected). No Stripe account, test or live, is available to this work. **No live product was touched, and none will be.**

Therefore billing is designed against an abstraction, with the concrete remainder stated exactly:

- **Abstraction (`server/billing.js`, proposed):** `createCheckoutSession({ownerType, ownerId, planCode, interval})`, `createPortalSession({ownerType, ownerId})`, `handleProviderEvent(event)` (idempotent via `billing_events.provider_event_id`), `syncSubscription(providerSubscriptionId)`. A `FakeBillingAdapter` (in-memory, deterministic) backs all tests and the dev server; a `StripeTestAdapter` is written against Stripe's test mode but **cannot be exercised until a test-mode connection exists**.
- **Test-mode-only rule:** the adapter refuses non-test keys (`sk_live_` / live-mode contexts are rejected at construction with `BILLING_LIVE_MODE_REFUSED`). Provider columns are named `provider_*` with `provider='stripe_test'` as the only non-`none` value in scope. Monthly/annual are Stripe Prices under one Product per plan code — created in *test mode only*, by a separately approved step.
- **What remains (exact list, all separately approved):** (1) Marcus connects Stripe via the connector's OAuth flow (`authorize-url` → `connect_url`) and confirms the *test-mode* context; (2) test Products/Prices created for `athlete_remote`, `coach_starter`, `coach_pro`, `team_academy` (monthly + annual); (3) webhook endpoint + signing secret configured as an Edge Function secret (never in code/repo); (4) `StripeTestAdapter` verified against test mode with Stripe's test cards; (5) only then, a *separate* Marcus decision on live-mode activation (owner decision §5) — pricing, merchant identity, tax, refunds, and terms are business/legal decisions this design does not make.
- **Sponsored-athlete protection lives in the abstraction, not in Stripe:** `createCheckoutSession` for an athlete first resolves entitlements; active sponsorship (or active in-person membership) ⇒ checkout is refused with `ALREADY_COVERED` and the covering source named. Double-charging is therefore impossible through the API even before Stripe exists.

### 2.7 Pages & sport verticals

**Pages (inside the existing application, without breaking it).** The established pattern is runtime injection (`index.html` loads additional scripts before `boot()`; `assessment-ui.js` wraps `vAssess`/`vAthlete`). The SaaS surfaces follow it — **no redesign of existing views, no change to `THE PROGRAM OS.html` beyond what a separately approved, hash-reviewed commit would do**:

| Surface | Where it lives | Integration |
|---|---|---|
| **Public homepage** | New standalone static page (e.g. `public/index.html` at deploy time — *not* inside the prototype shell, which assumes an operator). The first anonymous surface in the system: marketing copy, plan overview (test-mode pricing clearly labelled as such until live billing is approved), sign-in / create-account links. No athlete data, no API calls beyond auth. | Links into the app entry (`index.html`) after sign-in. Copy/pricing claims are Marcus's; the page must not present GAA results as validated outcomes (decision §8). |
| **Auth pages** (sign in, create account, accept invitation, guardian consent capture) | New runtime-injected module `saas-ui/` (sibling of `assessment-ui/`), loaded by `index.html` the same way. Production uses Supabase Auth (JWT → Edge Function); dev uses the existing "View as" switcher pattern extended with SaaS dev users. | On sign-in, the app boots into the role-appropriate shell (existing director/coach/athlete modes). |
| **Athlete dashboard** | Extends `vAthleteMode` via injection (same wrap pattern as `vAthlete`): today's assignments + completion, assessment results + progress (existing `athleteAssessmentView` data), unified history, tier/sponsorship status, next reassessment due. | Reads only through the SaaS/assessment APIs; no direct DB access from the browser. |
| **Coach experience** | Extends the coach shell via injection: roster (cohort ∪ linked), assessment administration (existing live section, unchanged), assignment composer (game picker reusing the library's data + Launch-Ready gate), completion/progress monitoring, plan/subscription status + roster-cap display. | The existing Assessments section is untouched; new panels sit alongside it. |
| **Org admin** | New injected view (director-shell style): coaches in org, org-wide roster, invitations, org subscription, sponsorship pool. Visible only to `org_admin`/`director`. | Scoped by `my_org_ids()` at API + RLS. |
| **Director (Marcus)** | Existing director shell, unchanged, plus (later, separately approved) a platform overview. The in-person tools (builder, sessions, cohorts, capacity) are not modified by SaaS work. | — |

**Sport verticals — one shared engine, configuration where justified.** The shared engine is: GAA battery + progress + advisory adapter + the 130-game library + assignments. What is genuinely sport-specific in v1 is **configuration, not content or prescriptions**:

- `athletes.sports` (existing `TEXT[]`) records the athlete's sports (baseball/softball, soccer, basketball, general).
- A static **sport profile** config (proposed `server/sport-profiles.js`, mirrored client-side for display): per sport — display name, default emphasis tags (drawn from the existing quality vocabulary), library filter presets (category/quality filters the builder already supports), and the assessment *module* to offer alongside GAA. Today only `baseball` has a module (`throw-velo`, `throw-accuracy`, `exit-velo` — existing engine definitions, existing seeded rows). **Soccer and basketball get profiles with no new tests in v1**: inventing unvalidated sport tests would repeat the exact error decision §8 guards against. A sport-specific assessment module is a future, separately validated decision (protocol authoring + field validation), not a config flag.
- **No manufactured sport-specific prescriptions.** A soccer athlete and a baseball athlete with the same GAA results receive the same advisory priorities; the coach's programming (game selection, dose, build) is where sport context lives — in the coach's judgment, recorded on the assignment. The suitability matrix's static ratings (Layer 1: `game_ratings` data file keyed by TP2 ID, from `DRILL_SUITABILITY_MATRIX.csv`) may inform the assignment composer's *filtering* (e.g. "games that train M2"), never auto-selection.

### 2.8 Guardian consent gate for minors

**Mechanism (this design):**
- Minor status is derived, never stored as a division: `athletes.dob` (preferred) or `age_years` < 18 ⇒ minor. (Age remains an attribute; the unified system is untouched.)
- A minor athlete's account is created in a **pending-consent** state: the athlete can sign in and see only the consent-pending screen. No assessments are recorded, no assignments are created or completable, no coach link becomes active, and no results are displayed until a guardian grants consent.
- Consent is captured from the guardian's own authenticated `parent` account (linked via `athlete_guardians`, existing tables), recorded in `guardian_consents` with the `consent_version` presented, timestamp, and method. Withdrawal flips status to `withdrawn` and immediately re-gates the account (history retained, access paused). Re-grant creates a new row (append-only; the current state is the latest row).
- Enforcement: API layer (`CONSENT_REQUIRED`, 403) on assessment recording, link activation, assignment creation/completion, and result reads for minors; RLS backstop via a `has_guardian_consent(p_athlete_id)` helper in the new policies. Adults (≥18) bypass the gate entirely — including the 48-year-old wingback path the test suite already exercises.
- Coach-recorded in-person athletes without logins: consent is still required before *remote* features activate for that athlete; the existing in-person operation's own consent practices (paper/waiver, outside this system) are not replaced by this mechanism.

**Flagged for counsel (not designed here):** the consent *text* and versioning policy; age-of-consent and verifiable-parental-consent requirements (e.g. COPPA in the US); what data collection the consent covers (assessment results, training history, DOB); retention/deletion rights; whether coach-recorded assessment of a minor requires the same in-app consent before the *first* recording; state-level youth-sports requirements. This design builds the gate and the audit record; it invents no legal language.

### 2.9 Phased implementation plan & validation journeys

Each phase needs its own approval. One approval covers one phase only. No phase merges, deploys, applies a migration live, or enables billing without that step being named in its approval.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Decisions** | Confirm: plan limits/pricing numbers (stored in `subscription_plans.limits`); free-tier display window; past-due grace; consent text owner (counsel); sport-profile contents; homepage copy owner. Record in `docs/MORNING_DECISIONS.md` (§17+). | Written decisions; no code. |
| **1 — Backend foundation** | Migrations 006–008 written on this branch (unapplied); `server/entitlements.js`, `server/saas-store.js` (memory + Postgres-interface), `server/saas-api.js`, `server/billing.js` (fake adapter), extended `assessment-access.js` directory; dev-server routes `/api/saas`, `/api/reservations`, `/api/billing`; unit + contract tests. Existing modules' behavior unchanged (additive only). | Suite green (250 + new); migrations apply cleanly to a scratch Postgres 15 and are idempotent; schema-snapshot test proves no existing table/policy changed except the additive columns + role CHECK. |
| **2 — Tenancy & entitlements proof** | RLS helpers + policies (in the migration files); cross-tenant test suite (API + simulated-RLS via fake client, same pattern as `edge-function.test.js`); entitlement derivation tests (sponsorship precedence, expiry fallback, cap enforcement). | Journey J7 (cross-tenant) and J5/J9 (sponsorship/expiry) pass as executable tests. **Release-blocking gate.** |
| **3 — Frontend (injected UI)** | `saas-ui/` module: auth pages, athlete dashboard extensions, coach roster/assignment composer, org admin view; homepage static page; `index.html` loader line (hash-reviewed commit, same as the assessment precedent). Dev-server end-to-end over real HTTP (same pattern as Phase 4 interruption tests). | Real-browser walkthrough (synthetic data) covering J1–J10 in dev; 0px mobile overflow; existing views byte-preserved except the loader. |
| **4 — Validation** | The 10 journeys below as executable tests + browser walkthrough; live-schema verification package prepared (pre-check → apply → verify → cleanup, the 004/005 pattern) but **not run** without approval. | All 10 journeys pass in the isolated environment; live-apply package ready for Marcus's decision. |
| **5 — Billing test-mode** | Stripe test-mode connection (Marcus), test Products/Prices, `StripeTestAdapter` verified with test cards, webhook Edge Function scaffold (undeployed). | Test-mode checkout → subscription active → entitlement flips; webhook replay idempotent; live mode still refused by construction. |

**The 10 validation journeys (each mapped to its design elements):**

| # | Journey | Design elements exercised | Proof |
|---|---|---|---|
| J1 | **Free athlete:** sign up → account auto-created → dashboard → sees own (empty) history, free-tier limits displayed | §2.1 registration, §2.3 free tier, §2.7 athlete dashboard | API test + browser walkthrough |
| J2 | **Paid remote athlete:** subscribe (test-mode) → full history display, unlimited coach links | §2.3, §2.6 abstraction + fake adapter | Billing test (fake adapter); Stripe test-mode in Phase 5 |
| J3 | **Coach:** sign up → solo tenant auto-created → plan selected → invite athlete → athlete linked → administer GAA assessment → baseline + 28-day due | §2.1, §2.2 links/invitations, existing assessment workflow | End-to-end test (dev server, real HTTP) |
| J4 | **Assignment loop:** coach assigns training (TP2 games + dose) → athlete completes → coach sees completion + history updates | §2.2 migration 007, §2.7 composer | End-to-end test |
| J5 | **Sponsored athlete:** coach sponsors athlete → athlete gets paid access → athlete checkout refused `ALREADY_COVERED` (no double charge) | §2.2 sponsorships, §2.3 precedence, §2.6 guard | Entitlement test |
| J6 | **Organization:** org_admin creates org → invites 2 coaches → coaches see own athletes; org_admin sees org-wide roster | §2.1–2.2 org tables, §2.4 org scoping | API test |
| J7 | **Tenant isolation (release-blocking):** Coach A attempts every read/write on Coach B's athlete (view, assess, assign, history, roster enumeration) — all refused at API and RLS layers | §2.4 (all layers) | Cross-tenant test suite; must pass before any SaaS surface ships |
| J8 | **Minor consent:** minor signs up → gated (`CONSENT_REQUIRED`) → guardian grants consent → full access → guardian withdraws → re-gated, history retained | §2.8 | API test + walkthrough |
| J9 | **Expiry:** paid athlete subscription lapses → free tier, history retained read-only; coach subscription lapses → read-only roster; reactivation restores | §2.3 derivation (no downgrade job) | Entitlement test |
| J10 | **In-person preserved:** $149 member books a session exactly as today (capacity, waitlist, attendance) and simultaneously holds paid remote access with no second charge; expired member refused booking (`MEMBERSHIP`) as today | Existing engine untouched; §2.3 resolution rule (1) | Existing reservation suite (unchanged) + new entitlement test |

---

## 3. Risks, untouched list, and regression protection

### 3.1 Components that must remain untouched

Except where a later, separately approved decision explicitly names the item:

- **The in-person operation:** `memberships` semantics and the $149 price (14900); cohort enrollment caps vs session reservation caps; `session-capacity.js` rules (never guessed, never universal); `reservation-engine.js` eligibility/duplicate/conflict/waitlist/attendance rules; `reserve_seat()`; human approval for session content (`planApprovedBy`); coach-unavailable blocks booking.
- **The assessment system:** GAA battery protocols and the 28-day cycle; measured/observation/interpretation separation; derived baselines; idempotency; draft semantics; baseline gate scope (plan finalization only) + recorded override; progress math + under-18 caveat; the advisory adapter's contract (`advisoryOnly`, no write path); "coach-recorded measurements" framing (decision §8).
- **The prototype:** `THE PROGRAM OS.html` content and behavior (including the 130 TP2 records, tiers, Safety Review/Retired restrictions, and the `field-tested-drills.js` collision guards); `index.html` except a hash-reviewed loader addition; the UI-preservation snapshot discipline.
- **Existing schema:** migrations 001–005 as applied artifacts (never edited retroactively); existing tables/columns/policies except the additive SaaS columns + role CHECK named in §2.2; `training_sessions.plan_id`'s untyped-pointer status (recorded, not "fixed").
- **Standing decisions:** Supabase sole backend; Neon unused/untouched; unified athlete system (no divisions, no age maximum); no automatic prescriptions; no new drill library; Smart Draft advisory-only.
- **Out of scope entirely:** Taskmill, MARVIN, StrikeZoners (different repo), Big Whiff, THE PROGRAM's other ventures.

### 3.2 Compatibility / regression risks

| # | Risk | Mitigation in this design |
|---|---|---|
| R1 | **Tenancy columns break existing queries.** Adding `organization_id` to `coaches`/`cohorts`/`locations`/`training_sessions` could change the meaning of existing reads. | Columns nullable; NULL = internal pre-tenancy tenant; no existing query filters on them; schema-snapshot test asserts existing tables gained *only* the named columns; backfill is a separate approved data step. |
| R2 | **RLS policy addition weakens existing scope.** New permissive policies OR with existing ones — a sloppy link policy could widen coach access. | Policies are additive and narrowly scoped (`is_my_linked_athlete` requires an *active* link row); J7 tests every cross-tenant path; no existing policy is edited. |
| R3 | **Two money systems confused.** `memberships` ($149 in-person) vs `subscriptions` (SaaS) — an implementer could gate booking on subscriptions or remote access on memberships incorrectly. | Separate tables, separate modules; the *only* meeting point is the documented resolution order in `entitlements.js`; J10 pins both directions. |
| R4 | **Entitlement derivation bugs** (sponsorship precedence, expiry) cause double-charges or wrongful lockouts. | Derivation is a pure function over rows — exhaustively unit-testable without Stripe; `ALREADY_COVERED` guard at checkout; lapse never deletes data, so errors are recoverable by re-derivation. |
| R5 | **Assessment scope widening.** Extending `assessment-access.js` for links could accidentally grant assess rights via org membership alone. | Org membership grants *nothing* by itself: assess requires an active link to the caller's coach row (org_admins administer, they do not assess unless also linked coaches); existing cohort tests unchanged + new link tests. |
| R6 | **Prototype hash drift.** `saas-ui/` injection touches `index.html` (and tempts edits to `THE PROGRAM OS.html`). | Same discipline as the assessment integration: loader-only change, hash updated in its own reviewed commit, UI-preservation test extended (including: no live-mode billing strings in UI). |
| R7 | **Homepage becomes an anonymous data leak.** First `anon`-reachable surface. | Homepage is static with no data API; auth pages call only Supabase Auth + JWT-gated functions; no `anon` RLS policies are added anywhere. |
| R8 | **Consent gate bypass via in-person path.** A minor assessed in-person (coach-recorded, no login) then linked remotely without consent. | Gate applies at *remote activation* (link activation, result display, assignments) regardless of how the athlete record was created; counsel question flagged (§2.8) on whether first recording itself needs in-app consent. |
| R9 | **Migration-number collision** with the methodology audit's proposed 006. | SaaS takes 006–008; methodology shadow form renumbered 009 if ever approved (§2.2). Neither is applied by this design. |
| R10 | **Scope creep into prescription/sport content.** Sport profiles + ratings metadata invite auto-selection. | Profiles are filters/emphasis only; assignments are coach-authored; the advisory contract is unchanged; graduation of any suggestion feature is a separate decision after field validation. |

### 3.3 Keeping the 250-test baseline green

- **Baseline:** 250/250 (`npm test`, verified 2026-11-20 on this branch at `fd3678d`).
- **Rule:** new tests are additive files only; no existing test is modified, weakened, or removed. Any phase that turns a baseline test red stops — the failure is investigated on the branch, never merged around.
- **New test families per phase:** migration tests (scratch-Postgres apply + idempotency + schema snapshot); entitlement derivation matrix (member > sponsored > own > free; expiry; caps); cross-tenant suite (J7, API + RLS-simulated); assignment/completion round-trips; consent gate (grant/withdraw/adult-bypass); billing fake-adapter flows (checkout guard, webhook idempotency, live-mode refusal); dev-server HTTP end-to-end for J1–J10; UI-preservation extension (hash + no-live-billing-strings + TP2 row count/IDs unchanged).
- **Rollback:** flag-off equivalent = the SaaS routes simply not mounted (dev) / functions not deployed (production); schema rollback = drop the new tables in reverse dependency order (no production data depends on them until live use is approved); the additive columns are nullable and harmless if left. No rollback migration for existing tables is needed because none are rewritten.

---

## 4. What could not be established (and why)

1. **Stripe test-mode behavior.** The connector is `not_connected` in this environment, so no Stripe tool schema, test context, or webhook behavior could be verified. The billing design is therefore written against the documented connector surface (`list-tools` / `call-tool`, per-operation approval, `stripe_context` selection) and a local abstraction. Everything Stripe-concrete awaits the connection in §2.6.
2. **Live-database state.** Not re-queried (read-only design; the live project must not be touched). The applied state of migrations 001–005 (26/15/72/0) rests on the recorded 2026-11-13 verification in `server/live-checks/`.
3. **Production sign-in.** Never exercised (dev "View as" only). Whether Supabase Auth email flows (confirmation, reset) are configured on the project could not be established without touching it; registration design assumes default Supabase Auth behavior and flags configuration as a deploy-time check.
4. **Pricing and limit numbers.** Plan prices (beyond the existing $149 in-person), roster caps, free-tier window, and grace periods are Marcus's business decisions. The design stores them as data (`subscription_plans.limits`) and uses illustrative values only.
5. **Legal sufficiency of the consent mechanism.** The gate/audit design is specified; the legal text, age thresholds, and verifiable-consent method require counsel (§2.8).
6. **Field validity of anything new.** The GAA battery remains unvalidated (decision §8); sport modules for soccer/basketball do not exist and are not designed here beyond profiles; assignment *effectiveness* is unmeasured — completions record that work was done, never that it worked.
7. **Duplicate-athlete identity resolution.** Linking an existing in-person record to a new remote login is designed as a coach/director (or verified-guardian) action; automated matching/merging is out of scope and undesigned.
8. **Notification delivery.** Reminders/notifications are referenced as entitlement *features* only; no email/push infrastructure exists in the repo, and none is designed here beyond the API surface that would trigger it.

---

## 5. Decision summary for Marcus (Phase 0 inputs)

1. Approve this architecture as the basis for Phase 1 (backend foundation, branch-only, unapplied migrations) — or amend it.
2. Plan catalogue: confirm tier names, roster/coach caps, free-tier display window, past-due grace, monthly/annual pricing (test-mode only until a separate live decision).
3. Guardian consent: engage counsel for text/versioning; confirm the gate scope (remote activation vs first recording).
4. Homepage: confirm copy ownership and that pricing shown pre-live-billing is labelled test-mode/demonstration.
5. Sequencing: confirm the SaaS stack lands after PR #2 → PR #3 (release sequence), and that migration application, Edge Function deploys, and Stripe connection each remain separate approvals.

*End of design. No code, schema, UI, or live system was changed to produce this document.*
