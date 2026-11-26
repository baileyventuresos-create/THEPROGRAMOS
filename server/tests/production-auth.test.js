/* Production Supabase Auth sign-in (Pathways integration, 2026-11-26).
 * Run: node --test server/tests/production-auth.test.js
 *
 * Covers saas-ui/supabase-auth.js (GoTrue REST client, no deps) and
 * the production gating in both UIs: off localhost the dev "View as"
 * switcher is gone, the SaaS hub gates on a Supabase Auth session,
 * roles map director/coach/athlete/parent from the Auth user (display
 * hint only — the server derives the role from app_users), and the
 * assessment UI stays quiet until someone signs in.
 *
 * No live Supabase: fetch is stubbed, sessions live in memory
 * storage. The real anon key is NOT in this repo (see
 * docs/PRODUCTION_AUTH.md); nothing here needs it.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Auth = require('../../saas-ui/supabase-auth');
const UI = require('../../saas-ui/saas-ui');
const AUI = require('../../assessment-ui/assessment-ui');

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function memoryStorage() {
  const store = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

/* Fake GoTrue: password grant succeeds for coach@dev.invalid /
 * correct-password, refresh succeeds for refresh-token-good, and
 * anything else is invalid_grant. */
function fakeFetch() {
  return async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const json = (status, data) => ({
      ok: status >= 200 && status < 300, status,
      json: async () => data,
    });
    if (String(url).includes('/auth/v1/token?grant_type=password')) {
      if (body.email === 'coach@dev.invalid' && body.password === 'correct-password') {
        return json(200, {
          access_token: 'access-token-1', refresh_token: 'refresh-token-good',
          expires_in: 3600, token_type: 'bearer',
          user: { id: 'auth-coach-1', email: 'coach@dev.invalid', app_metadata: { role: 'coach' }, user_metadata: {} },
        });
      }
      return json(400, { error_code: 'invalid_grant', msg: 'Invalid login credentials' });
    }
    if (String(url).includes('/auth/v1/token?grant_type=refresh_token')) {
      if (body.refresh_token === 'refresh-token-good') {
        return json(200, {
          access_token: 'access-token-2', refresh_token: 'refresh-token-good',
          expires_in: 3600, token_type: 'bearer',
          user: { id: 'auth-coach-1', email: 'coach@dev.invalid', app_metadata: { role: 'coach' }, user_metadata: {} },
        });
      }
      return json(400, { error_code: 'invalid_grant', msg: 'Invalid refresh token' });
    }
    if (String(url).includes('/auth/v1/logout')) return json(200, {});
    throw new Error('unexpected fetch: ' + url);
  };
}

function makeAuth(overrides = {}) {
  return Auth.createSupabaseAuth({
    url: 'https://test.supabase.co',
    anonKey: 'anon-key-test',
    fetchImpl: fakeFetch(),
    storage: memoryStorage(),
    ...overrides,
  });
}

/* ---------------- supabase-auth module ---------------- */

