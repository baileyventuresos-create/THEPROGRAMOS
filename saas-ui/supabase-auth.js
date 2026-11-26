/* THE PROGRAM OS — production Supabase Auth sign-in (browser client)
 * saas-ui/supabase-auth.js
 *
 * The app's production identity: Supabase Auth (GoTrue) email/password
 * sign-in against the live TheProgramOS project, replacing the dev
 * "View as" switcher on production paths. The dev switcher stays for
 * localhost dev only (see isLocalDevHost + the index.html loader).
 *
 * No dependency on @supabase/supabase-js: the app has no build step,
 * so this module talks to the GoTrue REST API directly with fetch.
 * The Supabase anon key is a PUBLIC/publishable key by Supabase
 * design, but it is still config, never hardcoded here: it comes from
 * window.THE_PROGRAM_SUPABASE_URL / window.THE_PROGRAM_SUPABASE_ANON_KEY
 * (saas-ui/supabase-config.js, gitignored — see
 * saas-ui/supabase-config.example.js) or from options. Without those
 * values the client reports unconfigured and the UI says so plainly
 * instead of pretending sign-in works.
 *
 * Role mapping: the SERVER is authoritative — the Edge Function reads
 * app_users.role WHERE auth_user_id = auth.uid() (see
 * supabase/functions/assessment-api/directory.ts). roleForUser() below
 * is a DISPLAY hint only, read from the Auth user's app_metadata.role
 * (falling back to user_metadata.role): it decides which hub the UI
 * shows, never what the server allows. A signed-in user with no
 * mapped role sees "no app role linked — ask the director" and can
 * call nothing role-gated, because the server derives the role from
 * the database on every request.
 *
 * Sessions persist in localStorage under SESSION_STORAGE_KEY (access
 * token + refresh token + user). Tokens are never logged. getToken()
 * is synchronous for the API clients: it returns the stored access
 * token while unexpired, else null; call ensureFreshSession() to
 * refresh proactively (boot does this).
 *
 * UMD like saas-client.js: require() in Node tests, global
 * window.SupabaseAuth in the browser. No dependencies.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SupabaseAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var APP_ROLES = ['director', 'coach', 'athlete', 'parent'];
  var SESSION_STORAGE_KEY = 'the-program-os.supabase.session.v1';
  var TOKEN_SKEW_MS = 60 * 1000;

  function isLocalDevHost(hostname) {
    var h = String(hostname || '').toLowerCase();
    return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  }

  function roleForUser(user) {
    if (!user) return null;
    var meta = user.app_metadata || {};
    var umeta = user.user_metadata || {};
    var role = meta.role || umeta.role || null;
    return APP_ROLES.indexOf(role) >= 0 ? role : null;
  }

  function decodeJwtPayload(token) {
    try {
      var parts = String(token || '').split('.');
      if (parts.length !== 3) return null;
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var json = typeof atob === 'function'
        ? atob(b64)
        : Buffer.from(b64, 'base64').toString('utf8');
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  function memoryStorage() {
    var store = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; },
    };
  }

  function createSupabaseAuth(options) {
    options = options || {};
    var url = options.url
      || (typeof window !== 'undefined' && window.THE_PROGRAM_SUPABASE_URL)
      || (typeof globalThis !== 'undefined' && globalThis.THE_PROGRAM_SUPABASE_URL)
      || null;
    var anonKey = options.anonKey
      || (typeof window !== 'undefined' && window.THE_PROGRAM_SUPABASE_ANON_KEY)
      || (typeof globalThis !== 'undefined' && globalThis.THE_PROGRAM_SUPABASE_ANON_KEY)
      || null;
    url = url ? String(url).replace(/\/+$/, '') : null;
    anonKey = anonKey ? String(anonKey) : null;
    var fetchImpl = options.fetchImpl
      || (typeof fetch !== 'undefined' ? fetch.bind(typeof globalThis !== 'undefined' ? globalThis : this) : null);
    var storage = options.storage || null;
    if (!storage) {
      try {
        storage = (typeof localStorage !== 'undefined') ? localStorage : memoryStorage();
      } catch (e) { storage = memoryStorage(); }
    }
    var listeners = [];

    function isConfigured() { return !!(url && anonKey); }

    function notify(event, session) {
      listeners.slice().forEach(function (fn) {
        try { fn(event, session || null); } catch (e) { /* listener errors never break auth */ }
      });
    }

    function onAuthStateChange(fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }

    function loadSession() {
      try {
        var raw = storage.getItem(SESSION_STORAGE_KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!s || !s.access_token || !s.user) return null;
        return s;
      } catch (e) { return null; }
    }

    function saveSession(session) {
      try {
        if (!session) storage.removeItem(SESSION_STORAGE_KEY);
        else storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      } catch (e) { /* storage unavailable — session lives in memory only */ }
    }

    function sessionFromTokenResponse(body) {
      return {
        access_token: body.access_token,
        refresh_token: body.refresh_token || null,
        expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
        token_type: body.token_type || 'bearer',
        user: body.user || null,
      };
    }

    function tokenError(code, message) {
      var e = new Error(message || code);
      e.code = code;
      return e;
    }

    async function authRequest(path, body) {
      if (!isConfigured()) throw tokenError('AUTH_NOT_CONFIGURED',
        'Supabase Auth is not configured: set THE_PROGRAM_SUPABASE_URL and THE_PROGRAM_SUPABASE_ANON_KEY (see saas-ui/supabase-config.example.js).');
      if (!fetchImpl) throw tokenError('AUTH_NO_FETCH', 'Supabase Auth needs fetch (pass fetchImpl in Node <18).');
      var res = await fetchImpl(url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: 'Bearer ' + anonKey },
        body: JSON.stringify(body || {}),
      });
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        var code = (data && (data.error_code || data.error)) || 'AUTH_FAILED';
        var msg = (data && (data.msg || data.message || data.error_description)) || ('Sign-in failed (HTTP ' + res.status + ').');
        if (code === 'invalid_grant' || /invalid login/i.test(String(msg))) {
          throw tokenError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
        }
        throw tokenError(String(code).toUpperCase().replace(/[^A-Z0-9_]/g, '_'), String(msg));
      }
      return data;
    }

    function getSession() { return loadSession(); }

    function getUser() {
      var s = loadSession();
      return s ? s.user : null;
    }

    function getAccessToken() {
      var s = loadSession();
      if (!s || !s.access_token) return null;
      if (s.expires_at && Date.now() > s.expires_at - TOKEN_SKEW_MS) return null;
      return s.access_token;
    }

    async function ensureFreshSession() {
      var s = loadSession();
      if (!s) return null;
      if (s.expires_at && Date.now() <= s.expires_at - TOKEN_SKEW_MS) return s;
      if (!s.refresh_token) return null;
      try {
        var body = await authRequest('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
        var next = sessionFromTokenResponse(body);
        if (!next.access_token) return null;
        saveSession(next);
        notify('TOKEN_REFRESHED', next);
        return next;
      } catch (e) {
        return null;
      }
    }

    async function signInWithPassword(email, password) {
      if (!email || !password) throw tokenError('INVALID_INPUT', 'Email and password are required.');
      var body = await authRequest('/auth/v1/token?grant_type=password', { email: email, password: password });
      if (!body.access_token || !body.user) throw tokenError('AUTH_FAILED', 'Sign-in did not return a session.');
      var session = sessionFromTokenResponse(body);
      saveSession(session);
      notify('SIGNED_IN', session);
      return { user: session.user, role: roleForUser(session.user) };
    }

    async function signOut() {
      var s = loadSession();
      if (s && s.access_token && fetchImpl) {
        try {
          await fetchImpl(url + '/auth/v1/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: 'Bearer ' + s.access_token },
            body: JSON.stringify({}),
          });
        } catch (e) { /* logout is best-effort; local session is cleared regardless */ }
      }
      saveSession(null);
      notify('SIGNED_OUT', null);
    }

    return {
      isConfigured: isConfigured,
      url: url,
      onAuthStateChange: onAuthStateChange,
      getSession: getSession,
      getUser: getUser,
      getAccessToken: getAccessToken,
      ensureFreshSession: ensureFreshSession,
      signInWithPassword: signInWithPassword,
      signOut: signOut,
      roleForUser: roleForUser,
    };
  }

  return {
    createSupabaseAuth: createSupabaseAuth,
    roleForUser: roleForUser,
    isLocalDevHost: isLocalDevHost,
    decodeJwtPayload: decodeJwtPayload,
    APP_ROLES: APP_ROLES,
    SESSION_STORAGE_KEY: SESSION_STORAGE_KEY,
  };
});
