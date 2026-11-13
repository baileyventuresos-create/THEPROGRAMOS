/* THE PROGRAM OS — Assessment API transport adapter (browser client)
 * assessment-ui/assessment-client.js
 *
 * The SINGLE transport the prototype UI uses to talk to the assessment
 * workflow API. The browser never re-implements workflow or business
 * logic: every call below is one method of the API contract
 * ({ method, params } -> { ok:true, data } | { ok:false, error }),
 * implemented once in server/assessment-api.js and ported once in
 * supabase/functions/assessment-api/api.ts.
 *
 * Endpoint (configurable, no logic duplicated here):
 *   - Development default: same-origin '/api/assessments', served by
 *     the dev-only server/server/dev-server.js (POST dispatch + a
 *     read-only GET .../battery route for protocol text).
 *   - Deployed: the Edge Function URL, passed as `endpoint` (or set
 *     window.ASSESSMENT_API_URL before boot). The client never sends
 *     actor/role: auth context is derived server-side from the JWT
 *     (via `getToken`, when one exists); in dev there is no token and
 *     the dev server injects a dev-only auth context.
 *
 * Retries: network failures and HTTP 5xx are retried (default 2
 * retries). recordAttempts / completeAssessment generate ONE
 * idempotency key per logical call and reuse it across retries, so a
 * retried completion can never record twice. Application errors
 * (ok:false) and HTTP 4xx are never retried.
 *
 * UMD like assessment-engine.js: require() in Node tests, global
 * window.AssessmentClient in the browser. No dependencies.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AssessmentClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var METHODS = [
    'listAthletes', 'startAssessment', 'recordAttempts', 'getDraft',
    'discardDraft', 'completeAssessment', 'athleteAssessmentView',
    'coachDashboard', 'recordDeferral', 'planReadiness', 'createPlan',
    'finalizePlan', 'advisoryPriorities',
  ];
  /* Methods whose server side is idempotent on a key: the client
   * generates one key per logical call and reuses it on retry. */
  var IDEMPOTENT_METHODS = ['recordAttempts', 'completeAssessment'];

  function makeError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  function defaultGenerateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'key_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function createAssessmentClient(options) {
    options = options || {};
    var endpoint = options.endpoint || '/api/assessments';
    var fetchImpl = options.fetchImpl
      || (typeof fetch !== 'undefined' ? fetch.bind(typeof globalThis !== 'undefined' ? globalThis : this) : null);
    if (!fetchImpl) throw new Error('createAssessmentClient requires fetch (pass fetchImpl in Node <18).');
    var getToken = typeof options.getToken === 'function' ? options.getToken : null;
    var generateId = typeof options.generateId === 'function' ? options.generateId : defaultGenerateId;
    var timeoutMs = options.timeoutMs != null ? options.timeoutMs : 15000;
    var retryDelayMs = options.retryDelayMs != null ? options.retryDelayMs : 250;

    function headers() {
      var h = { 'Content-Type': 'application/json' };
      if (getToken) {
        var token = getToken();
        if (token) h.Authorization = 'Bearer ' + token;
      }
      if (options.devRole) h['X-Dev-Role'] = options.devRole;
      if (options.devUser) h['X-Dev-User'] = options.devUser;
      if (options.devAthleteId) h['X-Dev-Athlete'] = options.devAthleteId;
      return h;
    }

    /* One POST. Throws on transport failure or on { ok:false }.
     * Returns data on { ok:true, data }. */
    function post(body, attemptSignal) {
      var controller = null;
      var signal = attemptSignal || null;
      var timer = null;
      if (!signal && typeof AbortController !== 'undefined' && timeoutMs > 0) {
        controller = new AbortController();
        signal = controller.signal;
        timer = setTimeout(function () { controller.abort(); }, timeoutMs);
      }
      function done() { if (timer) clearTimeout(timer); }
      var init = { method: 'POST', headers: headers(), body: JSON.stringify(body) };
      if (signal) init.signal = signal;
      var p = Promise.resolve()
        .then(function () { return fetchImpl(endpoint, init); })
        .catch(function (err) {
          done();
          if (err && err.name === 'AbortError') throw makeError('TIMEOUT', 'Assessment request timed out after ' + timeoutMs + 'ms.');
          throw makeError('NETWORK_ERROR', 'Could not reach the assessment service (' + (err && err.message ? err.message : 'network error') + ').');
        });
      return p.then(function (res) {
        done();
        if (!res || typeof res.status !== 'number') throw makeError('INVALID_RESPONSE', 'Assessment service returned an unreadable response.');
        if (res.status >= 500) throw makeError('HTTP_' + res.status, 'Assessment service returned HTTP ' + res.status + '.');
        return Promise.resolve()
          .then(function () { return res.json(); })
          .catch(function () { throw makeError('INVALID_RESPONSE', 'Assessment service returned HTTP ' + res.status + ' with an unreadable body.'); })
          .then(function (payload) {
            if (res.status >= 400) {
              var code = (payload && payload.error && payload.error.code) || ('HTTP_' + res.status);
              var msg = (payload && payload.error && payload.error.message) || ('Assessment service returned HTTP ' + res.status + '.');
              throw makeError(code, msg);
            }
            if (!payload || payload.ok !== true) {
              var e2 = (payload && payload.error) || {};
              throw makeError(e2.code || 'INVALID_RESPONSE', e2.message || 'Assessment service returned an unexpected response.');
            }
            return payload.data;
          });
      });
    }

    function isRetryable(err) {
      if (!err || !err.code) return false;
      if (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT') return true;
      return /^HTTP_5/.test(err.code);
    }

    /* Call one API method. opts: { retries, idempotencyKey }.
     * Idempotency keys are generated once per logical call for the
     * idempotent methods and reused across retries. */
    function call(method, params, opts) {
      if (METHODS.indexOf(method) < 0) return Promise.reject(makeError('INVALID_METHOD', 'Unknown assessment method: ' + method));
      opts = opts || {};
      var retries = opts.retries != null ? opts.retries : 2;
      var paramsOut = params ? JSON.parse(JSON.stringify(params)) : {};
      if (IDEMPOTENT_METHODS.indexOf(method) >= 0) {
        paramsOut.idempotencyKey = opts.idempotencyKey || generateId();
      }
      var attempt = 0;
      function attemptOnce() {
        return post({ method: method, params: paramsOut }).catch(function (err) {
          if (attempt < retries && isRetryable(err)) {
            attempt++;
            var delay = retryDelayMs > 0 ? sleep(retryDelayMs * attempt) : Promise.resolve();
            return delay.then(attemptOnce);
          }
          throw err;
        });
      }
      return attemptOnce();
    }

    /* Read-only protocol text for the run-assessment forms. Served by
     * the dev server from the real server/assessment-battery.js (no
     * duplication). The deployed Edge Function needs the same
     * read-only route before production use (see
     * docs/ASSESSMENT_UI_INTEGRATION.md); until then the UI falls
     * back to the prototype's draft test cards. */
    function getBattery() {
      var init = { method: 'GET', headers: headers() };
      return Promise.resolve()
        .then(function () { return fetchImpl(endpoint.replace(/\/$/, '') + '/battery', init); })
        .catch(function (err) {
          throw makeError('NETWORK_ERROR', 'Could not reach the assessment service (' + (err && err.message ? err.message : 'network error') + ').');
        })
        .then(function (res) {
          if (!res || res.status !== 200) throw makeError('HTTP_' + (res && res.status), 'Protocol data unavailable (HTTP ' + (res && res.status) + ').');
          return res.json();
        })
        .then(function (payload) {
          if (!payload || !Array.isArray(payload.tests)) throw makeError('INVALID_RESPONSE', 'Protocol data was unreadable.');
          return payload;
        });
    }

    /* Cheap connectivity check: true when the service answers with a
     * roster, false otherwise. Never throws. */
    function probe() {
      return call('listAthletes', {}, { retries: 0 })
        .then(function () { return true; })
        .catch(function () { return false; });
    }

    var client = { endpoint: endpoint, call: call, getBattery: getBattery, probe: probe, methods: METHODS.slice() };
    for (var i = 0; i < METHODS.length; i++) {
      (function (method) {
        client[method] = function (params, opts) { return call(method, params, opts); };
      })(METHODS[i]);
    }
    return client;
  }

  return { createAssessmentClient: createAssessmentClient, METHODS: METHODS.slice() };
});
