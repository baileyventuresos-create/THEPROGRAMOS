/* THE PROGRAM OS — SaaS UI wiring (frontend slice, 2026-11-20)
 * saas-ui/saas-ui.js
 *
 * User-facing SaaS experiences on top of the tested backend slice
 * (docs/SAAS_API.md): public plan catalogue, athlete registration +
 * dashboard + assignments + history, coach registration + roster +
 * assignment composer + progress monitoring, organization admin,
 * and test-mode billing. The browser never re-implements business
 * logic: every call is one method of the API contract through
 * saas-ui/saas-client.js, every access state shown comes from the
 * API (entitlements are computed server-side, never faked
 * client-side), and every failure branches on `error.code`.
 *
 * How it loads (same pattern as assessment-ui/):
 *   index.html injects saas-client.js + this file before boot().
 *   install() wraps window.vDashboard (SaaS hub prepended),
 *   window.vCoach (coach panels prepended), window.vAthleteMode
 *   (athlete panels prepended) and window.vAthlete (SaaS section
 *   appended to the profile). THE PROGRAM OS.html is never edited
 *   by this module; the in-person operation, cohort tools and the
 *   assessment UI are untouched.
 *
 * Honesty rules enforced in the copy below:
 *   - Billing is TEST MODE only (fake adapter). Every billing
 *     surface is labelled as such; nothing is presented as live
 *     billing and no real charge can happen.
 *   - GAA results are coach-recorded measurements from an
 *     unvalidated battery — no norms, percentiles or rankings.
 *   - Assignments are coach-authored, always. No assessment score
 *     ever creates one; Smart Draft stays advisory-only.
 *   - Free-tier history shows the 90-day display window with
 *     `truncated` — rows are retained, never deleted.
 *   - Sponsored athletes and $149 in-person members are never
 *     charged again: checkout returns ALREADY_COVERED and the UI
 *     says so instead of offering a purchase.
 *
 * Dev vs deployed: by default the client talks to same-origin
 * /api/saas + /api/billing with dev-role headers (the dev server,
 * server/dev-server.js). Pass { endpoint, getToken } at install
 * for the deployed Edge Function; the "View as" switcher is
 * dev-only and is hidden whenever no devRole is configured.
 *
 * UMD like assessment-ui.js: require() in Node tests, global
 * window.SaasUI in the browser. No dependencies.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SaasUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Pure helpers (no DOM, no network — unit-tested)                    */
  /* ------------------------------------------------------------------ */

  function escLocal(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }

  function fmtMoney(cents) {
    if (cents == null) return '—';
    const n = Number(cents);
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '$0';
    const dollars = n / 100;
    return '$' + (Number.isInteger(dollars) ? dollars.toFixed(0) : dollars.toFixed(2));
  }

  /* Athlete entitlement tier -> honest display label. The API's
   * precedence is member > sponsored > paid > free; the UI never
   * upgrades a tier on its own. */
  var TIER_LABELS = {
    member: { text: 'In-person member — $149 membership', cls: 'ok', note: 'Full remote access included with your in-person membership. You are never charged again for remote access.' },
    sponsored: { text: 'Sponsored by your coach / organization', cls: 'ok', note: 'Your coach or organization covers your paid access. You are never charged while the sponsorship is active.' },
    paid: { text: 'Athlete Remote subscription', cls: 'ok', note: 'Full history display and unlimited coach links.' },
    free: { text: 'Athlete Free', cls: 'assume', note: '1 training day per week, 90-day history display window (your full record is retained), 1 coach link.' },
  };

  function tierLabel(ent) {
    if (!ent) return { text: 'Unknown', cls: 'assume', note: '' };
    return TIER_LABELS[ent.tier] || { text: String(ent.tier || 'Unknown'), cls: 'v1', note: '' };
  }

  /* Stable error code -> coach/athlete-readable message. The server
   * message is kept as detail; branching is always on the code. */
  var ERROR_MESSAGES = {
    UNAUTHENTICATED: 'You need to sign in first.',
    FORBIDDEN: 'That is outside your scope — coaches see only their linked athletes, athletes see only themselves.',
    ATHLETE_NOT_FOUND: 'Athlete not found (or not in your scope — existence never leaks across tenants).',
    INVALID_INPUT: 'Some required information is missing or invalid.',
    INVALID_METHOD: 'Unknown request.',
    ACCOUNT_EXISTS: 'An account already exists for this sign-in with a different role.',
    INVITATION_INVALID: 'That invitation is invalid, already used, or expired. Invitations are single-use and last 7 days.',
    ENTITLEMENT_LIMIT: 'A plan limit has been reached (roster size, coach links, or organization coaches).',
    SUBSCRIPTION_INACTIVE: 'The coach/organization subscription is inactive — the roster is read-only until it is reactivated. Nothing is deleted.',
    CONSENT_REQUIRED: 'Guardian consent is required before remote features activate for a minor athlete.',
    ALREADY_COVERED: 'Already covered — no purchase needed and no double charge.',
    INVALID_GAME_ID: 'That game ID is not in the library (valid IDs are TP2-001 to TP2-130).',
    GAME_NOT_ASSIGNABLE: 'That game is Safety Review / Retired and must not be assigned.',
    ALREADY_COMPLETED: 'That assignment already has a completion recorded.',
    BILLING_LIVE_MODE_REFUSED: 'Live billing is refused by construction in this environment.',
    BILLING_NOT_CONFIGURED: 'Billing is not connected in this environment.',
  };

  function errorText(error) {
    if (!error) return '';
    const friendly = ERROR_MESSAGES[error.code] || 'Something went wrong.';
    const detail = error.message && error.message !== friendly ? ' (' + error.message + ')' : '';
    return friendly + detail;
  }

  /* Plan limits -> short feature lines for the pricing cards. Pure
   * presentation of the seeded catalogue data (listPlans). */
  function planFeatures(plan) {
    const l = (plan && plan.limits) || {};
    const out = [];
    if (plan.audience === 'athlete') {
      out.push(l.trainingDaysPerWeek == null ? 'Unlimited training days' : l.trainingDaysPerWeek + ' training day' + (l.trainingDaysPerWeek === 1 ? '' : 's') + ' per week');
      out.push(l.historyDays == null ? 'Full history display' : l.historyDays + '-day history display window');
      out.push(l.maxCoachLinks == null ? 'Unlimited coach links' : l.maxCoachLinks + ' coach link' + (l.maxCoachLinks === 1 ? '' : 's'));
      out.push('Assessment results + progress (coach-recorded measurements)');
    } else {
      out.push(l.maxCoaches == null ? 'Unlimited coaches' : l.maxCoaches + ' coach' + (l.maxCoaches === 1 ? '' : 's'));
      out.push(l.maxAthletes == null ? 'Unlimited athletes' : 'Up to ' + l.maxAthletes + ' athletes');
      if (l.overagePerAthleteCents) out.push('Overage ' + fmtMoney(l.overagePerAthleteCents) + ' per athlete / month (confirmed, never silent)');
      out.push('GAA assessment battery + 28-day reassessment cycle included');
      out.push('Training assignment from the 130-game library');
      out.push('Athlete progress monitoring');
    }
    if (l.trialDays) out.push(l.trialDays + '-day free trial');
    return out;
  }

  function planPrice(plan, interval) {
    const l = (plan && plan.limits) || {};
    const cents = interval === 'year' ? l.priceAnnualCents : l.priceMonthlyCents;
    if (!cents) return '$0';
    return fmtMoney(cents) + (interval === 'year' ? ' / year' : ' / month');
  }

  /* Assignment form -> API params. form: { athleteId, title,
   * instructions, gameIds[], build, dose:{rounds,workSec,restSec,
   * distance,reps,note}, dueAt }. Empty dose fields are dropped;
   * game IDs are trimmed/uppercased/deduped. The server validates
   * IDs and assignability — this only shapes the payload. */
  function buildAssignmentParams(form) {
    const dose = {};
    const src = (form && form.dose) || {};
    for (const k of ['rounds', 'workSec', 'restSec', 'reps']) {
      const n = Number(src[k]);
      if (src[k] !== '' && src[k] != null && Number.isFinite(n)) dose[k] = n;
    }
    if (src.distance) dose.distance = String(src.distance).trim();
    if (src.note) dose.note = String(src.note).trim();
    const seen = new Set();
    const gameIds = [];
    for (const g of (form && form.gameIds) || []) {
      const id = String(g || '').trim().toUpperCase();
      if (id && !seen.has(id)) { seen.add(id); gameIds.push(id); }
    }
    const params = {
      athleteId: form.athleteId,
      title: String(form.title || '').trim(),
      gameIds: gameIds,
    };
    if (form.instructions && String(form.instructions).trim()) params.instructions = String(form.instructions).trim();
    if (form.build) params.build = form.build;
    if (Object.keys(dose).length) params.dose = dose;
    if (form.dueAt) params.dueAt = form.dueAt;
    return params;
  }

  function validateAssignmentForm(form) {
    const problems = [];
    if (!form || !form.athleteId) problems.push('Choose an athlete.');
    if (!form || !String(form.title || '').trim()) problems.push('Give the assignment a title.');
    const dose = (form && form.dose) || {};
    for (const k of ['rounds', 'workSec', 'restSec', 'reps']) {
      if (dose[k] !== '' && dose[k] != null && !Number.isFinite(Number(dose[k]))) {
        problems.push('Dose field "' + k + '" must be a number.');
      }
    }
    if (form && form.build && ['LEARN', 'COMPETE', 'PRESSURE', 'CHAOS'].indexOf(form.build) < 0) {
      problems.push('Build must be LEARN, COMPETE, PRESSURE or CHAOS.');
    }
    return problems;
  }

  /* Completion form -> API params. RPE must be an integer 1-10
   * when given (server enforces too). */
  function buildCompletionParams(form) {
    const params = { assignmentId: form.assignmentId };
    if (form.durationMin !== '' && form.durationMin != null && Number.isFinite(Number(form.durationMin))) {
      params.durationMin = Number(form.durationMin);
    }
    if (form.effortRpe !== '' && form.effortRpe != null && Number.isFinite(Number(form.effortRpe))) {
      params.effortRpe = Number(form.effortRpe);
    }
    if (form.athleteNote && String(form.athleteNote).trim()) params.athleteNote = String(form.athleteNote).trim();
    return params;
  }

  function validateCompletionForm(form) {
    const problems = [];
    if (!form || !form.assignmentId) problems.push('No assignment selected.');
    if (form && form.effortRpe !== '' && form.effortRpe != null) {
      const r = Number(form.effortRpe);
      if (!Number.isInteger(r) || r < 1 || r > 10) problems.push('Effort (RPE) must be a whole number from 1 to 10.');
    }
    if (form && form.durationMin !== '' && form.durationMin != null) {
      const d = Number(form.durationMin);
      if (!Number.isFinite(d) || d < 0) problems.push('Duration must be a non-negative number of minutes.');
    }
    return problems;
  }

  /* Games for the assignment picker. `games` is the prototype's G
   * array when available ({id, name, tier}); otherwise the static
   * TP2-001..TP2-130 range. Safety Review / Retired games are
   * marked blocked (the server rejects them regardless). */
  var BLOCKED_GAME_IDS = ['TP2-084', 'TP2-090', 'TP2-092', 'TP2-093', 'TP2-098', 'TP2-125'];

  function gameOptions(games) {
    if (Array.isArray(games) && games.length) {
      return games.map(function (g) {
        const blocked = BLOCKED_GAME_IDS.indexOf(g.id) >= 0
          || g.tier === 'Safety review' || g.tier === 'Retired';
        return { id: g.id, name: g.name || g.id, tier: g.tier || '', blocked: blocked };
      });
    }
    const out = [];
    for (let n = 1; n <= 130; n++) {
      const id = 'TP2-' + String(n).padStart(3, '0');
      out.push({ id: id, name: id, tier: '', blocked: BLOCKED_GAME_IDS.indexOf(id) >= 0 });
    }
    return out;
  }

  /* Roster cap display: { count, max, over, label }. max null =
   * unlimited. Overage is a confirmed, billed state — never silent. */
  function rosterCap(entitlements, count) {
    const limits = (entitlements && entitlements.limits) || {};
    const max = limits.maxAthletes != null ? limits.maxAthletes : null;
    const over = max != null && count > max;
    const label = max == null
      ? count + ' athletes · no roster cap on this plan'
      : count + ' of ' + max + ' athletes' + (over ? ' · ' + (count - max) + ' over (overage applies)' : '');
    return { count: count, max: max, over: over, label: label };
  }

  /* ------------------------------------------------------------------ */
  /* Renderers: HTML strings in the prototype's design language        */
  /* (.panel/.ph/.pb, .tbl-wrap/.t, .btn/.btn sm, .lbl, .note).         */
  /* They never fetch and never mutate state; the controller loads     */
  /* data and calls render() after. h = { esc, lbl, games,             */
  /* athleteName(id), role, devRoles }.                                */
  /* ------------------------------------------------------------------ */

  function lblLocal(h, text, cls) {
    if (h.lbl) return h.lbl(text, cls);
    return '<span class="lbl ' + (cls || 'v1') + '">' + h.esc(text) + '</span>';
  }

  function panel(h, title, rightHtml, bodyHtml) {
    return '<section class="panel"><div class="ph"><h3>' + h.esc(title) + '</h3>'
      + (rightHtml ? '<div class="r" style="flex-wrap:wrap">' + rightHtml + '</div>' : '') + '</div>'
      + '<div class="pb">' + bodyHtml + '</div></section>';
  }

  function errorNote(h, error) {
    if (!error) return '';
    return '<div class="note">' + h.esc(errorText(error))
      + ' <span class="mono small">[' + h.esc(error.code || 'ERROR') + ']</span></div>';
  }

  function noticeNote(h, notice) {
    return notice ? '<div class="note">' + h.esc(notice) + '</div>' : '';
  }

  var TEST_MODE_BANNER = 'TEST MODE — billing is simulated with the fake adapter. No real charge, no card, no live billing. Prices are research recommendations, not approved public prices.';

  function testModeNote(h) {
    return '<div class="note"><b>Test mode.</b> ' + h.esc(TEST_MODE_BANNER) + '</div>';
  }

  var INPUT_STYLE = 'border:1px solid var(--line-strong);background:var(--surface);padding:8px;max-width:100%';

  function field(h, label, inner) {
    return '<label class="small" style="display:flex;flex-direction:column;gap:4px;min-width:0">' + h.esc(label) + inner + '</label>';
  }

  function textInput(id, value, placeholder, extra) {
    return '<input id="' + id + '" type="text" value="' + escLocal(value || '') + '" placeholder="'
      + escLocal(placeholder || '') + '" style="' + INPUT_STYLE + '"' + (extra || '') + '>';
  }

  function numberInput(id, value, placeholder, extra) {
    return '<input id="' + id + '" type="number" value="' + escLocal(value == null ? '' : value) + '" placeholder="'
      + escLocal(placeholder || '') + '" style="' + INPUT_STYLE + '"' + (extra || '') + '>';
  }

  /* ---- plans / pricing ---- */

  function renderPlans(state, h) {
    const plans = state.plans || [];
    if (!plans.length) return '<p class="muted" style="margin:0">Loading plans…</p>';
    const interval = state.interval || 'month';
    const groups = [['athlete', 'For athletes'], ['coach', 'For coaches'], ['organization', 'For teams & academies']];
    let html = testModeNote(h);
    html += '<div class="row" style="gap:8px;margin:10px 0;flex-wrap:wrap">'
      + '<button class="btn sm' + (interval === 'month' ? ' solid' : '') + '" data-sui="interval" data-interval="month">Monthly</button>'
      + '<button class="btn sm' + (interval === 'year' ? ' solid' : '') + '" data-sui="interval" data-interval="year">Annual (2 months free)</button>'
      + '</div>';
    html += '<p class="small muted" style="margin:0 0 10px">Every paid tier includes the GAA assessment battery on the 28-day cycle — test, train, retest. '
      + 'Assessment results are coach-recorded measurements from an unvalidated battery: no norms, percentiles, or rankings. '
      + 'Sponsored athletes and $149 in-person members are never charged again.</p>';
    for (const [aud, title] of groups) {
      const rows = plans.filter(function (p) { return p.audience === aud; });
      if (!rows.length) continue;
      html += '<div class="eyebrow" style="margin:12px 0 6px">' + h.esc(title) + '</div>'
        + '<div class="grid g3" style="gap:12px">' + rows.map(function (p) {
          const feats = planFeatures(p).map(function (f) { return '<li>' + h.esc(f) + '</li>'; }).join('');
          const free = !(p.limits && (p.limits.priceMonthlyCents || p.limits.priceAnnualCents));
          return '<div style="border:1px solid var(--line);padding:12px;min-width:0">'
            + '<div class="eyebrow">' + h.esc(p.name) + '</div>'
            + '<div class="mono" style="font-size:22px;font-weight:700;margin:4px 0">' + h.esc(planPrice(p, interval)) + '</div>'
            + '<ul class="small" style="margin:6px 0;padding-left:16px">' + feats + '</ul>'
            + (free ? '<span class="lbl assume">Free forever</span>'
              : '<button class="btn sm" data-sui="checkout" data-plan="' + h.esc(p.code) + '" data-audience="' + h.esc(p.audience) + '">Subscribe (test mode)</button>')
            + '</div>';
        }).join('') + '</div>';
    }
    if (state.checkout) {
      const c = state.checkout;
      html += '<div class="note" style="margin-top:12px">Test checkout session <span class="mono">' + h.esc(c.sessionId) + '</span> — '
        + h.esc(fmtMoney(c.priceCents)) + ' / ' + h.esc(c.interval) + ' for ' + h.esc(c.planCode) + '. '
        + '<button class="btn sm solid" data-sui="confirm-checkout" data-session="' + h.esc(c.sessionId) + '">Confirm test checkout</button> '
        + '<span class="small muted">Simulates a completed checkout + webhook. No payment occurs.</span></div>';
    }
    return html;
  }

  /* ---- account / registration ---- */

  function renderAccount(state, h) {
    const role = state.role || {};
    let html = '';
    if (state.registration) {
      const r = state.registration;
      html += '<div class="note">Registered: <b>' + h.esc(r.kind === 'coach' ? 'Coach' : 'Athlete') + '</b>'
        + (r.alreadyRegistered ? ' (already registered — nothing duplicated)' : '')
        + (r.organization ? ' · organization <b>' + h.esc(r.organization.name) + '</b>' : '')
        + (r.trial ? ' · 14-day trial started (' + h.esc(r.trial.planCode) + ', ends ' + fmtDate(r.trial.currentPeriodEnd) + ')' : '')
        + '.</div>';
    }
    html += '<p class="small muted" style="margin:0 0 10px">In production, sign-in is Supabase Auth and the account is provisioned on first authenticated call. '
      + 'In this dev environment the "View as" identity below stands in for the signed-in user — registration creates the account for that identity.</p>';
    html += '<div class="grid g2" style="gap:12px">'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Athlete — create account</div>'
      + '<div class="stack" style="gap:8px;margin-top:8px">'
      + field(h, 'Name', textInput('sui-reg-ath-name', '', 'Athlete name'))
      + field(h, 'Email', textInput('sui-reg-ath-email', '', 'athlete@example.com'))
      + field(h, 'Age (years)', numberInput('sui-reg-ath-age', '', 'e.g. 14', ' min="5"'))
      + field(h, 'Sports (comma separated)', textInput('sui-reg-ath-sports', '', 'Baseball, Soccer'))
      + '<button class="btn sm solid" data-sui="register-athlete">Register athlete</button>'
      + '<p class="small muted" style="margin:0">New athletes start on Athlete Free. Minors need guardian consent before remote features activate.</p>'
      + '</div></div>'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Coach — create account</div>'
      + '<div class="stack" style="gap:8px;margin-top:8px">'
      + field(h, 'Name', textInput('sui-reg-coach-name', '', 'Coach name'))
      + field(h, 'Email', textInput('sui-reg-coach-email', '', 'coach@example.com'))
      + field(h, 'Organization name (optional)', textInput('sui-reg-coach-org', '', 'Defaults to "Name Coaching"'))
      + '<button class="btn sm solid" data-sui="register-coach">Register coach</button>'
      + '<p class="small muted" style="margin:0">Creates your solo organization and starts a 14-day Coach Starter trial (test mode — no card).</p>'
      + '</div></div>'
      + '</div>';
    html += '<div style="margin-top:14px"><div class="eyebrow">Accept an invitation</div>'
      + '<div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap">'
      + textInput('sui-accept-token', '', 'Invitation token (single-use, 7 days)', ' style="' + INPUT_STYLE + ';flex:1 1 260px"')
      + '<button class="btn sm" data-sui="accept-invite">Accept invitation</button></div>'
      + '<p class="small muted" style="margin:6px 0 0">Coach invitations join you to the organization. Athlete invitations link you to the inviting coach (consent and plan limits apply).</p></div>';
    if (state.entitlements) {
      html += '<div style="margin-top:14px">' + renderEntitlements(state, h) + '</div>';
    }
    return html;
  }

  function renderEntitlements(state, h) {
    const e = state.entitlements;
    if (!e) return '<p class="muted" style="margin:0">Loading access…</p>';
    if (e.kind === 'athlete') {
      const ent = e.entitlements || {};
      const lab = tierLabel(ent);
      let html = '<div class="eyebrow">Your access</div>'
        + '<p style="margin:6px 0"><span class="lbl ' + lab.cls + '">' + h.esc(lab.text) + '</span> '
        + '<span class="small muted">' + h.esc(lab.note) + '</span></p>'
        + '<p class="small muted" style="margin:0">History display: '
        + (ent.fullHistory ? 'full' : (ent.historyDays != null ? ent.historyDays + '-day window (full record retained)' : 'full'))
        + ' · Coach links: ' + (ent.maxCoachLinks == null ? 'unlimited' : 'up to ' + ent.maxCoachLinks)
        + ' · Training days: ' + (ent.trainingDaysPerWeek == null ? 'unlimited' : ent.trainingDaysPerWeek + ' / week') + '.</p>';
      if (ent.tier === 'member' || ent.tier === 'sponsored') {
        html += '<p class="small" style="margin:6px 0 0">Checkout is refused for covered athletes (<span class="mono">ALREADY_COVERED</span>) — you will never be double-charged.</p>';
      }
      return html;
    }
    if (e.kind === 'coach') {
      const ent = e.entitlements || {};
      const cap = rosterCap(ent, state.roster ? state.roster.count : 0);
      return '<div class="eyebrow">Coach access</div>'
        + '<p style="margin:6px 0">' + (ent.active
          ? '<span class="lbl ok">Active — ' + h.esc(ent.planCode || '') + '</span>'
          : '<span class="lbl crit">Read-only — no active subscription</span>')
        + ' <span class="small muted">' + h.esc(cap.label) + '</span></p>'
        + (ent.readOnly ? '<p class="small muted" style="margin:0">Roster and history stay visible; new assessments, assignments and links are refused until reactivation. Nothing is deleted.</p>' : '');
    }
    if (e.kind === 'organization') {
      const rows = (e.organizations || []).map(function (o) {
        const ent = o.entitlements || {};
        return '<div class="small">' + h.esc(o.organizationId) + ': '
          + (ent.active ? '<span class="lbl ok">' + h.esc(ent.planCode || 'active') + '</span>' : '<span class="lbl crit">read-only</span>') + '</div>';
      }).join('');
      return '<div class="eyebrow">Organization access</div>' + (rows || '<p class="muted" style="margin:0">No organizations.</p>');
    }
    return '<div class="eyebrow">Access</div><p class="small muted" style="margin:6px 0 0">Director — full platform access.</p>';
  }

  /* ---- athlete experience ---- */

  function renderAthlete(state, h) {
    let html = renderEntitlements(state, h);
    const assignments = state.assignments || [];
    const open = assignments.filter(function (a) { return a.status === 'assigned'; });
    const done = assignments.filter(function (a) { return a.status === 'completed'; });
    html += '<div class="eyebrow" style="margin-top:14px">Training assignments</div>';
    if (!assignments.length) {
      html += '<p class="muted" style="margin:6px 0 0">No assignments yet. A linked coach assigns training from the 130-game library — assignments are always coach-authored.</p>';
    } else {
      html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Assignment</th><th>Games</th><th>Build</th><th>Due</th><th>Status</th><th></th></tr>'
        + assignments.map(function (a) {
          return '<tr><td><b>' + h.esc(a.title) + '</b>'
            + (a.instructions ? '<div class="small muted">' + h.esc(a.instructions) + '</div>' : '')
            + (a.dose ? '<div class="small muted">' + h.esc(doseText(a.dose)) + '</div>' : '')
            + '</td><td class="mono small">' + h.esc((a.gameIds || []).join(', ') || '—') + '</td>'
            + '<td>' + h.esc(a.build || '—') + '</td>'
            + '<td class="small">' + (a.dueAt ? fmtDate(a.dueAt) : '—') + '</td>'
            + '<td>' + (a.status === 'completed' ? '<span class="lbl ok">Completed</span>' : '<span class="lbl needval">Assigned</span>') + '</td>'
            + '<td style="white-space:nowrap">' + (a.status === 'assigned'
              ? '<button class="btn sm" data-sui="complete-open" data-assignment="' + h.esc(a.id) + '">Mark complete</button>' : '')
            + '</td></tr>';
        }).join('') + '</table></div>';
      html += '<p class="small muted" style="margin:6px 0 0">' + open.length + ' open · ' + done.length + ' completed. Completing work already assigned is never gated by tier.</p>';
    }
    if (state.completingId) {
      const a = assignments.find(function (x) { return String(x.id) === String(state.completingId); });
      html += '<div style="border:1px solid var(--line);padding:12px;margin-top:10px;min-width:0">'
        + '<div class="eyebrow">Complete — ' + h.esc(a ? a.title : '') + '</div>'
        + '<div class="row" style="gap:10px;margin-top:8px;flex-wrap:wrap">'
        + field(h, 'Duration (minutes)', numberInput('sui-comp-duration', '', 'e.g. 25', ' min="0"'))
        + field(h, 'Effort RPE (1–10)', numberInput('sui-comp-rpe', '', 'e.g. 7', ' min="1" max="10" step="1"'))
        + field(h, 'Note (optional)', textInput('sui-comp-note', '', 'How it went'))
        + '</div><div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">'
        + '<button class="btn sm solid" data-sui="complete-save" data-assignment="' + h.esc(state.completingId) + '">Record completion</button>'
        + '<button class="btn sm ghost" data-sui="complete-cancel">Cancel</button></div>'
        + '<p class="small muted" style="margin:8px 0 0">Completions are append-only history — one per assignment. They record that work was done, never that it "worked".</p></div>';
    }
    html += renderHistoryBlock(state, h);
    return html;
  }

  function doseText(dose) {
    if (!dose) return '';
    const parts = [];
    if (dose.rounds != null) parts.push(dose.rounds + ' rounds');
    if (dose.workSec != null) parts.push(dose.workSec + 's work');
    if (dose.restSec != null) parts.push(dose.restSec + 's rest');
    if (dose.reps != null) parts.push(dose.reps + ' reps');
    if (dose.distance) parts.push(String(dose.distance));
    if (dose.note) parts.push(String(dose.note));
    return parts.join(' · ');
  }

  function renderHistoryBlock(state, h) {
    const hist = state.history;
    let html = '<div class="eyebrow" style="margin-top:14px">History</div>';
    if (!hist) {
      return html + '<p class="muted" style="margin:6px 0 0">Loading history…</p>';
    }
    if (hist.truncated) {
      html += '<div class="note">Showing the last ' + h.esc(hist.historyWindowDays) + ' days (free-tier display window). '
        + 'Older records are retained in full — upgrading restores the full display. Nothing was deleted.</div>';
    }
    const comps = hist.completions || [];
    const assigns = hist.assignments || [];
    const assess = hist.assessments || [];
    const byId = {};
    for (const a of assigns) byId[a.id] = a;
    html += '<p class="small muted" style="margin:6px 0">'
      + comps.length + ' completions · ' + assigns.length + ' assignments · ' + assess.length + ' assessment sessions. '
      + 'Assessment results are coach-recorded measurements (unvalidated battery — see the Assessments section for results and progress).</p>';
    if (comps.length) {
      html += '<div class="tbl-wrap"><table class="t"><tr><th>Completed</th><th>Assignment</th><th>Duration</th><th>RPE</th><th>Note</th></tr>'
        + comps.slice().sort(function (x, y) { return Date.parse(y.completedAt) - Date.parse(x.completedAt); }).map(function (c) {
          const a = byId[c.assignmentId];
          return '<tr><td class="small">' + fmtDate(c.completedAt) + '</td>'
            + '<td>' + h.esc(a ? a.title : c.assignmentId) + '</td>'
            + '<td class="mono">' + (c.durationMin != null ? c.durationMin + ' min' : '—') + '</td>'
            + '<td class="mono">' + (c.effortRpe != null ? c.effortRpe + '/10' : '—') + '</td>'
            + '<td class="small">' + h.esc(c.athleteNote || '') + '</td></tr>';
        }).join('') + '</table></div>';
    }
    if (assess.length) {
      html += '<div class="small" style="margin-top:8px">Assessment sessions: '
        + assess.map(function (s) { return fmtDate(s.completedAt); }).join(' · ')
        + ' — full results + progress live in the Assessments section.</div>';
    }
    return html;
  }

  /* ---- coach experience ---- */

  function renderCoach(state, h) {
    let html = renderEntitlements(state, h);
    const roster = state.roster || { athletes: [], count: 0 };
    const ent = state.entitlements && state.entitlements.entitlements;
    const cap = rosterCap(ent, roster.count);
    html += '<div class="eyebrow" style="margin-top:14px">Roster — ' + h.esc(cap.label) + '</div>';
    if (cap.over) {
      html += '<div class="note">Over the plan roster cap. Overage is billed per athlete only with your explicit confirmation — never silently.</div>';
    }
    if (!roster.athletes.length) {
      html += '<p class="muted" style="margin:6px 0 0">No linked athletes yet. Invite an athlete below, or link an existing athlete by ID.</p>';
    } else {
      html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Athlete</th><th>Age</th><th>Links</th><th></th></tr>'
        + roster.athletes.map(function (row) {
          const a = row.athlete || {};
          return '<tr><td><b>' + h.esc(a.name || a.id) + '</b><div class="mono small muted">' + h.esc(a.id) + '</div></td>'
            + '<td class="mono">' + (a.age != null ? a.age : '—') + '</td>'
            + '<td class="mono">' + (row.links || []).length + '</td>'
            + '<td style="white-space:nowrap">'
            + '<button class="btn sm" data-sui="assign-open" data-athlete="' + h.esc(a.id) + '">Assign training</button> '
            + '<button class="btn sm ghost" data-sui="progress-open" data-athlete="' + h.esc(a.id) + '">Progress</button> '
            + '<button class="btn sm ghost" data-sui="sponsor" data-athlete="' + h.esc(a.id) + '">Sponsor</button> '
            + '<button class="btn sm ghost" data-sui="unlink" data-athlete="' + h.esc(a.id) + '">Unlink</button>'
            + '</td></tr>';
        }).join('') + '</table></div>';
    }
    /* Onboarding */
    html += '<div class="grid g2" style="gap:12px;margin-top:14px">'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Invite an athlete</div>'
      + '<div class="stack" style="gap:8px;margin-top:8px">'
      + field(h, 'Athlete email', textInput('sui-inv-email', '', 'athlete@example.com'))
      + '<button class="btn sm solid" data-sui="invite-athlete">Create invitation</button>'
      + (state.inviteToken ? '<div class="note">Invitation token (shown once — send it to the athlete): <span class="mono" style="word-break:break-all">' + h.esc(state.inviteToken) + '</span></div>' : '')
      + '<p class="small muted" style="margin:0">Single-use, 7-day expiry. Only the token hash is stored.</p></div></div>'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Link an existing athlete</div>'
      + '<div class="stack" style="gap:8px;margin-top:8px">'
      + field(h, 'Athlete ID', textInput('sui-link-athlete', '', 'athlete id'))
      + '<label class="small"><input id="sui-link-overage" type="checkbox"> Confirm overage if over the roster cap</label>'
      + '<button class="btn sm solid" data-sui="link-athlete">Link athlete</button>'
      + '<p class="small muted" style="margin:0">Gates, in order: guardian consent (minors) → active subscription → roster cap → athlete link cap.</p></div></div>'
      + '</div>';
    if (state.assigningTo) html += renderAssignmentComposer(state, h);
    if (state.progressFor) {
      html += '<div style="margin-top:14px"><div class="eyebrow">Progress — ' + h.esc(h.athleteName(state.progressFor)) + '</div>'
        + renderHistoryBlock(state, h) + '</div>';
    }
    html += renderSubscriptionBlock(state, h);
    return html;
  }

  function renderAssignmentComposer(state, h) {
    const athleteId = state.assigningTo;
    const games = gameOptions(h.games);
    const selected = new Set(state.assignGames || []);
    let html = '<div style="border:1px solid var(--line);padding:12px;margin-top:14px;min-width:0">'
      + '<div class="eyebrow">Assign training — ' + h.esc(h.athleteName(athleteId)) + '</div>'
      + '<p class="small muted" style="margin:6px 0">Coach-authored, always: pick games from the existing 130-game library and set the dose. '
      + 'Safety Review / Retired games are rejected by the server. No assessment score ever creates an assignment.</p>'
      + '<div class="stack" style="gap:8px">'
      + field(h, 'Title', textInput('sui-asn-title', '', 'e.g. Speed day — acceleration focus'))
      + field(h, 'Instructions (optional)', textInput('sui-asn-instructions', '', 'What to do, in plain language'))
      + '<div><div class="small" style="margin-bottom:4px">Games (tick to include)</div>'
      + '<div style="max-height:220px;overflow:auto;border:1px solid var(--line);padding:8px">'
      + games.map(function (g) {
        return '<label class="small" style="display:flex;gap:6px;align-items:baseline;padding:2px 0">'
          + '<input type="checkbox" class="sui-game" value="' + h.esc(g.id) + '"'
          + (selected.has(g.id) ? ' checked' : '') + (g.blocked ? ' disabled' : '') + '>'
          + '<span><span class="mono">' + h.esc(g.id) + '</span> ' + h.esc(g.name)
          + (g.blocked ? ' <span class="lbl crit">Safety Review / Retired — not assignable</span>' : '')
          + '</span></label>';
      }).join('')
      + '</div></div>'
      + '<div class="row" style="gap:10px;flex-wrap:wrap">'
      + field(h, 'Build', '<select id="sui-asn-build" style="' + INPUT_STYLE + '">'
        + '<option value="">—</option><option>LEARN</option><option>COMPETE</option><option>PRESSURE</option><option>CHAOS</option></select>')
      + field(h, 'Rounds', numberInput('sui-asn-rounds', '', '3', ' min="0"'))
      + field(h, 'Work (sec)', numberInput('sui-asn-work', '', '30', ' min="0"'))
      + field(h, 'Rest (sec)', numberInput('sui-asn-rest', '', '30', ' min="0"'))
      + field(h, 'Reps', numberInput('sui-asn-reps', '', '8', ' min="0"'))
      + field(h, 'Distance', textInput('sui-asn-distance', '', 'e.g. 20 yd'))
      + field(h, 'Dose note', textInput('sui-asn-dosenote', '', 'e.g. clean reps only'))
      + field(h, 'Due date', '<input id="sui-asn-due" type="date" style="' + INPUT_STYLE + '">')
      + '</div>'
      + '<div class="row" style="gap:8px;flex-wrap:wrap">'
      + '<button class="btn sm solid" data-sui="assign-save" data-athlete="' + h.esc(athleteId) + '">Create assignment</button>'
      + '<button class="btn sm ghost" data-sui="assign-cancel">Cancel</button></div>'
      + '</div></div>';
    return html;
  }

  function renderSubscriptionBlock(state, h) {
    const sub = state.subscription;
    let html = '<div class="eyebrow" style="margin-top:14px">Subscription</div>' + testModeNote(h);
    if (!sub) {
      return html + '<p class="muted" style="margin:6px 0 0">Loading subscription…</p>';
    }
    const granting = sub.granting || [];
    const all = sub.subscriptions || [];
    if (!all.length) {
      html += '<p class="muted" style="margin:6px 0 0">No subscription yet. Choose a plan in the Plans tab (test mode).</p>';
    } else {
      html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Plan</th><th>Status</th><th>Period ends</th><th>Grants access</th><th></th></tr>'
        + all.map(function (s) {
          const grants = granting.some(function (g) { return g.id === s.id; });
          return '<tr><td>' + h.esc(s.planCode) + '</td><td>' + h.esc(s.status) + '</td>'
            + '<td class="small">' + fmtDate(s.currentPeriodEnd) + '</td>'
            + '<td>' + (grants ? '<span class="lbl ok">Yes</span>' : '<span class="lbl assume">No</span>') + '</td>'
            + '<td>' + (grants ? '<button class="btn sm ghost" data-sui="cancel-sub" data-sub="' + h.esc(s.id) + '">Cancel at period end</button>' : '') + '</td></tr>';
        }).join('') + '</table></div>';
      html += '<p class="small muted" style="margin:6px 0 0">Cancellation keeps access to period end. Lapse never deletes data; reactivation restores it.</p>';
    }
    return html;
  }

  /* ---- organization experience ---- */

  function renderOrg(state, h) {
    let html = '<p class="small muted" style="margin:0 0 10px">Organizations hold multiple coaches under one subscription. '
      + 'Org admins see the org-wide roster; coaches inside the org still see only their own linked athletes.</p>';
    html += '<div class="grid g2" style="gap:12px">'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Create organization</div>'
      + '<div class="stack" style="gap:8px;margin-top:8px">'
      + field(h, 'Name', textInput('sui-org-name', '', 'e.g. River City Academy'))
      + field(h, 'Kind', '<select id="sui-org-kind" style="' + INPUT_STYLE + '"><option value="team">Team</option><option value="academy">Academy</option></select>')
      + '<button class="btn sm solid" data-sui="create-org">Create organization</button>'
      + '<p class="small muted" style="margin:0">You become org_admin; a 14-day Team / Academy trial starts (test mode).</p></div></div>'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Organization overview</div>'
      + '<div class="stack" style="gap:8px;margin-top:8px">'
      + field(h, 'Organization ID', textInput('sui-org-id', state.organizationId || '', 'organization id'))
      + '<button class="btn sm" data-sui="org-overview">Load overview</button>'
      + field(h, 'Invite coach (email)', textInput('sui-org-invite-email', '', 'coach@example.com'))
      + '<button class="btn sm" data-sui="invite-coach">Invite coach to organization</button>'
      + (state.orgInviteToken ? '<div class="note">Coach invitation token (shown once): <span class="mono" style="word-break:break-all">' + h.esc(state.orgInviteToken) + '</span></div>' : '')
      + '</div></div></div>';
    const ov = state.orgOverview;
    if (ov) {
      const ent = ov.entitlements || {};
      html += '<div style="margin-top:14px"><div class="eyebrow">' + h.esc(ov.organization ? ov.organization.name : 'Organization')
        + ' — ' + (ent.active ? h.esc(ent.planCode || 'active') : 'read-only') + '</div>'
        + '<p class="small muted" style="margin:6px 0">' + (ov.coaches || []).length + ' coaches · ' + h.esc(ov.athleteCount) + ' athletes · '
        + h.esc(ov.pendingInvitations) + ' pending invitations.</p>';
      if ((ov.coaches || []).length) {
        html += '<div class="tbl-wrap"><table class="t"><tr><th>Coach</th><th>Athletes</th></tr>'
          + ov.coaches.map(function (c) {
            return '<tr><td>' + h.esc(c.coach ? (c.coach.name || c.coach.id) : '—') + '</td><td class="mono">' + h.esc(c.athleteCount) + '</td></tr>';
          }).join('') + '</table></div>';
      }
      if ((ov.athletes || []).length) {
        html += '<div class="small" style="margin-top:8px">Athletes: '
          + ov.athletes.map(function (a) { return h.esc(a.name || a.id); }).join(', ') + '</div>';
      }
      html += '</div>';
    }
    return html;
  }

  /* ---- hub shell ---- */

  var TABS = [
    ['overview', 'Overview'], ['account', 'Account'], ['athlete', 'Athlete'],
    ['coach', 'Coach'], ['org', 'Organization'], ['plans', 'Plans & billing'],
  ];

  function renderOverview(state, h) {
    return '<p style="margin:0 0 8px"><b>The Program</b> is an assessment-driven athlete-development system: '
      + '<b>test, train, retest — every 28 days</b>. Coaches administer the GAA battery, assign training from the 130-game library, '
      + 'and watch progress over time. Results are coach-recorded measurements from an unvalidated battery — no norms, percentiles, or rankings — '
      + 'and no score ever auto-prescribes training: the coach always decides.</p>'
      + '<div class="grid g3" style="gap:12px;margin-top:10px">'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Athletes</div>'
      + '<p class="small" style="margin:6px 0">Know where you stand, train what matters, prove it in 28 days. Free forever, or Athlete Remote for full history and unlimited coach links.</p>'
      + '<button class="btn sm" data-sui="tab" data-tab="athlete">Athlete dashboard</button></div>'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Coaches</div>'
      + '<p class="small" style="margin:6px 0">Sell development you can demonstrate: roster, assessments, assignments, and progress parents can see. 14-day trial, no card.</p>'
      + '<button class="btn sm" data-sui="tab" data-tab="coach">Coach tools</button></div>'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Teams & academies</div>'
      + '<p class="small" style="margin:6px 0">Every athlete tested, every cycle, across every team — one organization, unlimited coaches, compliance you can see.</p>'
      + '<button class="btn sm" data-sui="tab" data-tab="org">Organization tools</button></div>'
      + '</div>'
      + '<p class="small muted" style="margin:10px 0 0">In-person training at The Program ($149/month membership, cohorts, sessions) is unchanged — members also hold full remote access with no second charge. '
      + 'Billing on this surface is test mode only.</p>';
  }

  function renderHub(state, h) {
    let right = '';
    if (h.devRoles) {
      right += h.devRoles.map(function (r) {
        const active = state.role && state.role.user === r.user;
        return '<button class="btn sm' + (active ? ' solid' : '') + '" data-sui="role" data-sui-role="' + h.esc(r.role)
          + '" data-user="' + h.esc(r.user) + '"' + (r.athleteId ? ' data-athlete="' + h.esc(r.athleteId) + '"' : '')
          + '>' + h.esc(r.label) + '</button>';
      }).join(' ');
    }
    right += ' <button class="btn sm ghost" data-sui="refresh">Refresh</button>';
    let body = '';
    if (state.connected === false) {
      body += '<p class="muted" style="margin:0">SaaS service not connected — start the dev server (<span class="mono">npm run dev</span>) to use accounts, rosters and assignments.</p>';
    } else if (state.connected !== true) {
      body += '<p class="muted" style="margin:0">Connecting to the SaaS service…</p>';
    } else {
      const tab = state.tab || 'overview';
      body += '<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:12px">' + TABS.map(function (t) {
        return '<button class="btn sm' + (tab === t[0] ? ' solid' : '') + '" data-sui="tab" data-tab="' + t[0] + '">' + h.esc(t[1]) + '</button>';
      }).join('') + '</div>';
      if (tab === 'account') body += renderAccount(state, h);
      else if (tab === 'athlete') body += renderAthlete(state, h);
      else if (tab === 'coach') body += renderCoach(state, h);
      else if (tab === 'org') body += renderOrg(state, h);
      else if (tab === 'plans') body += renderPlans(state, h);
      else body += renderOverview(state, h);
    }
    return panel(h, 'The Program — remote coaching & subscriptions',
      lblLocal(h, state.connected ? 'Connected' : 'Offline', state.connected ? 'ok' : 'assume') + ' ' + right,
      errorNote(h, state.error) + noticeNote(h, state.notice) + body);
  }

  /* Compact SaaS section appended to an athlete profile: access
   * state + assignment summary for that athlete (when in scope). */
  function renderAthleteProfileSection(state, h, athleteId) {
    if (!state.connected) return '';
    const view = state.profileView && String(state.profileView.athleteId) === String(athleteId) ? state.profileView : null;
    let body;
    if (!view) {
      body = '<p class="muted" style="margin:0">Loading remote-coaching status…</p>';
    } else if (view.error) {
      body = '<p class="muted" style="margin:0">' + h.esc(errorText(view.error)) + '</p>';
    } else {
      const ent = view.entitlements || {};
      const lab = tierLabel(ent);
      const hist = view.history || {};
      body = '<p class="small" style="margin:0 0 6px"><span class="lbl ' + lab.cls + '">' + h.esc(lab.text) + '</span> '
        + '<span class="muted">' + h.esc(lab.note) + '</span></p>'
        + '<p class="small muted" style="margin:0">' + (hist.completions || []).length + ' completions · '
        + (hist.assignments || []).length + ' assignments · ' + (hist.assessments || []).length + ' assessment sessions'
        + (hist.truncated ? ' · showing the ' + h.esc(hist.historyWindowDays) + '-day window (full record retained)' : '') + '.</p>';
    }
    return panel(h, 'Remote coaching — SaaS', lblLocal(h, 'Live', 'v1'),
      body + '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">'
      + '<button class="btn sm ghost" data-sui="profile-refresh" data-athlete="' + h.esc(athleteId) + '">Refresh</button></div>');
  }

  /* ------------------------------------------------------------------ */
  /* Controller                                                          */
  /* ------------------------------------------------------------------ */

  /* Dev-only "View as" users. Mirrors server/fixtures/dev-roster.js
   * plus the seeded SaaS identities (server/dev-server.js). Shown
   * only in dev mode. */
  var DEV_ROLES = [
    { role: 'director', user: 'dev-director-marcus', label: 'Director (Marcus)' },
    { role: 'coach', user: 'dev-coach-kayla', label: 'Coach Kayla (YAK)' },
    { role: 'coach', user: 'dev-coach-jordan', label: 'Coach Jordan (ELL)' },
    { role: 'coach', user: 'dev-coach-marcus', label: 'Coach Marcus (CLE)' },
    { role: 'parent', user: 'dev-parent-youth', label: 'Parent of Synthetic Youth (12)' },
    { role: 'athlete', user: 'dev-athlete-youth', athleteId: 'ath-synth-youth-12', label: 'Athlete: Synthetic Youth (12)' },
    { role: 'athlete', user: 'dev-athlete-wingback', athleteId: 'ath-synth-wingback-48', label: 'Athlete: Synthetic Wingback (48, $149 member)' },
  ];

  function createSaasUI(options) {
    options = options || {};
    var root = options.root || (typeof globalThis !== 'undefined' ? globalThis : {});
    var doc = options.doc || root.document || null;
    var endpoint = options.endpoint || root.SAAS_API_URL || '/api/saas';
    var getToken = typeof options.getToken === 'function' ? options.getToken : null;
    var devMode = options.dev !== false;
    var injectedClient = options.client || null;

    var state = {
      connected: null, error: null, notice: null,
      role: DEV_ROLES[0],
      tab: 'overview', interval: 'month',
      plans: null, entitlements: null, subscription: null,
      roster: null, assignments: null, history: null,
      completingId: null, assigningTo: null, assignGames: [],
      progressFor: null, inviteToken: null, orgInviteToken: null,
      registration: null, checkout: null,
      organizationId: null, orgOverview: null,
      profileView: null,
    };
    var installed = false;
    var clientCache = {};
    var loadingProfileFor = null;

    function resolveHelpers() {
      var e = (typeof esc === 'function') ? esc : escLocal;
      var l = (typeof lbl === 'function') ? lbl : null;
      return { esc: e, lbl: l };
    }

    function prototypeGames() {
      try {
        if (typeof G !== 'undefined' && Array.isArray(G)) return G;
      } catch (e) { /* not in the prototype scope (tests) */ }
      return (root && Array.isArray(root.G)) ? root.G : null;
    }

    function helpers() {
      var h = resolveHelpers();
      h.games = prototypeGames();
      h.athleteName = function (id) {
        const rows = (state.roster && state.roster.athletes) || [];
        const found = rows.find(function (r) { return r.athlete && String(r.athlete.id) === String(id); });
        return found ? (found.athlete.name || found.athlete.id) : String(id);
      };
      h.devRoles = devMode ? DEV_ROLES : null;
      h.role = state.role;
      return h;
    }

    function makeClient(role) {
      if (injectedClient) return injectedClient;
      if (!root.SaasClient || typeof root.SaasClient.createSaasClient !== 'function') {
        throw new Error('SaasClient is not loaded.');
      }
      const key = role.user;
      if (!clientCache[key]) {
        clientCache[key] = root.SaasClient.createSaasClient({
          endpoint: endpoint,
          devRole: devMode ? role.role : undefined,
          devUser: devMode ? role.user : undefined,
          devAthleteId: devMode ? role.athleteId : undefined,
          getToken: getToken,
        });
      }
      return clientCache[key];
    }

    function client() { return makeClient(state.role); }

    function toast(msg) {
      try { if (typeof root.toast === 'function') root.toast(msg); } catch (e) { /* best-effort */ }
    }

    function rerender() {
      try {
        if (typeof root.render === 'function' && typeof S !== 'undefined' && S) root.render(true);
      } catch (e) { /* render before boot — the next render picks it up */ }
    }

    function fail(e) {
      state.error = { code: (e && e.code) || 'ERROR', message: (e && e.message) || String(e) };
      if (e && e.coveringSource) state.error.coveringSource = e.coveringSource;
      state.notice = null;
    }

    function val(id) {
      const el = doc && doc.getElementById(id);
      return el ? String(el.value == null ? '' : el.value).trim() : '';
    }

    function checked(id) {
      const el = doc && doc.getElementById(id);
      return !!(el && el.checked);
    }

    function checkedGames() {
      const out = [];
      if (doc && typeof doc.querySelectorAll === 'function') {
        const els = doc.querySelectorAll('.sui-game');
        for (const el of els) if (el.checked) out.push(el.value);
      }
      return out;
    }

    async function refresh() {
      state.error = null;
      let ok = false;
      try { ok = await client().probe(); } catch (e) { ok = false; }
      state.connected = ok;
      if (!ok) { rerender(); return false; }
      try {
        const plans = await client().getPlans();
        state.plans = plans.plans || [];
      } catch (e) { state.plans = state.plans || []; }
      await refreshRoleData();
      rerender();
      return true;
    }

    async function refreshRoleData() {
      const role = state.role && state.role.role;
      state.entitlements = null;
      state.subscription = null;
      try { state.entitlements = await client().myEntitlements({}); }
      catch (e) { /* unregistered dev identities have no entitlements yet */ }
      if (role === 'coach' || role === 'org_admin' || role === 'director') {
        try { state.roster = await client().myRoster({}); } catch (e) { state.roster = null; }
      }
      if (role === 'coach' || role === 'org_admin' || role === 'athlete') {
        try { state.subscription = await client().mySubscription({}); } catch (e) { state.subscription = null; }
      }
      if (role === 'athlete') {
        try {
          const list = await client().listAssignments({});
          state.assignments = list.assignments || [];
        } catch (e) { state.assignments = []; }
        try { state.history = await client().athleteHistory({}); } catch (e) { state.history = null; }
      }
    }

    async function switchRole(role) {
      state.role = role;
      state.assignments = null;
      state.history = null;
      state.roster = null;
      state.completingId = null;
      state.assigningTo = null;
      state.progressFor = null;
      state.checkout = null;
      await refresh();
    }

    async function registerAthlete() {
      state.error = null; state.notice = null;
      const sports = val('sui-reg-ath-sports').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      const ageRaw = val('sui-reg-ath-age');
      try {
        const r = await client().registerAthlete({
          name: val('sui-reg-ath-name'), email: val('sui-reg-ath-email'),
          age: ageRaw === '' ? null : Number(ageRaw), sports: sports,
        });
        state.registration = { kind: 'athlete', alreadyRegistered: !!r.alreadyRegistered };
        state.notice = 'Athlete account ready on Athlete Free.';
        toast('Athlete registered');
        await refreshRoleData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function registerCoach() {
      state.error = null; state.notice = null;
      try {
        const r = await client().registerCoach({
          name: val('sui-reg-coach-name'), email: val('sui-reg-coach-email'),
          orgName: val('sui-reg-coach-org') || undefined,
        });
        state.registration = {
          kind: 'coach', alreadyRegistered: !!r.alreadyRegistered,
          organization: r.organization || null, trial: r.trial || null,
        };
        if (r.organization) state.organizationId = r.organization.id;
        state.notice = 'Coach account ready — 14-day Coach Starter trial started (test mode).';
        toast('Coach registered');
        await refreshRoleData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function acceptInvite() {
      state.error = null; state.notice = null;
      try {
        const r = await client().acceptInvitation({ token: val('sui-accept-token') });
        state.notice = r.organization
          ? 'Joined ' + (r.organization.name || 'the organization') + ' as a coach.'
          : 'Invitation accepted — you are now linked to your coach.';
        toast('Invitation accepted');
        await refreshRoleData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function inviteAthlete() {
      state.error = null; state.notice = null;
      try {
        const r = await client().inviteAthlete({ email: val('sui-inv-email') });
        state.inviteToken = r.token;
        state.notice = 'Invitation created. The token is shown once below.';
      } catch (e) { fail(e); }
      rerender();
    }

    async function linkAthlete() {
      state.error = null; state.notice = null;
      try {
        const r = await client().linkAthlete({
          athleteId: val('sui-link-athlete'),
          confirmOverage: checked('sui-link-overage'),
        });
        state.notice = r.alreadyLinked ? 'Already linked — nothing changed.'
          : 'Athlete linked' + (r.overage ? ' (overage confirmed — billed per athlete)' : '') + '.';
        await refreshRoleData();
      } catch (e) {
        fail(e);
        if (e && e.code === 'ENTITLEMENT_LIMIT') {
          state.notice = 'If this is the roster cap, tick "Confirm overage" and link again — overage is never applied silently.';
        }
      }
      rerender();
    }

    async function unlinkAthlete(athleteId) {
      state.error = null; state.notice = null;
      try {
        await client().unlinkAthlete({ athleteId: athleteId });
        state.notice = 'Link ended. Access ends; the athlete record and history are retained.';
        await refreshRoleData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function sponsorAthlete(athleteId) {
      state.error = null; state.notice = null;
      try {
        const r = await client().sponsorAthlete({ athleteId: athleteId });
        state.notice = r.alreadySponsored ? 'Already sponsored.' : 'Athlete sponsored — they now hold paid access and will never be charged while it lasts.';
        await refreshRoleData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function saveAssignment(athleteId) {
      state.error = null; state.notice = null;
      const form = {
        athleteId: athleteId,
        title: val('sui-asn-title'),
        instructions: val('sui-asn-instructions'),
        gameIds: checkedGames(),
        build: val('sui-asn-build') || null,
        dose: {
          rounds: val('sui-asn-rounds'), workSec: val('sui-asn-work'), restSec: val('sui-asn-rest'),
          reps: val('sui-asn-reps'), distance: val('sui-asn-distance'), note: val('sui-asn-dosenote'),
        },
        dueAt: val('sui-asn-due') ? new Date(val('sui-asn-due')).toISOString() : null,
      };
      const problems = validateAssignmentForm(form);
      if (problems.length) { fail({ code: 'INVALID_INPUT', message: problems.join(' ') }); rerender(); return; }
      try {
        const r = await client().createAssignment(buildAssignmentParams(form));
        state.notice = 'Assignment created: ' + r.assignment.title + '.';
        state.assigningTo = null;
        state.assignGames = [];
        toast('Assignment created');
      } catch (e) { fail(e); }
      rerender();
    }

    async function saveCompletion(assignmentId) {
      state.error = null; state.notice = null;
      const form = {
        assignmentId: assignmentId,
        durationMin: val('sui-comp-duration'),
        effortRpe: val('sui-comp-rpe'),
        athleteNote: val('sui-comp-note'),
      };
      const problems = validateCompletionForm(form);
      if (problems.length) { fail({ code: 'INVALID_INPUT', message: problems.join(' ') }); rerender(); return; }
      try {
        await client().completeAssignment(buildCompletionParams(form));
        state.notice = 'Completion recorded.';
        state.completingId = null;
        toast('Completion recorded');
        await refreshRoleData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function openProgress(athleteId) {
      state.error = null; state.notice = null;
      state.progressFor = athleteId;
      state.history = null;
      try { state.history = await client().athleteHistory({ athleteId: athleteId }); }
      catch (e) { fail(e); }
      rerender();
    }

    async function createOrg() {
      state.error = null; state.notice = null;
      try {
        const r = await client().createOrganization({
          name: val('sui-org-name'), kind: val('sui-org-kind') || 'team',
        });
        state.organizationId = r.organization.id;
        /* createOrganization promotes the founder to org_admin
         * server-side; mirror that in the dev identity so org
         * tools (orgOverview, inviteToOrg) are callable. In
         * production the next JWT carries the new role. */
        if (devMode && state.role) {
          state.role = { role: 'org_admin', user: state.role.user, athleteId: state.role.athleteId || null, label: state.role.label };
          delete clientCache[state.role.user];
        }
        state.notice = 'Organization created — 14-day Team / Academy trial started (test mode). You are org_admin.';
        toast('Organization created');
        await loadOrgOverview(r.organization.id);
      } catch (e) { fail(e); }
      rerender();
    }

    async function loadOrgOverview(orgId) {
      const id = orgId || val('sui-org-id') || state.organizationId;
      if (!id) { fail({ code: 'INVALID_INPUT', message: 'Enter an organization ID first.' }); rerender(); return; }
      state.error = null;
      try {
        state.orgOverview = await client().orgOverview({ organizationId: id });
        state.organizationId = id;
      } catch (e) { fail(e); }
      rerender();
    }

    async function inviteCoach() {
      state.error = null; state.notice = null;
      const orgId = val('sui-org-id') || state.organizationId;
      try {
        const r = await client().inviteToOrg({ organizationId: orgId, email: val('sui-org-invite-email') });
        state.orgInviteToken = r.token;
        state.notice = 'Coach invitation created. The token is shown once below.';
      } catch (e) { fail(e); }
      rerender();
    }

    async function checkout(planCode, audience) {
      state.error = null; state.notice = null;
      try {
        const sub = state.subscription;
        let ownerId = null;
        if (audience === 'athlete') {
          const self = state.entitlements && state.entitlements.athleteId;
          ownerId = self || (state.role && state.role.athleteId) || null;
        } else if (audience === 'coach') {
          ownerId = (state.entitlements && state.entitlements.coachId) || (sub && sub.ownerId) || null;
        } else if (audience === 'organization') {
          ownerId = state.organizationId || (sub && sub.ownerId) || null;
        }
        if (!ownerId) {
          fail({ code: 'INVALID_INPUT', message: 'Register (or load your organization) first, then subscribe.' });
          rerender(); return;
        }
        const r = await client().createCheckoutSession({
          ownerType: audience, ownerId: ownerId, planCode: planCode, interval: state.interval || 'month',
        });
        state.checkout = r;
        state.notice = 'Test checkout created — confirm it below to activate the subscription (no payment occurs).';
      } catch (e) {
        fail(e);
        if (e && e.code === 'ALREADY_COVERED') {
          state.notice = 'No purchase needed: this athlete is already covered via ' + (e.coveringSource || 'an existing source') + '.';
        }
      }
      rerender();
    }

    async function confirmCheckout(sessionId) {
      state.error = null; state.notice = null;
      try {
        const r = await client().confirmCheckout({ sessionId: sessionId });
        state.checkout = null;
        state.notice = r.alreadyComplete ? 'Test checkout already completed.' : 'Test subscription active: ' + (r.subscription ? r.subscription.planCode : '') + '.';
        toast('Subscription active (test mode)');
        await refreshRoleData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function cancelSubscription(subId) {
      state.error = null; state.notice = null;
      try {
        await client().cancelSubscription({ subscriptionId: subId, atPeriodEnd: true });
        state.notice = 'Subscription will cancel at period end. Access continues until then; data is retained.';
        await refreshRoleData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function loadProfile(athleteId) {
      if (loadingProfileFor === athleteId) return;
      loadingProfileFor = athleteId;
      try {
        const ent = await client().myEntitlements({ athleteId: athleteId });
        const hist = await client().athleteHistory({ athleteId: athleteId });
        state.profileView = { athleteId: athleteId, entitlements: ent.entitlements, history: hist };
      } catch (e) {
        state.profileView = { athleteId: athleteId, error: { code: e.code || 'ERROR', message: e.message } };
      } finally {
        loadingProfileFor = null;
      }
      rerender();
    }

    function onClick(e) {
      const t = e.target && e.target.closest ? e.target.closest('[data-sui]') : null;
      if (!t) return;
      const action = t.getAttribute('data-sui');
      const athleteId = t.getAttribute('data-athlete');
      const handlers = {
        'tab': function () { state.tab = t.getAttribute('data-tab') || 'overview'; state.error = null; rerender(); return Promise.resolve(); },
        'interval': function () { state.interval = t.getAttribute('data-interval') || 'month'; rerender(); return Promise.resolve(); },
        'refresh': function () { return refresh(); },
        'role': function () {
          return switchRole({
            role: t.getAttribute('data-sui-role'), user: t.getAttribute('data-user'),
            athleteId: athleteId || null,
            label: (t.textContent || '').trim(),
          });
        },
        'register-athlete': function () { return registerAthlete(); },
        'register-coach': function () { return registerCoach(); },
        'accept-invite': function () { return acceptInvite(); },
        'invite-athlete': function () { return inviteAthlete(); },
        'link-athlete': function () { return linkAthlete(); },
        'unlink': function () { return unlinkAthlete(athleteId); },
        'sponsor': function () { return sponsorAthlete(athleteId); },
        'assign-open': function () { state.assigningTo = athleteId; state.error = null; rerender(); return Promise.resolve(); },
        'assign-cancel': function () { state.assigningTo = null; rerender(); return Promise.resolve(); },
        'assign-save': function () { return saveAssignment(athleteId); },
        'progress-open': function () { return openProgress(athleteId); },
        'complete-open': function () { state.completingId = t.getAttribute('data-assignment'); state.error = null; rerender(); return Promise.resolve(); },
        'complete-cancel': function () { state.completingId = null; rerender(); return Promise.resolve(); },
        'complete-save': function () { return saveCompletion(t.getAttribute('data-assignment')); },
        'create-org': function () { return createOrg(); },
        'org-overview': function () { return loadOrgOverview(); },
        'invite-coach': function () { return inviteCoach(); },
        'checkout': function () { return checkout(t.getAttribute('data-plan'), t.getAttribute('data-audience')); },
        'confirm-checkout': function () { return confirmCheckout(t.getAttribute('data-session')); },
        'cancel-sub': function () { return cancelSubscription(t.getAttribute('data-sub')); },
        'profile-refresh': function () { return loadProfile(athleteId); },
      };
      const fn = handlers[action];
      if (!fn) return;
      Promise.resolve().then(fn).catch(function (err) { fail(err); rerender(); });
    }

    function install() {
      if (installed) return true;
      if (!root.SaasClient || typeof root.SaasClient.createSaasClient !== 'function') return false;
      if (typeof root.vDashboard === 'function' && !root.vDashboard.__suiWrapped) {
        const orig = root.vDashboard;
        const wrapped = function () { return renderHub(state, helpers()) + orig.apply(this, arguments); };
        wrapped.__suiWrapped = true;
        root.vDashboard = wrapped;
      }
      if (typeof root.vCoach === 'function' && !root.vCoach.__suiWrapped) {
        const orig = root.vCoach;
        const wrapped = function () { return renderHub(state, helpers()) + orig.apply(this, arguments); };
        wrapped.__suiWrapped = true;
        root.vCoach = wrapped;
      }
      if (typeof root.vAthleteMode === 'function' && !root.vAthleteMode.__suiWrapped) {
        const orig = root.vAthleteMode;
        const wrapped = function () { return renderHub(state, helpers()) + orig.apply(this, arguments); };
        wrapped.__suiWrapped = true;
        root.vAthleteMode = wrapped;
      }
      if (typeof root.vAthlete === 'function' && !root.vAthlete.__suiWrapped) {
        const orig = root.vAthlete;
        const wrapped = function (id) {
          const base = orig.apply(this, arguments);
          const extra = renderAthleteProfileSection(state, helpers(), id);
          if (extra && state.connected && (!state.profileView || String(state.profileView.athleteId) !== String(id))) {
            loadProfile(id);
          }
          return base + extra;
        };
        wrapped.__suiWrapped = true;
        root.vAthlete = wrapped;
      }
      if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('click', onClick);
      installed = true;
      refresh();
      return true;
    }

    return {
      state: state, install: install, refresh: refresh, refreshRoleData: refreshRoleData,
      switchRole: switchRole, registerAthlete: registerAthlete, registerCoach: registerCoach,
      acceptInvite: acceptInvite, inviteAthlete: inviteAthlete, linkAthlete: linkAthlete,
      unlinkAthlete: unlinkAthlete, sponsorAthlete: sponsorAthlete,
      saveAssignment: saveAssignment, saveCompletion: saveCompletion,
      openProgress: openProgress, createOrg: createOrg, loadOrgOverview: loadOrgOverview,
      inviteCoach: inviteCoach, checkout: checkout, confirmCheckout: confirmCheckout,
      cancelSubscription: cancelSubscription, loadProfile: loadProfile,
      helpers: helpers,
      renderHub: function () { return renderHub(state, helpers()); },
      renderAthleteProfileSection: function (id) { return renderAthleteProfileSection(state, helpers(), id); },
      onClick: onClick, client: client, devMode: devMode,
    };
  }

  return {
    createSaasUI: createSaasUI,
    esc: escLocal, fmtDate: fmtDate, fmtMoney: fmtMoney,
    tierLabel: tierLabel, errorText: errorText,
    planFeatures: planFeatures, planPrice: planPrice,
    buildAssignmentParams: buildAssignmentParams, validateAssignmentForm: validateAssignmentForm,
    buildCompletionParams: buildCompletionParams, validateCompletionForm: validateCompletionForm,
    gameOptions: gameOptions, rosterCap: rosterCap, doseText: doseText,
    renderHub: renderHub, renderOverview: renderOverview, renderPlans: renderPlans,
    renderAccount: renderAccount, renderEntitlements: renderEntitlements,
    renderAthlete: renderAthlete, renderCoach: renderCoach, renderOrg: renderOrg,
    renderAssignmentComposer: renderAssignmentComposer, renderHistoryBlock: renderHistoryBlock,
    renderSubscriptionBlock: renderSubscriptionBlock,
    renderAthleteProfileSection: renderAthleteProfileSection,
    BLOCKED_GAME_IDS: BLOCKED_GAME_IDS.slice(),
    DEV_ROLES: DEV_ROLES,
  };
});
