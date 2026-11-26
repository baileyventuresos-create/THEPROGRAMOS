# Athlete Pathways & Prospect Portal V1 — Visual Validation Results

Date: 2026-11-26 · Branch: `feature/athlete-pathways-v1` · $0 spend
Method: dev server on `127.0.0.1:8123` (seeded, memory stores), data seeded
through the real committed API (synthetic athletes only), then driven in a
local headless Chromium (Playwright, cached build) by
`docs/pathways-validation-2026-11-26/screenshots.js`.

Every screenshot below was verified by opening the image itself and
confirming the claimed element is visibly present — not from a test log.

## 01-owner-console.png — PASS
Director tab, Owner console active. Create-athlete form, grant-complimentary
form, invite form, and the athlete-accounts table (9 rows) are all visible:
Synthetic Wingback (48) shows `IN-PERSON MEMBER — $149 MEMBERSHIP` / Active;
Synthetic Youth (12) shows `COMPLIMENTARY — GRANTED BY THE PROGRAM` / Active /
`Indefinite` / `Walk-On Project pilot` with SUSPEND + REVOKE GRANT + role
select; Synthetic Pilot shows the same complimentary badge; Dev Athletes 01–06
show `ATHLETE FREE`. Audit history shows the latest 10 of 10 events
(owner_create_athlete, grant_complimentary ×2, assign_sport,
set_development_goal, record_scouting_evaluation, create_prospect_profile,
add_media_link, create_recruitment_contact, approve_prospect_profile) with
actors dev-director-marcus / dev-coach-kayla.
Observation: at 1280px the account table's action cell is wide and the
`SET ROLE` button sits at the right edge of its horizontal scroll wrapper
(`.tbl-wrap`); it is reachable by scrolling, not broken.

## 02-complimentary-grant-form.png — PASS
Grant form filled in: athlete select `Synthetic Youth (12)`, reason
`Walk-On Project pilot — second grant`, `Indefinite (no expiry)` checked,
expiry date left blank, `GRANT COMPLIMENTARY ACCESS` button, and the honest
copy underneath ("Complimentary beats every other tier … never sees a payment
prompt or trial notice … revoking or expiry falls back to the next covering
source — nothing is deleted"). Not submitted in this shot — the youth already
holds a grant from the seed.

## 03-athlete-portal.png — PASS
Viewed as Athlete: Synthetic Youth (12), Athlete tab. `YOUR ACCESS` shows
`COMPLIMENTARY — GRANTED BY THE PROGRAM` with "Full remote access, granted
complimentary by the owner. No payment prompt, no trial notice, never
charged." and the `ALREADY_COVERED` note; no Subscribe button, no payment
prompt anywhere. `ATHLETE PATHWAYS`: prospect profile `PENDING APPROVAL`,
Soccer — Striker, bio, measurements table (height 5 ft 10 in, weight 150 lb),
accomplishments, availability, approval status text, and an `APPROVE SHARING`
button. Development goal ("Hold a 60-second side plank each side", Dec 20,
2026, ACTIVE, MARK COMPLETE / CANCEL), coach feedback ("Great engine,
presses well, first to every second ball." — COACH-APPROVED), media portfolio
(HIGHLIGHT "Spring showcase highlights", embed frame + YouTube link),
recruitment-opportunities honest note, and 9 progress-trend charts with
baseline/latest/PB captions.

## 04-trend-chart.png — PASS
Close-up of the trend charts: 10-yd sprint (baseline 2.3 dashed tape line,
line descending to latest 2.25, PB star marker in a tape circle), 5-10-5
shuttle (5.75 → 5.66), 6-min walk/run (520 → 560), Broad jump (64 → 68),
Push-ups (12 → 15), Side plank — left (35 → 40). Captions read e.g.
"Baseline 2.3 · Latest 2.25 · Personal best 2.25 ★ · vs baseline -0.05 sec
(improved)". Lower-is-better is handled correctly for the timed tests.

## 05-coach-prospect-editor.png — PASS
Viewed as Coach Kayla, Coach tab, Pathways for Synthetic Youth (12).
Attendance & training history (0 completions, 0 assignments, 2 assessment
sessions, Oct 1 / Oct 30 2026); Sport & positions (Soccer, Striker, ASSIGN
SPORT, suggested-positions details); development-goal list + composer;
scouting-evaluation list + composer; prospect profile `APPROVED — SHAREABLE`
with both approval timestamps and the full editor (sports, positions,
availability, bio, measurements height/weight/handedness, accomplishments,
playing history, verified metrics "10yd sprint: 1.82 sec", contact email
labelled "never public", SAVE PROFILE CHANGES); media portfolio with add/remove;
share links ("No share links yet", CREATE SHARE LINK); Recruitment CRM with
River State University (collegiate, Soccer, Coach Rivera, NEW, OPEN) and the
add-contact form.

## 06-coach-share-link.png — PASS
After clicking CREATE SHARE LINK: the note "Share link (shown once — copy it
now): http://127.0.0.1:8123/prospect.html?token=…" (token value redacted from
this report; it is a dev-only token for synthetic data on a localhost memory
store) and the shares table (share id, Expires Dec 3, 2026, ACTIVE, REVOKE),
plus the transient "Share link created" toast. The toast briefly overlaps the
CRM table header in this capture — cosmetic and transient.

