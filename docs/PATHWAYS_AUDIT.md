# THE PROGRAM OS — Athlete Pathways & Prospect Portal V1: Audit

**Scope:** READ-ONLY audit, Marcus mission 2026-11-26, $0 budget. Branch
`feature/athlete-pathways-v1` (from SaaS head `35df1a2`). No live Supabase
call, no merge, no other file touched. Test baseline: `npm test` **310/310
pass, 0 fail** (run 2026-11-26, ~5.8 s).

## 1. Codebase map

| Piece | File | Size / notes |
|---|---|---|
| SaaS API (24 methods) | `server/saas-api.js` | 858 lines. `createSaasApi({store, billing, assessmentHistory})`; role table `ALLOWED`; `{method, params}` dispatch. |
| SaaS memory store + plans | `server/saas-store.js` | 209 lines. `MemorySaasStore` (Maps/arrays, same method surface a Postgres store would implement); `PLANS` catalogue mirrors migration 008 seed; `PROGRAM_INTERNAL_ORG_ID = 11111111-1111-4111-8111-111111111111`; game validation TP2-001..130, 6 blocked (5 Safety Review + 1 Retired). |
| Entitlements (computed) | `server/entitlements.js` | 191 lines. Pure functions over store rows + injectable `now`. See §1.1. |
| Billing (test-mode only) | `server/billing.js` | 179 lines. `FakeBillingAdapter` (in-memory); `StripeTestAdapter` refuses live keys by construction (`BILLING_LIVE_MODE_REFUSED`), makes no network calls, no Stripe connection exists. |
| Assessment battery | `server/assessment-battery.js` | 251 lines. GAA protocol `gaa-v1`, `RETEST_DAYS = 28`. |
| Assessment workflow/API/access | `server/assessment-workflow.js` (446), `server/assessment-api.js` (169), `server/assessment-access.js` (167) | 13 assessment methods; directory-based scoping. |
| Progress calculator | `server/progress.js` | `compareValues / progressForTest / progressForAthlete`. |
| Reassessment engine | `server/reassessment.js` | 28-day due dates, approaching window 7 days, deferrals. |
| Reservations (in-person) | `server/api.js` (134), `server/reservation-engine.js` | 7 methods; **no HTTP transport** (no Edge Function for it). |
| Dev server | `server/dev-server.js` | 425 lines. Node `http`, binds 127.0.0.1:8123, memory stores, synthetic seed only. Routes: `GET /` → `index.html`; static files; `GET /api/assessments/battery`; `POST /api/assessments`; `GET /api/saas/plans`; `POST /api/saas`; `POST /api/billing`. Auth = `X-Dev-Role / X-Dev-User / X-Dev-Athlete` headers, default director — dev-only, never ships. |
| App shell | `THE PROGRAM OS.html` (2,752 lines), `index.html` (loader), `homepage.html` (269) | Single-file prototype + `window.TP_DATA` (130 games). `index.html` fetches the OS html and injects `launch60-*.js`, `field-tested-drills.js`, `assessment-ui/*`, `saas-ui/*` before `boot()`. |
| SaaS UI | `saas-ui/saas-ui.js` (1,330), `saas-ui/saas-client.js` (215) | Wraps `window.vDashboard` (hub prepended), `vCoach`, `vAthleteMode`, `vAthlete`; never edits the OS html. Tabs: account / athlete / coach / org. |
| Assessment UI | `assessment-ui/assessment-ui.js` (969), `assessment-client.js` (200) | Same wrap pattern; progress tables (see §2). |
| Assessment engine | `assessment-engine/assessment-engine.js` (82) | v1.1.0 calculation source of truth. |
| Edge Function | `supabase/functions/assessment-api/` (`index.ts`, `api.ts`, `directory.ts`, `store.ts`, `workflow.ts`, `build.mjs`, `deno.json`); `supabase/config.toml` (`verify_jwt = true`) | **UNDEPLOYED** (docs/EDGE_FUNCTION_DEPLOY_STEPS.md; deploy needs Deno + Supabase CLI + separate approval; project ref `rkgdwqgmldznczikrjip`). |

### 1.1 Entitlements today — and the complimentary insertion point

