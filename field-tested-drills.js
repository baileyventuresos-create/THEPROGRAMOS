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

  console.info('[THE PROGRAM OS] Field-tested drill loaded:',id,GI[id].name);
})();