## 07-public-prospect-profile.png — PASS
No login. Tape-yellow testbar "SHARED PRIVATELY BY LINK — PROSPECT PROFILES
ARE PRIVATE BY DEFAULT." `PROSPECT PROFILE` heading, intro copy, PHOTO
PLACEHOLDER block ("Synthetic placeholder — no real photo"), bio, Sport &
positions (Soccer — Striker), playing history, accomplishments, availability,
measurements table, verified metrics (10yd sprint, 1.82 sec) with the honesty
line, VIDEO section (HIGHLIGHT "Spring showcase highlights", embed frame +
YouTube link), coach scouting evaluation (coach-approved Nov 26, 2026), and the
contact note ("No personal contact details are published on a prospect
profile"). No athlete name is shown anywhere — the server public view carries
none, by design. No contact email.
Environment note: the YouTube iframe renders as an empty frame here because
this sandbox has no external network to youtube-nocookie.com (the embed
element itself is present with the correct src, and the plain link below it
is visible). Not a UI defect.

## 08-coach-crm.png — PASS
Coach Kayla, Recruitment CRM. Notice "Athlete referred." Contacts table
(River State University, collegiate, Soccer, Coach Rivera, NEW, OPEN), add-
contact form, and the open pipeline panel: status new, contact details,
update-status control, OPPORTUNITIES (tryout, "Showcase invite"), NOTES &
FOLLOW-UPS ("Called — asked for spring film", follow-up Dec 1, 2026), and
REFERRALS (Synthetic Youth (12), REFERRED, status select + UPDATE) plus the
session-only honesty note ("Opportunities, notes, and referrals shown here
are the ones created in this session…"). Capture artifact: the full-page
stitch repeats the prototype's sticky topbar over one roster row mid-page;
the CRM content itself is complete and unobstructed.

## 09-mobile-athlete-portal.png — PASS (with a mobile nit)
390px viewport, athlete portal as Synthetic Youth (12). Hub wraps to a single
column, tabs wrap, profile now `APPROVED — SHAREABLE` (approved in the
desktop flow just before this capture), measurements, goals, feedback, media,
and all 9 trend charts stack single-column and stay legible.
Nit: the development-goals table at 390px is wider than the viewport, so the
`MARK COMPLETE` button is cut off at the right edge in this capture. The
table sits in a `.tbl-wrap` horizontal-scroll wrapper, so the button is
reachable by scrolling — same pattern as the owner-console table in 01 — but
it is the one place the mobile view is not fully one-glance readable.

## 10-public-profile-refusal.png — PASS
`prospect.html?token=bogus-token-123` renders `THIS PROFILE IS NOT
AVAILABLE.` with "Prospect profiles are private by default. This link may
have expired, been revoked, or the profile may not be approved for sharing.
If you were sent this link, ask the sender for a fresh one." No athlete data
of any kind leaks: no name, bio, sport, measurement, or contact detail.

## Reproduce
1. `npm run dev` (port 8123, seeded).
2. `node docs/pathways-validation-2026-11-26/screenshots.js`
   (Playwright from the after6 workspace node_modules; cached Chromium).
3. Screenshots land in `docs/pathways-validation-2026-11-26/screenshots/`.