`resolveAthleteEntitlements(store, athleteId, now)` in `server/entitlements.js`
(resolution order fixed by docs/SAAS_ARCHITECTURE.md §2.2/§2.3), returns
`{tier, planCode, source, fullHistory, historyDays, maxCoachLinks,
trainingDaysPerWeek, limits, …ids}`:

1. **(1) In-person membership** — `membershipsFor()` + `membershipCovers()`
   (status active/trialing, covering `now`) → `tier:'member'`,
   `planCode:'athlete_remote'`, `source:'in_person_membership'`, full history,
   unlimited links/days.
2. **(2) Sponsorship** — `activeSponsorshipsFor()`; sponsor subscription must
   grant access (`subscriptionGrantsAccess`: trialing/active within period;
   past_due until `currentPeriodEnd`; cancelled only if `cancelAtPeriodEnd`
   within period) → `tier:'sponsored'`, `source:'sponsorship'`, full history.
3. **(3) Own subscription** — `bestSubscription(subscriptionsFor('athlete', id))`
   (latest period end wins) → `tier:'paid'`, limits from plan.
4. **(4) Free** — `tier:'free'`, `planCode:'free_athlete'`, 90-day history,
   1 coach link, 1 training day/week.

Coach: org subscription > own subscription > read-only (`resolveCoachEntitlements`).
Org: own subscription or read-only (`resolveOrgEntitlements`). No tier is ever
stored — lapse needs no downgrade job; derivation is live.

**Complimentary access must slot in ABOVE (1), as new step (0), in
`resolveAthleteEntitlements`** — before the membership check, same shape as
the sponsorship branch: a new store accessor (e.g.
`store.activeComplimentaryGrantsFor(athleteId)`) + a new tier
(e.g. `tier:'complimentary'`, `source:'complimentary_grant'`, full history,
unlimited links) with `grantId` in the return. It must also be honoured in
`server/billing.js: athleteCoverageBlock()` — today that blocks checkout only
for `member`/`sponsored`; a complimentary athlete must get the same
`ALREADY_COVERED` refusal (extend the `if (ent.tier === …)` check). Mirror
for coaches only if Marcus wants complimentary coach seats (separate
decision; `resolveCoachEntitlements` has no grant hook today). New table
`complimentary_grants` (migration 009, §6) + RLS; audit via existing
`store.audit()` / `operational_audit_events`.

### 1.2 How invitations, consent, orgs, links, assignments/completions work

- **Registration:** `registerAthlete` (athlete/director; creates `app_users` +
  `athletes`, returns entitlements) / `registerCoach` (creates solo org,
  org_admin membership, 14-day `coach_starter` trial) / `createOrganization`
  (kind team/academy; org trial `team_academy`). Provisioning on first
  authenticated call; no Supabase Auth sign-up code exists anywhere in repo.
- **Invitations:** `inviteToOrg` (org_admin/director; coach-role; enforces org
  coach cap) / `inviteAthlete` (coach/org_admin/director; role athlete|parent).
  Token = 24 random bytes, **SHA-256 hash stored only**, raw token returned
  once; TTL 7 days (`INVITE_TTL_MS`); `acceptInvitation` hashes, checks
  pending + expiry, then creates org membership (coach) or calls `linkAthlete`
  (athlete/parent). No email is sent — there is no mailer; tokens are returned
  to the inviter in the API response.
- **Guardian consent:** `grantConsent` / `withdrawConsent` (parent/director
  only). Append-only `guardian_consents` rows; current state = latest row;
  `store.hasConsent()` gates `linkAthlete` and `createAssignment` /
  `completeAssignment` for minors (`requireConsent`; `isMinor` via age/dob).
  Legal text is counsel's — the module is mechanism only.
- **Orgs:** `organizations` (kind solo/team/academy/program_internal) +
  `organization_memberships` (org_admin/coach). `orgOverview` (org_admin/
  director). Director sees all; org_admin sees own org only.
- **Coach–athlete links:** `linkAthlete` (consent gate → coach must be active
  subscription, else `SUBSCRIPTION_INACTIVE` → roster cap with explicit
  `confirmOverage` → athlete free-tier 1-link cap) / `unlinkAthlete` (status
  → `ended`, data retained) / `myRoster`. Links are tenant-scoped
  (`coach_id, athlete_id, organization_id`, partial unique index on active).
  Athletes are tenant-neutral: ending a link ends access, never data.
