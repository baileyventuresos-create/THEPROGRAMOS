# THE PROGRAM OS — Existing Drill Content Suitability Review

**Date:** 2026-11-15
**Mission:** Existing Drill Content Suitability Review (Marcus, 2026-11-15) —
revisit the performance methodology audit before authorizing any new
drills, tables, migrations, or training systems.
**Branch audited:** `feature/universal-assessment-reassessment-v1`
(head `fd3678d`); review documents on branch
`audit/drill-suitability-2026-11-15`.
**Status:** READ-ONLY evaluation. No code, schema, drill, workflow, UI,
cohort, or production change was made. Migration 006 was NOT
implemented. No new drills were created. Nothing was merged or
deployed.
**Companion file:** `docs/DRILL_SUITABILITY_MATRIX.csv` — one row per
game (130 rows), every game rated on all six modalities.

## Primary question

Can The Program's existing 130 movement games support the six
athletic-development modalities through appropriate coaching,
programming, dosage, and progression — without expanding the library?

**Short answer: mostly yes — with programming, not with new games.**
The library as written already trains multidirectional/reactive
agility outright, and trains or developably supports linear
acceleration, movement competency, and conditioning across most of
the library. Plyometrics and strength/stability are partially
supported (the landing/stability and bodyweight layers are real; the
maximal/intensive layers are not). The genuine gaps are narrow and
specific: mobility/flexibility (zero content), linear sprint
technique and max velocity, intensive plyometrics, progressive
loaded strength, and structured energy-system templates. Those gaps
need a small set of focused supplementary drills (~20–30, plus
rescue of the 5 orphaned cards) — **not a new drill library, and
not the 44–62 new drills the earlier audit estimated.** The audit's
estimate counted primary labels; this review counts what coaching
and dosage can actually develop, and the number falls by more than
half.

## Method — how this review was done

- **Source:** `window.TP_DATA` in `THE PROGRAM OS.html` — 130 rows,
  130 distinct IDs (TP2-001–TP2-130), 31 columns each. Every game
  was read in full: Category, Primary Quality, Secondary Qualities,
  Age Range, Group Size, Duration, Equipment, Athletic Problem,
  Score / Win, all three Cues, Builds 1–4, Regression, Progression,
  Coach Watches, Safety / Guardrail, Status. Setup and Quick
  Explainer text was spot-checked where a rating was ambiguous.
- **Rating scale** (applied per game, per modality — see the matrix
  for every rating and its evidence note):
  - **T — Trains.** The game's mechanics, as written, directly
    provide a meaningful training stimulus for the quality.
    Repeated, dosed exposure would develop it.
  - **P — Develops via programming.** The quality is not the game's
    primary training effect, but a coach can meaningfully develop
    it by adjusting dose, intensity, distance, work:rest,
    complexity, or coaching emphasis — without changing the
    exercise's identity.
  - **I — Involved only.** The quality is involved in performing
    the activity (you run, you jump, you hold a position) but the
    mechanics and dose do not provide a meaningful training
    stimulus for it.
  - **– — Not supported.** The mechanics cannot provide a
    meaningful stimulus for the quality.
- **Rules applied throughout:** a quality that is merely involved
  is never rated T or P; no game is forced into a modality its
  mechanics cannot serve; a rating is lowered a tier where the
  game's own safety text caps the stimulus (e.g. "never reward
  maximum jump distance or height" caps M3 at submaximal);
  template-authored games are rated from their Athletic Problem and
  category mechanics, not from their generic build text.
