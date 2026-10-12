/* THE PROGRAM OS — Launch 60 field-authoring overrides
   This file intentionally patches the immutable V2.3 workbook-derived objects before boot().
   It lets the live OS advance through Launch 60 without rewriting the archived prototype source.
   Source decisions remain visible/auditable; field validation is still required. */
(function(){
  const authored = (id, patch, lid) => {
    const g = GI[id];
    if (!g) return;
    Object.assign(g, patch);
    g.buildKeys = BUILDS.filter(b => g.builds && g.builds[b]);
    g.status0 = 'Candidate — Coach Ready';
    g.base = 'Candidate';
    g.launch = g.launch || {lid: lid || ('L60-'+id), readiness:'', role:'Core Launch'};
    g.launch.readiness = 'LAUNCH READY — authored V2.4 (card standard; not field tested)';
    g.launch.role = 'Core Launch';
    g.tier = 'Launch ready';
    if (typeof EQP !== 'undefined') EQP[id] = parseEquip(g);
  };

  /* Already coach-ready in the uploaded V2.3 source: Mirror Escape, Everyone Hunts,
     Swarm Chase and Color Call. This pass authors the remaining first-priority core. */

  authored('TP2-002', {
    equip:'7 cones per field',
    setup:'For each pair, place 1 center cone and 2 turn cones 4 yards to its left and right, forming a shallow arc. Put a finish gate 8 yards beyond the center cone with 2 cones. Runner and chaser start side by side 2 yards behind the center cone; runner is one step ahead. Keep neighboring fields at least 5 yards apart.',
    explain:'Say: "Runner owns the curve; chaser owns the cutoff." On GO, the runner chooses left or right, curves around that turn cone, then races through the finish gate. The chaser must round the center cone before pursuing and may score only with an open-hand shoulder/upper-arm tag before the runner crosses the gate. Run 4 reps, alternating the runner’s choice, then swap roles.',
    score:'Runner scores 1 for crossing the finish gate untagged. Chaser scores 1 for a legal tag before the gate. Four reps in each role; highest combined score wins.',
    cues:['Win the Curve','Eyes on Hips','Cut the Angle'],
    builds:{
      LEARN:'Jog-speed reps with a 2-step runner advantage. No scoring. Runner practices a smooth curve; chaser practices rounding the center cone and taking a safe cutoff angle.',
      COMPETE:'Full speed. Score each rep; 4 reps per role.',
      PRESSURE:'Reduce the runner advantage to 1 step and move the finish gate 2 yards closer.',
      CHAOS:'Coach calls LEFT or RIGHT after GO; runner must take that curve and both athletes react.'
    },
    regress:'Increase the runner advantage to 3 steps, widen the arc, and run at controlled speed.',
    progress:'Narrow the start advantage or use a late direction call after both athletes begin moving.',
    watch:'Runner stays tall enough to see space, leans through the curve without crossing feet, and accelerates out. Chaser reads hips and cuts space instead of following the exact path.',
    safety:'Open-hand tag on shoulder or upper arm only; no grabbing, pushing, diving or cutting across another field. Keep at least 3 yards of clear runoff beyond the finish gate and 5 yards between pair fields. Non-slip surface only.',
    origin:'New V2 research/adaptation (authored V2.4)',
    filterWhy:'ADMIT: Hold speed on a curved path while reading and cutting off an opponent. Authored to coach-ready card standard; field validation still required.'
  });

  authored('TP2-018', {
    equip:'2 cones per pair; 1 soft playground/foam ball per pair',
    setup:'Create parallel 4-yard-wide lanes. Put a start cone at one end and a chase cone 6 yards away. In each pair, the DROPPER stands at the chase cone holding a soft ball at shoulder height with the arm extended; the RACER stands at the start cone facing the ball. Leave 3 yards of runoff beyond the dropper and at least 3 yards between lanes.',
    explain:'Say: "Move when the ball moves, not when the person moves." The dropper may fake with the body but keeps the ball still until the release. Without a countdown, the dropper releases the ball straight down. The racer reacts to the release and sprints to catch the ball after one bounce but before the second bounce. Five drops, then switch roles.',
    score:'Racer scores 1 for securing the ball after the first bounce and before the second. Dropper scores 1 if the ball bounces twice first. Five drops each; highest total wins.',
    cues:['See the Ball','First Step Now','Run Through'],
    builds:{
      LEARN:'Drop from head height with no fakes. Racer begins 4 yards away and learns to react to the release.',
      COMPETE:'Start 6 yards away. Five scored drops per role.',
      PRESSURE:'Drop from shoulder height or move the racer back 1 yard.',
      CHAOS:'Dropper holds one ball in each hand and releases either hand; racer must read which ball actually drops.'
    },
    regress:'Start 3–4 yards away, use a larger soft ball, and allow the catch before the third bounce.',
    progress:'Increase start distance by 1 yard or add legal body fakes before release.',
    watch:'Racer reacts to ball release rather than guessing, drives the first two steps, keeps eyes on the ball and decelerates under control to secure it.',
    safety:'Soft balls only. Drop vertically; never throw at the racer. One racer per lane. No diving or sliding for the ball. Keep lanes separated and runoff clear of walls/equipment.',
    origin:'V1 rebuilt (authored V2.4)',
    filterWhy:'ADMIT: React to an unpredictable release and accelerate before the object reaches the floor. Authored to coach-ready card standard; field validation still required.'
  });

  /* Backlog replacement selected by the Launch 60 review to fill the deceleration gap. */
  authored('TP2-012', {
    equip:'10 cones per field',
    setup:'Build a 12 x 18-yard rectangle. Use 6 cones to mark three parallel crossing lines at 0, 6, 12 and 18 yards (start plus three lanes). One DEFENDER owns each of the three interior lines and may slide only along that line. Remaining athletes are RUNNERS behind the start line. For groups over 10, build a second field.',
    explain:'Say: "Cross all three lines without getting tagged." One runner enters at a time. Defenders slide left/right on their own line and use an open-hand tag on shoulder or upper arm. A runner may stop, fake and change direction but cannot leave the side boundaries. Tagged runners still continue through the remaining lanes so every rep includes all three decisions. Rotate defenders after every 3 runners.',
    score:'Runner scores 1 point for each defended line crossed untagged, maximum 3 per rep. Defenders score 1 for each legal tag. After everyone has 3 running reps, highest individual runner total and highest defender total are the targets to beat next round.',
    cues:['Brake Before the Line','Move the Defender','Burst Through'],
    builds:{
      LEARN:'Defenders move at half speed and may not tag; runners practice braking, faking and bursting through each line.',
      COMPETE:'Live tags and 1 point per line crossed. Three running reps each.',
      PRESSURE:'Narrow the field from 12 to 9 yards or give each runner 8 seconds to clear all three lines.',
      CHAOS:'Coach removes one defender just before the rep or swaps which line is open, forcing the runner to scan and change the plan.'
    },
    regress:'Use two defended lines, a 14-yard-wide field and half-speed defenders.',
    progress:'Narrow the field, add an 8-second clock, or allow the middle defender to shift to either adjacent line after the runner crosses line one.',
    watch:'Runner decelerates before pressure instead of at the defender, sells a real fake, re-accelerates immediately and scans the next line. Defenders stay square and controlled.',
    safety:'Open-hand shoulder/upper-arm tags only; no grabbing, blocking, pushing or diving. Defenders stay on their assigned line. Only one runner enters a field at a time. Keep 3 yards clear beyond the final line.',
    origin:'New V2 research/adaptation (authored V2.4)',
    filterWhy:'ADMIT: Change speed and direction to cross multiple defended lanes. Selected from the Launch 60 replacement pool and authored to coach-ready standard; field validation still required.'
  }, 'L60-R1');
})();