- **Assignments/completions:** `createAssignment` (coach/director; requires
  title + linked athlete + consent; `game_ids` validated against assignable
  TP2 ids; `build` ∈ LEARN/COMPETE/PRESSURE/CHAOS; `dose` JSONB; optional
  `development_plan_id`) / `listAssignments` / `completeAssignment` (athlete/
  director; one completion per assignment — `UNIQUE(assignment_id)`,
  duration/effort RPE 1–10/notes; coach annotates via `coach_note`).
  `athleteHistory` merges assignments + completions + assessment history and
  applies the entitlement window (`historyDays`; `truncated: true` when rows
  are hidden — rows retained, never deleted).
- **Sponsorship:** `sponsorAthlete` / `endSponsorship` (coach/org_admin/
  director). Sponsor's subscription covers the athlete; billing refuses
  double-charge (`ALREADY_COVERED`).
- **Plans:** `listPlans`; `myEntitlements`, `mySubscription`,
  `cancelSubscription`, `expireSubscription` (director only). Trials:
  14 days, coach/org tiers only, auto-started on registration.

### 1.3 Dev server vs Edge Function

Same service modules, different transport/auth. Dev: Node `http`, memory
stores, header auth, `{method, params}` JSON dispatch, `POST /api/saas` +
`/api/billing`, `GET /api/saas/plans`. Edge (`supabase/functions/
assessment-api/index.ts`): Deno.serve, `verify_jwt = true`, `auth.getUser(token)`
→ user-scoped Supabase client (RLS applies), **no service-role key**,
directory built from DB per request. **Differences that matter for Pathways:**
(1) no `saas-api` Edge Function exists — design §378 proposes a sibling
function reusing the auth/dispatch pattern; (2) the Edge `directory.ts` does
not yet build SaaS links/orgMemberships (comment in `api.ts`: org_admin scope
is partial); (3) no billing-webhook function exists (proposed, service-role
only, writes `billing_events` + subscription status); (4) no reservation
transport at all. Dev-server SaaS state is wiped on restart; Edge state is
the live DB under RLS.

## 2. Assessment Engine V1 — reuse for Pathways

**Battery (reuse as-is):** GAA `gaa-v1`, 8 tests / 9 definition ids, 28-day
cycle (`server/assessment-battery.js`): 10yd sprint (Acceleration, sec,
lower, 3 attempts, band 0.05), broad jump (Power, in, higher, 3, band 1),
5-10-5 shuttle (Agility, sec, lower, 2, band 0.05), push-ups (Muscular
endurance, reps, higher, 1, band 1), side plank L/R (Core endurance, sec,
cap 120s), single-leg balance L/R (Balance, sec, cap 60s), 6-min walk/run
(Cardiovascular, m), movement assessment (Mobility, **observation-only, no
numeric result**). Protocol text (instructions/conditions/warm-up/safety/
valid-invalid criteria, youth/adult alternatives, `modified`/`capped` flags)
lives in the battery module; numeric aggregation (best, unit, direction,
attempts) in `assessment-engine/assessment-engine.js` v1.1.0.
**Already sport-specific in the engine:** `DEFINITIONS` has a `module:
'baseball'` trio — `throw-velo` (mph, 5 attempts), `throw-accuracy` (pct),
`exit-velo` (mph) — and `BATTERIES.baseball = [throw-velo, throw-accuracy,
exit-velo]` alongside `generalAthleticAssessment` and `generalAthlete`.
No soccer/basketball/football/flag-football definitions exist anywhere.

