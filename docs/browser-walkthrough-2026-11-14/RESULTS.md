# Real-Browser Walkthrough — Final Assessments Cleanup (2026-11-14)

**Environment:** Playwright + Chromium 1255 (installed as local dev tooling
under `/tmp/pw-setup`; NOT committed to the repo, NOT a repo dependency),
dev server `npm run dev` on `http://127.0.0.1:8123` (localhost only,
memory stores, synthetic data only). Script: `/tmp/pw-setup/walkthrough.mjs`
(kept out of the repo with the browser tooling; the run below is the
record — re-run it from `/tmp/pw-setup` to repeat).
**Result: 22/22 steps PASS.** Screenshots in this folder; machine-readable
results were captured in the run log (results.json alongside the script).

## Steps

| # | Step | Result |
|---|---|---|
| 1a | App loads; Assessments view shows the live section | PASS |
| 1b | Director roster shows 8 synthetic athletes | PASS |
| 1c | Switch to Coach Kayla narrows roster to her athletes only (wingback absent) | PASS |
| obs | Obsolete Assessments prototype content is gone (none of: "not being collected today", "REQUIRES PROGRAM VALIDATION", "12 weeks", "Decisions needed", "Mar 2027", "draft battery", "Due for testing") | PASS |
| 2 | Start assessment opens the run form — 10 slots (9 measured + movement observation), 14 attempt inputs | PASS |
| 3 | All eight protocols recorded (incl. modified push-ups, capped side plank at 120s) | PASS |
| 4a | Save draft reports success | PASS |
| 4b | Resume restores the saved draft (first sprint attempt 2.31 prefilled) | PASS |
| 5 | Complete establishes baseline, next due +28d (Dec 12, 2026) | PASS |
| 6 | History shows PB table, capped + modified results ("120.00 sec (capped)", "(modified)") | PASS |
| 7 | Due buckets visible; completed athlete now Not due (Never assessed / Approaching / Due / Overdue / Deferred / Not due) | PASS |
| 8 | Youth reassessment recorded; progress comparison updated (all 9 tests Improved vs baseline and previous) | PASS |
| 9a | Parent sees only their own athlete, no recording controls (0 run buttons) | PASS |
| 9b | Parent can view the youth history + PBs | PASS |
| 9c | Athlete sees only themself, no recording controls (0 run buttons) | PASS |
| 10a | Finalize without baseline/override is refused (PLAN_NOT_READY) | PASS |
| 10b | Finalize with a recorded override succeeds | PASS |
| 10c | Ready plan finalizes without an override | PASS |
| — | No page errors during the walkthrough | PASS |
| — | No same-origin request failures (see note below) | PASS |
| mob | Mobile (390×844) Assessments view: no horizontal overflow (0px) | PASS |
| mob | Mobile run form: no horizontal overflow (0px) | PASS |

## Screenshots

- `01-roster-kayla.png` — Assessments view as Coach Kayla (roster + buckets)
- `02-run-form-filled.png` — run form, all eight protocols filled
- `03-history-after-complete.png` — history + PBs after completing a baseline
- `04-youth-reassessment-history.png` — youth history after reassessment (3 sessions)
- `05-athlete-view.png` — athlete role: own results only
- `06-plan-finalized.png` — plan finalized with a recorded override
- `07-mobile-roster.png` — mobile roster, no overflow
- `08-mobile-run-form.png` — mobile run form, no overflow

## Defects found and fixed by this walkthrough

1. **Role-switcher `data-role` collision (real defect).** The dev "View
   as" buttons carried `data-role="coach"` etc., and the prototype's
   own click handler treats ANY `data-role` as its Director/Coach/
   Athlete mode switch, so clicking a role button navigated the
   prototype away from the Assessments view into its Coach Mode
   landing page. The automated tests never saw it (they call
   `onClick`/`switchRole` directly). Fixed in commit `5fe4281` by
   renaming the attribute to `data-aui-role`, with a regression test.
2. **Mobile header overflow (dev-only).** The live panel header packed
   Connected + 6 role buttons + Refresh into a non-wrapping flex row,
   forcing the page to 758px on a 390px phone. Fixed in commit
   `5fe4281` (`flex-wrap:wrap` on the panel header actions). Without
   the dev-only switcher, production mobile was already 390px — the
   roster table scrolls inside `.tbl-wrap` as designed.

## Notes

- The prototype loads Google Fonts (`fonts.googleapis.com`); the
  sandbox egress proxy blocks it (`ERR_TUNNEL_CONNECTION_FAILED`).
  Environmental only — system-font fallbacks render, and no
  same-origin request failed. On a network without the proxy the
  fonts load normally; nothing in the app depends on them.
- "Coach login" in dev is the "View as" role switcher (no real auth
  in the dev server; the deployed Edge Function derives auth from a
  verified Supabase JWT). Production login flow itself (Supabase Auth
  sign-in) was not exercised here — it is covered by the production
  smoke test in the release sequence.
- The walkthrough script's first two runs failed on script bugs, not
  app bugs: case-sensitive text matching (the prototype uppercases
  headings via CSS, `innerText` returns the rendered case), settle
  waits after role switches, and a wrong slot/input count in one
  assertion (shuttle has 2 attempts, not 3; 9 measured slots + the
  movement observation = 10 slots, 14 inputs). The app behavior was
  correct in each case; the script was fixed.
