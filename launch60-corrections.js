/* THE PROGRAM OS — Launch 60 correction pass */
(function(){
  window.PROGRAM_RULES=Object.assign({},window.PROGRAM_RULES||{},{
    launchStaffing:{status:'LOCKED',rule:'One coach = one active station. Simultaneous BUILD stations may never exceed available coaches. No unsupervised/self-running stations at launch.',stationRatio:'1 coach : 1 active station',selfDirectedStations:false}
  });

  const authored=(id,patch)=>{
    const g=GI[id]; if(!g)return;
    Object.assign(g,patch);
    g.buildKeys=BUILDS.filter(b=>g.builds&&g.builds[b]);
    g.status0='Candidate — Coach Ready';
    g.base='Candidate';
    g.launch=g.launch||{lid:'L60-'+id,readiness:'',role:'Core Launch'};
    g.launch.readiness='LAUNCH READY — authored V2.4 (card standard; not field tested)';
    g.launch.role='Core Launch';
    g.tier='Launch ready';
    if(typeof EQP!=='undefined') EQP[id]=parseEquip(g);
  };

  authored('TP2-028',{
    equip:'6 hoops per field; 8 floor spots per field',
    setup:'Build two parallel island lanes, each 8 yards long and at least 4 yards apart. In each lane place 3 hoops and 4 floor spots in a staggered path with 2–4 feet between landing zones. Mark a start line 2 yards before the first island and a finish cone 3 yards beyond the last island. One athlete per lane moves at a time.',
    explain:'Cross the islands without touching the water. Choose a route, jump from island to island, stick each landing for one count, then accelerate through the finish. A foot fully outside a target is water and the athlete restarts from the previous island.',
    score:'1 point for a clean crossing with no water touches; +1 for a controlled final landing and clean acceleration through the exit. Three reps each.',
    cues:['See the Next Island','Stick Then Go','Quiet Landings'],
    builds:{LEARN:'Walk the route first, then two-foot jumps with a one-count stick on every island. No score.',COMPETE:'Three scored crossings. One point clean route + one point controlled exit.',PRESSURE:'Move two islands farther apart or require a single-leg landing on the final two islands.',CHAOS:'Coach points LEFT or RIGHT at midpoint; athlete changes to the indicated branch without stepping off an island.'},
    regress:'Move islands closer, use larger targets and allow step-to-jump.',
    progress:'Increase spacing, add a branch decision or require selected single-leg landings while preserving control.',
    watch:'Scan before takeoff, land softly with knees tracking over toes, stabilize before the next jump and keep the trunk controlled.',
    safety:'Non-slip targets only. No unstable equipment. One athlete per lane. Keep 3 yards clear beyond the finish and at least 4 yards between lanes. Stop if landing quality breaks down.',
    origin:'V2 jump family correction (authored V2.4)'
  });

  authored('TP2-029',{
    equip:'8 cones per field; 2 short soft ropes per field',
    setup:'Lay two soft ropes parallel to form an 8-yard river. Start the banks 18 inches apart and widen them gradually to about 4 feet. Use cones to mark narrow, medium and wide crossing zones. Add a start cone 3 yards before the river and an exit cone 4 yards beyond.',
    explain:'Run the bank, choose a crossing, clear the river, stick the landing for one count, then accelerate to the exit. Alternate takeoff side each rep.',
    score:'Narrow crossing = 1, medium = 2, wide = 3. Points count only if the athlete clears both ropes and controls the landing. Three attempts.',
    cues:['Choose Before Takeoff','Drive Across','Own the Landing'],
    builds:{LEARN:'Use narrow and medium crossings at controlled speed; stick every landing for two counts.',COMPETE:'Choose any crossing and score 1/2/3 by width.',PRESSURE:'Coach closes one crossing after the approach begins, forcing a safe route change before takeoff.',CHAOS:'Two rivers are available; coach calls LEFT or RIGHT during the approach.'},
    regress:'Keep the river narrow, shorten the approach and allow two-foot takeoff/landing.',
    progress:'Widen selected zones or alternate takeoff legs while preserving controlled landings.',
    watch:'Choose before final steps, avoid stutter steps, land quietly and re-accelerate only after control.',
    safety:'Soft ropes flat on a non-slip surface. No raised obstacles. One athlete in the river area at a time. Never widen beyond a safely clearable distance.',
    origin:'V2 jump family correction (authored V2.4)'
  });

  authored('TP2-030',{
    equip:'8 cones per field; 4 low collapsible hurdles per field',
    setup:'Build two parallel 10-yard lanes at least 5 yards apart. Put two low collapsible hurdles 4 yards apart in each lane. At the end place LEFT and RIGHT exit gates, each 3 yards from hurdle two. Athlete starts 3 yards before hurdle one.',
    explain:'Clear both hurdles with controlled landings. While the athlete is over hurdle two, the coach points LEFT or RIGHT. Athlete lands, brakes, finds the cue and accelerates through the called gate.',
    score:'1 point for two clean hurdle clearances plus the correct gate. A knocked hurdle, wrong gate or uncontrolled landing scores 0. Four reps.',
    cues:['Clear Clean','Land Ready','Find the Gate'],
    builds:{LEARN:'One hurdle, no late cue; stick the landing then accelerate through a pre-called gate.',COMPETE:'Two hurdles plus late LEFT/RIGHT cue. Four scored reps.',PRESSURE:'Move exit gates wider and shorten reaction time after landing.',CHAOS:'Coach can call LEFT, RIGHT or BOTH; BOTH means choose the farther open gate.'},
    regress:'Use one very low hurdle or a tape line, pre-call the gate and increase recovery space.',
    progress:'Use a later cue or wider gates; do not progress by raising hurdle height.',
    watch:'Clear rather than over-jump, land under control, get eyes up quickly, brake before redirecting and accelerate through the gate.',
    safety:'Low collapsible hurdles only. One athlete per lane, 5 yards between lanes and 3 yards clear beyond gates. Stop if athletes clip hurdles or lose landing control.',
    origin:'V2 jump family correction (authored V2.4)'
  });

  authored('TP2-042',{
    equip:'8 cones per field; 1 pinnie per pair; 1 soft ball per field',
    setup:'Mark a 12 x 20-yard field with a 3-yard end zone at each end. Play 3v3 or 4v4; one team wears pinnies. For larger groups, create another field rather than increasing team size beyond 5.',
    explain:'Pass, move, catch in the end zone. Ball carrier may take up to 3 steps and has 3 seconds to pass. Defenders may intercept but may not body-check, strip from hands or make contact. Drop, interception, out-of-bounds or 3-second violation is a turnover.',
    score:'1 point per legal end-zone catch. After a score, the other team starts from its own end line. Play to 5 or use 5-minute rounds.',
    cues:['Scan Before Catch','Pass Then Move','Win Space'],
    builds:{LEARN:'Offense plays 4v3 or uses one neutral player. Ball carrier gets 3 steps and 5 seconds.',COMPETE:'Even teams. Three steps, 3-second rule, first to 5.',PRESSURE:'Ball carrier may NOT run: pivot only and pass within 3 seconds. This absorbs the No-Dribble / Keepaway variation.',CHAOS:'After every turnover, the new offense has 5 seconds to attempt a forward pass before normal rules resume.'},
    regress:'Add a neutral offensive player, enlarge the field or allow 5 seconds on the ball.',
    progress:'Pivot-only carrier rule, smaller field or faster transition after turnovers.',
    watch:'Scan before receiving, create width/depth, move after passing and transition immediately when possession changes.',
    safety:'No body checking, screening contact, diving or stripping from hands. Soft ball only. Keep 3 yards runoff beyond each end line.',
    origin:'V2.3 parent ruleset; consolidated V2.4'
  });

  const fold=(id,parent)=>{
    const g=GI[id]; if(!g)return;
    g.tier='Retired'; g.base='Retired'; g.status0='Retired — consolidated into '+gName(parent); g.launch=null;
  };
  fold('TP2-060','TP2-042');
  fold('TP2-067','TP2-042');

  if(Array.isArray(REVIEW_NOTES)){
    const done=new Set(['TP2-028','TP2-029','TP2-030','TP2-042','TP2-060','TP2-067']);
    for(let i=REVIEW_NOTES.length-1;i>=0;i--) if(done.has(REVIEW_NOTES[i][0])) REVIEW_NOTES.splice(i,1);
  }

  console.info('[THE PROGRAM OS] Launch staffing locked; jump trio authored; end-zone trio consolidated.');
})();