**Reassessment (reuse):** `server/reassessment.js` — due = last completed +
28d; statuses (never-assessed / due / approaching ≤7d / overdue / deferred);
`scheduleFor`, `reassessmentReminders`, deferral validation + recording.
**Progress calculator (reuse):** `server/progress.js` — per-test vs baseline /
vs previous / vs personal best, `improved | maintained | regressed` against
the test's maintenance band, percent null when baseline is 0, under-18
growth/maturation caveat on every record. **Deliberate limits (do not
weaken):** no population norms, percentiles, rankings, or medical
thresholds; athletes compared only to themselves; no auto-prescription —
`advisoryPriorities` is advisory-only, coach always decides.
**Workflow (reuse):** `assessment-workflow.js` — drafts, attempt recording,
`athleteAssessmentView` (history + PBs + progress + due dates),
`coachDashboard`, `planReadiness`, `advisoryPriorities`, `createPlan` /
`finalizePlan` (gated plans). `assessment-access.js` directory scoping
(cohort + SaaS links + org_admin read-only) is the access model to extend.

**What exists for trend visualisation:** only **tables, not charts**.
`assessment-ui.js` renders a per-test progress table (baseline / previous /
current / personal best ★ / vs-baseline ±abs (pct%) / status label) and a
personal-best list. No canvas/SVG/chart library, no time-series component,
no sparklines. `progressForAthlete` returns the exact per-test series
inputs (`{recordedAt, result}` histories) a chart needs — the data layer is
ready, the visualisation layer is not.

**Missing for sport-specific categories:** (a) no sport config table/module
— sport is a free-form `athletes.sports` array today, never validated or
used in logic; (b) no per-sport battery/category mapping (only the baseball
trio proves the pattern: add definitions + a `BATTERIES.<sport>` entry +
protocol text in `assessment-battery.js`); (c) no trend chart component;
(d) no per-sport norms — and per the standing rule, none should be invented;
trend = athlete vs own history only.

## 3. UI / visual identity — exact values to copy

Source: `THE PROGRAM OS.html` lines 6–~200 (tokens) and `homepage.html`
(same tokens, light subset). Concept comment: *"the scorer's table —
hard-edged panels, hairline rules, gym-tape yellow marks what matters,
numbers in scoreboard mono."* **No border-radius anywhere; no shadows;
no gradients. Everything is 1px hairlines and square corners.**

Light theme tokens (copy verbatim):
`--bg:#ECEEED; --surface:#F8F9F8; --sunk:#E2E5E3; --ink:#121514;
--muted:#59625E; --line:#C7CDCA; --line-strong:#9AA39F;
--tape:#F2C300; --tape-ink:#121514; --side:#121514; --side-ink:#ECEEED;
--side-muted:#8E9893; --crit:#B8321C; --warn:#9A6410; --ok:#2B7349;
--info:#2F5D86; --crit-bg:#F4DDD8; --warn-bg:#F3E7CF; --ok-bg:#D9EADF;
--info-bg:#DCE6EF;`
Dark theme (`prefers-color-scheme: dark` or `[data-theme="dark"]`):
`--bg:#0E1110; --surface:#161A19; --sunk:#1D2221; --ink:#E7EBE9;
--muted:#97A29D; --line:#2A312F; --line-strong:#46504C; --tape:#F2C300;
--side:#070908; --side-ink:#E7EBE9; --side-muted:#7D8883;
--crit:#FF7A62; --warn:#E8B04E; --ok:#5FC98D; --info:#7EB3E6;
--crit-bg:#3A1C16; --warn-bg:#352812; --ok-bg:#15301F; --info-bg:#172736;`
(Tape yellow `#F2C300` is identical in both themes.)

Typography (Google Fonts, same link in both files):
`--display:"Archivo","Arial Narrow","Helvetica Neue",Arial,sans-serif;`
`--body:"Public Sans","Helvetica Neue",Arial,sans-serif;`
`--mono:"JetBrains Mono",ui-monospace,"SFMono-Regular",Menlo,monospace;`
Headings: `.disp` — Archivo, `font-stretch:72%`, weight 850, uppercase,
`letter-spacing:.005em`, `line-height:.95`. Eyebrows: mono 10.5px,
`letter-spacing:.12em`, uppercase, muted. Body 14px (app) / 15px (homepage),
`line-height:1.5` / 1.55. Numbers/KPIs: mono, tabular-nums; KPI value 26px
bold. Focus ring: `2px solid var(--tape)`, offset 2px.