test('isLocalDevHost: localhost forms are dev, real hosts are not', () => {
  for (const h of ['', 'localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) {
    assert.equal(Auth.isLocalDevHost(h), true, h);
  }
  for (const h of ['example.com', 'theprogram.app', '192.168.1.5']) {
    assert.equal(Auth.isLocalDevHost(h), false, h);
  }
});

test('roleForUser: app_metadata wins, user_metadata falls back, unknown maps to null', () => {
  assert.equal(Auth.roleForUser({ app_metadata: { role: 'director' } }), 'director');
  assert.equal(Auth.roleForUser({ app_metadata: {}, user_metadata: { role: 'parent' } }), 'parent');
  assert.equal(Auth.roleForUser({ app_metadata: { role: 'coach' }, user_metadata: { role: 'athlete' } }), 'coach');
  assert.equal(Auth.roleForUser({ app_metadata: { role: 'superuser' } }), null);
  assert.equal(Auth.roleForUser({ app_metadata: {}, user_metadata: {} }), null);
  assert.equal(Auth.roleForUser(null), null);
  for (const r of Auth.APP_ROLES) assert.ok(['director', 'coach', 'athlete', 'parent'].includes(r));
});

test('unconfigured client reports it and refuses sign-in without faking a session', () => {
  const auth = Auth.createSupabaseAuth({ storage: memoryStorage(), fetchImpl: fakeFetch() });
  assert.equal(auth.isConfigured(), false);
  assert.equal(auth.getSession(), null);
  assert.equal(auth.getAccessToken(), null);
  return assert.rejects(
    () => auth.signInWithPassword('a@dev.invalid', 'x'),
    (e) => e.code === 'AUTH_NOT_CONFIGURED');
});

test('sign-in stores the session; token, user and role read back; sign-out clears', async () => {
  const auth = makeAuth();
  const r = await auth.signInWithPassword('coach@dev.invalid', 'correct-password');
  assert.equal(r.role, 'coach');
  assert.equal(r.user.email, 'coach@dev.invalid');
  assert.equal(auth.getAccessToken(), 'access-token-1');
  assert.equal(auth.getUser().id, 'auth-coach-1');
  await auth.signOut();
  assert.equal(auth.getSession(), null);
  assert.equal(auth.getAccessToken(), null);
});

test('wrong password rejects INVALID_CREDENTIALS and stores nothing', async () => {
  const auth = makeAuth();
  await assert.rejects(
    () => auth.signInWithPassword('coach@dev.invalid', 'wrong'),
    (e) => e.code === 'INVALID_CREDENTIALS');
  assert.equal(auth.getSession(), null);
});

test('expired token reads null; ensureFreshSession refreshes it', async () => {
  const auth = makeAuth();
  await auth.signInWithPassword('coach@dev.invalid', 'correct-password');
  // Force expiry by rewriting the stored session.
  const store = memoryStorage();
  const auth2 = Auth.createSupabaseAuth({
    url: 'https://test.supabase.co', anonKey: 'anon-key-test',
    fetchImpl: fakeFetch(), storage: store,
  });
  await auth2.signInWithPassword('coach@dev.invalid', 'correct-password');
  const saved = JSON.parse(store.getItem(Auth.SESSION_STORAGE_KEY));
  saved.expires_at = Date.now() - 1000;
  store.setItem(Auth.SESSION_STORAGE_KEY, JSON.stringify(saved));
  assert.equal(auth2.getAccessToken(), null, 'expired token is not handed out');
  const fresh = await auth2.ensureFreshSession();
  assert.ok(fresh, 'refresh succeeds');
  assert.equal(auth2.getAccessToken(), 'access-token-2');
});

test('decodeJwtPayload decodes the payload without verifying', () => {
  const payload = { sub: 'auth-1', role: 'authenticated', email: 'a@dev.invalid' };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = 'eyJhbGciOiJIUzI1NiJ9.' + b64 + '.sig';
  assert.deepEqual(Auth.decodeJwtPayload(token), payload);
  assert.equal(Auth.decodeJwtPayload('not-a-jwt'), null);
});

/* ---------------- SaaS UI production gating ---------------- */

function makeDoc() {
  const els = new Map();
  const doc = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, { value: '', checked: false });
      return els.get(id);
    },
    addEventListener() {},
    set(id, value) { els.set(id, { value: value == null ? '' : String(value), checked: false }); },
  };
  return doc;
}

function makeRoot(doc) {
  return {
    SaasClient: { createSaasClient: () => { throw new Error('injected client is used in tests'); } },
    vDashboard: () => '<div class="orig-dash">DASH</div>',
    vCoach: () => '<div class="orig-coach">COACH</div>',
    vAthleteMode: () => '<div class="orig-athlete-mode">ATHLETE MODE</div>',
    vAthlete: () => '<div class="orig-athlete">PROFILE</div>',
    render: () => {},
    toast: () => {},
    document: doc,
  };
}

function makeStubClient() {
  let probes = 0;
  return {
    probes: () => probes,
    probe() { probes++; return Promise.resolve(true); },
    getPlans() { return Promise.resolve({ plans: [] }); },
    myEntitlements() { return Promise.resolve({}); },
    myRoster() { return Promise.resolve({ athletes: [] }); },
    mySubscription() { return Promise.resolve({}); },
    listAssignments() { return Promise.resolve({ assignments: [] }); },
    athleteHistory() { return Promise.resolve({}); },
    listRecruitmentContacts() { return Promise.resolve({ contacts: [] }); },
  };
}

