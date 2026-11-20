/* THE PROGRAM — SaaS validation: HTTP journey checks (2026-11-20).
 *
 * Boots the dev server on an ephemeral port (memory stores, seeded
 * synthetic data) and exercises the 10 validation journeys over real
 * HTTP: /homepage.html, GET /api/saas/plans, POST /api/saas,
 * POST /api/billing, POST /api/assessments. Prints one PASS/FAIL line
 * per check with what was observed; exits non-zero on any failure.
 *
 * Run: node docs/saas-validation-2026-11-20/validate-journeys.js
 * Synthetic data only. No live database, no real billing.
 */
'use strict';

const { createDevServer } = require('../../server/dev-server');

let passed = 0;
let failed = 0;
function check(journey, label, condition, observed) {
  if (condition) { passed += 1; console.log(`PASS ${journey} ${label} :: ${observed}`); }
  else { failed += 1; console.log(`FAIL ${journey} ${label} :: ${observed}`); }
}

async function post(base, pathName, body, headers = {}) {
  const res = await fetch(base + pathName, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function get(base, pathName, headers = {}) {
  const res = await fetch(base + pathName, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML */ }
  return { status: res.status, text, json };
}
const saas = (base, method, params, headers) => post(base, '/api/saas', { method, params }, headers);
const billing = (base, method, params, headers) => post(base, '/api/billing', { method, params }, headers);
const assess = (base, method, params, headers) => post(base, '/api/assessments', { method, params }, headers);

const DIRECTOR = { 'X-Dev-Role': 'director', 'X-Dev-User': 'dev-director-marcus' };
const KAYLA = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-kayla' };
const JORDAN = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-jordan' };
const MARCUS_COACH = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-marcus' };
const PARENT = { 'X-Dev-Role': 'parent', 'X-Dev-User': 'dev-parent-youth' };
const YOUTH_ID = 'ath-synth-youth-12';
const WINGBACK_ID = 'ath-synth-wingback-48';

async function main() {
  const dev = createDevServer({ port: 0, seed: true });
  await dev.start();
  const base = dev.url;
  console.log(`Dev server: ${base} (memory stores, synthetic seed)`);
  try {
    /* ---------- J1: visitor discovers + selects a subscription ---------- */
    const home = await get(base, '/homepage.html');
    check('J1', 'homepage served', home.status === 200, `GET /homepage.html -> ${home.status}`);
    check('J1', 'homepage names the program + test-mode honesty',
      /The Program/.test(home.text) && /test mode/i.test(home.text),
      'contains "The Program" and a test-mode notice');
    check('J1', 'homepage links into the app (log in / create account)',
      /index\.html/.test(home.text), 'links to ./index.html present');
    const plans = await get(base, '/api/saas/plans', DIRECTOR);
    const planCodes = plans.json && plans.json.data && plans.json.data.plans.map(p => p.code);
    check('J1', 'plans API returns the 6 seeded plans',
      Array.isArray(planCodes) && planCodes.length === 6,
      `codes=${JSON.stringify(planCodes)}`);

    /* ---------- J2: athlete registers, correct free access ---------- */
    const ath1 = { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'val-ath-1' };
    const reg1 = await saas(base, 'registerAthlete', { email: 'val1@dev.invalid', name: 'Val Athlete One', age: 24 }, ath1);
    check('J2', 'athlete registration succeeds', reg1.json.ok === true, JSON.stringify(reg1.json).slice(0, 160));
    const ath1Id = reg1.json.data.athlete.id;
    check('J2', 'new athlete is on the free tier (90-day history window)',
      reg1.json.data.entitlements.tier === 'free' && reg1.json.data.entitlements.historyDays === 90,
      `tier=${reg1.json.data.entitlements.tier} historyDays=${reg1.json.data.entitlements.historyDays}`);
    const ent1 = await saas(base, 'myEntitlements', {}, ath1);
    check('J2', 'myEntitlements resolves free for the new athlete',
      ent1.json.ok && ent1.json.data.entitlements.tier === 'free',
      `tier=${ent1.json.data && ent1.json.data.entitlements.tier}`);

    /* ---------- J5 (setup): coach registers with trial ---------- */
    const coach1 = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'val-coach-1' };
    const coachReg = await saas(base, 'registerCoach', { email: 'valc1@dev.invalid', name: 'Val Coach One' }, coach1);
    check('J5', 'coach registration creates solo org + 14-day Coach Starter trial',
      coachReg.json.ok && coachReg.json.data.organization.kind === 'solo' && coachReg.json.data.trial.status === 'trialing',
      `org=${coachReg.json.data && coachReg.json.data.organization.kind} trial=${coachReg.json.data && coachReg.json.data.trial.status}/${coachReg.json.data && coachReg.json.data.trial.planCode}`);

    /* ---------- J3: no payment -> paid features refused server-side ---------- */
    const athAssign = await saas(base, 'createAssignment', { athleteId: ath1Id, title: 'self-assign attempt', gameIds: ['TP2-001'] }, ath1);
    check('J3', 'athlete cannot assign training (role refusal, server-side)',
      athAssign.json.ok === false && athAssign.json.error.code === 'FORBIDDEN',
      `code=${athAssign.json.error && athAssign.json.error.code}`);
    const athRoster = await saas(base, 'myRoster', {}, ath1);
    check('J3', 'athlete cannot call coach roster (role refusal)',
      athRoster.json.ok === false && athRoster.json.error.code === 'FORBIDDEN',
      `code=${athRoster.json.error && athRoster.json.error.code}`);
    const link1 = await saas(base, 'linkAthlete', { athleteId: ath1Id }, coach1);
    check('J3', 'first coach link succeeds for free athlete', link1.json.ok === true, JSON.stringify(link1.json).slice(0, 120));
    const coach2 = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'val-coach-2' };
    await saas(base, 'registerCoach', { email: 'valc2@dev.invalid', name: 'Val Coach Two' }, coach2);
    const link2 = await saas(base, 'linkAthlete', { athleteId: ath1Id }, coach2);
    check('J3', 'second coach link refused for free athlete (ENTITLEMENT_LIMIT)',
      link2.json.ok === false && link2.json.error.code === 'ENTITLEMENT_LIMIT',
      `code=${link2.json.error && link2.json.error.code}`);

    /* ---------- J4: assign -> complete -> persistent history ---------- */
    const badGame = await saas(base, 'createAssignment', { athleteId: ath1Id, title: 'bad', gameIds: ['TP2-084'] }, coach1);
    check('J4', 'Safety Review game rejected server-side (GAME_NOT_ASSIGNABLE)',
      badGame.json.ok === false && badGame.json.error.code === 'GAME_NOT_ASSIGNABLE',
      `code=${badGame.json.error && badGame.json.error.code}`);
    const unknownGame = await saas(base, 'createAssignment', { athleteId: ath1Id, title: 'bad', gameIds: ['TP2-999'] }, coach1);
    check('J4', 'unknown game ID rejected (INVALID_GAME_ID)',
      unknownGame.json.ok === false && unknownGame.json.error.code === 'INVALID_GAME_ID',
      `code=${unknownGame.json.error && unknownGame.json.error.code}`);
    const assigned = await saas(base, 'createAssignment', {
      athleteId: ath1Id, title: 'Speed day', gameIds: ['TP2-001', 'TP2-003'],
      build: 'COMPETE', dose: { rounds: 4, workSec: 30, restSec: 60 },
    }, coach1);
    check('J4', 'coach assignment created with games + dose',
      assigned.json.ok && assigned.json.data.assignment.status === 'assigned',
      `status=${assigned.json.data && assigned.json.data.assignment.status}`);
    const assignmentId = assigned.json.data.assignment.id;
    const listed = await saas(base, 'listAssignments', {}, ath1);
    check('J4', 'athlete sees the assignment',
      listed.json.ok && listed.json.data.assignments.some(a => a.id === assignmentId),
      `count=${listed.json.data && listed.json.data.assignments.length}`);
    const completed = await saas(base, 'completeAssignment', { assignmentId, durationMin: 25, effortRpe: 7, athleteNote: 'felt fast' }, ath1);
    check('J4', 'athlete completes with duration/RPE/note',
      completed.json.ok && completed.json.data.completion.effortRpe === 7,
      `rpe=${completed.json.data && completed.json.data.completion.effortRpe}`);
    const dup = await saas(base, 'completeAssignment', { assignmentId }, ath1);
    check('J4', 'double-complete refused (ALREADY_COMPLETED)',
      dup.json.ok === false && dup.json.error.code === 'ALREADY_COMPLETED',
      `code=${dup.json.error && dup.json.error.code}`);
    const hist1 = await saas(base, 'athleteHistory', {}, ath1);
    check('J4', 'history shows the completion (joined read model)',
      hist1.json.ok && hist1.json.data.completions.length === 1 && hist1.json.data.assignments[0].status === 'completed',
      `completions=${hist1.json.data && hist1.json.data.completions.length}`);
    const hist2 = await saas(base, 'athleteHistory', {}, ath1);
    check('J4', 'history persists across a fresh request (re-login equivalent)',
      hist2.json.ok && hist2.json.data.completions.length === 1,
      `completions=${hist2.json.data && hist2.json.data.completions.length} (dev memory store: restart wipes; within-session persistence + store tests prove the join)`);

    /* ---------- J5: coach checkout (test mode), invitations, roster cap ---------- */
    const coachCheckout = await billing(base, 'createCheckoutSession',
      { ownerType: 'coach', ownerId: coachReg.json.data.coach.id, planCode: 'coach_pro', interval: 'month' }, coach1);
    check('J5', 'coach test-mode checkout session created (fake adapter)',
      coachCheckout.json.ok && !!coachCheckout.json.data.sessionId,
      `sessionId=${coachCheckout.json.data && coachCheckout.json.data.sessionId} priceCents=${coachCheckout.json.data && coachCheckout.json.data.priceCents}`);
    const coachConfirm = await billing(base, 'confirmCheckout', { sessionId: coachCheckout.json.data.sessionId }, coach1);
    check('J5', 'test checkout confirms to an active subscription',
      coachConfirm.json.ok && coachConfirm.json.data.subscription.status === 'active',
      `status=${coachConfirm.json.data && coachConfirm.json.data.subscription.status} plan=${coachConfirm.json.data && coachConfirm.json.data.subscription.planCode}`);
    const invite = await saas(base, 'inviteAthlete', { email: 'invited@dev.invalid' }, coach1);
    check('J5', 'coach invitation returns a one-time token',
      invite.json.ok && typeof invite.json.data.token === 'string' && invite.json.data.token.length >= 16,
      `token length=${invite.json.data && invite.json.data.token.length}`);
    const invitedAth = { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'val-ath-invited' };
    const invitedReg = await saas(base, 'registerAthlete', { email: 'invited@dev.invalid', name: 'Invited Athlete', age: 27 }, invitedAth);
    const accepted = await saas(base, 'acceptInvitation', { token: invite.json.data.token, athleteId: invitedReg.json.data.athlete.id }, invitedAth);
    check('J5', 'athlete accepts invitation and is roster-linked',
      accepted.json.ok === true, JSON.stringify(accepted.json).slice(0, 160));
    const replay = await saas(base, 'acceptInvitation', { token: invite.json.data.token, athleteId: invitedReg.json.data.athlete.id }, invitedAth);
    check('J5', 'invitation token is single-use (INVITATION_INVALID on replay)',
      replay.json.ok === false && replay.json.error.code === 'INVITATION_INVALID',
      `code=${replay.json.error && replay.json.error.code}`);
    // Roster cap on a fresh Starter coach: 15 links OK, 16th refused, overage only when confirmed.
    const capCoach = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'val-coach-cap' };
    await saas(base, 'registerCoach', { email: 'cap@dev.invalid', name: 'Cap Coach' }, capCoach);
    let capOk = 0;
    for (let i = 0; i < 15; i++) {
      const a = await saas(base, 'registerAthlete', { email: `cap${i}@dev.invalid`, name: `Cap Athlete ${i}`, age: 20 + i },
        { 'X-Dev-Role': 'athlete', 'X-Dev-User': `val-cap-ath-${i}` });
      const l = await saas(base, 'linkAthlete', { athleteId: a.json.data.athlete.id }, capCoach);
      if (l.json.ok) capOk += 1;
    }
    const capRoster = await saas(base, 'myRoster', {}, capCoach);
    check('J5', 'Coach Starter roster fills to the 15-athlete cap', capOk === 15 && capRoster.json.data.count === 15,
      `linked=${capOk} rosterCount=${capRoster.json.data && capRoster.json.data.count}`);
    const sixteenth = await saas(base, 'registerAthlete', { email: 'cap16@dev.invalid', name: 'Cap Athlete 16', age: 24 },
      { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'val-cap-ath-16' });
    const overCap = await saas(base, 'linkAthlete', { athleteId: sixteenth.json.data.athlete.id }, capCoach);
    check('J5', '16th athlete refused at cap (ENTITLEMENT_LIMIT)',
      overCap.json.ok === false && overCap.json.error.code === 'ENTITLEMENT_LIMIT',
      `code=${overCap.json.error && overCap.json.error.code}`);
    const overConfirmed = await saas(base, 'linkAthlete', { athleteId: sixteenth.json.data.athlete.id, confirmOverage: true }, capCoach);
    check('J5', 'explicit overage confirmation links with overage flag',
      overConfirmed.json.ok && overConfirmed.json.data.overage === true,
      `overage=${overConfirmed.json.data && overConfirmed.json.data.overage}`);

    /* ---------- J6: coach views progress + assessments ---------- */
    const youthView = await assess(base, 'athleteAssessmentView', { athleteId: YOUTH_ID }, KAYLA);
    check('J6', 'linked coach views youth assessment record (seeded baseline + reassessment)',
      youthView.json.ok && Array.isArray(youthView.json.data.history) && youthView.json.data.history.length === 2,
      `history sessions=${youthView.json.data && youthView.json.data.history && youthView.json.data.history.length}`);
    const youthHist = await saas(base, 'athleteHistory', { athleteId: YOUTH_ID }, KAYLA);
    check('J6', 'coach athleteHistory joins assessment sessions for linked athlete',
      youthHist.json.ok && youthHist.json.data.assessments.length >= 1,
      `assessments=${youthHist.json.data && youthHist.json.data.assessments.length}`);
    const parentView = await assess(base, 'athleteAssessmentView', { athleteId: YOUTH_ID }, PARENT);
    check('J6', 'guardian parent views own athlete assessments', parentView.json.ok === true,
      `ok=${parentView.json.ok}`);

    /* ---------- J7: organization manages multiple coaches (+ org_admin fix) ---------- */
    const founder = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'val-coach-founder' };
    const founderReg = await saas(base, 'registerCoach', { email: 'founder@dev.invalid', name: 'Val Founder' }, founder);
    const orgCreated = await saas(base, 'createOrganization', { name: 'Val Academy', kind: 'academy' }, founder);
    check('J7', 'organization created with trial', orgCreated.json.ok === true, JSON.stringify(orgCreated.json).slice(0, 140));
    const orgId = orgCreated.json.data.organization.id;
    const founderAdmin = { 'X-Dev-Role': 'org_admin', 'X-Dev-User': 'val-coach-founder' };
    const orgInvite = await saas(base, 'inviteToOrg', { organizationId: orgId, email: 'second@dev.invalid' }, founderAdmin);
    check('J7', 'org_admin invites a second coach', orgInvite.json.ok === true, JSON.stringify(orgInvite.json).slice(0, 120));
    const secondCoach = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'val-coach-second' };
    await saas(base, 'registerCoach', { email: 'second@dev.invalid', name: 'Val Second Coach' }, secondCoach);
    const orgAccepted = await saas(base, 'acceptInvitation', { token: orgInvite.json.data.token }, secondCoach);
    check('J7', 'second coach joins the organization', orgAccepted.json.ok === true, JSON.stringify(orgAccepted.json).slice(0, 140));
    const orgAth = await saas(base, 'registerAthlete', { email: 'orgath@dev.invalid', name: 'Val Org Athlete', age: 22 },
      { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'val-ath-org' });
    const orgAthId = orgAth.json.data.athlete.id;
    const orgLink = await saas(base, 'linkAthlete', { athleteId: orgAthId, organizationId: orgId }, secondCoach);
    check('J7', 'org coach links an athlete inside the org', orgLink.json.ok === true, JSON.stringify(orgLink.json).slice(0, 120));
    const overview = await saas(base, 'orgOverview', { organizationId: orgId }, founderAdmin);
    check('J7', 'org overview shows both coaches + the org athlete',
      overview.json.ok && overview.json.data.coaches.length === 2 && overview.json.data.athleteCount === 1,
      `coaches=${overview.json.data && overview.json.data.coaches.length} athletes=${overview.json.data && overview.json.data.athleteCount}`);
    const adminView = await assess(base, 'athleteAssessmentView', { athleteId: orgAthId }, founderAdmin);
    check('J7', 'org_admin views in-org athlete assessments (THE FIX, over HTTP)',
      adminView.json.ok === true, `ok=${adminView.json.ok} code=${adminView.json.error && adminView.json.error.code}`);
    const adminAssess = await assess(base, 'startAssessment', { athleteId: orgAthId }, founderAdmin);
    check('J7', 'org_admin still cannot record assessments (read-only)',
      adminAssess.json.ok === false && adminAssess.json.error.code === 'FORBIDDEN',
      `code=${adminAssess.json.error && adminAssess.json.error.code}`);
    const adminOutside = await assess(base, 'athleteAssessmentView', { athleteId: YOUTH_ID }, founderAdmin);
    check('J7', 'org_admin cannot view athletes outside their org',
      adminOutside.json.ok === false && adminOutside.json.error.code === 'FORBIDDEN',
      `code=${adminOutside.json.error && adminOutside.json.error.code}`);

    /* ---------- J8: cross-tenant isolation (release-blocking) ---------- */
    const jordanList = await saas(base, 'listAssignments', { athleteId: YOUTH_ID }, JORDAN);
    check('J8', 'Coach B cannot list Coach A athlete assignments (ATHLETE_NOT_FOUND)',
      jordanList.json.ok === false && jordanList.json.error.code === 'ATHLETE_NOT_FOUND',
      `code=${jordanList.json.error && jordanList.json.error.code}`);
    const jordanHist = await saas(base, 'athleteHistory', { athleteId: YOUTH_ID }, JORDAN);
    check('J8', 'Coach B cannot read Coach A athlete history (ATHLETE_NOT_FOUND)',
      jordanHist.json.ok === false && jordanHist.json.error.code === 'ATHLETE_NOT_FOUND',
      `code=${jordanHist.json.error && jordanHist.json.error.code}`);
    const jordanAssess = await assess(base, 'athleteAssessmentView', { athleteId: YOUTH_ID }, JORDAN);
    check('J8', 'Coach B cannot view Coach A athlete assessments (FORBIDDEN)',
      jordanAssess.json.ok === false && jordanAssess.json.error.code === 'FORBIDDEN',
      `code=${jordanAssess.json.error && jordanAssess.json.error.code}`);
    const jordanRoster = await saas(base, 'myRoster', {}, JORDAN);
    check('J8', 'Coach B roster never contains Coach A athletes',
      jordanRoster.json.ok && !jordanRoster.json.data.athletes.some(r => r.athlete.id === YOUTH_ID),
      `jordan roster=${JSON.stringify(jordanRoster.json.data && jordanRoster.json.data.athletes.map(r => r.athlete.id))}`);
    const jordanAssign = await saas(base, 'createAssignment', { athleteId: YOUTH_ID, title: 'cross-tenant', gameIds: ['TP2-001'] }, JORDAN);
    check('J8', 'Coach B cannot assign to Coach A athlete (FORBIDDEN)',
      jordanAssign.json.ok === false && jordanAssign.json.error.code === 'FORBIDDEN',
      `code=${jordanAssign.json.error && jordanAssign.json.error.code}`);
    const kaylaRoster = await saas(base, 'myRoster', {}, KAYLA);
    check('J8', 'Coach A roster excludes Coach B athletes',
      kaylaRoster.json.ok && !kaylaRoster.json.data.athletes.some(r => r.athlete.id === 'dev-ath-04'),
      `kayla roster count=${kaylaRoster.json.data && kaylaRoster.json.data.count}`);

    /* ---------- J9: cancel / expire updates entitlements, history retained ---------- */
    const athCheckout = await billing(base, 'createCheckoutSession',
      { ownerType: 'athlete', ownerId: ath1Id, planCode: 'athlete_remote', interval: 'month' }, ath1);
    const athConfirm = await billing(base, 'confirmCheckout', { sessionId: athCheckout.json.data.sessionId }, ath1);
    const athSubId = athConfirm.json.data.subscription.id;
    const paidEnt = await saas(base, 'myEntitlements', {}, ath1);
    check('J9', 'athlete test checkout activates paid tier',
      paidEnt.json.ok && paidEnt.json.data.entitlements.tier === 'paid',
      `tier=${paidEnt.json.data && paidEnt.json.data.entitlements.tier}`);
    const cancelled = await saas(base, 'cancelSubscription', { subscriptionId: athSubId, atPeriodEnd: true }, ath1);
    const afterCancel = await saas(base, 'myEntitlements', {}, ath1);
    check('J9', 'cancel at period end keeps access until period end',
      cancelled.json.ok && afterCancel.json.data.entitlements.tier === 'paid',
      `tier=${afterCancel.json.data && afterCancel.json.data.entitlements.tier}`);
    const expired = await saas(base, 'expireSubscription', { subscriptionId: athSubId }, DIRECTOR);
    const afterExpire = await saas(base, 'myEntitlements', {}, ath1);
    check('J9', 'expiry derives athlete back to free (no deletion)',
      expired.json.ok && afterExpire.json.data.entitlements.tier === 'free',
      `tier=${afterExpire.json.data && afterExpire.json.data.entitlements.tier}`);
    const histAfter = await saas(base, 'athleteHistory', {}, ath1);
    check('J9', 'training history retained after expiry',
      histAfter.json.ok && histAfter.json.data.completions.length === 1,
      `completions=${histAfter.json.data && histAfter.json.data.completions.length}`);
    // Coach1 holds two granting subscriptions (registration trial +
    // confirmed Coach Pro checkout). Expire ALL of them; expiring
    // only one leaves the other granting (verified by probe).
    const coachSub = await saas(base, 'mySubscription', {}, coach1);
    const grantingIds = coachSub.json.data.granting.map(s => s.id);
    for (const id of grantingIds) {
      await saas(base, 'expireSubscription', { subscriptionId: id }, DIRECTOR);
    }
    const coachEntAfter = await saas(base, 'myEntitlements', {}, coach1);
    check('J9', 'expiring all granting subscriptions makes the coach read-only',
      coachEntAfter.json.ok && coachEntAfter.json.data.entitlements.readOnly === true,
      `expired=${grantingIds.length} readOnly=${coachEntAfter.json.data && coachEntAfter.json.data.entitlements.readOnly}`);
    // Fresh unlinked athlete: an already-linked athlete would be an
    // idempotent no-op (alreadyLinked) and would not exercise the
    // subscription gate.
    const freshAth = await saas(base, 'registerAthlete', { email: 'fresh@dev.invalid', name: 'Fresh Athlete', age: 29 },
      { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'val-ath-fresh' });
    const lapsedLink = await saas(base, 'linkAthlete', { athleteId: freshAth.json.data.athlete.id }, coach1);
    check('J9', 'expired coach is read-only: new links refused (SUBSCRIPTION_INACTIVE)',
      lapsedLink.json.ok === false && lapsedLink.json.error.code === 'SUBSCRIPTION_INACTIVE',
      `code=${lapsedLink.json.error && lapsedLink.json.error.code}`);
    const lapsedRoster = await saas(base, 'myRoster', {}, coach1);
    check('J9', 'expired coach roster remains readable (read-only, not deleted)',
      lapsedRoster.json.ok && lapsedRoster.json.data.count >= 1,
      `count=${lapsedRoster.json.data && lapsedRoster.json.data.count}`);

    /* ---------- J10: in-person workflows + $149 member precedence ---------- */
    const wingCheckout = await billing(base, 'createCheckoutSession',
      { ownerType: 'athlete', ownerId: WINGBACK_ID, planCode: 'athlete_remote', interval: 'month' }, DIRECTOR);
    check('J10', '$149 member checkout refused ALREADY_COVERED (no double charge)',
      wingCheckout.json.ok === false && wingCheckout.json.error.code === 'ALREADY_COVERED' &&
      wingCheckout.json.error.coveringSource === 'in_person_membership',
      `code=${wingCheckout.json.error && wingCheckout.json.error.code} coveringSource=${wingCheckout.json.error && wingCheckout.json.error.coveringSource}`);
    const wingEnt = await saas(base, 'myEntitlements', { athleteId: WINGBACK_ID }, DIRECTOR);
    check('J10', 'member entitlement resolves to member tier with full history',
      wingEnt.json.ok && wingEnt.json.data.entitlements.tier === 'member' && wingEnt.json.data.entitlements.fullHistory === true,
      `tier=${wingEnt.json.data && wingEnt.json.data.entitlements.tier} fullHistory=${wingEnt.json.data && wingEnt.json.data.entitlements.fullHistory}`);
    const wingView = await assess(base, 'athleteAssessmentView', { athleteId: WINGBACK_ID }, MARCUS_COACH);
    check('J10', 'in-person assessment flow intact (seeded wingback baseline visible to cohort coach)',
      wingView.json.ok && wingView.json.data.history.length === 1,
      `history sessions=${wingView.json.data && wingView.json.data.history && wingView.json.data.history.length}`);
    const battery = await get(base, '/api/assessments/battery');
    check('J10', 'GAA battery protocol route intact',
      battery.status === 200 && Array.isArray(battery.json.tests) && battery.json.tests.length > 0,
      `tests=${battery.json && battery.json.tests && battery.json.tests.length}`);

    /* ---------- Extra: guardian consent gate (SAAS_UI J8) ---------- */
    const minor = await saas(base, 'registerAthlete', { email: 'minor@dev.invalid', name: 'Val Minor', age: 11 },
      { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'val-ath-minor' });
    const minorId = minor.json.data.athlete.id;
    const minorLink = await saas(base, 'linkAthlete', { athleteId: minorId }, KAYLA);
    check('JX', 'minor without consent cannot be linked (CONSENT_REQUIRED)',
      minorLink.json.ok === false && minorLink.json.error.code === 'CONSENT_REQUIRED',
      `code=${minorLink.json.error && minorLink.json.error.code}`);
    const consent = await saas(base, 'grantConsent', { athleteId: minorId, consentVersion: 'dev-v1', method: 'paper_on_file' }, DIRECTOR);
    check('JX', 'director records off-platform consent (paper_on_file)', consent.json.ok === true,
      JSON.stringify(consent.json).slice(0, 120));
    const minorLink2 = await saas(base, 'linkAthlete', { athleteId: minorId }, KAYLA);
    check('JX', 'link activates after consent granted', minorLink2.json.ok === true,
      JSON.stringify(minorLink2.json).slice(0, 120));
  } finally {
    await dev.close();
  }
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2); });
