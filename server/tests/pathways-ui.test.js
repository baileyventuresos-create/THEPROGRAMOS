/* Athlete Pathways V1 UI tests (frontend slice).
 * Run: node --test server/tests/pathways-ui.test.js
 *
 * Tests the Pathways additions to saas-ui/saas-ui.js +
 * saas-ui/saas-client.js in Node (pure helpers, HTML renderers
 * with stub helpers, controller flow against a stub client backed
 * by the REAL SaaS API over memory stores) and over real HTTP
 * against the dev server (owner console, complimentary tier,
 * token-only public profile, athlete scoping, CRM, sport/goals/
 * evaluations/media). Follows server/tests/saas-ui.test.js and
 * server/tests/dev-server-saas.test.js. Synthetic data only.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const UI = require('../../saas-ui/saas-ui');
const SaasClient = require('../../saas-ui/saas-client');
const { MemorySaasStore } = require('../saas-store');
const { createSaasApi } = require('../saas-api');
const { FakeBillingAdapter } = require('../billing');
const { createDevServer } = require('../dev-server');
const { compareValues } = require('../progress');
const Youth = require('../fixtures/synthetic-youth-12');

const YOUTH_ID = Youth.athlete.id;

function h(overrides) {
  return {
    esc: UI.esc, lbl: null, games: null,
    athleteName: (id) => 'Athlete ' + id,
    devRoles: null, role: { role: 'director', user: 'dev-director-marcus' },
    ...(overrides || {}),
  };
}

/* Fake document: element values by id + game checkbox list. */
function makeDoc() {
  const els = new Map();
  const doc = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, { value: '', checked: false });
      return els.get(id);
    },
    querySelectorAll(sel) {
      if (sel !== '.sui-game') return [];
      return doc._games || [];
    },
    addEventListener() {},
    set(id, value, checked) { els.set(id, { value: value == null ? '' : String(value), checked: !!checked }); },
    setGames(ids) { doc._games = ids.map((id) => ({ value: id, checked: true })); },
    _games: [],
  };
  return doc;
}

/* Stub client: the real SaaS API + fake billing over memory
 * stores, with mutable auth (models the dev server deriving auth
 * from request headers). getPublicProfile is the unauthenticated
 * token-only read, modelled the same way. */
function makeStubClient() {
  const store = new MemorySaasStore();
  const billing = new FakeBillingAdapter(store);
  const api = createSaasApi({ store, billing });
  let auth = { authUserId: 'dev-director-marcus', role: 'director' };
  const stub = {
    store, billing, api,
    setAuth(next) { auth = next; },
    probe() { return Promise.resolve(true); },
    getPlans() { return Promise.resolve().then(() => api.listPlans(auth)); },
    getPublicProfile(token) {
      return Promise.resolve().then(() => api.getPublicProfile(null, { token }));
    },
  };
  for (const m of SaasClient.METHODS) {
    stub[m] = (params) => Promise.resolve().then(() => api[m](auth, params || {}));
  }
  for (const m of SaasClient.BILLING_METHODS) {
    stub[m] = (params) => Promise.resolve().then(() => {
      if (m === 'confirmCheckout') return billing.confirmCheckout((params || {}).sessionId, params || {});
      return billing[m](params || {});
    });
  }
  return stub;
}

function makeRoot(doc) {
  let renders = 0;
  return {
    root: {
      SaasClient: { createSaasClient: () => { throw new Error('injected client is used in tests'); } },
      vDashboard: () => '<div class="orig-dash">DASH</div>',
      vCoach: () => '<div class="orig-coach">COACH</div>',
      vAthleteMode: () => '<div class="orig-athlete-mode">ATHLETE MODE</div>',
      vAthlete: () => '<div class="orig-athlete">PROFILE</div>',
      render: () => { renders++; },
      toast: () => {},
      document: doc,
    },
    renders: () => renders,
  };
}

/* ---------------- pure helpers ---------------- */

test('complimentary tier label + entitlements render without any payment prompt', () => {
  const lab = UI.tierLabel({ tier: 'complimentary' });
  assert.ok(lab.text.includes('Complimentary'));
  assert.equal(lab.cls, 'ok');
  assert.ok(lab.note.includes('never charged'));

  const state = {
    entitlements: {
      kind: 'athlete', athleteId: 'a1',
      entitlements: { tier: 'complimentary', planCode: 'athlete_remote', source: 'complimentary_grant', fullHistory: true },
    },
  };
  const html = UI.renderEntitlements(state, h());
  assert.ok(html.includes('Complimentary'));
  assert.ok(html.includes('ALREADY_COVERED'));
  assert.ok(!html.includes('data-sui="checkout"'), 'no checkout button for a complimentary athlete');
  assert.ok(!html.includes('Subscribe'), 'no subscribe prompt for a complimentary athlete');
  /* The copy itself says "no trial notice" — that is the UI telling
   * the athlete there is none, not a trial offer. What must never
   * appear is a trial offer or start action. */
  assert.ok(!html.includes('14-day trial'), 'no trial offer for a complimentary athlete');
  assert.ok(!html.includes('trial started'), 'no trial start for a complimentary athlete');
});

test('plans hide Subscribe for covered athletes, keep it for free athletes', () => {
  const base = {
    plans: [
      { code: 'free_athlete', audience: 'athlete', name: 'Athlete Free', limits: { priceMonthlyCents: 0, priceAnnualCents: 0, trainingDaysPerWeek: 1, historyDays: 90, maxCoachLinks: 1, trialDays: 0 } },
      { code: 'athlete_remote', audience: 'athlete', name: 'Athlete Remote', limits: { priceMonthlyCents: 1499, priceAnnualCents: 14900, trainingDaysPerWeek: null, historyDays: null, maxCoachLinks: null, trialDays: 0 } },
    ],
    interval: 'month',
  };
  const covered = UI.renderPlans({
    ...base,
    entitlements: { kind: 'athlete', entitlements: { tier: 'complimentary' } },
  }, h());
  assert.ok(covered.includes('Covered — no purchase needed'));
  assert.ok(!covered.includes('Subscribe (test mode)'));
  const free = UI.renderPlans({
    ...base,
    entitlements: { kind: 'athlete', entitlements: { tier: 'free' } },
  }, h());
  assert.ok(free.includes('Subscribe (test mode)'));
});

test('sports catalogue: five sports, labels, position suggestions', () => {
  assert.deepEqual(UI.SPORT_IDS, ['soccer', 'baseball', 'basketball', 'football', 'flag_football']);
  assert.equal(UI.sportLabel('flag_football'), 'Flag football');
  assert.equal(UI.sportLabel('soccer'), 'Soccer');
  assert.ok(UI.positionsFor('soccer').includes('Goalkeeper'));
  assert.ok(UI.positionsFor('basketball').includes('Point guard'));
  assert.equal(UI.sportLabel('quidditch'), 'quidditch');
});

