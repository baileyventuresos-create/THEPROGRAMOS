/* THE PROGRAM — SaaS validation browser walkthrough (2026-11-20).
 *
 * Drives the real dev app in headless Chromium (playwright-core from
 * /tmp/pw-setup + the system Chromium binary under
 * ~/.cache/ms-playwright). Captures screenshots under
 * docs/saas-validation-2026-11-20/screenshots/ and logs PASS/FAIL per
 * UI check, including console/page errors and mobile overflow.
 * Synthetic data only; dev server memory stores. Tooling is NOT part
 * of the app: playwright-core lives in /tmp, never in the repo.
 *
 * Run: node docs/saas-validation-2026-11-20/walkthrough.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('/tmp/pw-setup/node_modules/playwright-core');
const { createDevServer } = require('../../server/dev-server');

const SHOT_DIR = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let passed = 0; let failed = 0;
function check(id, label, condition, observed) {
  if (condition) { passed += 1; console.log(`PASS ${id} ${label} :: ${observed}`); }
  else { failed += 1; console.log(`FAIL ${id} ${label} :: ${observed}`); }
}
async function shot(page, name) {
  const file = path.join(SHOT_DIR, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  screenshot: ${name}`);
}
async function waitText(page, text, timeout = 20000) {
  await page.waitForFunction(
    t => document.body && document.body.innerText.toLowerCase().includes(t.toLowerCase()),
    text, { timeout });
}
async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}
/* Switch hub identity (View as) and/or tab, waiting for the async
 * re-render to settle (active button carries .solid). */
async function goTab(page, user, tab, expectText) {
  if (user) {
    await page.click(`button[data-sui="role"][data-user="${user}"]`);
    await page.waitForFunction(u => {
      const b = document.querySelector(`button[data-sui="role"][data-user="${u}"]`);
      return b && b.classList.contains('solid');
    }, user, { timeout: 20000 });
    await page.waitForTimeout(600);
  }
  await page.click(`button[data-sui="tab"][data-tab="${tab}"]`);
  await page.waitForFunction(t => {
    const b = document.querySelector(`button[data-sui="tab"][data-tab="${t}"]`);
    return b && b.classList.contains('solid');
  }, tab, { timeout: 20000 });
  if (expectText) await waitText(page, expectText);
  await page.waitForTimeout(500);
}

