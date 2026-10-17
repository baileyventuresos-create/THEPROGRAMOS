/* THE PROGRAM OS — field-tested drill additions
   Additive only: no layout, styling, navigation, or archived prototype changes. */
(function(){
  if (typeof GI === 'undefined' || typeof BUILDS === 'undefined') return;

  const id='TP2-068';
  const existing=GI[id];
  if (existing && String(existing.name||existing.title||'').trim() !== '4-Gate Chaos') {
    console.warn('[THE PROGRAM OS] TP2-068 already occupied; 4-Gate Chaos not injected.');
    return;
  }

  GI[id]=Object.assign({},existing||{}, {
    id,
    name:'4-Gate Chaos',
    title:'4-Gate Chaos',
    phase:'Conditioning',
    family:'Repeated Sprint / Transition',
    sport:'Soccer',
    equip:'12–16 cones; 6–8 soccer balls per grid; pinnies for teams',
    setup:'Build a 15 x 15-yard square with a small gate at each corner and a 3 x 3-yard ball box in the center. Default team size is 4 athletes to minimize standing. For 24 athletes, preferred setup is two grids with three teams of four rotating through short bouts when space and coaching coverage allow; if using one grid, use four teams and rotate athletes deliberately. Each active team owns a corner gate.',
    explain:'Say: "Get balls. Bring them home. When the middle is empty, steal theirs. One player at a time. GO." One player from each active team sprints to the middle, collects a ball and dribbles it through the team gate. As soon as the runner crosses the gate, the next teammate may go. When the middle is empty, runners may steal a ball from another team and dribble it home. Only one active runner per team. Start with a 30-second demonstration round; stop and correct any misunderstanding before scored conditioning rounds.',
    score:'At the end of each round, each ball legally inside a team home counts 1 point. Highest total wins. Recommended conditioning dose: 4 x 90-second rounds with 45–60 seconds recovery. Repeat the same successful version rather than forcing a progression.',
    cues:['Explode to Space','Head Up on the Ball','Brake — Turn — Go'],
    builds:{
      LEARN:'30-second demonstration round. No score. One runner per team; collect from the middle and dribble home. Coach stops immediately to fix rule misunderstandings.',
      COMPETE:'Four 90-second rounds with 45–60 seconds recovery. Middle balls first; stealing becomes live when the middle is empty. Keep the same rules across rounds so intensity rises as understanding improves.',
      PRESSURE:'Soccer-realism option: ball must be passed through the home gate to a teammate rather than carried across. The receiving teammate controls it before the next runner releases.',
      CHAOS:'Soccer-realism option only after the base game is stable: on a steal, create a brief live 2v1 transition to the home gate. Use only when staffing, space and athlete understanding allow safe supervision.'
    },
    regress:'Use a 12 x 12-yard grid, remove stealing and run 30–45-second rounds until the exchange pattern is understood.',
    progress:'Do not progress automatically. Earn complexity by demonstrating clean execution first. Add scanning, passing through the home gate, ball protection or a controlled 2v1 transition before adding arbitrary reaction tasks.',
    watch:'High intent on 5–15-yard accelerations; controlled braking and turning; head up while dribbling; immediate transition when the middle empties; low idle time. If athletes are standing too long, reduce team size before increasing field size.',
    safety:'One active runner per team in the base version. Keep balls controlled below knee height, gates clear, and enough separation between grids to prevent collisions. No body contact during steals in the base game. Stop the round if rule confusion creates unsafe crossing traffic.',
    origin:'Coach field test — 2026-10-12',
    filterWhy:'KEEP / ITERATE — field-tested 7/10. Strong competitive conditioning response. Coach feedback: 4-player teams preferred over 6 to reduce standing; repeated rounds of one stable version were more effective than forced progression; instructions must be demonstrated before live play; future variations should increase soccer realism.',
    status0:'Field Tested — Coach Approved',
    base:'Field Tested',
    tier:'Launch ready',
    launch:{lid:'L60-'+id,readiness:'LAUNCH READY — FIELD TESTED 2026-10-12 — coach rating 7/10; keep/iterate',role:'Core Launch'},
    fieldTest:{date:'2026-10-12',rating:7,maxRating:10,status:'KEEP / ITERATE',notes:['Prefer teams of four over teams of six to reduce standing.','Use a 30-second demonstration round; verbal confirmation alone did not ensure rule understanding.','Repeat a successful version for multiple rounds instead of automatically progressing.','Prioritize future variations that add soccer-game realism.']}
  });
  GI[id].buildKeys=BUILDS.filter(b=>GI[id].builds&&GI[id].builds[b]);
  if(typeof EQP!=='undefined' && typeof parseEquip==='function') EQP[id]=parseEquip(GI[id]);

  const coneId='TP2-069';
  const coneExisting=GI[coneId];
  if (coneExisting && String(coneExisting.name||coneExisting.title||'').trim() !== 'Cone Carry') {
    console.warn('[THE PROGRAM OS] TP2-069 already occupied; Cone Carry not injected.');
  } else {
    GI[coneId]=Object.assign({},coneExisting||{}, {
      id:coneId,
      name:'Cone Carry',
      title:'Cone Carry',
      phase:'MOVE',
      family:'Horizontal Power / Acceleration',
      sport:'Multi-Sport',
      equip:'2 cones per athlete/lane; clearly separated sprint lanes',
      setup:'Create parallel lanes with one starting cone per athlete. Each athlete begins at the starting cone holding a second cone. Use 2 or more athletes head-to-head, or organize athletes into relay teams. Provide enough lateral separation that no athlete enters another athlete’s jump landing or sprint path.',
      explain:'On GO, each athlete performs a powerful two-foot broad jump while holding the cone. Stick and control the two-foot landing, then place the carried cone at the legitimate landing point. Immediately sprint back to the starting cone, touch/reach the start, accelerate back to the dropped cone, pick it up, and perform the next broad jump from that location. Stick, place, sprint back, return, and repeat. Complete 4 broad jumps. After Jump 4, sprint back through the starting point to finish.',
      score:'Race format: first athlete to complete 4 legal broad jumps and sprint back through the starting point wins. Team format: run the same sequence as a relay; the next athlete may leave only after the returning athlete crosses the start line.',
      cues:['Load','Stick','Explode'],
      builds:{
        LEARN:'2 jumps at submaximal speed. No race. Own each two-foot landing, place the cone accurately, and rehearse the first acceleration step before increasing intent.',
        COMPETE:'Head-to-head race for 4 broad jumps. First athlete to complete all 4 legal jumps and sprint through the starting point wins.',
        PRESSURE:'Best-of-3 head-to-head races with short but sufficient recovery. Athletes must preserve jump and landing quality as fatigue rises; stop or regress when landing control deteriorates.',
        CHAOS:'Team relay. Each athlete completes the Cone Carry sequence before crossing the start line to release the next teammate. First team to finish wins.'
      },
      regress:'Use 2 broad jumps instead of 4, remove the race, and reduce jump intensity until the athlete consistently demonstrates a balanced two-foot landing and clean acceleration transition.',
      progress:'Increase competitive pressure before adding volume. Progress from Learn to head-to-head competition, then best-of-3 or relay formats only while jump and landing quality remain clean.',
      watch:'Aggressive horizontal force production; coordinated arm and hip load; two-foot takeoff; balanced two-foot landing; no extra shuffle before acceleration; strong first three sprint steps; consistent jump quality across all four repetitions.',
      safety:'Broad jumps require a controlled two-foot landing before the athlete may sprint. Cones must be placed at the actual landing point — no throwing or reaching the cone forward. Keep athletes in clearly separated lanes with landing and sprint paths free of other athletes or equipment. Stop the rep if landing control breaks down.',
      origin:'Coach-designed drill — 2026-10-14',
      filterWhy:'CANDIDATE — coach-designed horizontal-power and acceleration race. Strong fit for THE PROGRAM movement library, but requires field testing before Launch 60 promotion.',
      status0:'THE LAB — Candidate',
      base:'Coach Designed',
      tier:'Candidate',
      launch:{lid:'L60-'+coneId,readiness:'THE LAB — CANDIDATE — FIELD TEST REQUIRED',role:'Candidate / Not Launch 60'},
      fieldTest:{date:null,rating:null,maxRating:10,status:'NOT YET FIELD TESTED',notes:['Test lane spacing and collision risk.','Confirm four jumps preserves landing quality for target age groups.','Evaluate head-to-head and relay versions for idle time and competitive response.','Promote only after coach field test and safety review.']}
    });
    GI[coneId].buildKeys=BUILDS.filter(b=>GI[coneId].builds&&GI[coneId].builds[b]);
    if(typeof EQP!=='undefined' && typeof parseEquip==='function') EQP[coneId]=parseEquip(GI[coneId]);
    console.info('[THE PROGRAM OS] Candidate drill loaded:',coneId,GI[coneId].name);
  }

  const candidates=[
    {
      id:'TP2-070', name:'Pace & Tap', phase:'MOVE', family:'Reaction / Change of Direction', sport:'Multi-Sport',
      equip:'8–12 floor dots or flat cones; 2 hoops; 4–6 cones; optional small target objects',
      setup:'Create a clearly marked circular or oval movement path with floor dots or flat cones spaced around the perimeter. Place a hoop/target station at opposite ends. Run athletes head-to-head only when each athlete has a clearly defined route and target so paths do not cross.',
      explain:'Athletes move around the marked path at the prescribed pace and direction. On the coach cue, each athlete reacts, changes speed and/or direction as assigned, and taps the called marker or target before returning to movement. The coach controls the cue timing and target. Begin with predictable targets and low speed before making the reaction competitive.',
      score:'Competitive format: 1 point to the first athlete who legally taps the called target and regains control. Play first to 5 points or use 20–30-second rounds. A rep does not count if the athlete cuts through the course, misses the target, or loses body control.',
      cues:['See It','Brake Low','Tap & Go'],
      builds:{LEARN:'Walk/jog the course with a single known target. Coach cues the change and athletes rehearse braking, tapping and re-accelerating without a race.',COMPETE:'Two athletes react to the same target call. First legal tap earns 1 point; first to 5 wins.',PRESSURE:'Use shorter cue intervals or alternate two known targets while athletes must maintain clean deceleration and re-acceleration.',CHAOS:'Coach may call any marked target and reverse movement direction. Use only after athletes consistently hold spacing and understand the course.'},
      regress:'Reduce the number of targets, slow the movement pace and remove the race until athletes can stop, tap and restart under control.',
      progress:'Increase decision demand before increasing speed: add target choices, direction changes or competitive scoring only while spacing and braking remain clean.',
      watch:'Eyes up for the cue; low center of mass into the stop; outside-foot control; quick but balanced target touch; efficient first step out of the change; no drifting into another athlete’s lane.',
      safety:'Use flat markers where possible. Keep athletes on defined paths with enough separation to prevent crossing collisions. No diving or sliding to win a tap. Require controlled deceleration before reaching toward a target. Stop the game if athletes begin cutting across traffic.',
      origin:'Adapted movement-game concept from coach reference — 2026-10-17', filterWhy:'CANDIDATE — reaction, deceleration and change-of-direction game adapted from a visual reference. Exact original rules were not assumed; THE PROGRAM version requires floor testing and safety review.',
      fieldNotes:['Confirm ideal circle size and marker spacing by age group.','Test whether first-to-5 or timed rounds creates better work-to-rest.','Verify head-to-head paths stay collision-free.','Promote only after coach field test and safety review.']
    },
    {
      id:'TP2-071', name:'Stack & Roll', phase:'CONTROL', family:'Ground Movement / Coordination', sport:'Multi-Sport',
      equip:'2 hoops per lane; 3–5 lightweight cones or stacking objects per athlete; clear padded or smooth floor space',
      setup:'Create parallel lanes with a hoop/stacking station at each end. Place identical lightweight objects in the starting hoop. Give each athlete enough width to roll laterally without contacting another athlete or equipment.',
      explain:'From the starting station, the athlete moves to the opposite station using a controlled lateral body roll, transfers one object, then returns by rolling back. Continue one object at a time until the required stack or transfer is complete. Athletes must regain control before handling the object; speed never overrides safe ground movement.',
      score:'Race format: first athlete to legally transfer and stack all assigned objects wins. An object that falls outside the target must be corrected before the athlete continues. Recommended first test: 3 objects per athlete.',
      cues:['Brace','Roll Long','Own the Stop'],
      builds:{LEARN:'One object, no race. Rehearse a controlled lateral roll, stop, orient, transfer the object and return.',COMPETE:'Parallel-lane race transferring 3 objects one at a time. First complete legal stack wins.',PRESSURE:'Best-of-3 short races or increase to 4 objects only if athletes maintain controlled rolls and orientation.',CHAOS:'Relay format with one athlete working at a time per lane. Each athlete transfers one object before tagging the next teammate.'},
      regress:'Shorten the rolling distance, use one or two objects and allow athletes to reset to a seated position between rolls.',
      progress:'Increase competitive pressure or object count modestly; do not add speed or volume when athletes show dizziness, poor orientation or uncontrolled contact with the floor.',
      watch:'Whole-body coordination; trunk stiffness during the roll; controlled stop; quick reorientation; accurate object placement; ability to move both directions with similar control.',
      safety:'Use only on a clean, unobstructed surface appropriate for ground movement. Space lanes so rolling athletes cannot collide. No head-first diving, forced neck rolling or contact between athletes. Stop immediately for dizziness, disorientation, pain or uncontrolled rolling.',
      origin:'Adapted movement-game concept from coach reference — 2026-10-17', filterWhy:'CANDIDATE — coordination and ground-movement challenge adapted from a visual reference. Requires floor testing, especially for surface suitability, dizziness response and safe spacing.',
      fieldNotes:['Test on intended gym surface before athlete use.','Determine age-appropriate roll distance and object count.','Monitor dizziness/orientation response closely.','Promote only after coach field test and safety review.']
    },
    {
      id:'TP2-072', name:'Lift & Shift', phase:'CONTROL', family:'Lateral Control / Object Manipulation', sport:'Multi-Sport',
      equip:'4–6 lightweight buckets/cups or targets; 2–3 pool noodles or light dowels; 2 hoops; flat floor markers',
      setup:'Build one station per athlete or pair. Arrange lightweight containers/targets to the left and right of a wide athletic starting position, with pool noodles/light dowels positioned as movement constraints or transfer tools. Keep all objects low, light and stable, with generous clearance between stations.',
      explain:'Athlete begins in a wide athletic stance and completes the assigned lift-and-shift pattern by moving lightweight objects between designated targets while staying balanced and under control. The athlete must shift the hips and body laterally rather than reaching recklessly. Start with a fixed sequence demonstrated by the coach; accuracy comes before speed.',
      score:'Challenge format: complete the prescribed transfer sequence cleanly. Competitive format: fastest legal completion wins; add a time penalty or require correction for a missed target or dropped object. Use short bouts rather than prolonged static holds.',
      cues:['Sit & Shift','Stay Tall','Place — Don’t Toss'],
      builds:{LEARN:'Fixed left-right transfer pattern with no race. Athlete learns stance, weight shift and accurate placement.',COMPETE:'Two matched stations run the same pattern. Fastest clean completion wins.',PRESSURE:'Add one extra transfer or require alternating hands while preserving stance and target accuracy.',CHAOS:'Coach calls left/right or target color/order during the bout. Athlete must solve the sequence while maintaining body control.'},
      regress:'Raise target height slightly, reduce reach distance, use fewer objects and allow the athlete to reset stance between transfers.',
      progress:'Increase decision complexity or alternate-hand demands before increasing reach distance or bout duration.',
      watch:'Athletic hip position; lateral weight transfer; stable feet and knees; trunk control; eyes locating the next target; accurate placement without throwing; no excessive reaching beyond the base of support.',
      safety:'Use only lightweight, non-breakable objects and soft/light constraints. Keep the floor clear and stations separated. Do not require extreme squat depth, forced range of motion or long static holds. Athletes place objects rather than throw them. Stop or regress if balance, knee position or back control deteriorates.',
      origin:'Adapted movement-game concept from coach reference — 2026-10-17', filterWhy:'CANDIDATE — lateral-control and coordination challenge adapted from a visual reference. Exact original rules were not assumed; THE PROGRAM version requires floor testing before approval.',
      fieldNotes:['Test target spacing and stance width across age groups.','Confirm equipment arrangement does not create trip hazards.','Compare fixed-sequence versus coach-call versions for engagement and movement quality.','Promote only after coach field test and safety review.']
    }
  ];

  candidates.forEach(d=>{
    const prior=GI[d.id];
    if(prior && String(prior.name||prior.title||'').trim()!==d.name){ console.warn('[THE PROGRAM OS] '+d.id+' already occupied; '+d.name+' not injected.'); return; }
    GI[d.id]=Object.assign({},prior||{},d,{
      title:d.name,
      status0:'THE LAB — Candidate',
      base:'Adapted / Coach Reference',
      tier:'Candidate',
      launch:{lid:'L60-'+d.id,readiness:'THE LAB — CANDIDATE — FIELD TEST REQUIRED',role:'Candidate / Not Launch 60'},
      fieldTest:{date:null,rating:null,maxRating:10,status:'NOT YET FIELD TESTED',notes:d.fieldNotes}
    });
    delete GI[d.id].fieldNotes;
    GI[d.id].buildKeys=BUILDS.filter(b=>GI[d.id].builds&&GI[d.id].builds[b]);
    if(typeof EQP!=='undefined' && typeof parseEquip==='function') EQP[d.id]=parseEquip(GI[d.id]);
    console.info('[THE PROGRAM OS] Candidate drill loaded:',d.id,GI[d.id].name);
  });

  console.info('[THE PROGRAM OS] Field-tested drill loaded:',id,GI[id].name);
})();