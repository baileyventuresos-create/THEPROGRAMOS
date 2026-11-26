/* Pathways V1 validation screenshots (2026-11-26).
 * Run: node docs/pathways-validation-2026-11-26/screenshots.js
 * Dev server must be running on 127.0.0.1:8123 (seeded) first.
 *
 * Seeds Pathways data through the real API (synthetic only), then
 * drives the app in a headless browser and captures 10 screenshots
 * under docs/pathways-validation-2026-11-26/screenshots/.
 * Every shot is verified afterwards by opening the image itself
 * (see RESULTS.md) — never from a log line alone.
 */
'use strict';

const { chromium } = require('/home/hatch/workspace/after6/repo/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:8123';
const OUT = path.join(__dirname, 'screenshots');
const YOUTH_ID = 'ath-synth-youth-12';

const DIRECTOR_H = { 'X-Dev-Role': 'director', 'X-Dev-User': 'dev-director-marcus' };
const KAYLA_H = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-kayla' };

async function post(body, headers) {
  const res = await fetch(BASE + '/api/saas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(body.method + ' failed: ' + JSON.stringify(json.error));
  return json.data;
}

async function seed() {
  const pilot = await post(
    { method: 'ownerCreateAthlete', params: { name: 'Synthetic Pilot', age: 16, sports: ['soccer'] } },
    DIRECTOR_H);
  console.log('pilot athlete:', pilot.athlete.id);
  await post(
    { method: 'grantComplimentary', params: { athleteId: pilot.athlete.id, reason: 'Walk-On Project pilot' } },
    DIRECTOR_H);
  await post(
    { method: 'grantComplimentary', params: { athleteId: YOUTH_ID, reason: 'Walk-On Project pilot' } },
    DIRECTOR_H);
  await post(
    { method: 'assignSport', params: { athleteId: YOUTH_ID, sport: 'soccer', positions: ['Striker'] } },
    KAYLA_H);
  await post(
    { method: 'setDevelopmentGoals', params: { athleteId: YOUTH_ID, goal: 'Hold a 60-second side plank each side', targetDate: '2026-12-20T00:00:00Z' } },
    KAYLA_H);
  await post(
    { method: 'recordScoutingEvaluation', params: { athleteId: YOUTH_ID, body: 'Great engine, presses well, first to every second ball.' } },
    KAYLA_H);
  const profile = await post(
    {
      method: 'createProspectProfile',
      params: {
        athleteId: YOUTH_ID, primarySport: 'soccer', positions: ['Striker'],
        bio: 'Synthetic prospect bio — Yakima United 2025, state cup 2026.',
        measurements: { height: '5 ft 10 in', weight: '150 lb' },
        accomplishments: ['State cup 2026'],
        playingHistory: ['Yakima United 2025'],
        verifiedMetrics: { '10yd sprint': '1.82 sec' },
        availability: 'Available Jan 2027',
        contactInfo: { email: 'coach-only@example.com' },
      },
    },
    KAYLA_H);
  console.log('profile:', profile.profile.id);
  await post(
    { method: 'addMediaLink', params: { profileId: profile.profile.id, kind: 'highlight', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Spring showcase highlights' } },
    KAYLA_H);
  const contact = await post(
    {
      method: 'createRecruitmentContact',
      params: {
        orgName: 'River State University', sport: 'soccer', level: 'collegiate',
        region: 'WA', contactName: 'Coach Rivera', email: 'coach@example.edu', status: 'new',
      },
    },
    KAYLA_H);
  console.log('contact:', contact.contact.id);
  await post(
    { method: 'approveProspectProfile', params: { profileId: profile.profile.id, approval: 'coach' } },
    KAYLA_H);
  return { pilotId: pilot.athlete.id, profileId: profile.profile.id, contactId: contact.contact.id };
}

async function clickFirst(page, selector, label) {
  await page.locator(selector).first().click();
  await page.waitForTimeout(1200);
  console.log('clicked:', label);
}

async function waitText(page, text, label) {
  await page.locator(`text=${text}`).first().waitFor({ state: 'visible', timeout: 10000 });
  console.log('visible:', label || text);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ids = await seed();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitText(page, 'OWNER CONSOLE', 'owner console tab (director default)');

  // 1. Owner console.
  await clickFirst(page, '[data-sui="tab"][data-tab="director"]', 'Owner console tab');
  await waitText(page, 'Athlete accounts', 'account list');
  await page.screenshot({ path: path.join(OUT, '01-owner-console.png'), fullPage: true });

  // 2. Complimentary grant form, filled in (not submitted — the youth
  //    already holds a grant from the seed).
  await page.locator('#sui-grant-athlete').first().selectOption(YOUTH_ID);
  await page.locator('#sui-grant-reason').first().fill('Walk-On Project pilot — second grant');
  await page.locator('#sui-grant-indefinite').first().check();
  await page.locator('#sui-grant-athlete').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '02-complimentary-grant-form.png') });

  // 3. Athlete portal (youth): complimentary badge, pending profile
  //    with Approve sharing, goals, feedback, media, trends.
  await clickFirst(page, '[data-sui="role"][data-user="dev-athlete-youth"]', 'View as youth athlete');
  await clickFirst(page, '[data-sui="tab"][data-tab="athlete"]', 'Athlete tab');
  await waitText(page, 'Approve sharing', 'athlete approval action');
  await page.screenshot({ path: path.join(OUT, '03-athlete-portal.png'), fullPage: true });

  // 4. Trend chart, close up.
  await page.locator('text=Progress trends').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '04-trend-chart.png') });

  // Athlete approves sharing (drives the profile to approved).
  await clickFirst(page, '[data-sui="approve-profile"]', 'Approve sharing');
  await waitText(page, 'Approved — shareable', 'profile approved');

  // 5. Coach prospect editor.
  await clickFirst(page, '[data-sui="role"][data-user="dev-coach-kayla"]', 'View as Coach Kayla');
  await clickFirst(page, '[data-sui="tab"][data-tab="coach"]', 'Coach tab');
  await clickFirst(page, `[data-sui="pathways-open"][data-athlete="${YOUTH_ID}"]`, 'Pathways for youth');
  await waitText(page, 'Athlete pathways', 'coach athlete detail');
  await page.screenshot({ path: path.join(OUT, '05-coach-prospect-editor.png'), fullPage: true });

  // 6. Coach creates a share link; capture the URL shown once.
  await page.locator('text=Share links').first().scrollIntoViewIfNeeded();
  await clickFirst(page, '[data-sui="share-create"]', 'Create share link');
  await waitText(page, 'Share link created', 'share created note');
  const shareHref = await page.locator('.note a').first().getAttribute('href');
  console.log('share href:', shareHref);
  await page.locator('text=Share links').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '06-coach-share-link.png') });

  // 7. Public prospect profile (no login).
  const shareUrl = shareHref.startsWith('http') ? shareHref : BASE + shareHref;
  await page.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitText(page, 'Prospect profile', 'public profile heading');
  await page.screenshot({ path: path.join(OUT, '07-public-prospect-profile.png'), fullPage: true });

  // 8. Coach CRM: open the contact, add opportunity + note + referral
  //    through the UI, then capture the pipeline.
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await clickFirst(page, '[data-sui="role"][data-user="dev-coach-kayla"]', 'View as Coach Kayla (2)');
  await clickFirst(page, '[data-sui="tab"][data-tab="coach"]', 'Coach tab (2)');
  await page.locator('text=Recruitment CRM').first().scrollIntoViewIfNeeded();
  await clickFirst(page, `[data-sui="crm-contact-open"][data-contact="${ids.contactId}"]`, 'Open CRM contact');
  await waitText(page, 'River State University — pipeline', 'contact pipeline');
  await page.locator('#sui-crm-opp-notes').first().fill('Showcase invite');
  await clickFirst(page, '[data-sui="crm-opp-add"]', 'Add opportunity');
  await page.locator('#sui-crm-note-body').first().fill('Called — asked for spring film');
  await page.locator('#sui-crm-note-followup').first().fill('2026-12-01');
  await clickFirst(page, '[data-sui="crm-note-add"]', 'Add note');
  await clickFirst(page, '[data-sui="crm-refer-add"]', 'Refer athlete');
  await waitText(page, 'Athlete referred', 'referral recorded');
  await page.locator('text=Recruitment CRM').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '08-coach-crm.png'), fullPage: true });

  // 9. Mobile athlete portal (390px).
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mob.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await mob.locator('[data-sui="role"][data-user="dev-athlete-youth"]').first().click();
  await mob.waitForTimeout(1200);
  await mob.locator('[data-sui="tab"][data-tab="athlete"]').first().click();
  await mob.waitForTimeout(1200);
  await mob.locator('text=Approve sharing').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await mob.screenshot({ path: path.join(OUT, '09-mobile-athlete-portal.png'), fullPage: true });

  // 10. Public refusal (bogus token).
  await page.goto(BASE + '/prospect.html?token=bogus-token-123', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitText(page, 'This profile is not available', 'neutral refusal');
  await page.screenshot({ path: path.join(OUT, '10-public-profile-refusal.png') });

  await browser.close();
  console.log('done. screenshots in', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
