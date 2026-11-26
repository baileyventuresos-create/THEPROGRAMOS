/* UI preservation tests — read-only checks that detect unintended changes
 * to the existing interface. They never edit a UI file.
 * Run: node --test server/tests/ui-preservation.test.js
 *
 * 1. SHA-256 snapshot: the six shipped UI/source files must be byte-identical
 *    to tests/ui-preservation.snapshot.json (recorded 2026-11-11 from main
 *    commit dc5d42d). Any edit — intentional or accidental — fails loudly
 *    and must be reviewed, never silently absorbed.
 * 2. Structural presence: the modes and surfaces the owner listed as
 *    must-preserve still exist in the prototype source.
 * 3. No backend/billing code leaked into the UI files: reservations and
 *    payments live in server/, not in the HTML.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'ui-preservation.snapshot.json'), 'utf8'));

test('UI files are byte-identical to the preservation snapshot', () => {
  for (const [file, expected] of Object.entries(snapshot)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
    assert.equal(actual, expected, `${file} changed! If intentional, update the snapshot with a reviewed commit; if not, revert.`);
  }
});

test('all owner-listed modes and surfaces still exist in the prototype', () => {
  const html = fs.readFileSync(path.join(ROOT, 'THE PROGRAM OS.html'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const needle of [
    'Director', 'Coach', 'Athlete', 'Program Builder', 'Training Library',
    'THE LAB', 'Assessments', 'function boot(', 'draftSession',
    'function vSessions', 'function vCohorts', 'function vAthletes',
    'function vBuilder', 'function vLibrary', 'function vLab',
    'function coachSession', 'function athleteApp',
  ]) assert.ok(html.includes(needle), `missing from THE PROGRAM OS.html: ${needle}`);
  assert.ok(index.includes('THE%20PROGRAM%20OS.html'), 'index.html still loads the prototype');
  assert.ok(index.includes('launch60-overrides.js'), 'index.html still loads overrides');
  assert.ok(index.includes('field-tested-drills.js'), 'index.html still loads field-tested drills');
});

test('no reservation, billing, or backend code leaked into UI files', () => {
  const html = fs.readFileSync(path.join(ROOT, 'THE PROGRAM OS.html'), 'utf8');
  for (const forbidden of ['reserve_seat', 'waitlist', 'price_cents', 'operational_audit_events', 'ReservationEngine']) {
    assert.ok(!html.includes(forbidden), `UI file must not contain backend symbol: ${forbidden}`);
  }
  // The prototype mentions pricing exactly once, inside its DECISIONS register
  // ('$149 / $179 memberships' as an ASSUMPTION) — that is a note, not billing.
  // There is no checkout, price display, or payment flow in the UI.
  assert.equal((html.match(/\$149/g) || []).length, 1, 'pricing appears only in the decisions register');
  assert.ok(!html.includes('checkout') && !html.includes('Stripe') && !html.includes('payment'), 'no billing flow in the UI');
});