Patterns (copy, don't redesign):
- **Top strip:** `.scenario` / homepage `.testbar` — tape-yellow bar, mono
  11px, uppercase, `letter-spacing:.06em`.
- **Topbar:** sticky, surface bg, 1px bottom border, 10–12px × 16–20px
  padding. Brand: `.wm` Archivo 900, `font-stretch:62%`, 24px, with the
  first word in an inverted ink chip (`background:var(--ink);
  color:var(--bg); padding:1px 5px 0`); tagline mono 10px `.14em` muted.
  Wordmark text: `THE PROGRAM`, tagline `PLAY WITH PURPOSE.`
- **Role switcher:** `.roles` — 1px ink border, mono 11px uppercase buttons;
  active = ink bg / bg text.
- **Director shell:** `.shell { grid-template-columns: 212px minmax(0,1fr) }`;
  dark sidebar `.side` (ink bg), group labels mono 10px `.14em` side-muted,
  nav buttons Archivo 700 15px uppercase with 3px left border — active =
  tape border + `rgba(255,255,255,.08)` bg; counts in mono 10.5px.
  Main: `padding: 24px 28px 64px`.
- **Panels:** `.panel { background:var(--surface); border:1px solid
  var(--line) }`; header `.ph` 12px/16px padding, 1px bottom border, `h3`
  Archivo 800 17px uppercase `font-stretch:78%`. Grids: `.g2`/`.g3`,
  `gap:16px`; `.g-main` = 1.6fr/1fr.
- **Buttons:** `.btn` — inline-flex, 1px ink border, transparent bg,
  7px/12px padding, mono 11px uppercase `.08em`; hover sunk bg;
  `.solid` ink bg; `.tape` tape bg/border; `.ghost` line-strong border;
  `.sm` 4px/8px, 10px.
- **Labels:** `.lbl` mono 9.5px 600 `.1em` uppercase, 2px/6px padding,
  1px `currentColor` border; variants `.locked` (ink fill), `.needdef`
  (tape), `.needval` (info), `.draft` (warn), `.crit`/`.ok`.
  Chips: 1px line-strong border, 3px/8px; `.on` = ink fill.
- **KPI strip:** `.kpis` grid `repeat(auto-fit,minmax(128px,1fr))`, 1px
  border, surface bg; `.kpi` 12px/14px, value mono 26px bold.
- **Tables:** `table.t`, 13px; `th` mono 10px 600 `.1em` uppercase muted,
  8px/10px, bottom border line-strong; `td` 9px/10px, bottom border line.
  Status dot: 7px square `::before` (ok/warn/crit/tape).
- **Homepage extras:** `.wrap { max-width:1080px; margin:0 auto;
  padding:0 20px }`; hero `h1 clamp(38px,7vw,72px)`; 3-step `.cycle` and
  `.grid3` cards (surface, 1px border, 16px padding); plan cards with mono
  26px price; breakpoint 760px collapses grids to 1 column, hero padding
  36px/24px.
- **Copy anchors (do not rewrite):** homepage title `Test. Train. Retest.
  Every 28 days.`; sections `One system, three doors` / `Simple bands,
  assessment included`; footer honesty line (unvalidated battery, coach-
  authored assignments, guardian consent for minors). GAA honesty rule:
  results are coach-recorded measurements — never norms/percentiles/
  rankings/diagnoses.

## 4. Infrastructure capacity + zero-spend verdict

**Project facts (from repo docs only; no live call made):**
TheProgramOS, ref `rkgdwqgmldznczikrjip`, org BigWiffWiffleBallLeague,
**Pro plan**, region **us-east-2**, Postgres **15.8.1.50**, **Micro** compute,
created 2026-10-13, status ACTIVE (docs/MORNING_DECISIONS.md,
docs/MIGRATION_EXECUTION_PLAN.md). Live state last verified 2026-11-13:
migrations 001–005 applied — **26 tables / 15 definitions / 72 policies /
0 rows**, **0 auth users** (docs/SAAS_ARCHITECTURE.md §1.4,
docs/RELEASE_READINESS.md). Migrations 006–008 are **branch-only,
unapplied** (headers in each file say so).

**Current usage (verified from code/docs):** Storage — **none used**; no
bucket, no `supabase.storage` call, no media column exists in any migration.
Edge Functions — **none deployed** (assessment-api scaffold only; deploy
steps unexecuted; function URL would be
`https://rkgdwqgmldznczikrjip.supabase.co/functions/v1/assessment-api`).
Auth — 0 users at last inspection; no sign-up code. Realtime — not used.
DB rows — 0 at last verification; all test/dev data is in-memory only.
Dependencies: only `pg ^8.23.1` (package.json); no build step; tests run
on Node's built-in runner.

**Plan limits — NOT stated in the repo:** no numeric Pro-plan limit (DB
size, storage GB, Edge Function invocations, MAU, bandwidth, Micro
compute caps) appears in any repo doc or code file. This audit does **not**
assert Supabase's published Pro numbers from memory; they are unverified
here and must be confirmed from Supabase's own pricing/limits page before
any capacity claim is made to Marcus. What the repo does prove is the
usage side: the app is at or near zero on every metered dimension
(0 rows, 0 auth users, 0 storage, 0 deployed functions), and the Pathways
V1 work as scoped is additive tables + RLS + one Edge Function sibling +
static UI — the same shape already proven at 310/310 in tests. **Verdict:
$0 additional cost is credible for build + dev + test; no spend is
required by anything in this audit.** Cost risks (all gated, none
triggered by building): (1) Stripe — live mode is refused by construction;
test mode needs Marcus's connector approval; (2) Edge Function deploy is a
separately approved step; invocations scale with real users, who do not
exist yet; (3) media links in Pathways (video/photos) — if stored in
Supabase Storage later, that is a new metered surface needing its own
approval and a storage design (today: links only, no uploads);
(4) Micro compute + Pro DB size only become relevant at real user volume,
which is a launch decision, not a build cost.

## 5. Real Postgres availability in this environment — NO

Checked 2026-11-26: `which psql postgres pg_ctl initdb docker podman deno
supabase` → **only `node` and `npm` found**; `psql`, `postgres`, `pg_ctl`,
`initdb`, `docker`, `podman`, `deno`, `supabase` all absent.
`/usr/lib/postgresql/`, `/usr/local/pgsql/`, `/opt/postgres*` do not exist;
`find /usr /opt /home/hatch -maxdepth 4 -name postgres -type f` returned
nothing. `node_modules/` does not exist in the repo (only dep `pg` is
declared, not installed) — yet `npm test` passes 310/310 because the suite
runs against memory/SQLite-style stores, not a live Postgres. **Verdict:
NO real Postgres engine is available in this environment.** The
migration-validation gate (prove migrations on real Postgres before any
production apply) **cannot be satisfied here** — it needs either a Neon
scratch branch, a Supabase scratch project, or a Postgres install on a
machine that has one, each a separately approved step. Do not claim any
006–009 migration as validated until that run happens on real Postgres.

## 6. Gaps for the builders (reuse-first sketches)

| # | Gap | Smallest reuse-first sketch |
|---|---|---|
| G1 | **Complimentary grants** (owner-granted free access) | New `complimentary_grants` table in migration **009** (athlete_id, granted_by, reason, starts/ends_at, status; RLS director-only write); `MemorySaasStore.activeComplimentaryGrantsFor()` in `server/saas-store.js`; step (0) in `resolveAthleteEntitlements` (§1.1) + `athleteCoverageBlock` in `server/billing.js`; tests in `server/tests/entitlements.test.js`. |
| G2 | **Owner account management** (Marcus/director admin: grant/revoke complimentary, manage orgs/users, view audit) | No owner console exists — director is only a role in `ALLOWED` + dev-seed headers. Extend `saas-api.js` with director-only methods (`grantComplimentary`, `revokeComplimentary`, `listAudit` over existing `store.audit()`/`operational_audit_events`); surface in `saas-ui.js` director tab reusing `.panel`/`.btn` patterns. No new auth system. |
| G3 | **Prospect profiles + sharing links** | New tables in migration 009: `prospect_profiles` (athlete_id FK nullable — prospects may be pre-registration — sport, age band, school/club, contact consent flag, notes) + `profile_shares` (token_hash SHA-256 pattern copied from `invitations`, 7-day TTL copied from `INVITE_TTL_MS`, status pending/used/expired/revoked). API methods in `saas-api.js` modelled on `inviteAthlete`/`acceptInvitation` (same token-hash + TTL code path); public read route renders with homepage tokens. Guardian consent gate applies before any minor's profile is shareable. |
| G4 | **Recruitment CRM** (pipeline stages, notes, follow-ups, coach contacts) | New `recruitment_notes` + `recruitment_stage` on prospect profile (migration 009; stage as CHECK text, e.g. `new/contacted/evaluating/offered/committed/declined` — values are Marcus's decision). Reuse `store.audit()` for the activity trail instead of a new audit table; coach-scoped list reuses `myRoster` scoping. No external CRM, no email sending. |
| G5 | **Media links** (video/photo URLs on a profile) | New `prospect_media_links` table (migration 009: profile_id, kind video/photo, url, label, added_by; URL-only — **no uploads, no Storage bucket**). Validate URL shape server-side in `saas-api.js`; render as plain links in `saas-ui.js` athlete-profile section (`renderAthleteProfileSection`). Storage-backed uploads are a separate, cost-bearing decision. |
| G6 | **Sport configs** (soccer / baseball / basketball / football / flag football) | Follow the proven baseball pattern: add definitions to `assessment-engine.js` `DEFINITIONS` + `BATTERIES.<sport>`, protocol text to `server/assessment-battery.js` (instructions/safety/alternatives per test), and a `sport_profiles` data table or config object (migration 009 or a `server/sport-profiles.js` module) mapping sport → battery ids + emphasis categories. Profiles are **filters/emphasis only** — assignments stay coach-authored; no auto-prescription (standing rule, SAAS_ARCHITECTURE R10). Baseball trio already exists; other four sports have zero definitions today. |
| G7 | **Athlete portal beyond the SaaS athlete hub** | `saas-ui.js` `renderAthlete` already gives: entitlements, open assignments, history (90-day/free vs full). Missing for Pathways: prospect-profile view/edit, share-link management, trend charts (§2), media links. Extend `renderAthlete` + `renderAthleteProfileSection` in the same file; add API methods to `saas-api.js` (`getProspectProfile`, `updateProspectProfile`, `listProfileShares`); no new UI framework. |
| G8 | **SaaS Edge Function + billing webhook** (production transport) | New `supabase/functions/saas-api/` sibling of `assessment-api`, copying `index.ts` auth/dispatch pattern (JWT → user-scoped client, `verify_jwt = true`); fix Edge `directory.ts` to build SaaS links/orgMemberships (known gap, §1.3); `billing-webhook` function later, service-role only. Both undeployed until separately approved. |
| G9 | **Registration / sign-in** (production) | No Supabase Auth sign-up code exists. `registerAthlete`/`registerCoach` provision rows on first authenticated call — the missing step is the Auth sign-up + JWT plumbing (design §2.2). Reuse the Edge Function's `verifiedClient` pattern; email/password first, OAuth later, each separately approved. |
| G10 | **Migration validation** | §5: no local Postgres. Validation must run on a real Postgres copy (Neon scratch / Supabase scratch) per the production-migration-validation protocol before 006–009 are applied live. Migrations 006–008 remain unapplied; 009 must be written additive + idempotent like them. |

## 7. Test baseline

`npm test` (2026-11-26, this branch): **310 tests, 310 pass, 0 fail,
0 skipped** (`node --test server/tests/*.test.js
assessment-engine/assessment-engine.test.js`). No tests modified. Note:
the suite runs against memory stores — it does **not** validate SQL
against real Postgres (§5).

## 8. Audit verdict

Pathways V1 is buildable reuse-first at $0: entitlements, invitations,
consent, links, assignments, the GAA battery + 28-day cycle + progress
calculator, the SaaS UI hub, and the visual system all exist and are
tested. The work is additive: one entitlement step, one migration (009),
a prospect/share/CRM/media slice modelled on invitations, sport configs
following the baseball pattern, and a trend-chart component over data the
progress calculator already returns. Blockers that are **not** build
blockers but are launch gates: real-Postgres migration validation (§5),
Edge Function deploy + SaaS transport (§1.3, G8), Stripe test-mode
connection, production sign-in (G9), and Marcus's decisions on
complimentary scope, sport-profile contents, CRM stages, and consent text
for prospect sharing.
