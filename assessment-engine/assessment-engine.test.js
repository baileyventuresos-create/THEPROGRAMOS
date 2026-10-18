/* Run with: node assessment-engine/assessment-engine.test.js */
const assert=require('assert');
const E=require('./assessment-engine.js');

assert.equal(E.result('10yd-sprint',[2.11,2.06,2.08]),2.06);
assert.equal(E.result('broad-jump',[58,63,61]),63);

const sprint=E.change('10yd-sprint',2.06,1.97);
assert.equal(sprint.improved,true);
assert(sprint.improvementPercent>4);

const jump=E.change('broad-jump',58,63);
assert.equal(jump.improved,true);
assert(jump.improvementPercent>8);

const asym=E.asymmetry(18,21);
assert.equal(asym.label,'within-band');
assert.equal(asym.higher,'right');

const monitor=E.asymmetry(17,21);
assert.equal(monitor.label,'monitor');

const session=E.buildSession('demo-athlete',[{assessmentId:'10yd-sprint',attempts:[2.11,2.06,2.08]}],{battery:'generalAthlete',recordedAt:'2026-10-18T12:00:00Z'});
assert.equal(session.results[0].result,2.06);
assert.equal(session.results[0].attempts.length,3);

const priorities=E.generatePriorities([{assessmentId:'broad-jump',baseline:63,current:60},{assessmentId:'10yd-sprint',baseline:2.06,current:2.10}]);
assert(priorities.length>=1);

console.log('Assessment Engine V1 smoke tests passed.');
