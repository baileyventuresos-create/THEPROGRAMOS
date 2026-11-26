# THE PROGRAM OS — Athlete Pathways & Prospect Portal V1: Backend Notes

**Scope:** Backend only, Marcus mission 2026-11-26, $0 budget. Branch
`feature/athlete-pathways-v1`. Spec: `docs/PATHWAYS_AUDIT.md` §6
(G1–G6, G10). No live Supabase call, no merge, no spend, synthetic
data only, no secrets in code/logs. Tests: `npm test` **331/331**
(baseline 310/310 + 21 new; 0 existing tests weakened or removed —
see "Existing-test updates" below).

## Entitlement precedence now enforced

`resolveAthleteEntitlements` (`server/entitlements.js`), highest first:

1. **(0) Complimentary grant** — `tier:'complimentary'`,
   `planCode:'athlete_remote'`, `source:'complimentary_grant'`, full
   history, unlimited coach links, `grantId` in the return. Same shape
   as the sponsorship branch.
2. (1) In-person membership — `tier:'member'`
3. (2) Sponsorship — `tier:'sponsored'`
4. (3) Own subscription — `tier:'paid'`
5. (4) Free — `tier:'free'`

`athleteCoverageBlock` (`server/billing.js`) now also refuses checkout
for complimentary athletes with `ALREADY_COVERED`
(`coveringSource:'complimentary_grant'`). A revoked or expired grant
falls back to the next covering source by derivation; nothing is
deleted on lapse. Suspension (`athlete.status`) is an account state,
not an entitlement tier — it does not by itself change entitlements.

## Migration 009 — `server/migrations/009_athlete_pathways.sql`

STATUS: NOT APPLIED. Branch-only, additive, idempotent, transactional.
**Not validated on real Postgres** (no engine in this environment;
audit §5) — must be proven on a real Postgres copy before any
production apply.

Tables (all RLS-enabled, director-full-access policies, no anon policies):

| Table | Purpose |
|---|---|
| `complimentary_grants` | G1: athlete_id, granted_by, granted_at, expires_at NULL = indefinite, status active/suspended/revoked, reason, revoked_at; one live grant per athlete (partial unique index) |
| `prospect_profiles` | G3: athlete_id (unique), bio, primary/secondary sport, positions, measurements, accomplishments, playing history, verified metrics, availability, contact_info (never public), status draft/pending_approval/approved, coach_approved_by/at, athlete_approved_at, guardian_consent_id |
| `profile_shares` | G3: profile_id, token_hash (SHA-256), expires_at, revoked_at, status active/revoked/expired |
| `recruitment_contacts` | G4: org name, sport, league, level, region, contact name/title/email/phone, requirements, status new/contacted/evaluating/offered/committed/declined |
| `recruitment_opportunities` | G4: contact_id, type tryout/combine/other, date, notes |
| `recruitment_notes` | G4: contact_id, author, body, follow_up_date |
| `referrals` | G4: contact_id, athlete_id, status referred/contacted/evaluating/offered/committed/declined, outcome, referred_at |
| `prospect_media_links` | G5: profile_id, kind highlight/full_game/other, url, title, approved_by/at — URL/embed links ONLY, no uploads, no Storage |
| `development_goals` | G6: athlete_id, coach_id, goal, target_date, status active/completed/cancelled |
| `scouting_evaluations` | G6: athlete_id, coach_id, body, coach_approved, approved_by/at |
| + additive columns | `athletes.status` (active/suspended, default active); `coach_athlete_links.sport` + `.positions` |
| + seed | The 5 new sport assessment definitions in `assessment_definitions` (engine is source of truth) |

Opportunity levels: collegiate, developmental, pre-professional,
semi-professional, professional, national team. Regions: free text
(WA/OR/CA first by convention, not a CHECK).

## Methods added — `server/saas-api.js`

All server-side enforced via the `ALLOWED` role table + in-method
checks; cross-tenant reads return `ATHLETE_NOT_FOUND`, writes
`FORBIDDEN`. Every owner/grant/profile/CRM/media/goal/evaluation
action writes an audit row via `store.audit()`.

- **G1/G2, director-only:** `ownerCreateAthlete` (manual, no card or
  subscription), `ownerListAthletes` (all athletes + grant status +
  entitlements), `grantComplimentary` (indefinite or `expiresAt`),
  `revokeComplimentary` (by grantId or athleteId), `suspendAthlete`,
  `reactivateAthlete`, `updateAthleteRole` (athlete/parent/coach;
  updates the linked app-user role), `ownerInviteAthlete` (24-byte
  token, SHA-256 hash stored, 7-day TTL, token returned once, **no
  email sent**), `listAudit`.
- **G3:** `createProspectProfile`, `updateProspectProfile` (editing an
  approved profile re-opens it to draft), `approveProspectProfile`
  (one call per side, `approval:'athlete'|'coach'`; status becomes
  `approved` only when BOTH are present; minors additionally require
  a guardian-consent row — `CONSENT_REQUIRED` otherwise),
  `getProspectProfile`, `createProfileShare` (approved profiles only,
  7-day default TTL, revocable), `revokeProfileShare`,
  `listProfileShares`, `getPublicProfile` (**unauthenticated,
  token-only**; returns ONLY the approved public fields — bio,
  sports, positions, measurements, accomplishments, playing history,
  verified metrics, availability, approved media links,
  coach-approved scouting evaluations. Never contact info, training
  notes, or medical info).