/* Stub auth client with the same surface the UI uses. */
function stubAuthClient({ configured = true, user = null } = {}) {
  let session = user ? { access_token: 'tok', refresh_token: 'rt', expires_at: Date.now() + 3600e3, user } : null;
  return {
    isConfigured: () => configured,
    getSession: () => session,
    getAccessToken: () => (session ? session.access_token : null),
    ensureFreshSession: async () => session,
    roleForUser: (u) => Auth.roleForUser(u),
    signInWithPassword: async (email, password) => {
      if (email === 'coach@dev.invalid' && password === 'correct-password') {
        session = { access_token: 'tok', user: { id: 'auth-coach-1', email, app_metadata: { role: 'coach' } } };
        return { user: session.user, role: 'coach' };
      }
      const e = new Error('Email or password is incorrect.');
      e.code = 'INVALID_CREDENTIALS';
      throw e;
    },
    signOut: async () => { session = null; },
  };
}

function fakeClick(action, attrs = {}) {
  return {
    target: {
      closest: () => ({
        getAttribute: (name) => (name === 'data-sui' ? action : (attrs[name] ?? null)),
        textContent: '',
      }),
    },
  };
}

test('SaaS UI production, signed out: sign-in form, no View as switcher, no API calls', () => {
  const doc = makeDoc();
  const client = makeStubClient();
  const ui = UI.createSaasUI({
    root: makeRoot(doc), doc, client, dev: false, auth: stubAuthClient({ user: null }),
  });
  assert.equal(ui.install(), true);
  assert.equal(ui.state.authStatus, 'signed-out');
  assert.equal(ui.state.role, null);
  assert.equal(client.probes(), 0, 'nothing calls the API before sign-in');
  const html = ui.renderHub();
  assert.ok(html.includes('sui-auth-email'), 'sign-in form rendered');
  assert.ok(html.includes('Sign in'), 'sign-in button rendered');
  assert.ok(!html.includes('data-sui="role"'), 'no View as switcher off localhost');
  assert.ok(!html.includes('dev-director-marcus'), 'no dev identities leak into production');
});

test('SaaS UI production, signed in as coach: hub renders, sign-out present, role switch refused', async () => {
  const doc = makeDoc();
  const client = makeStubClient();
  const coach = { id: 'auth-coach-1', email: 'coach@dev.invalid', app_metadata: { role: 'coach' } };
  const ui = UI.createSaasUI({
    root: makeRoot(doc), doc, client, dev: false, auth: stubAuthClient({ user: coach }),
  });
  assert.equal(ui.install(), true);
  await tick(20);
  assert.equal(ui.state.authStatus, 'signed-in');
  assert.equal(ui.state.role.role, 'coach');
  assert.equal(client.probes(), 1, 'signed-in install probes once');
  const html = ui.renderHub();
  assert.ok(html.includes('data-sui="auth-sign-out"'), 'sign-out button present');
  assert.ok(html.includes('coach@dev.invalid'), 'signed-in email shown');
  assert.ok(!html.includes('data-sui="role"'), 'no View as switcher for a signed-in coach');
  await ui.switchRole({ role: 'director', user: 'dev-director-marcus', label: 'Director (Marcus)' });
  assert.equal(ui.state.role.role, 'coach', 'production switchRole is refused');
});

test('SaaS UI production, signed in without a mapped role: unmapped notice, no hub', () => {
  const doc = makeDoc();
  const ui = UI.createSaasUI({
    root: makeRoot(doc), doc, client: makeStubClient(), dev: false,
    auth: stubAuthClient({ user: { id: 'auth-x', email: 'x@dev.invalid', app_metadata: {} } }),
  });
  assert.equal(ui.install(), true);
  assert.equal(ui.state.authStatus, 'unmapped');
  const html = ui.renderHub();
  assert.ok(html.includes('no app role'), 'unmapped notice rendered');
  assert.ok(!html.includes('sui-auth-email'), 'no sign-in form when already signed in');
  assert.ok(!html.includes('data-sui="tab"'), 'no hub tabs without a role');
});