test('embed allowlist: YouTube/Vimeo embed, everything else is a plain link', () => {
  assert.equal(
    UI.embedUrlFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(
    UI.embedUrlFor('https://youtu.be/dQw4w9WgXcQ'),
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(
    UI.embedUrlFor('https://vimeo.com/123456789'),
    'https://player.vimeo.com/video/123456789');
  assert.equal(UI.embedUrlFor('https://example.com/video.mp4'), null);
  assert.equal(UI.embedUrlFor('javascript:alert(1)'), null);
  assert.equal(UI.embedUrlFor('not a url'), null);
  assert.equal(UI.embedUrlFor(null), null);
});

test('verified-metrics key/value lines round-trip', () => {
  const obj = UI.parseKeyValueLines('10yd sprint: 1.82 sec\nBroad jump: 66 in\nno colon here\n: empty key\n');
  assert.deepEqual(obj, { '10yd sprint': '1.82 sec', 'Broad jump': '66 in' });
  assert.equal(UI.formatKeyValueLines(obj), '10yd sprint: 1.82 sec\nBroad jump: 66 in');
  assert.deepEqual(UI.parseKeyValueLines(''), {});
  assert.deepEqual(UI.splitCommaList(' Point guard, Shooting guard, Point guard '), ['Point guard', 'Shooting guard']);
});

/* ---------------- trend chart ---------------- */

const TWO_SESSIONS = [
  { completedAt: '2026-09-01T00:00:00Z', results: [
    { assessmentId: '10yd-sprint', result: 2.06, unit: 'sec' },
    { assessmentId: 'broad-jump', result: 63, unit: 'in' },
  ] },
  { completedAt: '2026-09-29T00:00:00Z', results: [
    { assessmentId: '10yd-sprint', result: 1.97, unit: 'sec' },
    { assessmentId: 'broad-jump', result: 66, unit: 'in' },
  ] },
];

test('trend series: baseline/latest/personal best, lower-is-better for timed tests', () => {
  const series = UI.trendSeriesFromAssessments(TWO_SESSIONS);
  assert.equal(series.length, 2);
  const sprint = series.find((s) => s.testId === '10yd-sprint');
  assert.equal(sprint.baseline, 2.06);
  assert.equal(sprint.latest, 1.97);
  assert.equal(sprint.personalBest, 1.97, 'timed test: PB is the minimum');
  assert.equal(sprint.direction, 'lower');
  const jump = series.find((s) => s.testId === 'broad-jump');
  assert.equal(jump.personalBest, 66, 'distance test: PB is the maximum');
  assert.equal(jump.direction, 'higher');
  const single = UI.trendSeriesFromAssessments([TWO_SESSIONS[0]]);
  assert.equal(single[0].baseline, single[0].latest);
  assert.deepEqual(UI.trendSeriesFromAssessments([]), []);
});

test('F1: trend caption status matches the canonical calculator at the maintenance-band edge', () => {
  /* The seeded validation case (VALIDATION.md §7/F1): 10yd-sprint
   * 2.30 → 2.25 is exactly −0.05 s, the band edge. The calculator
   * says maintained; the old caption said (improved). */
  const edge = [
    { completedAt: '2026-09-01T00:00:00Z', results: [{ assessmentId: '10yd-sprint', result: 2.30, unit: 'sec' }] },
    { completedAt: '2026-09-29T00:00:00Z', results: [{ assessmentId: '10yd-sprint', result: 2.25, unit: 'sec' }] },
  ];
  const series = UI.trendSeriesFromAssessments(edge);
  assert.equal(series.length, 1);
  const calc = compareValues('10yd-sprint', 2.30, 2.25, 0.05);
  assert.equal(calc.status, 'maintained', 'calculator: band-edge move is maintained');
  assert.equal(series[0].status, calc.status, 'chart series status agrees with the calculator');
  const caption = UI.renderTrendChart(series[0]);
  assert.ok(caption.includes('-0.05 sec'), 'numbers stay exact');
  assert.ok(caption.includes('(maintained)'), 'band-edge move is captioned maintained, not improved');
  assert.ok(!caption.includes('(improved)'), 'no contradictory improved label');

  /* Agreement table: caption rule vs calculator across bands,
   * directions, and the edge on both sides. */
  const cases = [
    ['10yd-sprint', 'lower', 2.30, 2.25, 0.05, 'maintained'],
    ['10yd-sprint', 'lower', 2.30, 2.28, 0.05, 'maintained'],
    ['10yd-sprint', 'lower', 2.30, 2.20, 0.05, 'improved'],
    ['10yd-sprint', 'lower', 2.30, 2.36, 0.05, 'regressed'],
    ['broad-jump', 'higher', 64, 65, 1, 'maintained'],
    ['broad-jump', 'higher', 64, 68, 1, 'improved'],
    ['broad-jump', 'higher', 64, 62, 1, 'regressed'],
    ['push-ups', 'higher', 20, 21, 1, 'maintained'],
    ['push-ups', 'higher', 20, 22, 1, 'improved'],
  ];
  for (const [id, dir, base, latest, band, expected] of cases) {
    assert.equal(compareValues(id, base, latest, band).status, expected);
    assert.equal(UI.trendStatusFor(id, dir, base, latest), expected,
      `${id} ${base} → ${latest} must be ${expected}`);
  }

  /* A hand-built series without a precomputed status still renders
   * the canonical word via the same rule. */
  const bare = UI.renderTrendChart({
    testId: '10yd-sprint', label: '10-yd sprint', unit: 'sec', direction: 'lower',
    baseline: 2.30, latest: 2.25, personalBest: 2.25,
    points: [{ t: '2026-09-01T00:00:00Z', value: 2.30 }, { t: '2026-09-29T00:00:00Z', value: 2.25 }],
  });
  assert.ok(bare.includes('(maintained)'), 'hand-built series agrees too');
  assert.ok(bare.includes('-0.05 sec'), 'hand-built series keeps exact numbers');
});

test('trend chart SVG: line, dashed baseline, personal-best star, honest caption', () => {
  const series = UI.trendSeriesFromAssessments(TWO_SESSIONS);
  const svg = UI.renderTrendChart(series[0]);
  assert.ok(svg.includes('<svg'), 'renders an SVG');
  assert.ok(svg.includes('<polyline'), 'draws the value line');
  assert.ok(svg.includes('stroke-dasharray'), 'baseline is dashed');
  assert.ok(svg.includes('★'), 'personal best is starred');
  assert.ok(svg.includes('Baseline'), 'caption names the baseline');
  assert.ok(svg.includes('2.06'), 'caption shows the baseline value');
  assert.ok(svg.includes('1.97'), 'caption shows the latest value');
  assert.ok(svg.includes('improved'), 'lower time is an improvement');
  assert.equal(UI.renderTrendChart(null), '');
  assert.equal(UI.renderTrendChart({ testId: 'x', points: [] }), '');
  const grid = UI.renderTrendChartsFromAssessments(TWO_SESSIONS, h());
  assert.equal((grid.match(/<svg/g) || []).length, 2, 'one chart per test');
  assert.ok(grid.includes('Compared only to yourself'), 'no-norms honesty line');
  assert.ok(UI.renderTrendChartsFromAssessments([], h()).includes('No recorded results yet'));
});

/* ---------------- owner console ---------------- */

function directorState() {
  return {
    connected: true, tab: 'director',
    role: { role: 'director', user: 'dev-director-marcus' },
    directorAthletes: {
      count: 2,
      athletes: [
        {
          athlete: { id: 'ath-1', name: 'Synthetic One', age: 14, sports: ['soccer'], role: 'athlete' },
          status: 'active',
          complimentaryGrant: { id: 'g-1', grantedAt: '2026-11-26T00:00:00Z', expiresAt: null, reason: 'Walk-On Project pilot' },
          entitlements: { tier: 'complimentary' },
        },
        {
          athlete: { id: 'ath-2', name: 'Synthetic Two', age: 20, sports: ['basketball'], role: 'athlete' },
          status: 'suspended',
          complimentaryGrant: { id: 'g-2', grantedAt: '2026-11-01T00:00:00Z', expiresAt: '2027-05-01T00:00:00Z', reason: null },
          entitlements: { tier: 'free' },
        },
      ],
    },
    auditEvents: {
      count: 2,
      events: [
        { actor: 'dev-director-marcus', action: 'grant_complimentary', detail: { athleteId: 'ath-1', grantId: 'g-1' }, at: '2026-11-26T10:00:00Z' },
        { actor: 'dev-director-marcus', action: 'suspend_athlete', detail: { athleteId: 'ath-2' }, at: '2026-11-26T11:00:00Z' },
      ],
    },
  };
}

test('owner console renders only for the director', () => {
  const directorHtml = UI.renderHub(directorState(), h());
  assert.ok(directorHtml.includes('Owner console'), 'director sees the tab');
  assert.ok(directorHtml.includes('Synthetic One'), 'director sees the athlete list');

  const coachState = { ...directorState(), role: { role: 'coach', user: 'dev-coach-kayla' } };
  const coachHtml = UI.renderHub(coachState, h());
  assert.ok(!coachHtml.includes('data-tab="director"'), 'coach never sees the Owner console tab button');
  assert.ok(!coachHtml.includes('Synthetic One'), 'coach never sees the owner list');
  assert.ok(coachHtml.includes('director only'), 'forced director tab refuses with a plain note');

  const forced = UI.renderDirector(
    { ...directorState(), role: { role: 'coach', user: 'dev-coach-kayla' } }, h());
  assert.ok(forced.includes('director only'), 'forced director render refuses non-directors');
  assert.ok(!forced.includes('Synthetic One'));
});

test('owner console: tier, status, grant expiry, actions, audit rows', () => {
  const html = UI.renderDirector(directorState(), h());
  assert.ok(html.includes('Complimentary'), 'complimentary badge shown');
  assert.ok(html.includes('Indefinite'), 'indefinite grant shown');
  assert.ok(html.includes('May 1, 2027'), 'dated grant expiry shown');
  assert.ok(html.includes('Suspended'), 'suspended status shown');
  assert.ok(html.includes('data-sui="suspend-athlete"'), 'suspend action present');
  assert.ok(html.includes('data-sui="reactivate-athlete"'), 'reactivate action present');
  assert.ok(html.includes('data-sui="revoke-grant"'), 'revoke-grant action present');
  assert.ok(html.includes('data-sui="update-role"'), 'role action present');
  assert.ok(html.includes('data-sui="grant-complimentary"'), 'grant form present');
  assert.ok(html.includes('data-sui="owner-create-athlete"'), 'create-athlete form present');
  assert.ok(html.includes('grant_complimentary'), 'audit shows the grant row');
  assert.ok(html.includes('suspend_athlete'), 'audit shows the suspension row');
});

/* ---------------- athlete portal ---------------- */

function pathwaysBundle(overrides) {
  return {
    profile: {
      id: 'prof-1', athleteId: 'ath-1', bio: 'Synthetic bio.',
      primarySport: 'soccer', secondarySport: null, positions: ['Striker'],
      measurements: { height: '5 ft 10 in', weight: '150 lb' },
      accomplishments: ['State cup 2026'], playingHistory: ['Yakima United 2025'],
      verifiedMetrics: { '10yd sprint': '1.82 sec' }, availability: 'Available Jan 2027',
      status: 'pending_approval', athleteApprovedAt: null, coachApprovedAt: '2026-11-25T00:00:00Z',
    },
    mediaLinks: [{ id: 'm-1', kind: 'highlight', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Highlights' }],
    scoutingEvaluations: [{ id: 'e-1', body: 'Great engine, presses well.', coachApproved: true, createdAt: '2026-11-25T00:00:00Z' }],
    developmentGoals: [{ id: 'goal-1', goal: 'Hold a 60-second side plank each side', targetDate: '2026-12-20T00:00:00Z', status: 'active' }],
    ...(overrides || {}),
  };
}

test('athlete pathways: profile, goals, feedback, media, approval action, trends', () => {
  const state = {
    pathways: pathwaysBundle(),
    history: { assessments: TWO_SESSIONS, completions: [], assignments: [] },
  };
  const html = UI.renderAthletePathways(state, h());
  assert.ok(html.includes('Pending approval'), 'profile status shown');
  assert.ok(html.includes('Striker'), 'positions shown');
  assert.ok(html.includes('5 ft 10 in'), 'measurements shown');
  assert.ok(html.includes('State cup 2026'), 'accomplishments shown');
  assert.ok(html.includes('Hold a 60-second side plank'), 'development goal shown');
  assert.ok(html.includes('Great engine'), 'coach feedback shown');
  assert.ok(html.includes('youtube-nocookie'), 'YouTube embed rendered');
  assert.ok(html.includes('data-sui="approve-profile"'), 'athlete approval action present');
  assert.ok(html.includes('<svg'), 'trend chart rendered from assessment history');
  assert.ok(html.includes('Recruitment opportunities'), 'recruitment section present');

  const approved = UI.renderAthletePathways({
    pathways: pathwaysBundle({
      profile: { ...pathwaysBundle().profile, status: 'approved', athleteApprovedAt: '2026-11-26T00:00:00Z' },
    }),
    history: { assessments: [], completions: [], assignments: [] },
  }, h());
  assert.ok(!approved.includes('data-sui="approve-profile"'), 'no approval action once approved');

  const none = UI.renderAthletePathways({ pathways: null, history: null }, h());
  assert.ok(none.includes('No prospect profile yet'), 'honest empty state with no profile');
});

test('coach athlete detail: sport, goals, evaluations, profile editor, shares, history', () => {
  const bundle = {
    ...pathwaysBundle(),
    athlete: { id: 'ath-1', name: 'Synthetic One', sports: ['soccer'] },
    shares: [{ id: 'sh-1', expiresAt: '2026-12-03T00:00:00Z', status: 'active' }],
  };
  bundle.profile = { ...bundle.profile, status: 'approved', athleteApprovedAt: '2026-11-26T00:00:00Z' };
  const state = {
    coachAthleteId: 'ath-1', coachPathways: bundle,
    coachHistory: { completions: [], assignments: [], assessments: TWO_SESSIONS },
    roster: { athletes: [{ athlete: { id: 'ath-1', name: 'Synthetic One' }, links: [] }], count: 1 },
  };
  const html = UI.renderCoachAthleteDetail(state, h());
  assert.ok(html.includes('Attendance &amp; training history'), 'history wired into the detail view');
  assert.ok(html.includes('data-sui="assign-sport"'), 'assign-sport form present');
  assert.ok(html.includes('data-sui="goal-add"'), 'goal composer present');
  assert.ok(html.includes('Hold a 60-second side plank'), 'existing goal listed');
  assert.ok(html.includes('data-sui="eval-add"'), 'evaluation composer present');
  assert.ok(html.includes('data-sui="profile-save"'), 'profile editor present');
  assert.ok(html.includes('Verified metrics'), 'verified-metrics editor present');
  assert.ok(html.includes('Contact email (never public)'), 'contact info labelled never-public');
  assert.ok(html.includes('data-sui="share-create"'), 'share creation present for approved profiles');
  assert.ok(html.includes('data-sui="share-revoke"'), 'share revocation present');
  assert.ok(html.includes('data-sui="media-add"'), 'media add present');
});

test('CRM view: contacts, add form, contact detail with opportunities/notes/referrals', () => {
  const state = {
    crmContacts: {
      count: 1,
      contacts: [{
        id: 'c-1', orgName: 'River State University', sport: 'soccer', level: 'collegiate',
        league: 'NCAA D-II', contactName: 'Coach Rivera', title: 'Recruiting coordinator',
        email: 'coach@example.edu', status: 'contacted',
      }],
    },
    crmContactId: 'c-1',
    crmActivity: {
      opportunities: [{ id: 'o-1', contactId: 'c-1', type: 'tryout', date: '2026-12-10T00:00:00Z', notes: 'Showcase invite' }],
      notes: [{ id: 'n-1', contactId: 'c-1', body: 'Called — asked for spring film', followUpDate: '2026-12-01T00:00:00Z', createdAt: '2026-11-26T00:00:00Z' }],
      referrals: [{ id: 'r-1', contactId: 'c-1', athleteId: 'ath-1', status: 'referred', outcome: null }],
    },
    roster: { athletes: [{ athlete: { id: 'ath-1', name: 'Synthetic One' }, links: [] }], count: 1 },
  };
  const html = UI.renderCrm(state, h());
  assert.ok(html.includes('River State University'), 'contact listed');
  assert.ok(html.includes('data-sui="crm-contact-add"'), 'add-contact form present');
  assert.ok(html.includes('Showcase invite'), 'opportunity shown');
  assert.ok(html.includes('spring film'), 'note shown');
  assert.ok(html.includes('Dec 1, 2026'), 'follow-up date shown');
  assert.ok(html.includes('Athlete ath-1'), 'referral shown');
  assert.ok(html.includes('data-sui="crm-referral-status"'), 'referral status update present');
});

/* ---------------- public profile ---------------- */

test('public profile renders approved fields only; refusal leaks nothing', () => {
  const pub = {
    profileId: 'prof-1', bio: 'Synthetic bio.', primarySport: 'soccer',
    secondarySport: 'baseball', positions: ['Striker'],
    measurements: { height: '5 ft 10 in' },
    accomplishments: ['State cup 2026'], playingHistory: ['Yakima United 2025'],
    verifiedMetrics: { '10yd sprint': '1.82 sec' }, availability: 'Available Jan 2027',
    mediaLinks: [{ kind: 'highlight', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Highlights' }],
    scoutingEvaluations: [{ body: 'Great engine.', approvedAt: '2026-11-26T00:00:00Z' }],
    contactInfo: { email: 'secret@example.com', phone: '555-0000' },
  };
  const html = UI.renderPublicProfile(pub, h());
  assert.ok(html.includes('Synthetic bio.'));
  assert.ok(html.includes('Soccer'));
  assert.ok(html.includes('Striker'));
  assert.ok(html.includes('State cup 2026'));
  assert.ok(html.includes('1.82 sec'));
  assert.ok(html.includes('youtube-nocookie'), 'allowlisted embed rendered');
  assert.ok(html.includes('Great engine.'), 'coach-approved evaluation shown');
  assert.ok(html.includes('PHOTO PLACEHOLDER'), 'synthetic photo placeholder shown');
  assert.ok(!html.includes('secret@example.com'), 'contact email never rendered even if present');
  assert.ok(!html.includes('555-0000'), 'contact phone never rendered even if present');

  // Name display: the server-sent athleteName is the heading when
  // present; without it the page stays generic and names nothing.
  const named = UI.renderPublicProfile({ ...pub, athleteName: 'Synthetic Athlete' }, h());
  assert.ok(named.includes('Synthetic Athlete'), 'authorized name shown as heading');
  assert.ok(!named.includes('<h1 class="disp" style="margin:8px 0">Prospect profile</h1>'),
    'named heading replaces the generic one');
  const unnamed = UI.renderPublicProfile({ ...pub, athleteName: null }, h());
  assert.ok(unnamed.includes('Prospect profile</h1>'), 'no name: generic heading');
  assert.ok(!unnamed.includes('Synthetic Athlete'), 'no name: nothing leaks');

  const refusal = UI.renderPublicRefusal(h());
  assert.ok(refusal.includes('not available'));
  assert.ok(!refusal.includes('Synthetic bio.'));
  assert.ok(!refusal.includes('Soccer'));
});

/* ---------------- controller flow (stub client, real API) ---------------- */

test('controller: director owner flow — list, grant, revoke via the hub', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createSaasUI({ root, doc, client });
  const director = { role: 'director', user: 'dev-director-marcus', label: 'Director (Marcus)' };
  client.setAuth({ authUserId: 'dev-director-marcus', role: 'director' });

  const created = await client.api.ownerCreateAthlete(
    { authUserId: 'dev-director-marcus', role: 'director' },
    { name: 'Synthetic Pilot', age: 16, sports: ['soccer'] });
  const athleteId = created.athlete.id;

  await ui.switchRole(director);
  assert.equal(ui.state.directorAthletes.count, 1);
  assert.equal(ui.state.directorAthletes.athletes[0].athlete.name, 'Synthetic Pilot');
  assert.equal(ui.state.directorAthletes.athletes[0].entitlements.tier, 'free');
  ui.state.tab = 'director';
  const hub = ui.renderHub();
  assert.ok(hub.includes('Owner console'));
  assert.ok(hub.includes('Synthetic Pilot'));

  doc.set('sui-grant-athlete', athleteId);
  doc.set('sui-grant-reason', 'Walk-On Project pilot');
  doc.set('sui-grant-indefinite', '', true);
  await ui.grantComplimentary();
  assert.ok(ui.state.notice.includes('granted'));
  assert.equal(ui.state.directorAthletes.athletes[0].entitlements.tier, 'complimentary');
  assert.ok(ui.state.directorAthletes.athletes[0].complimentaryGrant.expiresAt === null, 'indefinite grant');
  ui.state.tab = 'director';
  assert.ok(ui.renderHub().includes('Indefinite'));

  await ui.revokeComplimentary(athleteId, ui.state.directorAthletes.athletes[0].complimentaryGrant.id);
  assert.equal(ui.state.directorAthletes.athletes[0].entitlements.tier, 'free');
  assert.ok(ui.state.directorAthletes.athletes[0].complimentaryGrant === null);

  await ui.suspendAthlete(athleteId);
  assert.equal(ui.state.directorAthletes.athletes[0].status, 'suspended');
  await ui.reactivateAthlete(athleteId);
  assert.equal(ui.state.directorAthletes.athletes[0].status, 'active');
});

test('controller: athlete portal shows only own pathways, no owner console', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createSaasUI({ root, doc, client });
  const athleteAuth = { authUserId: 'dev-ath-test', role: 'athlete' };
  const reg = await client.api.registerAthlete(athleteAuth, { email: 'a@test.invalid', name: 'Test Athlete', age: 20 });
  const athleteId = reg.athlete.id;
  client.setAuth(athleteAuth);
  await ui.switchRole({ role: 'athlete', user: 'dev-ath-test', athleteId, label: 'Athlete' });
  assert.equal(ui.state.pathways, null, 'no profile yet');
  assert.equal(ui.state.entitlements.entitlements.tier, 'free');
  ui.state.tab = 'athlete';
  const html = ui.renderHub();
  assert.ok(html.includes('No prospect profile yet'));
  assert.ok(!html.includes('Owner console'));
});

test('controller: CRM detail reloads opportunities/notes/referrals from the server after refresh (G1)', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createSaasUI({ root, doc, client });
  const coachAuth = { authUserId: 'dev-coach-kayla', role: 'coach' };
  const coach = await client.api.registerCoach(coachAuth,
    { email: 'kayla@test.invalid', name: 'Coach Kayla' });
  const reg = await client.api.registerAthlete(
    { authUserId: 'dev-ath-test', role: 'athlete' },
    { email: 'a@test.invalid', name: 'Test Athlete', age: 20 });
  const athleteId = reg.athlete.id;
  await client.api.linkAthlete(coachAuth, { athleteId });
  client.setAuth(coachAuth);
  await ui.switchRole({ role: 'coach', user: 'dev-coach-kayla', label: 'Coach Kayla' });

  // Seed CRM rows through the real API (as the coach would in the UI).
  const { contact } = await client.api.createRecruitmentContact(coachAuth, {
    orgName: 'River State University', sport: 'soccer', level: 'collegiate', region: 'WA',
  });
  const contactId = contact.id;
  await client.api.createOpportunity(coachAuth,
    { contactId, type: 'tryout', date: '2026-12-10T00:00:00Z', notes: 'Showcase invite' });
  await client.api.addRecruitmentNote(coachAuth,
    { contactId, body: 'Called — asked for spring film', followUpDate: '2026-12-01T00:00:00Z' });
  await client.api.referAthlete(coachAuth, { contactId, athleteId });

  // The UI reloads its contacts list after a contact is added;
  // mirror that here so the detail has a contact to render.
  await ui.refreshRoleData();

  // Open the contact: the detail loads from the server, not session state.
  ui.state.crmContactId = contactId;
  await ui.loadCrmContactDetail(contactId);
  assert.equal(ui.state.crmActivity.opportunities.length, 1);
  assert.equal(ui.state.crmActivity.opportunities[0].notes, 'Showcase invite');
  assert.equal(ui.state.crmActivity.notes.length, 1);
  assert.equal(ui.state.crmActivity.notes[0].body, 'Called — asked for spring film');
  assert.equal(ui.state.crmActivity.referrals.length, 1);
  assert.equal(ui.state.crmActivity.referrals[0].athleteId, athleteId);
  const html = UI.renderCrm(ui.state, h());
  assert.ok(html.includes('Showcase invite'), 'opportunity rendered from server data');
  assert.ok(html.includes('spring film'), 'note rendered from server data');
  assert.ok(!html.includes('has no list method'), 'session-only honest note is gone');

  // Simulate a refresh: wipe the in-memory activity, reload, rows return.
  ui.state.crmActivity = { opportunities: [], notes: [], referrals: [] };
  await ui.loadCrmContactDetail(contactId);
  assert.equal(ui.state.crmActivity.opportunities.length, 1, 'opportunities survive a refresh');
  assert.equal(ui.state.crmActivity.notes.length, 1, 'notes survive a refresh');
  assert.equal(ui.state.crmActivity.referrals.length, 1, 'referrals survive a refresh');

  // Adds also reload from the server (no local push): a second
  // opportunity appears via the list read, and the count is exact.
  doc.set('sui-crm-opp-type', 'combine');
  doc.set('sui-crm-opp-date', '2027-01-15');
  doc.set('sui-crm-opp-notes', 'Winter combine');
  await ui.addCrmOpportunity(contactId);
  assert.equal(ui.state.crmActivity.opportunities.length, 2);
  assert.ok(ui.state.crmActivity.opportunities.some((o) => o.notes === 'Winter combine'));
  assert.ok(ui.state.crmActivity.opportunities.some((o) => o.notes === 'Showcase invite'));
});

test('controller: athlete portal reads own referrals/opportunities from the server (G1/G3)', async () => {
  const doc = makeDoc();
  const { root } = makeRoot(doc);
  const client = makeStubClient();
  const ui = UI.createSaasUI({ root, doc, client });
  const coachAuth = { authUserId: 'dev-coach-kayla', role: 'coach' };
  await client.api.registerCoach(coachAuth, { email: 'kayla@test.invalid', name: 'Coach Kayla' });
  const reg = await client.api.registerAthlete(
    { authUserId: 'dev-ath-test', role: 'athlete' },
    { email: 'a@test.invalid', name: 'Test Athlete', age: 20 });
  const athleteId = reg.athlete.id;
  await client.api.linkAthlete(coachAuth, { athleteId });
  const { contact } = await client.api.createRecruitmentContact(coachAuth, {
    orgName: 'River State University', sport: 'soccer', level: 'collegiate',
  });
  await client.api.createOpportunity(coachAuth,
    { contactId: contact.id, type: 'tryout', date: '2026-12-10T00:00:00Z', notes: 'Showcase invite' });
  const { referral } = await client.api.referAthlete(coachAuth, { contactId: contact.id, athleteId });
  await client.api.updateReferralStatus(coachAuth, { referralId: referral.id, status: 'contacted' });

  client.setAuth({ authUserId: 'dev-ath-test', role: 'athlete' });
  await ui.switchRole({ role: 'athlete', user: 'dev-ath-test', athleteId, label: 'Athlete' });
  assert.equal(ui.state.pathways.opportunities.length, 1, 'athlete portal loads own opportunities');
  assert.equal(ui.state.pathways.opportunities[0].type, 'tryout');
  assert.equal(ui.state.pathways.opportunities[0].organization, 'River State University');
  assert.equal(ui.state.pathways.referrals.length, 1, 'athlete portal loads own referrals');
  assert.equal(ui.state.pathways.referrals[0].status, 'contacted');
  const html = UI.renderAthletePathways(ui.state, h());
  assert.ok(html.includes('River State University'), 'organization shown to the athlete');
  assert.ok(html.includes('tryout'), 'opportunity shown to the athlete');
  assert.ok(html.includes('contacted'), 'referral stage shown to the athlete');
  assert.ok(!html.includes('No athlete-facing recruitment list exists'), 'honest empty-state note is gone');

  // An athlete with no referrals sees the empty state, not an error.
  const other = await client.api.registerAthlete(
    { authUserId: 'dev-ath-other', role: 'athlete' },
    { email: 'o@test.invalid', name: 'Other Athlete', age: 22 });
  client.setAuth({ authUserId: 'dev-ath-other', role: 'athlete' });
  await ui.switchRole({ role: 'athlete', user: 'dev-ath-other', athleteId: other.athlete.id, label: 'Other' });
  assert.equal(ui.state.pathways, null, 'no profile and no pipeline means no pathways bundle');
  const emptyHtml = UI.renderAthletePathways(
    { pathways: { profile: null, mediaLinks: [], scoutingEvaluations: [], developmentGoals: [], referrals: [], opportunities: [] }, history: null }, h());
  assert.ok(emptyHtml.includes('No recruitment opportunities yet.'));
});

/* ---------------- HTTP: dev server ---------------- */

let dev;
let base;
const DIRECTOR_H = { 'X-Dev-Role': 'director', 'X-Dev-User': 'dev-director-marcus' };
const KAYLA_H = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-kayla' };
const YOUTH_H = { 'X-Dev-Role': 'athlete', 'X-Dev-User': 'dev-athlete-youth', 'X-Dev-Athlete': YOUTH_ID };

async function post(pathName, body, headers = {}) {
  const res = await fetch(base + pathName, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test.before(async () => {
  dev = createDevServer({ port: 0, seed: true });
  await dev.start();
  base = dev.url;
});

test.after(async () => {
  if (dev) await dev.close();
});

test('HTTP: owner console flow — grant makes the athlete complimentary, revoke falls back', async () => {
  const created = await post('/api/saas', {
    method: 'ownerCreateAthlete', params: { name: 'HTTP Pilot', age: 17, sports: ['basketball'] },
  }, DIRECTOR_H);
  assert.equal(created.json.ok, true, JSON.stringify(created.json));
  const athleteId = created.json.data.athlete.id;

  const forbidden = await post('/api/saas', { method: 'ownerListAthletes', params: {} }, KAYLA_H);
  assert.equal(forbidden.json.ok, false);
  assert.equal(forbidden.json.error.code, 'FORBIDDEN', 'coach may not list all athletes');

  const granted = await post('/api/saas', {
    method: 'grantComplimentary', params: { athleteId, reason: 'Walk-On Project pilot' },
  }, DIRECTOR_H);
  assert.equal(granted.json.ok, true, JSON.stringify(granted.json));
  assert.equal(granted.json.data.entitlements.tier, 'complimentary');

  const list = await post('/api/saas', { method: 'ownerListAthletes', params: {} }, DIRECTOR_H);
  assert.equal(list.json.ok, true);
  const row = list.json.data.athletes.find((r) => r.athlete.id === athleteId);
  assert.equal(row.entitlements.tier, 'complimentary');
  assert.equal(row.complimentaryGrant.expiresAt, null, 'indefinite grant');

  const suspended = await post('/api/saas', { method: 'suspendAthlete', params: { athleteId } }, DIRECTOR_H);
  assert.equal(suspended.json.ok, true);
  assert.equal(suspended.json.data.athlete.status, 'suspended');
  await post('/api/saas', { method: 'reactivateAthlete', params: { athleteId } }, DIRECTOR_H);

  const role = await post('/api/saas', { method: 'updateAthleteRole', params: { athleteId, role: 'parent' } }, DIRECTOR_H);
  assert.equal(role.json.ok, true);
  assert.equal(role.json.data.athlete.role, 'parent');

  const audit = await post('/api/saas', { method: 'listAudit', params: {} }, DIRECTOR_H);
  assert.equal(audit.json.ok, true);
  assert.ok(audit.json.data.events.some((e) => e.action === 'grant_complimentary'));

  const revoked = await post('/api/saas', { method: 'revokeComplimentary', params: { athleteId } }, DIRECTOR_H);
  assert.equal(revoked.json.ok, true);
  assert.equal(revoked.json.data.entitlements.tier, 'free', 'revoke falls back to free');
});

test('HTTP: complimentary grant changes the athlete entitlement (seeded youth)', async () => {
  const before = await post('/api/saas', { method: 'myEntitlements', params: {} }, YOUTH_H);
  assert.equal(before.json.ok, true);
  assert.equal(before.json.data.entitlements.tier, 'free');

  await post('/api/saas', { method: 'grantComplimentary', params: { athleteId: YOUTH_ID, reason: 'HTTP check' } }, DIRECTOR_H);
  const after = await post('/api/saas', { method: 'myEntitlements', params: {} }, YOUTH_H);
  assert.equal(after.json.data.entitlements.tier, 'complimentary');
  assert.equal(after.json.data.entitlements.source, 'complimentary_grant');

  await post('/api/saas', { method: 'revokeComplimentary', params: { athleteId: YOUTH_ID } }, DIRECTOR_H);
  const back = await post('/api/saas', { method: 'myEntitlements', params: {} }, YOUTH_H);
  assert.equal(back.json.data.entitlements.tier, 'free');
});

test('HTTP: public profile — approved share renders, revoked/unapproved refuse with no data', async () => {
  const created = await post('/api/saas', {
    method: 'createProspectProfile',
    params: {
      athleteId: YOUTH_ID, primarySport: 'soccer', positions: ['Striker'],
      bio: 'Synthetic HTTP bio.', measurements: { height: '5 ft 10 in' },
      accomplishments: ['State cup 2026'], verifiedMetrics: { '10yd sprint': '1.82 sec' },
      availability: 'Available Jan 2027', contactInfo: { email: 'never-public@example.com' },
    },
  }, KAYLA_H);
  assert.equal(created.json.ok, true, JSON.stringify(created.json));
  const profileId = created.json.data.profile.id;

  const shareEarly = await post('/api/saas', { method: 'createProfileShare', params: { profileId } }, KAYLA_H);
  assert.equal(shareEarly.json.ok, false);
  assert.equal(shareEarly.json.error.code, 'PROFILE_NOT_APPROVED', 'draft profiles cannot be shared');

  const coachOk = await post('/api/saas', {
    method: 'approveProspectProfile', params: { profileId, approval: 'coach' },
  }, KAYLA_H);
  assert.equal(coachOk.json.ok, true);
  assert.equal(coachOk.json.data.profile.status, 'pending_approval');
  const athleteOk = await post('/api/saas', {
    method: 'approveProspectProfile', params: { profileId, approval: 'athlete' },
  }, YOUTH_H);
  assert.equal(athleteOk.json.ok, true, JSON.stringify(athleteOk.json));
  assert.equal(athleteOk.json.data.profile.status, 'approved');

  const share = await post('/api/saas', { method: 'createProfileShare', params: { profileId } }, KAYLA_H);
  assert.equal(share.json.ok, true, JSON.stringify(share.json));
  const token = share.json.data.token;
  assert.ok(token && !share.json.data.share.tokenHash, 'token returned once, hash never leaves the server');

  const pubRes = await fetch(base + '/api/public/profile?token=' + encodeURIComponent(token));
  const pub = await pubRes.json();
  assert.equal(pub.ok, true, JSON.stringify(pub));
  assert.equal(pub.data.profile.bio, 'Synthetic HTTP bio.');
  assert.equal(pub.data.profile.primarySport, 'soccer');
  assert.ok(!('contactInfo' in pub.data.profile), 'public view never carries contact info');
  assert.ok(!JSON.stringify(pub).includes('never-public@example.com'), 'no contact email leaks');

  const viaSaas = await post('/api/saas', { method: 'getPublicProfile', params: { token } }, DIRECTOR_H);
  assert.equal(viaSaas.status, 400, 'the token-only read is not an /api/saas method');

  const revoked = await post('/api/saas', {
    method: 'revokeProfileShare', params: { shareId: share.json.data.share.id },
  }, KAYLA_H);
  assert.equal(revoked.json.ok, true);

  const afterRevoke = await fetch(base + '/api/public/profile?token=' + encodeURIComponent(token));
  const afterJson = await afterRevoke.json();
  assert.equal(afterJson.ok, false);
  assert.equal(afterJson.error.code, 'PROFILE_SHARE_INVALID');
  assert.ok(!JSON.stringify(afterJson).includes('Synthetic HTTP bio.'), 'revoked token leaks no profile data');

  const noToken = await fetch(base + '/api/public/profile');
  const noTokenJson = await noToken.json();
  assert.equal(noTokenJson.ok, false);
  assert.equal(noTokenJson.error.code, 'INVALID_INPUT');
});

test('HTTP: athlete scoping — an athlete reads only their own pathways', async () => {
  const other = await post('/api/saas', {
    method: 'ownerCreateAthlete', params: { name: 'Scope Other', age: 18, sports: ['soccer'] },
  }, DIRECTOR_H);
  const otherId = other.json.data.athlete.id;
  await post('/api/saas', {
    method: 'linkAthlete', params: { coachId: 'kayla', athleteId: otherId },
  }, DIRECTOR_H);
  const otherProfile = await post('/api/saas', {
    method: 'createProspectProfile', params: { athleteId: otherId, primarySport: 'soccer' },
  }, KAYLA_H);
  assert.equal(otherProfile.json.ok, true, JSON.stringify(otherProfile.json));

  const cross = await post('/api/saas', {
    method: 'getProspectProfile', params: { athleteId: otherId },
  }, YOUTH_H);
  assert.equal(cross.json.ok, false);
  assert.equal(cross.json.error.code, 'ATHLETE_NOT_FOUND', 'cross-tenant read never leaks existence');

  const crossGoals = await post('/api/saas', {
    method: 'listDevelopmentGoals', params: { athleteId: otherId },
  }, YOUTH_H);
  assert.equal(crossGoals.json.ok, false);

  const own = await post('/api/saas', {
    method: 'getProspectProfile', params: { athleteId: YOUTH_ID },
  }, YOUTH_H);
  assert.equal(own.json.ok, true, 'athlete reads their own profile');
  assert.equal(own.json.data.profile.athleteId, YOUTH_ID);

  const coachB = await post('/api/saas', {
    method: 'registerCoach', params: { email: 'b@test.invalid', name: 'Coach B' },
  }, { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-b' });
  assert.equal(coachB.json.ok, true, JSON.stringify(coachB.json));
  const coachBCross = await post('/api/saas', {
    method: 'getProspectProfile', params: { athleteId: YOUTH_ID },
  }, { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-b' });
  assert.equal(coachBCross.json.ok, false, 'unlinked coach sees nothing');
  assert.equal(coachBCross.json.error.code, 'ATHLETE_NOT_FOUND');
});

test('HTTP: CRM — contact, opportunity, note, referral, status transitions', async () => {
  const contact = await post('/api/saas', {
    method: 'createRecruitmentContact',
    params: {
      orgName: 'River State University', sport: 'soccer', level: 'collegiate',
      region: 'WA', contactName: 'Coach Rivera', email: 'coach@example.edu', status: 'new',
    },
  }, KAYLA_H);
  assert.equal(contact.json.ok, true, JSON.stringify(contact.json));
  const contactId = contact.json.data.contact.id;

  const listed = await post('/api/saas', { method: 'listRecruitmentContacts', params: {} }, KAYLA_H);
  assert.equal(listed.json.ok, true);
  assert.ok(listed.json.data.contacts.some((c) => c.id === contactId));

  const forbidden = await post('/api/saas', { method: 'listRecruitmentContacts', params: {} }, YOUTH_H);
  assert.equal(forbidden.json.ok, false);
  assert.equal(forbidden.json.error.code, 'FORBIDDEN', 'athletes do not list CRM contacts');

  const updated = await post('/api/saas', {
    method: 'updateRecruitmentContact', params: { contactId, status: 'contacted' },
  }, KAYLA_H);
  assert.equal(updated.json.data.contact.status, 'contacted');

  const opp = await post('/api/saas', {
    method: 'createOpportunity', params: { contactId, type: 'tryout', date: '2026-12-10T00:00:00Z', notes: 'Showcase invite' },
  }, KAYLA_H);
  assert.equal(opp.json.ok, true);
  assert.equal(opp.json.data.opportunity.type, 'tryout');

  const note = await post('/api/saas', {
    method: 'addRecruitmentNote',
    params: { contactId, body: 'Called — asked for spring film', followUpDate: '2026-12-01T00:00:00Z' },
  }, KAYLA_H);
  assert.equal(note.json.ok, true);
  assert.equal(note.json.data.note.followUpDate, '2026-12-01T00:00:00Z');

  const referral = await post('/api/saas', {
    method: 'referAthlete', params: { contactId, athleteId: YOUTH_ID },
  }, KAYLA_H);
  assert.equal(referral.json.ok, true, JSON.stringify(referral.json));
  assert.equal(referral.json.data.referral.status, 'referred');

  const moved = await post('/api/saas', {
    method: 'updateReferralStatus',
    params: { referralId: referral.json.data.referral.id, status: 'contacted', outcome: 'Film requested' },
  }, KAYLA_H);
  assert.equal(moved.json.ok, true);
  assert.equal(moved.json.data.referral.status, 'contacted');
  assert.equal(moved.json.data.referral.outcome, 'Film requested');
});

test('HTTP: CRM list methods read back opportunities/notes/referrals; athlete sees only own', async () => {
  const contact = await post('/api/saas', {
    method: 'createRecruitmentContact',
    params: {
      orgName: 'Listback University', sport: 'soccer', level: 'collegiate',
      region: 'WA', contactName: 'Coach Listback', status: 'new',
    },
  }, KAYLA_H);
  assert.equal(contact.json.ok, true, JSON.stringify(contact.json));
  const contactId = contact.json.data.contact.id;

  const opp = await post('/api/saas', {
    method: 'createOpportunity', params: { contactId, type: 'tryout', date: '2026-12-10T00:00:00Z', notes: 'Listback tryout' },
  }, KAYLA_H);
  assert.equal(opp.json.ok, true);
  const note = await post('/api/saas', {
    method: 'addRecruitmentNote',
    params: { contactId, body: 'Listback note', followUpDate: '2026-12-01T00:00:00Z' },
  }, KAYLA_H);
  assert.equal(note.json.ok, true);
  const referral = await post('/api/saas', {
    method: 'referAthlete', params: { contactId, athleteId: YOUTH_ID },
  }, KAYLA_H);
  assert.equal(referral.json.ok, true, JSON.stringify(referral.json));

  // Coach reads back exactly what was created, filtered by contact.
  const opps = await post('/api/saas', { method: 'listOpportunities', params: { contactId } }, KAYLA_H);
  assert.equal(opps.json.ok, true, JSON.stringify(opps.json));
  assert.equal(opps.json.data.count, 1);
  assert.equal(opps.json.data.opportunities[0].notes, 'Listback tryout');
  assert.equal(opps.json.data.opportunities[0].organization, 'Listback University');
  const notes = await post('/api/saas', { method: 'listRecruitmentNotes', params: { contactId } }, KAYLA_H);
  assert.equal(notes.json.ok, true);
  assert.equal(notes.json.data.count, 1);
  assert.equal(notes.json.data.notes[0].body, 'Listback note');
  const refs = await post('/api/saas', { method: 'listReferrals', params: { contactId } }, KAYLA_H);
  assert.equal(refs.json.ok, true);
  assert.equal(refs.json.data.count, 1);
  assert.equal(refs.json.data.referrals[0].athleteId, YOUTH_ID);

  // Empty contact reads back empty, not an error.
  const empty = await post('/api/saas', {
    method: 'createRecruitmentContact', params: { orgName: 'Empty Listback College' },
  }, KAYLA_H);
  const emptyId = empty.json.data.contact.id;
  const emptyOpps = await post('/api/saas', { method: 'listOpportunities', params: { contactId: emptyId } }, KAYLA_H);
  assert.equal(emptyOpps.json.ok, true);
  assert.deepEqual(emptyOpps.json.data, { opportunities: [], count: 0 });

  // The referred athlete reads their own pipeline; another athlete is refused.
  const youthOpps = await post('/api/saas', { method: 'listOpportunities', params: { athleteId: YOUTH_ID } }, YOUTH_H);
  assert.equal(youthOpps.json.ok, true, JSON.stringify(youthOpps.json));
  assert.ok(youthOpps.json.data.opportunities.some((o) => o.notes === 'Listback tryout'));
  const youthRefs = await post('/api/saas', { method: 'listReferrals', params: { athleteId: YOUTH_ID } }, YOUTH_H);
  assert.equal(youthRefs.json.ok, true);
  assert.ok(youthRefs.json.data.referrals.some((r) => r.contactId === contactId));
  const other = await post('/api/saas', {
    method: 'ownerCreateAthlete', params: { name: 'Listback Other', age: 19, sports: ['soccer'] },
  }, DIRECTOR_H);
  const otherId = other.json.data.athlete.id;
  const cross = await post('/api/saas', { method: 'listReferrals', params: { athleteId: otherId } }, YOUTH_H);
  assert.equal(cross.json.ok, false);
  assert.equal(cross.json.error.code, 'ATHLETE_NOT_FOUND');
  const youthNotes = await post('/api/saas', { method: 'listRecruitmentNotes', params: { contactId } }, YOUTH_H);
  assert.equal(youthNotes.json.ok, false);
  assert.equal(youthNotes.json.error.code, 'FORBIDDEN', 'notes stay coach-side');

  // An unlinked coach reads nothing of Kayla's contact items.
  const coachB = await post('/api/saas', {
    method: 'registerCoach', params: { email: 'listback-b@test.invalid', name: 'Coach Listback B' },
  }, { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-listback-b' });
  assert.equal(coachB.json.ok, true, JSON.stringify(coachB.json));
  const bHeaders = { 'X-Dev-Role': 'coach', 'X-Dev-User': 'dev-coach-listback-b' };
  const bOpps = await post('/api/saas', { method: 'listOpportunities', params: { contactId } }, bHeaders);
  assert.equal(bOpps.json.ok, false);
  assert.equal(bOpps.json.error.code, 'FORBIDDEN');
  const bRefs = await post('/api/saas', { method: 'listReferrals', params: { contactId } }, bHeaders);
  assert.equal(bRefs.json.error.code, 'FORBIDDEN');
  const bAll = await post('/api/saas', { method: 'listOpportunities', params: {} }, bHeaders);
  assert.equal(bAll.json.ok, true);
  assert.equal(bAll.json.data.count, 0, 'unlinked coach lists nothing');
});

test('HTTP: sport, goals, evaluations, media links', async () => {
  const assigned = await post('/api/saas', {
    method: 'assignSport', params: { athleteId: YOUTH_ID, sport: 'soccer', positions: ['Striker'] },
  }, KAYLA_H);
  assert.equal(assigned.json.ok, true, JSON.stringify(assigned.json));
  assert.equal(assigned.json.data.link.sport, 'soccer');
  assert.deepEqual(assigned.json.data.link.positions, ['Striker']);

  const badSport = await post('/api/saas', {
    method: 'assignSport', params: { athleteId: YOUTH_ID, sport: 'quidditch' },
  }, KAYLA_H);
  assert.equal(badSport.json.ok, false);
  assert.equal(badSport.json.error.code, 'INVALID_INPUT');

  const goal = await post('/api/saas', {
    method: 'setDevelopmentGoals',
    params: { athleteId: YOUTH_ID, goal: 'Hold a 60-second side plank each side', targetDate: '2026-12-20T00:00:00Z' },
  }, KAYLA_H);
  assert.equal(goal.json.ok, true, JSON.stringify(goal.json));
  const goalId = goal.json.data.goal.id;

  const goalsAsAthlete = await post('/api/saas', {
    method: 'listDevelopmentGoals', params: { athleteId: YOUTH_ID },
  }, YOUTH_H);
  assert.equal(goalsAsAthlete.json.ok, true);
  assert.ok(goalsAsAthlete.json.data.goals.some((g) => g.id === goalId));

  const done = await post('/api/saas', {
    method: 'updateDevelopmentGoal', params: { goalId, status: 'completed' },
  }, KAYLA_H);
  assert.equal(done.json.data.goal.status, 'completed');

  const evaluation = await post('/api/saas', {
    method: 'recordScoutingEvaluation',
    params: { athleteId: YOUTH_ID, body: 'Great engine, presses well.' },
  }, KAYLA_H);
  assert.equal(evaluation.json.ok, true, JSON.stringify(evaluation.json));
  assert.equal(evaluation.json.data.evaluation.coachApproved, true);

  const evalsAsAthlete = await post('/api/saas', {
    method: 'listScoutingEvaluations', params: { athleteId: YOUTH_ID },
  }, YOUTH_H);
  assert.equal(evalsAsAthlete.json.ok, true);
  assert.ok(evalsAsAthlete.json.data.evaluations.some((e) => e.body === 'Great engine, presses well.'));

  const profile = await post('/api/saas', {
    method: 'getProspectProfile', params: { athleteId: YOUTH_ID },
  }, KAYLA_H);
  const profileId = profile.json.data.profile.id;

  const media = await post('/api/saas', {
    method: 'addMediaLink',
    params: { profileId, kind: 'highlight', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Highlights' },
  }, KAYLA_H);
  assert.equal(media.json.ok, true, JSON.stringify(media.json));

  const badUrl = await post('/api/saas', {
    method: 'addMediaLink', params: { profileId, kind: 'highlight', url: 'not-a-url' },
  }, KAYLA_H);
  assert.equal(badUrl.json.ok, false);
  assert.equal(badUrl.json.error.code, 'INVALID_INPUT', 'non-URL media refused');

  const links = await post('/api/saas', { method: 'listMediaLinks', params: { profileId } }, YOUTH_H);
  assert.equal(links.json.ok, true);
  assert.ok(links.json.data.mediaLinks.some((m) => m.title === 'Highlights'));

  const removed = await post('/api/saas', {
    method: 'removeMediaLink', params: { mediaLinkId: media.json.data.mediaLink.id },
  }, KAYLA_H);
  assert.equal(removed.json.ok, true);
  assert.equal(removed.json.data.removed, true);
});
