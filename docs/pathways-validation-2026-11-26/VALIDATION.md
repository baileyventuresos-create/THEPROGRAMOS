# Athlete Pathways & Prospect Portal V1 — Independent Validation

Date: 2026-11-26 · Validator: independent worker (did not build this) · Branch:
`feature/athlete-pathways-v1` · $0 spend · Synthetic data only · No live
Supabase project touched · No source code modified (this doc only).

Method: `npm test` run by the validator; the 15 acceptance criteria exercised
live over HTTP against the real dev server (`node server/dev-server.js`,
127.0.0.1:8123, seeded memory stores) with validator-written scripts
(`/tmp/validation-e2e.mjs`, `/tmp/validation-e2e2.mjs`,
`/tmp/validation-c7.mjs` — not the builders' scripts); 4 screenshots opened
and inspected directly; diff greps for secrets, external services, and gaps;
migration file read + environment re-check for a real Postgres engine.

## 1. Git state

| Check | Result |
|---|---|
| Current branch | `feature/athlete-pathways-v1` |
| HEAD | `97aa12c` — "Pathways: visual validation — 10 screenshots + per-shot verification notes" |
| Working tree | Clean at start; only this doc added by validation |
| Commits since `35df1a2` | 12: `3e0d0d3` audit, `627665b` G1, `1c1354d` migration 009, `b564e9c` G2–G6, `45e98d6` G6 sport configs, `587d458` 21 new tests + snapshot/seed-pin updates, `89c212d` backend notes, `253aaba` SaaS client + dev-server public route, `33b188b` owner/athlete/coach portals + charts, `650c06c` prospect.html + homepage section, `94842d5` 21 UI tests, `97aa12c` screenshots |
| Pushed? | Yes — branch in sync with `origin/feature/athlete-pathways-v1` at start (`97aa12c`) |
| main untouched? | Yes — `main` = `dc5d42d` ("Add Assessment Engine V1 foundation"), unchanged |
| PR #2 / #3 | Both OPEN but belong to earlier branches, not this one: #2 = `feature/program-operational-foundation-v1`, #3 = `feature/universal-assessment-reassessment-v1`, both MERGEABLE. **No PR exists for `feature/athlete-pathways-v1`.** None created by the validator. |
| Diff since `35df1a2` | 32 files, +5225/−20. Only one pre-existing test file changed (`server/tests/assessment-store.test.js`, +5/−1); only one pre-existing source file changed in the engine (`assessment-engine/assessment-engine.js`, additive only). |

## 2. Test suite (run by the validator)

- `npm test`: **352 tests, 352 pass, 0 fail, 0 skipped** (~6.3 s).
- Baseline intact: 310 (at `35df1a2`) + 42 new Pathways tests = 352.
  - `pathways-complimentary.test.js`: 9/9
  - `pathways-profiles-crm.test.js`: 7/7
  - `pathways-sports-migration.test.js`: 5/5
  - `pathways-ui.test.js`: 21/21
  - (Backend notes quote 331/331 — that was the backend-only state before the 21 UI tests landed.)
- No existing test weakened: the only pre-existing test-file change is
  `assessment-store.test.js`, where the "migrations seed exactly the engine
  definitions" pin now also accepts migration 009 as a seed source for the 5
  new sport definitions. The invariant is unchanged (every engine definition
  must be seeded by some migration); no assertion was removed, no test was
  skipped or deleted. Verified by diff: 1 line changed in that file, both
  sides shown in §2 of the validator's working notes.
- Snapshot update is invariant-preserving and documented:
  `tests/ui-preservation.snapshot.json` hash for
  `assessment-engine/assessment-engine.js` changed `a2f85b…` → `1e0c32…`.
  The engine diff is purely additive — 5 new measured definitions
  (`30m-sprint`, `t-test-agility`, `vertical-jump`, `lane-agility`,
  `40yd-dash`) + 4 sport batteries; the 8-test GAA core is byte-unchanged.
  Commit `587d458` ("extend seed pin to 009, update engine snapshot hash")
  and `docs/PATHWAYS_BACKEND_NOTES.md` ("Existing-test updates") both
  document it; the snapshot procedure itself sanctions this for intentional
  changes.

## 3. Acceptance criteria (exercised live over HTTP)

First E2E run: 33/40 raw checks passed; the 7 apparent failures were all
validator-script errors (wrong `myEntitlements` nesting — data lives under
`.entitlements`; wrong checkout params; wrong assessment method name;
wrong share-token field), not product failures. Every one was re-run with
corrected expectations and passed. Evidence below is from the corrected runs.

| # | Criterion | Verdict | Evidence (validator's own HTTP calls) |
|---|---|---|---|
| 1 | Owner creates athlete account | PASS | `ownerCreateAthlete` → 200, athlete `5d828640-…` created, `status:active`, `createdBy:dev-director-marcus` |
| 2 | Indefinite complimentary grant | PASS | `grantComplimentary` (no expiry) → grant `expiresAt:null`, `status:active`; `myEntitlements` → `tier:complimentary`, `source:complimentary_grant`, `grantId` present; checkout `createCheckoutSession` (athlete/athlete_remote) → `ALREADY_COVERED`, `coveringSource:complimentary_grant` |
| 3 | Complimentary athlete: full portal, no payment prompt/trial notice | PASS | Entitlements `fullHistory:true`, `historyDays:null`, `maxCoachLinks:null`; athlete portal screenshot 03 shows "COMPLIMENTARY — GRANTED BY THE PROGRAM / No payment prompt, no trial notice, never charged" and the `ALREADY_COVERED` note; no Subscribe button anywhere on the tab |
| 4 | Suspend / reactivate / revoke | PASS | `suspendAthlete` → `status:suspended`; `reactivateAthlete` → `status:active`; `revokeComplimentary` → grant revoked; entitlements after revoke fall back to `tier:free` (nothing deleted) |
| 5 | Athlete sees own dashboard only | PASS | Athlete-as-youth `myEntitlements(youth)` → complimentary; `ownerListAthletes` as athlete → `FORBIDDEN`; `myEntitlements(wingback)` as youth → `ATHLETE_NOT_FOUND` |
| 6 | Coach assigns training + records assessment | PASS | Coach Kayla `createAssignment` → assignment created; athlete `completeAssignment` → completion recorded; `startAssessment` → draft created; `recordAttempts` (10yd-sprint [2.2, 2.25]) → ok; `getDraft` → 1 entry persisted |
| 7 | Reassessment progress comparison accuracy | PASS* | Seeded history: baseline 10yd-sprint result 2.30 (attempts 2.35/2.30/2.32), reassessment 2.25 (2.28/2.25/2.27). Hand: 2.25 − 2.30 = **−0.05 sec**. `compareValues('10yd-sprint', 2.30, 2.25, 0.05)` → `absolute:-0.05, percent:-2.17, improvementPercent:2.17` — delta matches hand computation exactly. Broad jump hand +4 in (64→68) → calculator `absolute:4, status:improved` — exact match. *See finding F1 below: the trend-chart caption's status word disagrees with the calculator at the tolerance edge. |
| 8 | Coach creates prospect profile | PASS | `createProspectProfile` (soccer/Striker, bio, measurements, accomplishments, history, verified metrics, contactInfo) → profile `e4330671-…` created |
| 9 | External recipient views approved profile via token, no login | PASS | Dual approval (athlete + coach; minor consent already seeded) → `status:approved`; `createProfileShare` → token returned once (top-level `token`, not in `share`); unauthenticated `GET /api/public/profile?token=…` → 200 with bio/sport/measurements/verified metrics/media/evaluations; payload contains **no athlete name and no contact email** |
| 10 | Sharing revoked → refusal, no data leak | PASS | `revokeProfileShare` → ok; same token afterwards → `PROFILE_SHARE_INVALID` ("Profile share is revoked or invalid"), empty of any profile data |
| 11 | Recruitment contact + opportunity + referral tracked | PARTIAL | `createRecruitmentContact` → contact created; `createOpportunity` (tryout 2027-03-01) → created; `referAthlete` → referral `status:referred`; `listRecruitmentContacts` → 1 contact. **But** there is no API list method for opportunities/notes/referrals, so they cannot be reloaded — see gap G1. Server-side they are stored; UI-side they are session-only. |
| 12 | Unauthorized access refused | PASS | Cross-coach profile read → `ATHLETE_NOT_FOUND`; non-owner (coach) grant attempt → `FORBIDDEN`; bogus token → `PROFILE_SHARE_INVALID`; cross-athlete assessment view → `FORBIDDEN`; cross-coach assignment → `FORBIDDEN` ("Athlete is outside your scope") |
| 13 | Existing functionality intact | PASS | Suite 352/352; `GET /api/assessments/battery` → GAA v1, 8 tests; `GET /` and `/prospect.html` serve (1698 / 7626 bytes); homepage Pathways section present; seeded 2-session youth history renders |
| 14 | New UI matches existing aesthetics | PASS | `prospect.html` carries audit §3 tokens verbatim: `--tape:#F2C300`, Archivo/Public Sans/JetBrains Mono font link, tape-yellow `.testbar`, square corners, no `border-radius` anywhere in new UI; `saas-ui.js` reuses host tokens (`var(--line)` ×27, `var(--ink)`, `var(--surface)`, `var(--tape)`). Screenshots 01/03/07/10 visually match the existing shell (see §4). |
| 15 | $0 additional cost | PASS | `package.json` diff since `35df1a2` is **empty** (still only `pg ^8.23.1`, no new dependency, no build script added); no new service calls in the diff — only relative `fetch('./api/public/profile…')`, YouTube/Vimeo URL embeds (no uploads/storage), and the pre-existing Google Fonts link pattern from audit §3; no Supabase/Storage/network calls in new server or client code; dev server binds 127.0.0.1 only |

## 4. Screenshots (inspected directly by the validator)

Opened and read 4 of 10 (the required minimum: 01, 03, 07, 10). All match
their `RESULTS.md` claims.

- **01-owner-console.png — CONFIRMED.** Owner console tab active; create-athlete form, grant-complimentary form (Indefinite checked), invite form, and the 9-row athlete-accounts table all visible: Wingback `IN-PERSON MEMBER — $149 MEMBERSHIP`, Youth + Pilot `COMPLIMENTARY — GRANTED BY THE PROGRAM / Indefinite`, Dev Athletes 01–06 `ATHLETE FREE`; SUSPEND / REVOKE GRANT / role controls; audit history 10/10 events. The `SET ROLE` button sits at the right edge of the table's horizontal scroll, as RESULTS.md notes — reachable, not broken.
- **03-athlete-portal.png — CONFIRMED.** Athlete tab as Synthetic Youth (12): `YOUR ACCESS` complimentary badge with the no-payment-prompt copy; prospect profile `PENDING APPROVAL`, Soccer — Striker, measurements 5 ft 10 in / 150 lb, `APPROVE SHARING` button; development goal, coach-approved feedback, media portfolio with empty YouTube frame + plain link (sandbox has no external network — embed element present, as RESULTS.md notes); recruitment-opportunities honesty note; **9 trend charts** with baseline/latest/PB captions, including "Baseline 2.3 · Latest 2.25 · Personal best 2.25 ★ · vs baseline -0.05 sec (improved)" — see finding F1.
- **07-public-prospect-profile.png — CONFIRMED.** No login. Tape-yellow testbar "SHARED PRIVATELY BY LINK — PROSPECT PROFILES ARE PRIVATE BY DEFAULT." `PROSPECT PROFILE` heading, photo placeholder ("Synthetic placeholder — no real photo"), bio, Soccer — Striker, playing history, accomplishments, availability, measurements, verified metrics (10yd sprint 1.82 sec) with the honesty line, video section (empty embed frame + YouTube link), coach-approved scouting evaluation, contact note. **No athlete name appears anywhere.**
- **10-public-profile-refusal.png — CONFIRMED.** `THIS PROFILE IS NOT AVAILABLE.` with the expired/revoked/not-approved explanation. No athlete data of any kind leaks.

(The other six screenshots were not independently opened; their claims are
consistent with the four inspected and with the live HTTP evidence above.)

## 5. Migration 009 — two separate lines

- **Mocked / in-memory validation: PASS (static + in-memory only).**
  `pathways-sports-migration.test.js` asserts on the SQL text:
  `STATUS: NOT APPLIED`, `BEGIN;`/`COMMIT;`, no `DROP TABLE` / `DROP COLUMN`
  / `DELETE FROM` / `TRUNCATE` / row-rewriting `UPDATE`, no storage bucket,
  no `supabase.storage` — all pass inside the 352/352 suite. The in-memory
  store mirrors the 009 tables and every Pathways API test runs against it.
  This proves the SQL text's shape and the API's behaviour over memory —
  **not** that the SQL executes on Postgres.
- **Real-database validation: NOT RUN — no real Postgres engine exists here.**
  Re-checked 2026-11-26: no `pg_isready`/`psql`/`postgres` binary,
  no `/usr/lib/postgresql`, no `DATABASE_URL` set, nothing listening on
  5432/5433. The migration file itself states the gate ("must be proven on
  a real Postgres copy … before any production apply. Do not claim it as
  validated until then."). **This is the blocker for any production apply.**
- Migrations 006–008 remain **unapplied** (headers in all three files say
  `STATUS: NOT APPLIED`, branch-only). Migration 009 is branch-only and
  unapplied. No production migration was applied by this validation (no live
  Supabase project was touched; no `supabase` calls exist in the new code).

## 6. Secrets / safety scan

Grep of the full branch diff since `35df1a2` for passwords, secrets, API
keys, bearer tokens, private keys, and real personal data: **clean**.
- Only hits are negations or synthetic test data: "no service-role key",
  "No secrets in code/logs", and `secret@example.com` inside a test that
  asserts the contact email is **never rendered**.
- Names in the diff are dev identifiers (`dev-director-marcus`,
  `dev-coach-kayla`) and fictional fixtures (Coach Rivera, River State
  University, Synthetic Youth/Pilot/Wingback, Yakima United). No real
  athlete name or real personal data found. All test athletes are
  synthetic/fictional, per the fixture headers.
- Share tokens are 24 random bytes, SHA-256-hashed at rest, returned once
  (`saas-api.js:1209–1219`); the validator's token was used only against
  localhost and revoked during testing.

## 7. Known gaps — confirmed real, impact judged

- **G1 — No API list methods for opportunities / notes / referrals: REAL.**
  Store accessors exist (`saas-store.js:245–253`:
  `opportunitiesForContact`, `notesForContact`, `referralsForContact`)
  but no `listOpportunities`/`listNotes`/`listReferrals` method exists in
  `saas-api.js` (only create/add/update). The coach CRM UI shows them from
  session-local state only, with an honest note (`saas-ui.js:1447`:
  "the API records them server-side but has no list method for them yet, so
  they are not reloaded on refresh"). **This breaks criterion 11 as a
  user-facing promise** — hence C11 = PARTIAL. The data is stored, but a
  coach who refreshes the page loses sight of the opportunities, notes,
  and referrals they just created. Small fix: three list methods wiring
  the existing accessors + client wiring + tests.
- **G2 — Public profile carries no athlete name: REAL, by design.**
  `publicProfileView` (`saas-api.js:198–219`) returns profileId, bio,
  sports, positions, measurements, accomplishments, history, verified
  metrics, availability, media, coach-approved evaluations — no name
  field; the UI comment states the identity is deliberately not part of a
  share link. Does **not** break criterion 9 (the profile renders and is
  viewable), but it does make the profile less usable as a recruiting
  artefact — a recruiter cannot tell whose profile it is except via the
  sender. Marcus decision: confirm this is the intended privacy posture
  or add a name field.
- **G3 — Athlete portal recruitment opportunities has no API read: REAL.**
  Athlete portal shows the honest note (`saas-ui.js:1162`: "No
  athlete-facing recruitment list exists in the API yet"). Does **not**
  break any criterion as written (no criterion requires the athlete to
  see the pipeline), but the athlete cannot see their own recruitment
  activity. Follow-up, not a merge blocker on its own.

## 8. Findings (beyond the gaps)

- **F1 — Trend-chart caption ignores the maintenance band (minor).**
  The new Pathways chart caption (`saas-ui.js:488–491`) labels any nonzero
  move in the good direction "(improved)". The canonical progress
  calculator (`server/progress.js:38–49`, used by the pre-existing
  assessment UI) applies the protocol maintenance band: 10yd-sprint band
  is 0.05 s, so the seeded −0.05 s change is exactly at the edge and the
  calculator says `status:maintained`, while screenshot 03's caption says
  "(improved)". The numbers agree exactly (−0.05); only the status word
  disagrees. The pre-existing progress table is unaffected. Recommend
  applying the band in the caption (or documenting the caption's simpler
  rule) before merge so the two surfaces never contradict each other.
- **F2 — Nits already disclosed by the builders, confirmed visually:**
  owner-console table's `SET ROLE` at the scroll edge (01); mobile
  goals-table overflow at 390 px (09, not re-opened by the validator);
  transient toast overlap (06, not re-opened). Cosmetic only.

## 9. "Production build"

The repo has **no build script** (`package.json` scripts: `dev`,
`test` only; no bundler, no `build`). "Production build" here therefore
means: `npm test` (352/352, run by the validator) + dev-server smoke
(all routes exercised above: `/`, `/homepage.html`, `/prospect.html`,
`/api/assessments/battery`, `/api/saas`, `/api/billing`,
`/api/public/profile`). There is no artefact to build, no deploy step in
this repo, and no production deployment was attempted. Anything labelled
"production" for this branch is the future Supabase/Edge Function step
(audit G8/G9), which is out of scope and unbuilt.

## 10. Verdict

**Ready to merge: NO.**

Reasons:
1. **Criterion 11 is PARTIAL (gap G1).** The CRM records opportunities,
   notes, and referrals server-side but offers no way to read them back,
   so they vanish from the coach's view on refresh. The fix is small —
   three list methods over accessors that already exist — and belongs on
   this branch before the feature merges as a complete V1.
2. **Finding F1 should be resolved or explicitly accepted.** The new
   trend caption and the canonical progress calculator disagree on the
   status word for a band-edge change. One line of rule (or one line of
   documented intent) removes a real inconsistency between two surfaces
   Marcus will compare.
3. **Migration 009 is unvalidated on real Postgres — the production-apply
   blocker, not a merge blocker.** Merging the branch does not apply
   anything (all four migrations 006–009 declare NOT APPLIED), but the
   file must still be proven on a real Postgres copy per the
   production-migration-validation protocol before any production apply.
   Do not let the merge be read as migration approval.

What is solid: suite 352/352 with the 310 baseline intact and no test
weakened; 14 of 15 criteria PASS on live HTTP evidence; authz refusals
all correct; no secrets, no real data, $0 spend, no new dependency, no
live project touched; screenshots verified by direct inspection.
