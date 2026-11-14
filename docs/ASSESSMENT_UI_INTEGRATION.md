# Assessment UI Integration — Phase 2

**Branch:** `feature/universal-assessment-reassessment-v1`
**Date:** 2026-11-14
**Status:** UI wired to the server workflow in development; ready for
review. Nothing merged, deployed, or applied to any live system.

## 1. What Phase 2 built

The app was a static prototype with the server assessment workflow
complete but the UI never wired to it. Phase 2 wires the UI to the
workflow without touching the prototype file and without rebuilding
any server logic:

| File | What it is |
|---|---|
| `assessment-ui/assessment-ui.js` (new) | Browser UI module (`window.AssessmentUI`). Renders the live assessment section, the run-assessment form, history/progress, deferral form, and plan controls, all as HTML strings in the prototype's design language (`.panel` / `.ph` / `.pb`, `.tbl-wrap` / `.t`, `.btn` / `.btn sm`, `.lbl`). Talks to the workflow ONLY through `assessment-ui/assessment-client.js`. No workflow or business logic in the browser. |
| `server/dev-server.js` (new) | Dev-only server (localhost only, memory stores only). Serves the static prototype and hosts the assessment API at `POST /api/assessments` + the read-only protocol route `GET /api/assessments/battery`. Run with `npm run dev` (default port 8123). |
| `server/fixtures/dev-roster.js` (new) | Synthetic dev roster: the two fixture athletes (48-year-old wingback, 12-year-old youth) + six invented cohort athletes. Coaches mirror the prototype (Marcus / Kayla / Jordan). Never loaded by production code. |
| `index.html` (1 line) | Loads `assessment-ui/assessment-client.js` + `assessment-ui/assessment-ui.js` before `boot()` and installs the UI (`window.__assessmentUI`). The only file whose preservation hash changed. |
| `server/tests/assessment-ui.test.js` (new, 16 tests) | UI module: pure helpers, entry building/validation, renderers, install wrapping, full controller flow against a stub client backed by the REAL workflow + API over memory stores. |
| `server/tests/dev-server.test.js` (new, 10 tests) | Dev server over real HTTP: static serving, battery route, role-scoped rosters, seeded buckets, full workflow, idempotent replay, deferral/exclusion, plan gate + override, forbidden access, malformed input, traversal rejection. |
| `package.json` | Adds `npm test` and `npm run dev` scripts. No new dependencies. |

**Changed 2026-11-14 under Marcus's decision §14 (cleanup mission):**
`THE PROGRAM OS.html` was edited for the first time — the obsolete
Assessments prototype content was removed from `vAssess()` (battery
cards, due table, decisions list, stale lede). `vAssess()` now
returns only the page head; the live section is the whole
Assessments experience. The athlete-profile progress-tab note was
reworded to point at the official Assessments section. The
preservation-snapshot hash for `THE PROGRAM OS.html` was updated in
the reviewed commit `f90dd11` (old `bdee15bc…`, new `74aba9d7…`).
The dashboard "due for testing" card is NOT rewired — wiring it to
live reassessment data is not a minimal change; it is recorded as a
remaining item in the release package. The stale `KNOWN GAP` comment
in the Edge Function store was resolved in Phase 3.

## 2. How the wiring works

`index.html` fetches the prototype, injects the override scripts,
then the two assessment scripts, then calls `boot()`. The UI module's
`install()` runs before `boot()` and wraps two prototype functions:

- `window.vAssess` — the live section is PREPENDED to the
  Assessments view; since the 2026-11-14 §14 cleanup the prototype
  battery cards and "Decisions needed" below it no longer exist, so
  the live section is the whole Assessments experience.
- `window.vAthlete` — a compact live section is APPENDED to an
  athlete profile, but only when the athlete is in the live roster
  (matched by id). Demo athletes not in the live roster see their
  profile exactly as before.

Wrapping works because the prototype's view functions are top-level
`function` declarations (globals), and the module runs after the
prototype script but before `boot()`. This is the same pattern as
`launch60-overrides.js` ("intentionally patches … before boot()").

