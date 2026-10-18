/* THE PROGRAM OS — Assessment Engine V1
 * Pure, UI-agnostic assessment calculations. No production state mutation.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.TPAssessmentEngine=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const DEFINITIONS={
    '10yd-sprint':{id:'10yd-sprint',name:'10-Yard Sprint',domain:'acceleration',unit:'sec',direction:'lower',attempts:3,aggregation:'best',retestDays:28},
    'broad-jump':{id:'broad-jump',name:'Standing Broad Jump',domain:'horizontal_power',unit:'in',direction:'higher',attempts:3,aggregation:'best',retestDays:28},
    'rotational-scoop-r':{id:'rotational-scoop-r',name:'Rotational Scoop Throw — Right',domain:'rotational_power',unit:'ft',direction:'higher',attempts:3,aggregation:'best',side:'right',pairId:'rotational-scoop',retestDays:28},
    'rotational-scoop-l':{id:'rotational-scoop-l',name:'Rotational Scoop Throw — Left',domain:'rotational_power',unit:'ft',direction:'higher',attempts:3,aggregation:'best',side:'left',pairId:'rotational-scoop',retestDays:28},
    'push-ups':{id:'push-ups',name:'Quality Push-Ups',domain:'relative_strength',unit:'reps',direction:'higher',attempts:1,aggregation:'best',retestDays:28},
    'side-plank-r':{id:'side-plank-r',name:'Side Plank — Right',domain:'trunk_control',unit:'sec',direction:'higher',attempts:1,aggregation:'best',side:'right',pairId:'side-plank',retestDays:28},
    'side-plank-l':{id:'side-plank-l',name:'Side Plank — Left',domain:'trunk_control',unit:'sec',direction:'higher',attempts:1,aggregation:'best',side:'left',pairId:'side-plank',retestDays:28},
    'throw-velo':{id:'throw-velo',name:'Throwing Velocity',domain:'throwing_velocity',unit:'mph',direction:'higher',attempts:5,aggregation:'best',module:'baseball',retestDays:28},
    'throw-accuracy':{id:'throw-accuracy',name:'Throwing Accuracy',domain:'throwing_accuracy',unit:'pct',direction:'higher',attempts:1,aggregation:'best',module:'baseball',retestDays:28},
    'exit-velo':{id:'exit-velo',name:'Exit Velocity',domain:'bat_speed_output',unit:'mph',direction:'higher',attempts:5,aggregation:'best',module:'baseball',retestDays:28}
  };

  const BATTERIES={
    generalAthlete:['10yd-sprint','broad-jump','rotational-scoop-r','rotational-scoop-l','push-ups','side-plank-r','side-plank-l'],
    baseball:['throw-velo','throw-accuracy','exit-velo']
  };

  function finite(values){return (values||[]).map(Number).filter(Number.isFinite);}
  function definition(id){const d=DEFINITIONS[id]; if(!d) throw new Error('Unknown assessment: '+id); return d;}
  function result(id,attempts){
    const d=definition(id), vals=finite(attempts);
    if(!vals.length) return null;
    return d.direction==='lower'?Math.min.apply(null,vals):Math.max.apply(null,vals);
  }
  function change(id,baseline,current){
    const d=definition(id), b=Number(baseline), c=Number(current);
    if(!Number.isFinite(b)||!Number.isFinite(c)||b===0) return null;
    const raw=c-b, pct=(raw/Math.abs(b))*100;
    const improvement=d.direction==='lower'?-pct:pct;
    return {raw:Number(raw.toFixed(3)),percent:Number(pct.toFixed(2)),improvementPercent:Number(improvement.toFixed(2)),improved:improvement>0};
  }
  function asymmetry(left,right){
    const l=Number(left),r=Number(right); if(!Number.isFinite(l)||!Number.isFinite(r)||Math.max(Math.abs(l),Math.abs(r))===0)return null;
    const pct=(Math.abs(l-r)/Math.max(Math.abs(l),Math.abs(r)))*100;
    return {percent:Number(pct.toFixed(2)),higher:l===r?'even':(l>r?'left':'right'),label:pct>=15?'monitor':'within-band'};
  }
  function interpret(id,baseline,current){
    const d=definition(id), delta=change(id,baseline,current);
    if(!delta) return {domain:d.domain,status:'baseline',message:'Baseline established.'};
    const a=Math.abs(delta.improvementPercent);
    const status=a<1?'stable':(delta.improved?'improved':'declined');
    return {domain:d.domain,status,change:delta,message:status==='stable'?'No meaningful change yet.':(status==='improved'?'Output improved from baseline.':'Output is below baseline; review context before changing training.')};
  }
  function generatePriorities(records){
    const scores={};
    (records||[]).forEach(r=>{
      if(!r||!r.assessmentId)return;
      const d=DEFINITIONS[r.assessmentId]; if(!d)return;
      const delta=change(r.assessmentId,r.baseline,r.current);
      if(!delta)return;
      const need=Math.max(0,-delta.improvementPercent);
      scores[d.domain]=(scores[d.domain]||0)+need;
    });
    return Object.keys(scores).sort((a,b)=>scores[b]-scores[a]).map(domain=>({domain,evidenceScore:Number(scores[domain].toFixed(2)),source:'assessment-trend'}));
  }
  function buildSession(athleteId,entries,meta){
    const results=(entries||[]).map(e=>({assessmentId:e.assessmentId,attempts:finite(e.attempts),result:result(e.assessmentId,e.attempts),notes:e.notes||''}));
    return {version:1,athleteId:String(athleteId||''),recordedAt:(meta&&meta.recordedAt)||new Date().toISOString(),battery:(meta&&meta.battery)||'custom',results,notes:(meta&&meta.notes)||''};
  }
  return {version:'1.0.0',definitions:DEFINITIONS,batteries:BATTERIES,result,change,asymmetry,interpret,generatePriorities,buildSession};
});