- **Authoring-depth caveat (material).** The library is unevenly
  authored, and the split is measured, not impressionistic: 23
  games carry game-specific builds, regressions, and coach watches
  (TP2-001, 003, 005, 017, 032, 036, 037, 038, 039, 041, 042, 047,
  058–067, 120). The other 107 share category-level build
  templates — 31 distinct Build 1 texts across 130 games. The
  category templates are at least mechanically relevant (e.g.
  Jump / Land's "rehearse the movement pattern at low speed",
  Strength's "technique-only with very light resistance"), but
  they are not per-game: all 8 Strength games, all 8 Balance
  games, and all 8 Coordination games share identical builds,
  regressions, watches, and safety text within their category.
  The thinnest group is 23 games sharing a single generic Build
  1 ("Learn the base rules at controlled speed") with generic
  watches ("Decision quality and movement control") — Chase
  002/004/006–015 and Reaction 016/018–027 (minus the specific
  ones above). For those games the Athletic Problem and category
  are the only differentiating evidence, and ratings rest on
  them. Where a template game is rated P, the programming lever
  named in this review is the coach's, not the card's — the card
  does not spell it out. This is itself a finding: the library's
  programming flexibility is real, but for most games it lives
  in the coach's head, not in the written content.
- **Usable set.** Counts are given for all 130 games and for the
  124 usable games (excluding the 5 Safety Review games and the 1
  Retired game). Safety Review games are rated in the matrix but
  must not be programmed until reviewed; the Retired game
  (TP2-125) is rated but must not be programmed at all.
- **Test baseline re-run for this review:** 250/250 pass, 0 fail
  (`npm test`). Nothing changed.

## 1. Drill-by-drill suitability matrix

`docs/DRILL_SUITABILITY_MATRIX.csv` — columns: Game ID, Game,
Category, Primary Quality, Status, M1–M6 ratings (T/P/I/–), and an
Evidence / notes column per game (Athletic Problem in brief plus the
decisive fact behind any non-obvious rating, e.g. "Three 60s
continuous rounds, 15s breather (M6 T)" for TP2-003, "SAFETY REVIEW
— do not program until reviewed" for the five). Every one of the
130 games is rated on all six modalities. Summary counts are in §2.

## 2. Summary of effective coverage across all six modalities

Counts are ratings, not primary labels. "Effective coverage" =
T + P (games that train the quality, or develop it via programming).

| Modality | Trains (T) | Develops via programming (P) | Involved only (I) | Not supported (–) | Effective coverage (T+P) / 130 | Effective coverage / 124 usable |
|---|---|---|---|---|---|---|
| M1 Linear speed / acceleration | 56 | 33 | 28 | 13 | **89** | 86 |
| M2 Multidirectional / reactive agility | 55 | 43 | 31 | 1 | **98** | 96 |
| M3 Plyometric / explosive power | 10 | 4 | 94 | 22 | **14** | 14 |
| M4 Strength / stability | 26 | 19 | 85 | 0 | **45** | 39 |
| M5 Mobility / movement competency | 35 | 87 | 8 | 0 | **122** | 116 |
| M6 Conditioning / energy-system | 20 | 81 | 17 | 12 | **101** | 97 |

Other headline numbers: 65 games Train two or more qualities;
101 games Train or develop three or more; 26 games Train nothing
(the Throw/Catch and Target station games, which train hand-eye
skill outside the six modalities); 7 games Train or develop nothing
in the six modalities at all (TP2-050–056 — stationary accuracy
stations; they are sport-skill content, not athletic-development
content, and that is a legitimate role, not a defect).

### Per-modality verdicts (the required four-way classification)

- **M1 — Partially supported with meaningful limitations.**
  Acceleration is broadly trained (56 games): chase, reaction,
  invasion, striking, and conditioning games all repeat short
  accelerations with intent, and TP2-034 (bounds into
  acceleration), TP2-037 (rope into sprint), and TP2-087
  (ground positions into acceleration) train the acceleration
  transition explicitly. What is missing is the *linear* half:
  no straight-line sprint drills, no start mechanics, no
  acceleration technique progressions, no max-velocity work.
  Every sprint in the library is short (5–8 yards), curved, or
  reactive. M1 is supported for acceleration; it is not
  adequately supported for linear speed.
- **M2 — Already supported by existing content.** 55 games Train
  it and 43 more develop it via programming (98/130 effective).
  Chase, Reaction, Invasion, Net/Wall, and Conditioning games are
  genuinely decision-based: braking, cutting, reacting to live
  cues, role reversals at speed. The gap is measurement, not
  content — there is no reactive *test* in the GAA battery (the
  prototype's own TESTS list marks the reaction test NEEDS
  DEFINITION). No new M2 drills are needed.
- **M3 — Partially supported with meaningful limitations.**
  10 games Train it — the whole Jump / Land category — and 4 more
  develop it via programming (rope work, obstacle jumps). But the
  training is submaximal by design: every Jump / Land safety text
  says "Never reward maximum jump distance or height", landings
  are scored for quiet control, and there is no vertical jump, no
  depth jump, no single-leg bound, no ground-contact or volume
  structure. The library trains landing quality and submaximal
  jump volume; it does not train maximal, elastic, or vertical
  power. That layer needs new dosed drills.
- **M4 — Partially supported with meaningful limitations.**
  The stability half is genuinely trained (26 games): landing
  control in Jump / Land, holds and perturbations in Balance,
  trunk work in Strength Through Play, group balance shapes
  (TP2-118). The strength half is thin: 8 Strength Through Play
  games, 3 of them in Safety Review (leaving 5 usable), all
  submaximal by explicit guardrail ("No maximal resistance, neck
  contact, jerking, twisting joints"), no load, no hinge / squat /
  push / pull progressions, no sets/load structure. The library
  trains stability and strength-endurance at low level; it does
  not train progressive strength.
- **M5 — Partially supported with meaningful limitations
  (competency yes, mobility no).** Movement competency is the
  best-covered quality after M2 (35 Train, 87 via programming):
  landing mechanics, balance/posture work, coordination patterns,
  cross-body work, obstacle posture adaptation are all explicitly
  coached and scored. **Mobility is 0/130.** No joint-specific
  range-of-motion work, no flexibility content, no corrective
  content exists anywhere in the library. The M5 "T" ratings in
  the matrix are for the competency half only; the mobility half
  is entirely unsupported and cannot be programmed out of games.
- **M6 — Supported through coaching and dosage adjustments,
  with meaningful limitations.** This is the largest correction
  to the earlier audit, which called M6 the weakest modality on
  the strength of 6 primary entries. By mechanics, 20 games Train
  conditioning (continuous invasion play, 60-second chase rounds,
  45–60-second conditioning rounds) and 81 more develop it via
  programming (round structure, work:rest, bout density). What is
  missing is *structure*, not content: no interval templates, no
  heart-rate zones, no aerobic/anaerobic differentiation, no
  continuous moderate work (nothing sustains effort beyond ~10
  minutes), and no prescribed work:rest by energy system. The
  conditioning games can be dosed as intervals today; a true
  aerobic-base block cannot.

## 3. Games supporting multiple athletic qualities (mechanism, not label)

- **TP2-034 Bound & Break** — repeated bounds (M3) transition
  immediately into acceleration (M1); landing control (M4) and
  landing mechanics (M5) are the scored quality gate. Three
  modalities in one rep, by design.
- **TP2-037 Jump-Rope Sprint** — rope rhythm (M5, M3 at low
  intensity) then a clean sprint through a gate (M1), with a
  late-call second gate (M2) in the Chaos build.
- **TP2-001 Mirror Escape** — mirroring an opponent's hips (M5
  competency), braking low (M2), explosive first step (M1), with
  a random "SWITCH" role reversal (M2 reactive) in Chaos.
- **TP2-087 Get-Up Race** — varied ground positions (M5
  competency, M4 positional control) into acceleration (M1),
  a different start position every rep.
- **TP2-094 Bear Crawl Tag** — contralateral ground movement
  (M5), trunk/force production (M4), pursuit and evasion
  (M1/M2).
- **TP2-124 Builders & Bulldozers** — repeated
  accelerate/decelerate/change-direction (M1/M2) under fatigue,
  with braking control explicitly watched (M4) across 45–60
  second rounds (M6).
- **TP2-123 Clean Your Yard** — continuous retrieve-and-send
  (M6) with scanning, braking, and reacceleration (M1/M2) in
  every rep.
- **TP2-109 Portal Race** — reacting to changing gateways
  (M2), route solving (M5), sprint segments (M1, via
  programming).
- **TP2-047 Grounder Race** — footwork to intercept (M5),
  stable base before the throw (M4), lane race to 10 (M1/M6
  via programming).
- **TP2-036 Lateral Leap Duel** — lateral power (M3), clean
  landing pairs scored to 8 (M4/M5), single-leg landing option
  in Progression.

Pattern worth noting: the multi-quality games are the ones whose
Athletic Problem is specific — whether their builds are
game-specific (TP2-001, 047) or category-templated (TP2-034, 037,
087, 094, 123, 124). Category-template builds neither add nor
subtract multi-quality value; the rating rests on the problem and
the mechanics.

## 4. Specific programming adjustments (tied to named games)

These expand usefulness without changing any game's identity. All
use levers already present in the cards (Builds, Regression,
Progression, Score/Win, Duration) or standard coaching controls.

- **Work:rest as the conditioning lever.** The Competitive
  Conditioning template (Build 1: 30-second learning round;
  Build 2: 45–60-second scored rounds; Build 3: reduce recovery
  slightly while quality remains high) is a complete interval
  structure. Apply it to any running game: TP2-003 and TP2-005
  already run it (three 60-second rounds, 15-second breather);
  run TP2-001, TP2-016, and TP2-017 the same way to convert
  intermittent bursts into repeat-sprint intervals. For aerobic
  emphasis, lengthen rounds and lengthen recovery proportionally;
  for anaerobic emphasis, shorten rounds and cut recovery —
  both are coach decisions, not new content.
- **Distance and intensity as the speed lever.** TP2-001's
  Progression already lengthens the lane to 8 yards; TP2-058
  narrows the field from 25 to 15 yards and adds an 8-second
  limit, changing the same game from evasion to sprint
  pressure. Mandate sprint returns (walk back, sprint back) in
  invasion games, and use TP2-087's rotating start positions
  (prone, seated, kneeling, supine) as the acceleration-technique
  warm-up the library otherwise lacks.
- **Late cues as the reactive-agility lever.** The Chaos builds
  already convert pre-planned COD into reactive agility: TP2-001
  "SWITCH", TP2-032 "SWITCH" at spot 4, TP2-037 second gate
  called as the rope drops, TP2-017 two-color sequences and
  conflicting cues, TP2-109 changing gateways. A coach who runs
  Build 4 instead of Build 2 gets reactive training from the
  same game; a coach who stays on Build 2 does not. The lever
  is authored — it only needs using.
- **Clean-rep counting as the plyometric dose lever.** Jump /
  Land games score only technically clean reps (TP2-036: first
  to 8 clean pairs; TP2-032: 6 heats, judge-called errors).
  Prescribe a rep target instead of a time block — e.g. 3 sets
  of 8 clean lateral pairs (TP2-036), 6 heats of Hopscotch Chase
  (TP2-032) — and the clean-rep count becomes a volume cap.
  Regress to the Learn build (walking tempo, 2-count stick) when
  landing quality deteriorates; the cards already say this.
- **Round structure as the strength dose lever.** Strength
  Through Play games run 20–30-second rounds. Prescribe them as
  intervals — e.g. 4 × 30 seconds of Sandbag Shuttle (TP2-097)
  with 30 seconds recovery, or 3 × 30 seconds of Plank Ball
  Exchange (TP2-096) — and a bodyweight game becomes a
  strength-endurance dose. Carry progressions are already
  authored (TP2-091/097: longer carry, slightly more resistance
  only when technique is stable); use them instead of inventing
  new carries.
- **Base-of-support and single-leg progressions as the
  stability lever.** Balance games already carry the ladder:
  widen stance → narrow base → single-leg → add an object task
  (TP2-083–090 Regression/Progression). Single-leg landing is
  already an authored Progression in TP2-028–037 ("single-leg
  landing where age and control support it"). These are the
  only single-leg progressions in the library — use them
  deliberately rather than treating them as flavour text.
- **Cadence and pattern length as the coordination lever.**
  Coordination games already scale by cadence and sequence
  length (TP2-099–106: slow pattern → race after accuracy →
  increase cadence or add a cue change → coach changes the
  pattern mid-section). Cross-body action and faster sprint
  transitions are the authored Progressions; they convert a
  coordination game into a coordination-plus-acceleration game
  (TP2-100, TP2-106).
- **What programming cannot do.** It cannot create mobility
  content (no ROM work exists to scale), cannot create load
  (no equipment, guardrail forbids maximal resistance), cannot
  create maximal jump height (guardrail forbids rewarding it),
  cannot create straight-line sprint technique (no such drill
  exists to dose), and cannot create energy-system templates
  (no HR zones or work:rest prescriptions exist). Those are
  the genuine gaps in §5 — everything else on this list is
  already in the cards.

## 5. Genuine training gaps (cannot reasonably be addressed with existing content)

1. **Mobility / flexibility (M5).** Zero content in 130 games.
   No joint-specific ROM (ankle, hip, thoracic, shoulder), no
   flexibility work, no corrective content. Cannot be
   programmed out of games.
2. **Linear sprint technique and max velocity (M1).** No
   straight-line sprint drills, no start mechanics, no
   acceleration technique progressions, no max-velocity work.
   All sprinting in the library is short, curved, or reactive.
3. **Intensive plyometrics (M3).** No vertical jump, no depth
   jump, no single-leg bound, no reactive/elastic jump work, no
   ground-contact or volume structure. The existing jump content
   is submaximal by guardrail; the intensive layer does not
   exist.
4. **Progressive strength (M4).** No load, no hinge / squat /
   push / pull progressions, no sets/load structure. The 8
   Strength Through Play games train stability and
   strength-endurance at low level (5 usable after Safety
   Review); progressive overload does not exist.
5. **Structured energy-system templates (M6).** No interval
   templates by energy system, no heart-rate zones, no
   continuous moderate work (nothing sustains effort beyond
   ~10 minutes), no aerobic-base prescription. Games can be
   dosed as intervals; a true aerobic-base block cannot.
6. **Reactive agility measurement (assessment gap, not a
   content gap).** No reactive test exists in the GAA battery;
   the prototype's own TESTS list marks it NEEDS DEFINITION.
   M2 content is strong; M2 measurement is missing.
7. **Single-leg strength and stability progressions.**
   Only TP2-085 (single-leg catch) and the single-leg landing
   options in Jump / Land address it; there is no single-leg
   strength series. Thin enough to count as a gap, small
   enough to close with a handful of progressions.

What is NOT a genuine gap (against the earlier audit): reactive
agility content (M2, 98/130 effective); conditioning content
(M6, 101/130 effective — structure is the gap, not content);
acceleration content (M1, 89/130 effective — technique is the
gap, not acceleration); landing quality and submaximal jump
volume (M3 base layer); stability and strength-endurance (M4
base layer); movement competency (M5, 122/130 effective).

## 6. Is a new drill library necessary?

**No.** The existing 130 games can deliver a comprehensive,
safe, progressive, sport-agnostic athletic development
methodology for general youth athletic development (ages 8–18,
coach-led group sessions) — provided the methodology is built
on coaching and programming, not on primary-label counting.
The library already trains M2 outright and trains or
developably supports M1, M5 (competency), and M6 across most
of its content; M3 and M4 are partially supported at the base
layer. The gaps in §5 are real but narrow, and they are not
a library problem: they are a small set of supplementary,
dosed, non-game drills and templates. Concretely, the content
that must be *added* is on the order of **~20–30 focused
drills** (mobility series ~6–8; sprint-technique set ~4–6;
intensive plyometrics ~4–6; strength progressions ~6–10)
plus **~4–6 conditioning templates**, plus rescue of the 5
orphaned cards (which are already authored). That is a
supplement, not a library — and it should be authored in the
same TP2 schema, field-tested before Launch Ready status,
under the library's own rules. The alternative the audit
implied — 44–62 new drills — would have been proliferation:
it counted submodalities as if each needed its own drills,
when the games already cover most of them once programmed.
Two conditions attach to the verdict. First, the verdict
assumes a coach programs the games (round structures,
distances, late cues, clean-rep targets) rather than running
cards as written at default settings — at default settings
the library is a games collection, not a methodology. Second,
the verdict does not extend to maximal strength, elite
sprint/power development, or rehabilitation — those are
outside the library's stated scope and its safety guardrails,
and would need different content and different governance.

## 7. Smallest possible additive integration approach (using existing content)

No new tables are required for the methodology itself. In
order of increasing invasiveness:

- **Layer 0 — Programming guide (no code, no schema).** A
  coach-facing document plus the matrix CSV as its reference:
  for each modality, which games (by TP2 ID) train it, which
  develop it via programming, and which programming levers to
  pull (§4). The matrix is the weighting the earlier audit
  said was missing. Zero implementation risk; the methodology
  can run on paper tomorrow.
- **Layer 1 — Static modality ratings (no schema, one data
  file).** Ship the matrix ratings as a static data structure
  keyed by TP2 ID alongside `TP_DATA` (the same shape as the
  existing `phasefit` records), and let the existing
  `draftSession` selection engine read it as one more
  emphasis dimension. No table, no migration, no change to
  any game record; the engine already ranks on emphasis and
  fit. This is the smallest technical integration, and it is
  sufficient for modality-aware session planning.
- **Layer 2 — Rescue the orphaned cards (content, not code).**
  Re-issue the 5 cards under new IDs (see §8) — the single
  highest-value content action, and the only one that adds
  dosed conditioning and horizontal-power content without
  authoring anything new.
- **Layer 3 — Genuine-gap supplements only (new content,
  same schema).** Author the §5 gap drills (~20–30) as new
  TP2 entries with full metadata (Builds 1–4, regression,
  progression, cues, safety), field-test before Launch Ready,
  under the library's own rules. Do not author them until the
  programming guide (Layer 0) is in use and the gaps are
  confirmed in practice.
- **Layer 4 — Only if shadow-mode recommendations are wanted.**
  The audit's migration 006, reduced to two tables:
  `game_modalities` (the matrix ratings + coach-set weights)
  and `recommendation_runs` (shadow-mode audit trail). Defer
  the other proposed tables (objectives, progressions, dose,
  coaching, contraindications, links) — the games already
  carry that content in free text, and structuring it before
  field validation would be premature. Shadow mode stays
  flag-off by default, writes only to `recommendation_runs`,
  never touches a plan, and graduates only by separate owner
  decision after field validation.

Explicitly not in any layer: automatic prescriptions,
athlete-facing recommendations, pricing/billing/cohort/
capacity/assessment changes, merges, or deploys.

## 8. The five orphaned field-tested cards — resolution

**What collides.** `field-tested-drills.js` defines 5 cards
under IDs TP2-068–072, but all five IDs are already occupied
in `TP_DATA` by different, Coach Ready Striking / Fielding
games: TP2-068 Race to the Bases, TP2-069 Bucket Run,
TP2-070 Longball Decision, TP2-071 Stop Spot, TP2-072 Kick &
Run. The file's own guards work correctly — each card checks
whether `GI[id].name` matches its own name and, finding a
different game, logs a warning and returns without injecting
— so at runtime all 5 cards contribute 0 drills, exactly as
the audit found. The file is loaded by `index.html` after the
game index is built, so the guards do execute. Two of the
occupied IDs (TP2-068, TP2-069) are also Launch 60 Candidates
(L60-47, L60-48, "PRIORITY AUTHORING — must pass coach
test"), and 9 equipment rows reference TP2-068–072, so the
collision is load-bearing: renaming the existing games would
break launch records, equipment rows, and coach familiarity.

**What the cards contain (and why they matter).**
- **TP2-068 '4-Gate Chaos'** — the ONLY dosed conditioning
  content in the repo: 4 × 90-second rounds, 45–60 seconds
  recovery, field-tested 2026-10-12, coach rating 7/10, KEEP /
  ITERATE. Repeated-sprint / transition, soccer. Rated here
  (not in the 130): M1 T, M2 T, M3 I, M4 P, M5 P, M6 T.
- **TP2-069 'Cone Carry'** — the ONLY horizontal-power card:
  4 broad jumps with stick landings, sprint-back transitions,
  head-to-head and relay formats. Coach-designed, NOT yet
  field-tested (candidate). Rated here: M1 T, M2 I, M3 T,
  M4 P, M5 T, M6 P.
- **TP2-070 'Pace & Tap'** — reaction / change-of-direction
  on a marked path. Candidate, NOT field-tested. Rated here:
  M1 P, M2 T, M3 I, M4 I, M5 P, M6 P.
- **TP2-071 'Stack & Roll'** — ground movement / coordination
  (lateral rolls, object transfer). Candidate, NOT
  field-tested. Rated here: M1 I, M2 I, M3 –, M4 P, M5 T,
  M6 I.
- **TP2-072 'Lift & Shift'** — lateral control / object
  manipulation in an athletic stance. Candidate, NOT
  field-tested. Rated here: M1 I, M2 I, M3 –, M4 P, M5 P,
  M6 I.

**Recommended resolution (no information lost, no behavior
changed, no duplication).** Re-issue the 5 cards under the
next free IDs in the existing sequence, **TP2-131–TP2-135**,
preserving their content verbatim including field-test status
and coach notes. Rationale: one namespace is preserved (the
launch roster, equipment tables, and phase-fit records all
join on TP2 IDs; a `TP3-` namespace would be a second join
key for no benefit), the existing TP2-068–072 games are
untouched, and no content is duplicated. Two preconditions:
(1) reconcile the record-shape mismatch — the cards use a
different record shape than TP_DATA rows (they carry
`phase`/`family`/`sport` and overlay fields onto the `GI`
index, which does not set Category / Primary Quality /
Secondary Qualities), so the re-issued cards must be
authored as full TP_DATA rows (category, primary/secondary
qualities, age range, duration, status) rather than pasted
in as overlays; (2) carry field-test status exactly as
recorded — only 4-Gate Chaos is field-tested (7/10); Cone
Carry, Pace & Tap, Stack & Roll, and Lift & Shift are
candidates requiring field tests and safety review before
any Launch Ready status. Renumbering the *existing* games
is rejected: it would break L60-47/48, 9 equipment rows,
and any coach familiarity, to save 5 cards that can simply
take new IDs. Deleting the collision guards is rejected:
they are the mechanism that prevented a silent overwrite.

## 9. Safety classifications — preserved and clarified

- **The 5 Safety Review games stay restricted:** TP2-084
  Push-Off Balance, TP2-090 Partner Counterbalance, TP2-092
  Partner Push Line, TP2-093 Tug & Tag, TP2-098 Sledless
  Partner Drive. They are rated in the matrix (their mechanics
  are assessable) but must not be programmed until reviewed.
  Their removal from the usable set costs the methodology 5
  M4-Train games (26 → 21 usable) — the single largest
  usable-content loss in the library, and it falls entirely
  on the thinnest modality.
- **The 1 Retired game stays retired:** TP2-125 Corner Rush
  (Duplicate / Consolidate). It duplicates TP2-124/128; it is
  rated in the matrix for completeness and excluded from all
  usable counts.
- **Field-tested status is not evidence of effectiveness or
  age suitability.** Only one card in the entire repo is
  field-tested: 4-Gate Chaos (coach rating 7/10, 2026-10-12,
  "KEEP / ITERATE"). That rating records one coach's judgement
  that the game ran well with 4-player teams and repeated
  rounds — it does not establish that the game improves
  conditioning, and it says nothing about any age group: the
  library's age ranges are per-category (8–18 for most), never
  per-game, and no per-game age-suitability evidence exists
  anywhere. Cone Carry and the three candidates are explicitly
  NOT field-tested. Nothing in this review treats a field
  test, a Launch Ready tier, or a Coach Ready status as proof
  of physiological effect. Effectiveness claims require the
  field validation the assessment battery itself still awaits
  (decision §8).
- **Guardrails that do real work (do not weaken without a
  coach decision):** "Never reward maximum jump distance or
  height" (Jump / Land); "No maximal resistance, neck contact,
  jerking, twisting joints, or mismatched partners" (Strength
  Through Play); "Conditioning is never punishment. Stop the
  round when technique degrades" (Competitive Conditioning);
  "No pushing to failure" (Balance). These texts are the
  reason M3 and M4 are partial rather than absent — they cap
  intensity and keep the games coachable — and they are also
  the reason the intensive layers need separate, governed
  content rather than a quiet loosening of the games.

## 10. Where the earlier audit's conclusions change (and where they don't)

- **M6 — changes substantially.** The audit called it the
  weakest modality (6 primary games). By mechanics it is 20
  Train + 81 via programming (101/130 effective). The weakness
  is structure (no templates, zones, or aerobic base), not
  content. The audit's primary-count framing understated it.
- **M1 — changes in scope.** The audit said "thin at the core"
  (2 primary). Acceleration training is in fact broad (56
  Train). The gap narrows to linear technique and max
  velocity specifically.
- **M2 — confirmed and strengthened.** Still the strongest
  modality; now quantified at 98/130 effective, and no new
  drills are needed for it (only a reactive *test* is missing).
- **M3 — confirmed in substance, narrowed in scope.** The
  base layer (landing quality, submaximal volume) is real;
  the gap is the intensive/vertical layer and dose structure.
- **M4 — confirmed, with the loss quantified.** Stability is
  trained; strength is thin; Safety Review removes 5 of 26
  Train games from use, all in this modality.
- **M5 — confirmed exactly.** Competency covered, mobility
  absent (0/130).
- **New-drill floor — changes: 44–62 → ~20–30 focused
  drills + ~4–6 templates + 5 rescued cards.** The audit
  counted submodalities as if each needed its own drills;
  this review shows most are already covered once programmed.
- **Orphaned cards — confirmed, with a precise resolution.**
  Re-issue as TP2-131–135 as full TP_DATA rows (not overlays);
  carry field-test status exactly; do not renumber existing
  games; do not delete the guards.
- **Unchanged:** no drill/session-content table exists in the
  DB; session planning is prototype-only; no recommendation
  system exists; Smart Draft is advisory-only; the shadow-mode
  design, the phased roadmap's shape, and the untouched list
  all stand. This review does not propose implementing
  migration 006, and its Layer 4 defers most of the audit's
  proposed tables.

## 11. What I could not establish (and why)

- **Whether template-authored games behave as rated in real
  sessions.** 107 games share category-level build/coach-watch
  templates (23 of them a single generic text);
  their ratings rest on the Athletic Problem and category
  mechanics. Whether a coach actually gets the rated stimulus
  from them is a field question, not a document question.
- **Dose response.** No evidence exists anywhere in the repo
  about how much of any game produces how much development.
  The T/P/I/– ratings are judgements about stimulus, not
  measured outcomes. Field validation (§8) is the only route
  to measured claims.
- **Whether the 5 Safety Review games' issues are
  resolvable, and at what cost.** That needs a coach review
  of the specific concerns; the cards do not state them.
- **Per-game age suitability.** Age ranges are per-category
  (8–18 / 9–18 / 10–18); no per-game age evidence exists.
  Nothing in this review endorses any game for any specific
  age.
- **Session-level outcomes.** No session data exists; the
  review rates games, not programs. A session built from
  T-rated games can still be badly dosed.
- **Live-database state.** Not re-queried (read-only audit);
  the applied state of migrations 004/005 rests on the
  recorded 2026-11-13 verification.

## 12. Bottom line for the decision

Reuse before expansion: the library carries the methodology
today for M2 outright, and for M1, M5 (competency), and M6
with programming. Programming before proliferation: the
levers in §4 — round structures, distances, late cues,
clean-rep targets, base-of-support ladders — are already
authored in the cards and cost nothing. Evidence before
prescription: nothing here establishes that any game
*improves* any quality; that claim needs field validation,
and no recommendation should be automated from scores until
it exists. The build order is: programming guide (Layer 0),
static ratings (Layer 1), rescue the 5 cards (Layer 2), then
— only after the guide is in use — the ~20–30 gap drills
(Layer 3). A new drill library is not necessary.