test('SaaS UI production, auth unconfigured: honest notice, no sign-in form', () => {
  const doc = makeDoc();
  const ui = UI.createSaasUI({
    root: makeRoot(doc), doc, client: makeStubClient(), dev: false,
    auth: stubAuthClient({ configured: false }),
  });
  assert.equal(ui.install(), true);
  assert.equal(ui.state.authStatus, 'unconfigured');
  const html = ui.renderHub();
  assert.ok(html.includes('not configured'), 'unconfigured notice rendered');
  assert.ok(!html.includes('sui-auth-email'), 'no fake sign-in form when unconfigured');
});

test('SaaS UI production sign-in flow: form submit signs in, wrong password shows the error', async () => {
  const doc = makeDoc();
  const client = makeStubClient();
  const auth = stubAuthClient({ user: null });
  const ui = UI.createSaasUI({ root: makeRoot(doc), doc, client, dev: false, auth });
  ui.install();
  doc.set('sui-auth-email', 'coach@dev.invalid');
  doc.set('sui-auth-password', 'wrong');
  ui.onClick(fakeClick('auth-sign-in'));
  await tick(20);
  assert.equal(ui.state.authStatus, 'signed-out', 'wrong password stays signed out');
  assert.ok(ui.state.error && ui.state.error.code === 'INVALID_CREDENTIALS', 'error surfaced, not swallowed');
  doc.set('sui-auth-password', 'correct-password');
  ui.onClick(fakeClick('auth-sign-in'));
  await tick(20);
  assert.equal(ui.state.authStatus, 'signed-in');
  assert.equal(ui.state.role.role, 'coach');
  ui.onClick(fakeClick('auth-sign-out'));
  await tick(20);
  assert.equal(ui.state.authStatus, 'signed-out');
  assert.equal(ui.state.role, null);
});

/* ---------------- Assessment UI production gating ---------------- */

test('Assessment UI production, signed out: quiet notice, no View as switcher, no API calls', () => {
  const doc = makeDoc();
  const root = {
    AssessmentClient: { createAssessmentClient: () => { throw new Error('injected client is used in tests'); } },
    vAssess: () => '<div class="orig-assess">ASSESS</div>',
    vAthlete: () => '<div class="orig-athlete">PROFILE</div>',
    render: () => {},
    document: doc,
  };
  const client = { probe() { throw new Error('probe must not run while signed out'); } };
  const ui = AUI.createAssessmentUI({
    root, doc, client, dev: false, auth: stubAuthClient({ user: null }),
  });
  assert.equal(ui.install(), true);
  assert.equal(ui.state.role, null);
  const html = ui.renderLiveSection();
  assert.ok(html.includes('Sign in above'), 'quiet sign-in notice rendered');
  assert.ok(!html.includes('data-aui="role"'), 'no View as switcher off localhost');
});

test('Assessment UI production, signed in as director: role applied, no switcher', async () => {
  const doc = makeDoc();
  const root = {
    AssessmentClient: { createAssessmentClient: () => { throw new Error('injected client is used in tests'); } },
    vAssess: () => '<div class="orig-assess">ASSESS</div>',
    vAthlete: () => '<div class="orig-athlete">PROFILE</div>',
    render: () => {},
    document: doc,
  };
  let probes = 0;
  const client = {
    probe() { probes++; return Promise.resolve(true); },
    battery() { return Promise.resolve({ tests: [] }); },
    listAthletes() { return Promise.resolve([]); },
    coachDashboard() { return Promise.resolve({}); },
  };
  const director = { id: 'auth-dir-1', email: 'director@dev.invalid', app_metadata: { role: 'director' } };
  const ui = AUI.createAssessmentUI({
    root, doc, client, dev: false, auth: stubAuthClient({ user: director }),
  });
  assert.equal(ui.install(), true);
  await tick(20);
  assert.equal(ui.state.role.role, 'director');
  assert.equal(probes, 1);
  const html = ui.renderLiveSection();
  assert.ok(!html.includes('data-aui="role"'), 'no View as switcher for a signed-in director');
});