Clicks use the prototype's own delegation model: the UI's buttons
carry `data-aui="…"` attributes (never `data-ath` / `data-go`, so the
prototype's handler ignores them) and the module adds one document
click listener. Form values are read at action time; every save goes
through the server (`recordAttempts` is the draft save).

Collision found 2026-11-14 in the real-browser walkthrough (the
automated tests never saw it — they call `onClick`/`switchRole`
directly, bypassing the prototype's listener): the "View as" role
buttons originally carried `data-role="coach"` etc., and the
prototype's own click handler treats ANY `data-role` as its
Director/Coach/Athlete mode switch (`S.role = ds.role; render()`),
so clicking a role button navigated the prototype away from the
Assessments view into its Coach Mode landing page. Fixed by
renaming the attribute to `data-aui-role` (renderer + click
handler); regression test in `server/tests/assessment-ui.test.js`.
Rule: the UI module must never emit a `data-*` attribute the
prototype's handler acts on (`data-role`, `data-go`, `data-ath`,
`data-session`, …) — only `data-aui*` attributes are safe.

When the assessment service is unreachable, the Assessments view
shows a short "not connected" note in the live section and nothing
else. The app never breaks for lack of a server.

## 3. The 11-step workflow in the UI

All inside the Assessments view (`Live assessments` panel), plus the
athlete-profile section:

1. **Select an athlete** — roster from `listAthletes()` (scoped to
   the caller's role). Due buckets from `coachDashboard()`.
2. **Start the assessment** — `startAssessment()`; resumes a saved
   draft when one exists.
3. **Follow the eight protocols** — the run form is built from
   `GET …/battery` (the real `server/assessment-battery.js`); the
   eight tests expand to ten recordable slots (side plank and
   single-leg balance are bilateral). Instructions, attempt counts,
   units, and caps come from the server, never duplicated in the UI.
4. **Record results, incl. modified/capped** — per-test attempt
   inputs + Modified / Capped checkboxes. Client-side validation
   mirrors the server's protocol checks (cap, attempt count, whole
   reps, negatives) for immediate feedback.
5. **Save incomplete / resume** — `recordAttempts()` is the save;
   the draft never counts as history, a baseline, or a due date.
6. **Complete + baseline** — `completeAssessment()` validates,
   records the session, establishes the baseline, sets the next
   reassessment 28 days out. Retries reuse one idempotency key.
7. **History + personal bests** — `athleteAssessmentView()`.
8. **Compare baseline / previous / current** — the progress table
   (absolute + percent, direction-correct), with the under-18 growth
   caveat shown for youth.
9. **Approaching / due / overdue / deferred** — the bucket row in
   the roster view, from `coachDashboard()`; per-athlete status on
   the history view.
10. **Reassess / defer** — `completeAssessment()` again, or
    `recordDeferral()` (deferral / exclusion / modification, test or
    whole battery, reason required and recorded).
11. **Finalize plans only when ready** — `planReadiness()` +
    `createPlan()` / `finalizePlan()`; an unready plan is refused
    unless an explicit coach override (reason + approver) is
    recorded on the plan.

Athletes view their own results and progress through the same
history view (read-only; no recording controls render for
parent/athlete roles).

## 4. Running it (development only)

```sh
npm run dev        # http://127.0.0.1:8123/  (localhost only)
```

Seeded state on first load (synthetic, memory only — restart wipes it):

- Synthetic Youth (12): baseline 56 days ago + reassessment 27.5
  days ago → **due today**.
- Synthetic Wingback (48): baseline 40 days ago → **overdue 12 days**.
- Six dev athletes: **never assessed**.
- Open the Assessments view: the live panel shows the buckets and
  the roster. "Start assessment" on a never-assessed athlete runs
  the full form; the youth's History shows two sessions, personal
  bests, and baseline-vs-current comparisons.

The "View as" buttons in the live panel switch the dev auth context
(Director / Coach Kayla / Coach Jordan / Coach Marcus / Parent /
Athlete) so role scoping can be seen directly: a coach sees only
their cohort athletes, a parent sees only their own athlete and no
recording controls, an athlete sees only themself. The switcher is
dev-only — it is hidden whenever the UI is installed with an
`endpoint`/`getToken` for a deployed Edge Function.

## 5. What still needs the Edge Function (Phase 3)

- The deployed Edge Function needs the same read-only
  `GET …/battery` route the dev server provides; until then the UI
  disables the run form when protocol data is unavailable (roster
  and history keep working).
- The workflow bundle is generated, not committed (function README
  §4). The stale `KNOWN GAP` comment in the Edge Function store is
  Phase 3 cleanup, not Phase 2.
- No deploy, merge, production migration, or production data change
  was made or is authorized by this work. The dev server is
  localhost-only and its stores are memory-only.

## 6. Test results

Command: `npm test`
(`node --test server/tests/*.test.js assessment-engine/assessment-engine.test.js`)

- **219 tests, 219 passed, 0 failed** (193 at the Phase 2 baseline —
  182 at Phase 1 + 11 from the transport adapter — + 26 new: 16 UI,
  10 dev-server).
- Typecheck / lint / build: the repo has none (`package.json` has no
  build step; no TypeScript, ESLint, or build config). Recorded as
  not-applicable, not run, not invented.
- Live smoke check (2026-11-14): dev server started on 127.0.0.1:8123;
  `/`, the prototype, and both UI scripts returned 200; battery
  returned the 8-test GAA protocol; `listAthletes` as director
  returned 8 synthetic athletes; `coachDashboard` as Coach Kayla
  returned 3 never-assessed + 1 due. Server stopped after the check;
  no process left running.
- Not verified in a real browser render: the UI module was exercised
  through stubbed globals (install/wrapping) and the dev server over
  HTTP; no headless-browser render was run (none is available in
  this environment). The first real-browser check is a manual
  pass over the dev server URL.