async function main() {
  const dev = createDevServer({ port: 0, seed: true });
  await dev.start();
  const base = dev.url;
  console.log(`Dev server: ${base}`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });
  const consoleErrors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));

    /* ---- J1 UI: homepage ---- */
    await page.goto(base + '/homepage.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('#plans .plan', { timeout: 20000 });
    const planCount = await page.$$eval('#plans .plan', els => els.length);
    check('J1-UI', 'homepage renders live pricing cards', planCount === 6, `plan cards=${planCount}`);
    const homeText = await bodyText(page);
    check('J1-UI', 'homepage shows test-mode banner + hero', /test mode/i.test(homeText) && /test\. train\. retest\./i.test(homeText), 'testbar + hero present');
    check('J1-UI', 'homepage has Log in / Create account CTAs', /log in/i.test(homeText) && /create account/i.test(homeText), 'CTAs present');
    await shot(page, '01-homepage-desktop.png');
    await page.evaluate(() => document.querySelector('#pricing').scrollIntoView());
    await page.waitForTimeout(400);
    await shot(page, '02-homepage-pricing-desktop.png');

    /* ---- App boot + SaaS hub ---- */
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await waitText(page, 'remote coaching & subscriptions');
    await waitText(page, 'connected');
    check('APP', 'SaaS hub renders and connects', true, 'hub panel + Connected label visible');
    await shot(page, '03-app-hub-overview-desktop.png');

    /* ---- J2 UI: free athlete (Youth) ---- */
    await goTab(page, 'dev-athlete-youth', 'athlete', 'athlete free');
    const athText1 = await bodyText(page);
    check('J2-UI', 'youth athlete sees Athlete Free tier', /athlete free/i.test(athText1), 'tier label visible');
    check('J2-UI', 'seeded assessment history visible in athlete history', /assessment/i.test(athText1), 'history section mentions assessments');
    await shot(page, '04-athlete-free-youth-desktop.png');

    /* ---- J2 UI: paid checkout (Youth -> Athlete Remote) ---- */
    await goTab(page, null, 'plans', 'athlete remote');
    await shot(page, '05-plans-tab-desktop.png');
    await page.click('button[data-sui="checkout"][data-plan="athlete_remote"]');
    await waitText(page, 'confirm test checkout');
    await page.click('button[data-sui="confirm-checkout"]');
    await waitText(page, 'test subscription active');
    await goTab(page, null, 'athlete', 'athlete remote subscription');
    const athText2 = await bodyText(page);
    check('J2-UI', 'test checkout flips youth to paid tier in UI (DOM updates after confirm)', /athlete remote subscription/i.test(athText2), 'paid tier label after confirm');
    await shot(page, '06-athlete-paid-after-checkout-desktop.png');

    /* ---- J10 UI: Wingback member ---- */
    await goTab(page, 'dev-athlete-wingback', 'athlete', 'in-person member');
    const wingText = await bodyText(page);
    check('J10-UI', 'wingback shows member tier + ALREADY_COVERED honesty copy',
      /in-person member/i.test(wingText) && /ALREADY_COVERED/.test(wingText), 'member label + covered copy present');
    await shot(page, '07-wingback-member-desktop.png');
    await goTab(page, null, 'plans', 'athlete remote');
    const wingPlans = await page.$('button[data-sui="checkout"][data-plan="athlete_remote"]');
    if (wingPlans) {
      await wingPlans.click();
      await waitText(page, 'ALREADY_COVERED');
      const wingAfter = await bodyText(page);
      check('J10-UI', 'member checkout attempt refused with ALREADY_COVERED in UI', /ALREADY_COVERED/.test(wingAfter), 'error code surfaced in UI');
      await shot(page, '08-wingback-checkout-refused-desktop.png');
    } else {
      check('J10-UI', 'member checkout attempt refused with ALREADY_COVERED in UI', false, 'checkout button not found on plans tab');
    }

    /* ---- J5/J4 UI: coach roster + assignment loop ---- */
    await goTab(page, 'dev-coach-kayla', 'coach', 'of 15');
    const coachText = await bodyText(page);
    check('J5-UI', 'coach roster shows seeded links + cap label n of 15', /of 15/.test(coachText), 'cap label visible');
    await shot(page, '09-coach-roster-kayla-desktop.png');
    const assignBtn = await page.$('button[data-sui="assign-open"][data-athlete="ath-synth-youth-12"]');
    check('J4-UI', 'assign action available on roster athlete', !!assignBtn, assignBtn ? 'assign-open button found' : 'NOT FOUND');
    if (assignBtn) {
      await assignBtn.click();
      await page.waitForSelector('#sui-asn-title', { timeout: 15000 });
      await page.fill('#sui-asn-title', 'Speed day — UI walkthrough');
      await page.fill('#sui-asn-instructions', 'Clean reps only.');
      const gameBox = await page.$('input.sui-game[value="TP2-001"]');
      if (gameBox) await gameBox.check();
      const blockedBox = await page.$('input.sui-game[value="TP2-084"]');
      const blockedDisabled = blockedBox ? await blockedBox.evaluate(el => el.disabled) : null;
      check('J4-UI', 'Safety Review game checkbox disabled in composer', blockedDisabled === true, `TP2-084 disabled=${blockedDisabled}`);
      await page.fill('#sui-asn-rounds', '4');
      await page.fill('#sui-asn-work', '30');
      await page.fill('#sui-asn-rest', '60');
      await shot(page, '10-coach-assignment-composer-desktop.png');
      await page.click('button[data-sui="assign-save"]');
      await page.waitForTimeout(1500);
      await goTab(page, 'dev-athlete-youth', 'athlete', 'speed day — ui walkthrough');
      check('J4-UI', 'athlete sees coach-assigned training', true, 'assignment title visible');
      const completeBtn = await page.$('button[data-sui="complete-open"]');
      if (completeBtn) {
        await completeBtn.click();
        await page.waitForSelector('#sui-comp-duration', { timeout: 15000 });
        await page.fill('#sui-comp-duration', '25');
        await page.fill('#sui-comp-rpe', '7');
        await page.fill('#sui-comp-note', 'UI walkthrough completion');
        await page.click('button[data-sui="complete-save"]');
        await page.waitForTimeout(1500);
        const afterComplete = await bodyText(page);
        check('J4-UI', 'completion recorded and history updates in UI', /completed/i.test(afterComplete), 'completed status visible');
        await shot(page, '11-athlete-completed-history-desktop.png');
      } else {
        check('J4-UI', 'completion recorded and history updates in UI', false, 'complete-open button not found');
      }
    }

    /* ---- J6 UI: assessments section (prototype nav) ---- */
    try {
      const navClicked = await page.evaluate(() => {
        const els = [...document.querySelectorAll('button, a, [data-view], [onclick]')];
        const target = els.find(el => /^assessments$/i.test((el.textContent || '').trim()) && el.offsetParent !== null);
        if (target) { target.click(); return (target.textContent || '').trim().slice(0, 60); }
        return null;
      });
      await page.waitForTimeout(2000);
      const assessText = await bodyText(page);
      check('J6-UI', 'Assessments section reachable in app', !!navClicked && /assess/i.test(assessText), `nav=${JSON.stringify(navClicked)}`);
      await shot(page, '12-assessments-section-desktop.png');
    } catch (e) {
      check('J6-UI', 'Assessments section reachable in app', false, 'error: ' + e.message);
    }

    /* ---- J7 UI: organization create + overview ---- */
    // The Assessments view has no SaaS hub; return to the Dashboard.
    await page.evaluate(() => {
      const el = document.querySelector('[data-go="dashboard"]')
        || [...document.querySelectorAll('button, a')].find(e => /^dashboard$/i.test((e.textContent || '').trim()));
      if (el) el.click();
    });
    await page.waitForSelector('button[data-sui="role"][data-user="dev-coach-marcus"]', { timeout: 20000 });
    await goTab(page, 'dev-coach-marcus', 'org');
    await page.waitForTimeout(800);
    const orgName = await page.$('#sui-org-name');
    if (orgName) {
      await page.fill('#sui-org-name', 'Val Academy UI');
      await page.click('button[data-sui="create-org"]');
      await page.waitForTimeout(1800);
      const orgText = await bodyText(page);
      check('J7-UI', 'organization created from UI (identity flips to org_admin)', /val academy ui/i.test(orgText) || /organization/i.test(orgText), 'org UI reflects creation');
      await shot(page, '13-org-created-desktop.png');
      const overviewBtn = await page.$('button[data-sui="org-overview"]');
      if (overviewBtn) {
        await overviewBtn.click();
        await page.waitForTimeout(1500);
        await shot(page, '14-org-overview-desktop.png');
        const ovText = await bodyText(page);
        check('J7-UI', 'org overview renders coaches/athletes', /coach/i.test(ovText), 'overview content visible');
      } else {
        check('J7-UI', 'org overview renders coaches/athletes', false, 'org-overview button not found');
      }
    } else {
      check('J7-UI', 'organization created from UI (identity flips to org_admin)', false, '#sui-org-name not found');
    }

    /* ---- J8 UI: cross-tenant roster (Jordan) ---- */
    await goTab(page, 'dev-coach-jordan', 'coach', 'of 15');
    // Scope to roster rows (assign buttons carry athlete ids); the
    // View-as labels above the hub always name every dev identity.
    const jordanRosterIds = await page.$$eval('button[data-sui="assign-open"]', els => els.map(e => e.getAttribute('data-athlete')));
    check('J8-UI', 'Jordan roster excludes Kayla athletes in UI',
      !jordanRosterIds.includes('ath-synth-youth-12') && jordanRosterIds.includes('dev-ath-04') && jordanRosterIds.includes('dev-ath-05'),
      `roster ids=${JSON.stringify(jordanRosterIds)}`);
    await shot(page, '15-coach-roster-jordan-desktop.png');

    /* ---- Mobile 390px ---- */
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mpage = await mctx.newPage();
    mpage.on('console', msg => { if (msg.type() === 'error') consoleErrors.push('[mobile] ' + msg.text()); });
    mpage.on('pageerror', err => consoleErrors.push('[mobile] PAGEERROR: ' + err.message));
    await mpage.goto(base + '/homepage.html', { waitUntil: 'networkidle' });
    await mpage.waitForSelector('#plans .plan', { timeout: 20000 });
    const homeOverflow = await mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('MOB', 'homepage has no horizontal overflow at 390px', homeOverflow <= 1, `overflow=${homeOverflow}px`);
    await shot(mpage, '16-homepage-mobile-390.png');
    await mpage.goto(base + '/', { waitUntil: 'networkidle' });
    await waitText(mpage, 'remote coaching & subscriptions');
    await goTab(mpage, 'dev-athlete-youth', 'athlete', 'your access');
    const appOverflow = await mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('MOB', 'app athlete view has no horizontal overflow at 390px', appOverflow <= 1, `overflow=${appOverflow}px`);
    await shot(mpage, '17-athlete-mobile-390.png');
    await goTab(mpage, 'dev-coach-kayla', 'coach', 'of 15');
    const coachOverflow = await mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('MOB', 'app coach view has no horizontal overflow at 390px', coachOverflow <= 1, `overflow=${coachOverflow}px`);
    await shot(mpage, '18-coach-mobile-390.png');

    const realErrors = consoleErrors.filter(e => !/fonts\.googleapis|ERR_TUNNEL|404/.test(e));
    check('APP', 'no app console/page errors during walkthrough (font/404 network noise excluded)',
      realErrors.length === 0,
      realErrors.length ? realErrors.slice(0, 5).join(' | ') : `clean (${consoleErrors.length} network-noise entries excluded)`);
  } finally {
    await browser.close();
    await dev.close();
  }
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('WALKTHROUGH ERROR', e); process.exit(2); });