- **G4:** `createRecruitmentContact`, `updateRecruitmentContact`,
  `listRecruitmentContacts` (coach sees only own contacts; director
  sees all; filter by status/level/region/sport),
  `createOpportunity`, `addRecruitmentNote`, `referAthlete`,
  `updateReferralStatus`. No mass outreach, no contract negotiation,
  no agent functionality.
- **G5:** `addMediaLink` (valid http(s) URL required; non-URLs and
  non-http(s) schemes refused), `removeMediaLink`, `listMediaLinks`.
  Media visibility follows the profile's sharing state.
- **G6:** `assignSport` (stores sport + positions on the active
  coach-athlete link), `setDevelopmentGoals`,
  `updateDevelopmentGoal`, `listDevelopmentGoals`,
  `recordScoutingEvaluation` (coach-authored = coach-approved on
  record unless `coachApproved:false`), `listScoutingEvaluations`.

## Store — `server/saas-store.js`

Memory mirror of the 009 tables plus accessors:
`activeComplimentaryGrantsFor(athleteId, now)`,
`complimentaryGrantById`, `prospectProfileById/ByAthlete`,
`profileShareByTokenHash`, `profileSharesFor`,
`mediaLinksForProfile`, `recruitmentContactById`, `referralById`,
`opportunitiesForContact`, `notesForContact`, `referralsForContact`,
`goalsForAthlete`, `evaluationsForAthlete`.

## Sport configs — G6

`assessment-engine/assessment-engine.js`: 5 new measured definitions
(`30m-sprint`, `t-test-agility`, `vertical-jump`, `lane-agility`,
`40yd-dash`; all `retestDays:28`, no norms/thresholds/scores) and
`BATTERIES.soccer` / `.basketball` / `.football` / `.flag_football`.
`server/assessment-battery.js`: protocol entries for the 5 tests
(`SPORT_TESTS`), `SPORT_BATTERIES`, `SPORTS`, `sportTestsFor(sport)`;
`protocolFor`/`isMeasured` now also resolve sport tests. The 8-test
GAA core is untouched and remains the shared baseline for every
sport; football/flag_football batteries reuse GAA definitions
(`broad-jump`, `5-10-5-shuttle`) where they fit.

## Tests — 21 new

- `server/tests/pathways-complimentary.test.js` (9): precedence over
  member/sponsored/paid/free; revoke + expiry fallback; checkout
  `ALREADY_COVERED`; grant/suspend/reactivate/revoke lifecycle +
  audit rows; owner-only enforcement; owner create/list; role
  update; invitation token-hash + 7-day TTL; indefinite grant.
- `server/tests/pathways-profiles-crm.test.js` (7): dual approval;
  minor consent gate; public-field allowlist; revoked/expired share
  refusal; Coach A/B tenant isolation; CRM CRUD + referral
  transitions; media URL-only.
- `server/tests/pathways-sports-migration.test.js` (5): sport
  batteries + GAA intact; `assignSport` link storage; goals +
  evaluations visible to the athlete; only coach-approved
  evaluations in the public profile; migration 009 invariants.

## Existing-test updates (not weakenings)

- `tests/ui-preservation.snapshot.json`: hash for
  `assessment-engine/assessment-engine.js` updated to the new file —
  the sanctioned procedure in `ui-preservation.test.js` itself
  ("If intentional, update the snapshot with a reviewed commit";
  precedent: v1.1.0 GAA extension, 2026-11-12). No existing engine
  definition changed; 5 definitions added only.
- `server/tests/assessment-store.test.js`: the "migrations seed
  exactly the engine definitions" pin now also checks migration 009
  for the 5 new sport definitions. The invariant is unchanged —
  every engine definition must be seeded by a migration.

## What is NOT done

- **No UI** (no prospect-portal, owner-console, or CRM screens;
  `saas-ui.js` untouched). UI is the coordinator/frontend builder's
  scope; audit G7 sketches the extension points.
- **No Edge Function** (no `supabase/functions/saas-api/` sibling;
  audit G8). Dev-server transport only.
- **No production sign-in / Supabase Auth plumbing** (audit G9).
- **No real-Postgres validation** of migration 009 (audit §5/G10):
  no Postgres engine exists in this environment; 009 must be proven
  on a real Postgres copy before any production apply.
- **No media uploads/storage**, no generative video, no mass
  outreach, no contract negotiation, no agent functionality, no
  norms/percentiles/rankings/readiness scores — all deliberately
  excluded per the audit and the mission.
- **No complimentary coach seats**: `resolveCoachEntitlements` has
  no grant hook (audit §1.1 — separate decision for Marcus).
- Suspension does not alter entitlement resolution (account state
  only); whether a suspended athlete should lose access is an owner
  decision, not implemented.
- `updateAthleteRole` changes the linked app-user role; it does not
  create a new auth identity or touch Supabase Auth.
