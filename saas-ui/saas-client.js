/* THE PROGRAM OS — SaaS API transport adapter (browser client)
 * saas-ui/saas-client.js
 *
 * The SINGLE transport the SaaS UI uses to talk to the SaaS backend
 * (docs/SAAS_API.md). The browser never re-implements business logic:
 * every call below is one method of the API contract
 * ({ method, params } -> { ok:true, data } | { ok:false, error }),
 * implemented once in server/saas-api.js (+ server/billing.js for
 * billing, fake adapter / test-mode shape only).
 *
 * Endpoints (configurable, no logic duplicated here):
 *   - Development default: same-origin '/api/saas' + '/api/billing'
 *     + GET '/api/saas/plans', served by server/dev-server.js with
 *     dev-role headers (X-Dev-Role / X-Dev-User / X-Dev-Athlete).
 *   - Deployed: the Edge Function URL, passed as `endpoint` (or set
 *     window.SAAS_API_URL before boot). The client never sends
 *     actor/role as params: auth context is derived server-side
 *     from the JWT (via `getToken`, when one exists).
 *
 * Errors: application errors ({ ok:false }) are thrown as Error
 * objects with `.code` (and `.coveringSource` when present) so the
 * UI branches on `error.code`, never on the message. Network
 * failures and HTTP 5xx are retried (default 1 retry); application
 * errors and HTTP 4xx are never retried.
 *
 * UMD like assessment-client.js: require() in Node tests, global
 * window.SaasClient in the browser. No dependencies.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SaasClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SAAS_METHODS = [
    'registerAthlete', 'registerCoach', 'createOrganization',
    'inviteToOrg', 'inviteAthlete', 'acceptInvitation',
    'linkAthlete', 'unlinkAthlete', 'myRoster',
    'createAssignment', 'listAssignments', 'completeAssignment',
    'athleteHistory', 'myEntitlements', 'mySubscription',
    'cancelSubscription', 'expireSubscription', 'listPlans',
    'sponsorAthlete', 'endSponsorship',
    'grantConsent', 'withdrawConsent', 'orgOverview',
    // Athlete Pathways V1 (2026-11-26): owner management (G1/G2),
    // prospect profiles + sharing (G3), recruitment CRM (G4),
    // media links (G5), sport/goals/evaluations (G6). Same
    // { method, params } dispatch as every method above.
    // getPublicProfile is NOT here: it is unauthenticated and
    // token-only, served by GET /api/public/profile (see below).
    'ownerCreateAthlete', 'ownerListAthletes',
    'grantComplimentary', 'revokeComplimentary',
    'suspendAthlete', 'reactivateAthlete', 'updateAthleteRole',
    'ownerInviteAthlete', 'listAudit',
    'createProspectProfile', 'updateProspectProfile',
    'approveProspectProfile', 'getProspectProfile',
    'listProfileShares', 'createProfileShare', 'revokeProfileShare',
    'createRecruitmentContact', 'updateRecruitmentContact',
    'listRecruitmentContacts', 'createOpportunity',
    'addRecruitmentNote', 'referAthlete', 'updateReferralStatus',
    'addMediaLink', 'removeMediaLink', 'listMediaLinks',
    'assignSport', 'setDevelopmentGoals', 'updateDevelopmentGoal',
    'listDevelopmentGoals', 'recordScoutingEvaluation',
    'listScoutingEvaluations',
  ];

  var BILLING_METHODS = [
    'createCheckoutSession', 'confirmCheckout',
    'createPortalSession', 'handleProviderEvent',
  ];

  function makeError(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra && extra.coveringSource) e.coveringSource = extra.coveringSource;
    return e;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function createSaasClient(options) {
    options = options || {};
    var endpoint = options.endpoint || '/api/saas';
    var billingEndpoint = options.billingEndpoint
      || endpoint.replace(/\/saas\/?$/, '/billing');
    var plansEndpoint = options.plansEndpoint
      || endpoint.replace(/\/?$/, '') + '/plans';
    /* Public prospect-profile read (Pathways V1, G3): unauthenticated,
     * token-only GET. The dev server hosts it at
     * /api/public/profile?token=...; no dev-role headers, no JWT —
     * the share token is the only credential, and the server returns
     * only the approved public fields (never contact info). */
    var publicEndpoint = options.publicEndpoint
      || endpoint.replace(/\/saas\/?$/, '/public/profile');
    var fetchImpl = options.fetchImpl
      || (typeof fetch !== 'undefined' ? fetch.bind(typeof globalThis !== 'undefined' ? globalThis : this) : null);
    if (!fetchImpl) throw new Error('createSaasClient requires fetch (pass fetchImpl in Node <18).');
    var getToken = typeof options.getToken === 'function' ? options.getToken : null;
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
    function post(url, body) {
      var controller = null;
      var signal = null;
      var timer = null;
      if (typeof AbortController !== 'undefined' && timeoutMs > 0) {
        controller = new AbortController();
        signal = controller.signal;
        timer = setTimeout(function () { controller.abort(); }, timeoutMs);
      }
      function done() { if (timer) clearTimeout(timer); }
      var init = { method: 'POST', headers: headers(), body: JSON.stringify(body) };
      if (signal) init.signal = signal;
      var p = Promise.resolve()
        .then(function () { return fetchImpl(url, init); })
        .catch(function (err) {
          done();
          if (err && err.name === 'AbortError') throw makeError('TIMEOUT', 'SaaS request timed out after ' + timeoutMs + 'ms.');
          throw makeError('NETWORK_ERROR', 'Could not reach the SaaS service (' + (err && err.message ? err.message : 'network error') + ').');
        });
      return p.then(function (res) {
        done();
        if (!res || typeof res.status !== 'number') throw makeError('INVALID_RESPONSE', 'SaaS service returned an unreadable response.');
        if (res.status >= 500) throw makeError('HTTP_' + res.status, 'SaaS service returned HTTP ' + res.status + '.');
        return Promise.resolve()
          .then(function () { return res.json(); })
          .catch(function () { throw makeError('INVALID_RESPONSE', 'SaaS service returned HTTP ' + res.status + ' with an unreadable body.'); })
          .then(function (payload) {
            if (res.status >= 400) {
              var e1 = (payload && payload.error) || {};
              throw makeError(e1.code || ('HTTP_' + res.status), e1.message || ('SaaS service returned HTTP ' + res.status + '.'), e1);
            }
            if (!payload || payload.ok !== true) {
              var e2 = (payload && payload.error) || {};
              throw makeError(e2.code || 'INVALID_RESPONSE', e2.message || 'SaaS service returned an unexpected response.', e2);
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

    function callOn(url, allowed, method, params, opts) {
      if (allowed.indexOf(method) < 0) {
        return Promise.reject(makeError('INVALID_METHOD', 'Unknown method: ' + method));
      }
      opts = opts || {};
      var retries = opts.retries != null ? opts.retries : 1;
      var paramsOut = params ? JSON.parse(JSON.stringify(params)) : {};
      var attempt = 0;
      function attemptOnce() {
        return post(url, { method: method, params: paramsOut }).catch(function (err) {
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

    function call(method, params, opts) {
      return callOn(endpoint, SAAS_METHODS, method, params, opts);
    }

    function billing(method, params, opts) {
      return callOn(billingEndpoint, BILLING_METHODS, method, params, opts);
    }

    /* Plan catalogue via the read-only GET route (also available as
     * the listPlans method). Returns { plans }. */
    function getPlans() {
      var init = { method: 'GET', headers: headers() };
      return Promise.resolve()
        .then(function () { return fetchImpl(plansEndpoint, init); })
        .catch(function (err) {
          throw makeError('NETWORK_ERROR', 'Could not reach the SaaS service (' + (err && err.message ? err.message : 'network error') + ').');
        })
        .then(function (res) {
          if (!res || typeof res.status !== 'number') throw makeError('INVALID_RESPONSE', 'SaaS service returned an unreadable response.');
          return Promise.resolve()
            .then(function () { return res.json(); })
            .catch(function () { throw makeError('INVALID_RESPONSE', 'SaaS service returned HTTP ' + res.status + ' with an unreadable body.'); })
            .then(function (payload) {
              if (res.status >= 400 || !payload || payload.ok !== true) {
                var e = (payload && payload.error) || {};
                throw makeError(e.code || ('HTTP_' + res.status), e.message || ('SaaS service returned HTTP ' + res.status + '.'), e);
              }
              return payload.data;
            });
        });
    }

    /* Cheap connectivity check: true when the service answers with
     * the plan catalogue, false otherwise. Never throws. */
    function probe() {
      return getPlans().then(function () { return true; }).catch(function () { return false; });
    }

    /* Unauthenticated public profile read by share token. Returns
     * { profile } (public fields only) or throws with the server's
     * code (PROFILE_SHARE_INVALID / PROFILE_NOT_APPROVED /
     * INVALID_INPUT). Never retries: a refused token is a final
     * answer, and the refusal carries no athlete data. */
    function getPublicProfile(token) {
      if (!token) return Promise.reject(makeError('INVALID_INPUT', 'getPublicProfile requires a share token.'));
      var url = publicEndpoint + '?token=' + encodeURIComponent(String(token));
      return Promise.resolve()
        .then(function () { return fetchImpl(url, { method: 'GET', headers: {} }); })
        .catch(function (err) {
          throw makeError('NETWORK_ERROR', 'Could not reach the SaaS service (' + (err && err.message ? err.message : 'network error') + ').');
        })
        .then(function (res) {
          if (!res || typeof res.status !== 'number') throw makeError('INVALID_RESPONSE', 'SaaS service returned an unreadable response.');
          return Promise.resolve()
            .then(function () { return res.json(); })
            .catch(function () { throw makeError('INVALID_RESPONSE', 'SaaS service returned HTTP ' + res.status + ' with an unreadable body.'); })
            .then(function (payload) {
              if (res.status >= 400 || !payload || payload.ok !== true) {
                var e = (payload && payload.error) || {};
                throw makeError(e.code || ('HTTP_' + res.status), e.message || ('SaaS service returned HTTP ' + res.status + '.'), e);
              }
              return payload.data;
            });
        });
    }

    var client = {
      endpoint: endpoint, billingEndpoint: billingEndpoint, plansEndpoint: plansEndpoint,
      publicEndpoint: publicEndpoint,
      call: call, billing: billing, getPlans: getPlans, probe: probe,
      getPublicProfile: getPublicProfile,
      methods: SAAS_METHODS.slice(), billingMethods: BILLING_METHODS.slice(),
    };
    for (var i = 0; i < SAAS_METHODS.length; i++) {
      (function (method) {
        client[method] = function (params, opts) { return call(method, params, opts); };
      })(SAAS_METHODS[i]);
    }
    for (var j = 0; j < BILLING_METHODS.length; j++) {
      (function (method) {
        client[method] = function (params, opts) { return billing(method, params, opts); };
      })(BILLING_METHODS[j]);
    }
    return client;
  }

  return { createSaasClient: createSaasClient, METHODS: SAAS_METHODS.slice(), BILLING_METHODS: BILLING_METHODS.slice() };
});
