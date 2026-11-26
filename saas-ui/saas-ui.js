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
 *   - Athlete Pathways V1 (2026-11-26): complimentary athletes
 *     (owner-granted) never see a payment prompt or trial notice;
 *     prospect profiles are private by default and shareable only
 *     after BOTH athlete and coach approval (plus guardian consent
 *     for minors); the public profile shows only the server's
 *     approved public fields — never contact info, training notes,
 *     or medical info. Trend charts compare an athlete only to
 *     their own history. Media is external links/embeds only — no
 *     uploads, no storage.
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
   * precedence is complimentary > member > sponsored > paid > free;
   * the UI never upgrades a tier on its own. Complimentary athletes
   * never see a payment prompt or trial notice. */
  var TIER_LABELS = {
    complimentary: { text: 'Complimentary — granted by The Program', cls: 'ok', note: 'Full remote access, granted complimentary by the owner. No payment prompt, no trial notice, never charged.' },
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
    PROFILE_NOT_APPROVED: 'That profile is not approved for sharing yet — it needs both athlete and coach approval first (and guardian consent for a minor).',
    PROFILE_SHARE_INVALID: 'That share link is invalid, expired, or revoked. Prospect profiles are private by default.',
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
  /* Athlete Pathways V1 — pure helpers (no DOM, no network)          */
  /* ------------------------------------------------------------------ */

  /* The five Pathways sports (server/saas-api.js SPORTS). Positions
   * are UI suggestions only — the server stores free-form position
   * strings, so a coach may type any position; these lists only
   * save typing. The GAA 8-test core is shared by every sport; the
   * sport-specific batteries live in the assessment engine. */
  var SPORTS = {
    soccer: { label: 'Soccer', positions: ['Goalkeeper', 'Centre-back', 'Full-back', 'Defensive midfield', 'Central midfield', 'Attacking midfield', 'Winger', 'Striker'] },
    baseball: { label: 'Baseball', positions: ['Pitcher', 'Catcher', 'First base', 'Second base', 'Shortstop', 'Third base', 'Outfield', 'Designated hitter'] },
    basketball: { label: 'Basketball', positions: ['Point guard', 'Shooting guard', 'Small forward', 'Power forward', 'Center'] },
    football: { label: 'Football', positions: ['Quarterback', 'Running back', 'Wide receiver', 'Tight end', 'Offensive line', 'Defensive line', 'Linebacker', 'Defensive back', 'Kicker / punter'] },
    flag_football: { label: 'Flag football', positions: ['Quarterback', 'Receiver', 'Rusher', 'Center', 'Defensive back'] },
  };
  var SPORT_IDS = ['soccer', 'baseball', 'basketball', 'football', 'flag_football'];

  function sportLabel(id) {
    return (SPORTS[id] && SPORTS[id].label) || String(id || '—');
  }

  function positionsFor(sport) {
    return (SPORTS[sport] && SPORTS[sport].positions.slice()) || [];
  }

  /* Prospect-profile status -> display label. Sharing needs BOTH
   * approvals (athlete + coach); the server enforces that, the UI
   * only reports it. Editing an approved profile re-opens it to
   * draft server-side, so re-approval is required. */
  var PROFILE_STATUS_LABELS = {
    draft: { text: 'Draft — not shareable', cls: 'assume' },
    pending_approval: { text: 'Pending approval', cls: 'needval' },
    approved: { text: 'Approved — shareable', cls: 'ok' },
  };

  function profileStatusLabel(status) {
    return PROFILE_STATUS_LABELS[status] || { text: String(status || 'Unknown'), cls: 'v1' };
  }

  /* CRM vocabularies — copied from server/saas-api.js; the server
   * validates, the UI only offers the values. */
  var CONTACT_STATUSES = ['new', 'contacted', 'evaluating', 'offered', 'committed', 'declined'];
  var REFERRAL_STATUSES = ['referred', 'contacted', 'evaluating', 'offered', 'committed', 'declined'];
  var OPPORTUNITY_LEVELS = ['collegiate', 'developmental', 'pre-professional', 'semi-professional', 'professional', 'national team'];
  var OPPORTUNITY_TYPES = ['tryout', 'combine', 'other'];
  var MEDIA_KINDS = ['highlight', 'full_game', 'other'];

  function mediaKindLabel(kind) {
    return { highlight: 'Highlight', full_game: 'Full game', other: 'Other' }[kind] || String(kind || '—');
  }

  /* Split a comma-separated input into trimmed, deduped values. */
  function splitCommaList(text) {
    const seen = new Set();
    const out = [];
    for (const part of String(text || '').split(',')) {
      const v = part.trim();
      if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
  }

  /* Verified-metrics editing: the profile stores an object
   * ({'10yd sprint': '1.82 sec'}); the editor is one "Test: value"
   * line per metric. Lines without a colon are ignored. */
  function parseKeyValueLines(text) {
    const out = {};
    String(text || '').split('\n').forEach(function (line) {
      const i = line.indexOf(':');
      if (i > 0) {
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k && v) out[k] = v;
      }
    });
    return out;
  }

  function formatKeyValueLines(obj) {
    return Object.entries(obj || {}).map(function (kv) { return kv[0] + ': ' + kv[1]; }).join('\n');
  }

  /* External video embeds: allowlist only. YouTube (incl. youtu.be)
   * and Vimeo become privacy-enhanced embeds; anything else renders
   * as a plain link — never an iframe. Non-http(s) URLs never embed
   * (and the server refuses them on add). */
  function embedUrlFor(url) {
    if (!url) return null;
    let u;
    try { u = new URL(String(url)); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtube.com') {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) return 'https://www.youtube-nocookie.com/embed/' + v;
      return null;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      if (id && /^[A-Za-z0-9_-]{6,}$/.test(id)) return 'https://www.youtube-nocookie.com/embed/' + id;
      return null;
    }
    if (host === 'vimeo.com') {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      if (id && /^\d+$/.test(id)) return 'https://player.vimeo.com/video/' + id;
      return null;
    }
    return null;
  }

  function mediaEmbedHtml(link) {
    const embed = embedUrlFor(link.url);
    if (embed) {
      return '<div style="margin:6px 0"><iframe src="' + escLocal(embed) + '" title="' + escLocal(link.title || mediaKindLabel(link.kind))
        + '" style="border:1px solid var(--line);width:100%;max-width:560px;aspect-ratio:16/9" allowfullscreen></iframe></div>';
    }
    return '';
  }

  /* ---- trend visualisation (SVG, no dependencies) ---- */

  /* GAA + sport-test display names. Unknown ids fall back to the id
   * itself — the chart never invents a name. */
  var TEST_LABELS = {
    '10yd-sprint': '10-yd sprint', 'broad-jump': 'Broad jump', '5-10-5-shuttle': '5-10-5 shuttle',
    'push-ups': 'Push-ups', 'side-plank-r': 'Side plank — right', 'side-plank-l': 'Side plank — left',
    'single-leg-balance-r': 'Balance — right', 'single-leg-balance-l': 'Balance — left',
    '6min-walk-run': '6-min walk/run',
    'throw-velo': 'Throw velocity', 'throw-accuracy': 'Throw accuracy', 'exit-velo': 'Exit velocity',
    '30m-sprint': '30-m sprint', 't-test-agility': 'T-Test agility',
    'vertical-jump': 'Vertical jump', 'lane-agility': 'Lane agility', '40yd-dash': '40-yd dash',
  };

  /* Lower-is-better tests (timed): personal best is the minimum. */
  var LOWER_BETTER_TESTS = {
    '10yd-sprint': true, '5-10-5-shuttle': true,
    '30m-sprint': true, 't-test-agility': true, 'lane-agility': true, '40yd-dash': true,
  };

  function fmtNum(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }

  /* Maintenance bands (seconds / inches / reps / metres) — the
   * canonical per-test tolerances from server/assessment-battery.js
   * (GAA entries + Pathways sport entries), mirrored here so the
   * browser chart can classify a change exactly the way the
   * canonical progress calculator does (server/progress.js
   * compareValues). Keep this table in sync with that file: a band
   * that drifts here re-opens the caption/calculator disagreement
   * (validation F1, 2026-11-26). Unknown tests fall back to 0, the
   * same fallback the calculator applies when a protocol entry
   * carries no band. */
  var MAINTENANCE_BANDS = {
    '10yd-sprint': 0.05, 'broad-jump': 1, '5-10-5-shuttle': 0.05,
    'push-ups': 1, 'side-plank-r': 3, 'side-plank-l': 3,
    'single-leg-balance-r': 3, 'single-leg-balance-l': 3,
    '6min-walk-run': 10,
    '30m-sprint': 0.05, 't-test-agility': 0.05, 'vertical-jump': 1,
    'lane-agility': 0.05, '40yd-dash': 0.05,
  };

  /* Canonical change status for one test, vs its baseline — the
   * same rule as server/progress.js compareValues, in the same
   * arithmetic order (raw = latest − baseline, then direction),
   * because the order matters in floating point: 2.30 → 2.25 is
   * −0.05 at the 10yd-sprint band edge only when computed this way
   * (raw −0.04999… ≤ 0.05 → maintained); baseline − latest gives
   * 0.05000…04 > 0.05 → improved, and would contradict the
   * calculator. Do not "simplify" this. */
  function trendStatusFor(testId, direction, baseline, latest) {
    const raw = latest - baseline;
    const dir = direction === 'lower' ? -1 : 1;
    const improvement = raw * dir;
    const band = MAINTENANCE_BANDS[testId] != null ? MAINTENANCE_BANDS[testId] : 0;
    return Math.abs(improvement) <= band ? 'maintained'
      : (improvement > 0 ? 'improved' : 'regressed');
  }

  /* Group assessment sessions into per-test series for the chart.
   * sessions: [{completedAt, results:[{assessmentId, result, unit}]}]
   * (the shape athleteHistory returns). Returns one series per test
   * with >= 1 numeric result, sorted by recorded date:
   * {testId, label, unit, direction, points:[{t, value}], baseline,
   * latest, personalBest}. The data layer is progressForAthlete's
   * input shape; the chart only draws it. */
  function trendSeriesFromAssessments(assessments) {
    const byId = {};
    for (const s of (assessments || [])) {
      for (const r of (s.results || [])) {
        if (!r || r.result == null || !Number.isFinite(Number(r.result))) continue;
        if (!byId[r.assessmentId]) {
          byId[r.assessmentId] = { testId: r.assessmentId, unit: r.unit || '', points: [] };
        }
        byId[r.assessmentId].points.push({ t: s.completedAt, value: Number(r.result) });
      }
    }
    return Object.keys(byId).sort().map(function (id) {
      const s = byId[id];
      s.points.sort(function (a, b) { return Date.parse(a.t) - Date.parse(b.t); });
      s.label = TEST_LABELS[id] || id;
      const vals = s.points.map(function (p) { return p.value; });
      s.baseline = vals[0];
      s.latest = vals[vals.length - 1];
      s.personalBest = LOWER_BETTER_TESTS[id]
        ? Math.min.apply(null, vals) : Math.max.apply(null, vals);
      s.direction = LOWER_BETTER_TESTS[id] ? 'lower' : 'higher';
      s.maintenanceBand = MAINTENANCE_BANDS[id] != null ? MAINTENANCE_BANDS[id] : 0;
      /* Canonical status vs baseline (calculator rule, with the
       * maintenance band) — the chart caption reads this, never a
       * recomputed direction. Single-point series are baseline-only. */
      s.status = s.points.length === 1 ? 'baseline-only'
        : trendStatusFor(id, s.direction, s.baseline, s.latest);
      return s;
    });
  }

  /* One small SVG line chart for a single test series: the value
   * line, a dashed tape baseline, and a ★ marker on the personal
   * best. No canvas, no library, same tokens as the rest of the app
   * (1px hairlines, square corners, mono numbers). Returns '' for
   * an empty series. */
  function renderTrendChart(series) {
    if (!series || !series.points || !series.points.length) return '';
    const W = 320, H = 110, PADL = 10, PADR = 10, PADT = 14, PADB = 20;
    const vals = series.points.map(function (p) { return p.value; });
    let min = Math.min.apply(null, vals.concat([series.baseline]));
    let max = Math.max.apply(null, vals.concat([series.baseline]));
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    function x(i) {
      return series.points.length === 1 ? W / 2
        : PADL + (i * (W - PADL - PADR) / (series.points.length - 1));
    }
    function y(v) { return PADT + (1 - (v - min) / span) * (H - PADT - PADB); }
    const pts = series.points.map(function (p, i) {
      return x(i).toFixed(1) + ',' + y(p.value).toFixed(1);
    }).join(' ');
    let pbIdx = -1;
    series.points.forEach(function (p, i) { if (p.value === series.personalBest) pbIdx = i; });
    const yBase = y(series.baseline).toFixed(1);
    const circles = series.points.map(function (p, i) {
      return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="3" style="fill:var(--ink)"/>';
    }).join('');
    const pbMark = pbIdx >= 0
      ? '<circle cx="' + x(pbIdx).toFixed(1) + '" cy="' + y(series.personalBest).toFixed(1) + '" r="6" style="fill:none;stroke:var(--tape);stroke-width:2"/>'
        + '<text x="' + x(pbIdx).toFixed(1) + '" y="' + (y(series.personalBest) - 10).toFixed(1) + '" text-anchor="middle" style="fill:var(--ink);font-size:11px;font-family:var(--mono)">★</text>'
      : '';
    const vsBase = series.points.length > 1
      ? (function () {
        const raw = series.latest - series.baseline;
        /* Canonical status from the progress calculator's rule
         * (maintenance band applied). Prefer the status the series
         * already carries; recompute by the same rule for
         * hand-built series that lack one. Numbers are untouched. */
        const status = (series.status === 'improved' || series.status === 'maintained' || series.status === 'regressed')
          ? series.status
          : trendStatusFor(series.testId, series.direction, series.baseline, series.latest);
        return ' · vs baseline ' + (raw > 0 ? '+' : '') + fmtNum(raw) + ' ' + escLocal(series.unit || '')
          + ' (' + status + ')';
      })()
      : ' · baseline only';
    return '<figure style="margin:0;border:1px solid var(--line);padding:10px;min-width:0">'
      + '<figcaption class="small" style="margin-bottom:6px"><b>' + escLocal(series.label) + '</b>'
      + ' <span class="mono muted">' + escLocal(series.unit || '') + '</span></figcaption>'
      + '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" role="img" aria-label="'
      + escLocal(series.label) + ' trend: baseline ' + fmtNum(series.baseline) + ', latest ' + fmtNum(series.latest)
      + ', personal best ' + fmtNum(series.personalBest) + '">'
      + '<line x1="' + PADL + '" y1="' + yBase + '" x2="' + (W - PADR) + '" y2="' + yBase
      + '" style="stroke:var(--tape);stroke-width:1;stroke-dasharray:4 3"/>'
      + '<text x="' + (W - PADR) + '" y="' + (Number(yBase) - 4).toFixed(1) + '" text-anchor="end" style="fill:var(--muted);font-size:9px;font-family:var(--mono)">baseline ' + fmtNum(series.baseline) + '</text>'
      + '<polyline points="' + pts + '" style="fill:none;stroke:var(--ink);stroke-width:2"/>'
      + circles + pbMark
      + '</svg>'
      + '<figcaption class="small muted" style="margin-top:6px">Baseline <span class="mono">' + fmtNum(series.baseline) + '</span>'
      + ' · Latest <span class="mono">' + fmtNum(series.latest) + '</span>'
      + ' · Personal best <span class="mono">' + fmtNum(series.personalBest) + ' ★</span>' + vsBase + '</figcaption>'
      + '</figure>';
  }

  /* All per-test charts for an athlete's assessment sessions, as a
   * responsive grid. Empty when there are no numeric results. */
  function renderTrendChartsFromAssessments(assessments, h) {
    const series = trendSeriesFromAssessments(assessments || []);
    if (!series.length) {
      return '<p class="muted" style="margin:6px 0 0">No recorded results yet — trends appear after the first assessment.</p>';
    }
    return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:8px">'
      + series.map(function (s) { return renderTrendChart(s); }).join('')
      + '</div>'
      + '<p class="small muted" style="margin:8px 0 0">Compared only to yourself — no norms, percentiles, or rankings. '
      + 'Under-18 athletes: growth and maturation can move results independently of training.</p>';
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
    /* Covered athletes (complimentary / member / sponsored) never
     * see a Subscribe button: the server refuses their checkout
     * with ALREADY_COVERED, and the UI says so instead of offering
     * a purchase. */
    const coveredTier = state.entitlements && state.entitlements.kind === 'athlete'
      ? (state.entitlements.entitlements || {}).tier : null;
    const covered = ['complimentary', 'member', 'sponsored'].indexOf(coveredTier) >= 0;
    const interval = state.interval || 'month';
    const groups = [['athlete', 'For athletes'], ['coach', 'For coaches'], ['organization', 'For teams & academies']];
    let html = testModeNote(h);
    if (covered) {
      html += '<div class="note">Your access is already covered'
        + (coveredTier === 'complimentary' ? ' by a complimentary grant from The Program' : coveredTier === 'member' ? ' by your in-person membership' : ' by your coach / organization')
        + ' — no subscription needed, no purchase offered.</div>';
    }
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
              : covered ? '<span class="lbl ok">Covered — no purchase needed</span>'
              : '<button class="btn sm" data-sui="checkout" data-plan="' + h.esc(p.code) + '" data-audience="' + h.esc(p.audience) + '">Subscribe (test mode)</button>')
            + '</div>';
        }).join('') + '</div>';
    }
    if (state.checkout) {
      /* data-sui-session, never data-session: the prototype's global
       * click handler treats data-session as "open session drawer"
       * (THE PROGRAM OS.html ds.session), which froze the whole app
       * render after a test checkout (validation defect, 2026-11-20). */
      const c = state.checkout;
      html += '<div class="note" style="margin-top:12px">Test checkout session <span class="mono">' + h.esc(c.sessionId) + '</span> — '
        + h.esc(fmtMoney(c.priceCents)) + ' / ' + h.esc(c.interval) + ' for ' + h.esc(c.planCode) + '. '
        + '<button class="btn sm solid" data-sui="confirm-checkout" data-sui-session="' + h.esc(c.sessionId) + '">Confirm test checkout</button> '
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
      if (ent.tier === 'complimentary') {
        html += '<p class="small" style="margin:6px 0 0">No payment prompt appears for complimentary athletes — access is granted, never billed. '
          + 'Checkout is refused for covered athletes (<span class="mono">ALREADY_COVERED</span>).</p>';
      } else if (ent.tier === 'member' || ent.tier === 'sponsored') {
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
    html += renderAthletePathways(state, h);
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

  /* historyOverride: render another athlete's history (coach
   * detail view) instead of state.history. */
  function renderHistoryBlock(state, h, historyOverride) {
    const hist = historyOverride || state.history;
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
            + '<button class="btn sm ghost" data-sui="pathways-open" data-athlete="' + h.esc(a.id) + '">Pathways</button> '
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
    if (state.coachAthleteId) html += renderCoachAthleteDetail(state, h);
    html += renderCrm(state, h);
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

  /* ---- owner console (director only) ---- */

  /* Athlete account list row: { athlete, status,
   * complimentaryGrant: {id, grantedAt, expiresAt, reason} | null,
   * entitlements } — the shape ownerListAthletes returns. */
  function renderDirector(state, h) {
    if (!state.role || state.role.role !== 'director') {
      return '<p class="muted" style="margin:0">Owner console — director only. Coaches see only their linked athletes; athletes see only themselves.</p>';
    }
    let html = '<p class="small muted" style="margin:0 0 10px">Owner account management: create athlete accounts, grant '
      + 'complimentary access, suspend or reactivate accounts, change account roles, and review the audit trail. '
      + 'No card, no subscription, no payment of any kind is involved in any action on this tab.</p>';
    /* Create athlete */
    html += '<div class="grid g2" style="gap:12px">'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Create athlete account</div>'
      + '<div class="stack" style="gap:8px;margin-top:8px">'
      + field(h, 'Name', textInput('sui-owner-ath-name', '', 'Athlete name'))
      + field(h, 'Age (years)', numberInput('sui-owner-ath-age', '', 'e.g. 14', ' min="5"'))
      + field(h, 'Sports (comma separated)', textInput('sui-owner-ath-sports', '', 'Soccer, Baseball'))
      + '<button class="btn sm solid" data-sui="owner-create-athlete">Create athlete</button>'
      + '<p class="small muted" style="margin:0">Manual creation by the owner. Sign-in is linked later; the athlete starts on Athlete Free unless a complimentary grant is added below.</p></div></div>'
      + '<div style="border:1px solid var(--line);padding:12px;min-width:0"><div class="eyebrow">Grant complimentary access</div>'
      + '<div class="stack" style="gap:8px;margin-top:8px">'
      + field(h, 'Athlete', '<select id="sui-grant-athlete" style="' + INPUT_STYLE + '">'
        + ((state.directorAthletes && state.directorAthletes.athletes) || []).map(function (row) {
          return '<option value="' + h.esc(row.athlete.id) + '">' + h.esc(row.athlete.name || row.athlete.id) + '</option>';
        }).join('') + '</select>')
      + field(h, 'Reason (optional)', textInput('sui-grant-reason', '', 'e.g. Walk-On Project pilot'))
      + '<label class="small"><input id="sui-grant-indefinite" type="checkbox" checked> Indefinite (no expiry)</label>'
      + field(h, 'Expiry date (only when not indefinite)', '<input id="sui-grant-expires" type="date" style="' + INPUT_STYLE + '">')
      + '<button class="btn sm solid" data-sui="grant-complimentary">Grant complimentary access</button>'
      + '<p class="small muted" style="margin:0">Complimentary beats every other tier (member, sponsored, paid, free). '
      + 'The athlete never sees a payment prompt or trial notice while the grant is active; revoking or expiry falls back to the next covering source — nothing is deleted.</p></div></div>'
      + '</div>';
    /* Invite (owner) */
    html += '<div style="border:1px solid var(--line);padding:12px;margin-top:12px;min-width:0"><div class="eyebrow">Invite an athlete (owner)</div>'
      + '<div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">'
      + field(h, 'Athlete email', textInput('sui-owner-invite-email', '', 'athlete@example.com'))
      + '</div><div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">'
      + '<button class="btn sm" data-sui="owner-invite-athlete">Create invitation</button></div>'
      + (state.ownerInviteToken ? '<div class="note">Invitation token (shown once — send it to the athlete; no email is sent): <span class="mono" style="word-break:break-all">' + h.esc(state.ownerInviteToken) + '</span></div>' : '')
      + '<p class="small muted" style="margin:6px 0 0">Single-use, 7-day expiry. Only the token hash is stored.</p></div>';
    /* Account list */
    const rows = (state.directorAthletes && state.directorAthletes.athletes) || null;
    html += '<div class="eyebrow" style="margin-top:14px">Athlete accounts'
      + (rows ? ' — ' + rows.length : '') + '</div>';
    if (!rows) {
      html += '<p class="muted" style="margin:6px 0 0">Loading athlete accounts…</p>';
    } else if (!rows.length) {
      html += '<p class="muted" style="margin:6px 0 0">No athlete accounts yet.</p>';
    } else {
      html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Athlete</th><th>Sports</th><th>Tier</th><th>Status</th><th>Complimentary grant</th><th></th></tr>'
        + rows.map(function (row) {
          const a = row.athlete || {};
          const ent = row.entitlements || {};
          const lab = tierLabel(ent);
          const grant = row.complimentaryGrant;
          const suspended = (row.status || a.status || 'active') === 'suspended';
          return '<tr><td><b>' + h.esc(a.name || a.id) + '</b><div class="mono small muted">' + h.esc(a.id) + '</div>'
            + (a.age != null ? '<div class="small muted">Age ' + h.esc(a.age) + '</div>' : '') + '</td>'
            + '<td class="small">' + (((a.sports || []).map(function (s) { return sportLabel(s); }).join(', ')) || '—') + '</td>'
            + '<td><span class="lbl ' + lab.cls + '">' + h.esc(lab.text) + '</span></td>'
            + '<td>' + (suspended ? '<span class="lbl crit">Suspended</span>' : '<span class="lbl ok">Active</span>') + '</td>'
            + '<td class="small">' + (grant
              ? (grant.expiresAt ? 'Expires ' + fmtDate(grant.expiresAt) : 'Indefinite')
                + (grant.reason ? '<div class="muted">' + h.esc(grant.reason) + '</div>' : '')
              : '—') + '</td>'
            + '<td style="white-space:nowrap">'
            + (suspended
              ? '<button class="btn sm" data-sui="reactivate-athlete" data-athlete="' + h.esc(a.id) + '">Reactivate</button> '
              : '<button class="btn sm ghost" data-sui="suspend-athlete" data-athlete="' + h.esc(a.id) + '">Suspend</button> ')
            + (grant ? '<button class="btn sm ghost" data-sui="revoke-grant" data-athlete="' + h.esc(a.id) + '" data-grant="' + h.esc(grant.id) + '">Revoke grant</button> ' : '')
            + '<select id="sui-role-' + h.esc(a.id) + '" style="' + INPUT_STYLE + ';padding:4px" aria-label="Account role for ' + h.esc(a.name || a.id) + '">'
            + ['athlete', 'parent', 'coach'].map(function (r) {
              return '<option value="' + r + '"' + ((a.role || 'athlete') === r ? ' selected' : '') + '>' + r + '</option>';
            }).join('') + '</select> '
            + '<button class="btn sm ghost" data-sui="update-role" data-athlete="' + h.esc(a.id) + '">Set role</button>'
            + '</td></tr>';
        }).join('') + '</table></div>'
        + '<p class="small muted" style="margin:6px 0 0">Suspension is an account state only — it does not by itself change entitlements. '
        + 'Changing a role updates the linked sign-in account; it does not create a new auth identity.</p>';
    }
    /* Audit history */
    const events = (state.auditEvents && state.auditEvents.events) || null;
    html += '<div class="eyebrow" style="margin-top:14px">Audit history</div>';
    if (!events) {
      html += '<p class="muted" style="margin:6px 0 0">Loading audit history…</p>';
    } else if (!events.length) {
      html += '<p class="muted" style="margin:6px 0 0">No audit events yet.</p>';
    } else {
      const shown = events.slice(-50).reverse();
      html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>When</th><th>Action</th><th>Detail</th><th>Actor</th></tr>'
        + shown.map(function (e) {
          const detail = e.detail || {};
          const bits = [];
          if (detail.athleteId) bits.push('athlete ' + String(detail.athleteId).slice(0, 13) + '…');
          if (detail.grantId) bits.push('grant ' + String(detail.grantId).slice(0, 13) + '…');
          if (detail.profileId) bits.push('profile ' + String(detail.profileId).slice(0, 13) + '…');
          if (detail.role) bits.push('role ' + detail.role);
          if (detail.status) bits.push('status ' + detail.status);
          if (detail.expiresAt) bits.push('expires ' + fmtDate(detail.expiresAt));
          return '<tr><td class="small">' + fmtDate(e.at) + '</td><td class="mono small">' + h.esc(e.action) + '</td>'
            + '<td class="small">' + h.esc(bits.join(' · ') || '—') + '</td>'
            + '<td class="mono small">' + h.esc(String(e.actor || '—').slice(0, 20)) + '</td></tr>';
        }).join('') + '</table></div>'
        + '<p class="small muted" style="margin:6px 0 0">Showing the latest ' + shown.length + ' of ' + events.length + ' events. '
        + 'Creation, permission changes, grants, revocations, suspensions, and profile actions are all recorded here.</p>';
    }
    return html;
  }

  /* ---- shared Pathways fragments ---- */

  function measurementsTable(h, measurements) {
    const m = measurements || {};
    const keys = Object.keys(m);
    if (!keys.length) return '<p class="muted" style="margin:6px 0 0">No measurements recorded.</p>';
    return '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Measurement</th><th>Value</th></tr>'
      + keys.map(function (k) {
        return '<tr><td>' + h.esc(k) + '</td><td class="mono">' + h.esc(m[k]) + '</td></tr>';
      }).join('') + '</table></div>';
  }

  function profileSportsLine(h, profile) {
    if (!profile) return '—';
    const bits = [];
    if (profile.primarySport) {
      bits.push('<b>' + h.esc(sportLabel(profile.primarySport)) + '</b>'
        + ((profile.positions || []).length ? ' — ' + h.esc(profile.positions.join(', ')) : ''));
    }
    if (profile.secondarySport) bits.push(h.esc(sportLabel(profile.secondarySport)) + ' (secondary)');
    return bits.join(' · ') || '—';
  }

  function goalsListHtml(h, goals) {
    const rows = goals || [];
    if (!rows.length) return '<p class="muted" style="margin:6px 0 0">No development goals set yet.</p>';
    return '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Goal</th><th>Target date</th><th>Status</th><th></th></tr>'
      + rows.map(function (g) {
        return '<tr><td>' + h.esc(g.goal || g.title || '') + '</td>'
          + '<td class="small">' + (g.targetDate ? fmtDate(g.targetDate) : '—') + '</td>'
          + '<td>' + (g.status === 'completed' ? '<span class="lbl ok">Completed</span>'
            : g.status === 'cancelled' ? '<span class="lbl assume">Cancelled</span>'
            : '<span class="lbl needval">Active</span>') + '</td>'
          + '<td style="white-space:nowrap">'
          + (g.status === 'active'
            ? '<button class="btn sm ghost" data-sui="goal-status" data-goal="' + h.esc(g.id) + '" data-status="completed">Mark complete</button> '
              + '<button class="btn sm ghost" data-sui="goal-status" data-goal="' + h.esc(g.id) + '" data-status="cancelled">Cancel</button>'
            : '')
          + '</td></tr>';
      }).join('') + '</table></div>';
  }

  function evaluationsListHtml(h, evaluations) {
    const rows = evaluations || [];
    if (!rows.length) return '<p class="muted" style="margin:6px 0 0">No scouting evaluations recorded yet.</p>';
    return '<div class="stack" style="gap:8px;margin-top:6px">' + rows.map(function (e) {
      return '<div style="border:1px solid var(--line);padding:10px;min-width:0">'
        + '<p style="margin:0">' + h.esc(e.body || '') + '</p>'
        + '<p class="small muted" style="margin:6px 0 0">' + fmtDate(e.createdAt)
        + (e.coachApproved ? ' · <span class="lbl ok">Coach-approved</span>' : ' · <span class="lbl assume">Not coach-approved</span>')
        + '</p></div>';
    }).join('') + '</div>';
  }

  function mediaListHtml(h, links, profileId) {
    const rows = links || [];
    if (!rows.length) return '<p class="muted" style="margin:6px 0 0">No media links yet. External video links only — no uploads.</p>';
    return '<div class="stack" style="gap:10px;margin-top:6px">' + rows.map(function (m) {
      return '<div style="border:1px solid var(--line);padding:10px;min-width:0">'
        + '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:baseline">'
        + '<span class="lbl v1">' + h.esc(mediaKindLabel(m.kind)) + '</span>'
        + '<b>' + h.esc(m.title || m.url) + '</b></div>'
        + mediaEmbedHtml(m)
        + '<p class="small" style="margin:6px 0 0"><a href="' + h.esc(m.url) + '" target="_blank" rel="noopener">'
        + h.esc(m.url) + '</a></p>'
        + (profileId ? '<button class="btn sm ghost" data-sui="media-remove" data-media="' + h.esc(m.id) + '" data-profile="' + h.esc(profileId) + '">Remove link</button>' : '')
        + '</div>';
    }).join('') + '</div>';
  }

  /* ---- athlete portal: Pathways sections ---- */

  function renderAthletePathways(state, h) {
    const bundle = state.pathways;
    let html = '<div class="eyebrow" style="margin-top:14px">Athlete pathways</div>';
    if (bundle === undefined) {
      return html + '<p class="muted" style="margin:6px 0 0">Loading pathways…</p>';
    }
    if (bundle === null) {
      return html + '<p class="muted" style="margin:6px 0 0">No prospect profile yet — your coach creates one, and you approve sharing. Development goals, coach feedback, and media appear here once they exist.</p>';
    }
    const profile = bundle.profile || null;
    if (profile) {
      const lab = profileStatusLabel(profile.status);
      html += '<div style="border:1px solid var(--line);padding:12px;margin-top:6px;min-width:0">'
        + '<div class="eyebrow">Your prospect profile</div>'
        + '<p style="margin:6px 0"><span class="lbl ' + lab.cls + '">' + h.esc(lab.text) + '</span> '
        + '<span class="small muted">' + profileSportsLine(h, profile) + '</span></p>'
        + (profile.bio ? '<p class="small" style="margin:6px 0">' + h.esc(profile.bio) + '</p>' : '')
        + measurementsTable(h, profile.measurements)
        + ((profile.accomplishments || []).length
          ? '<p class="small" style="margin:8px 0 0"><b>Accomplishments:</b> ' + h.esc(profile.accomplishments.join(' · ')) + '</p>' : '')
        + (profile.availability ? '<p class="small" style="margin:6px 0 0"><b>Availability:</b> ' + h.esc(profile.availability) + '</p>' : '')
        + '<p class="small muted" style="margin:8px 0 0">Approval status: athlete '
        + (profile.athleteApprovedAt ? 'approved ' + fmtDate(profile.athleteApprovedAt) : 'not yet approved')
        + ' · coach ' + (profile.coachApprovedAt ? 'approved ' + fmtDate(profile.coachApprovedAt) : 'not yet approved')
        + '. Sharing needs both approvals' + ' (and guardian consent for minors). Editing an approved profile re-opens it to draft.</p>'
        + (!profile.athleteApprovedAt
          ? '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn sm solid" data-sui="approve-profile" data-profile="' + h.esc(profile.id) + '">Approve sharing</button>'
            + '<span class="small muted">Approving lets your coach share this profile with recruiters via a private link. The profile stays private until then.</span></div>'
          : '')
        + '</div>';
    } else {
      html += '<p class="muted" style="margin:6px 0 0">No prospect profile yet — your coach creates one, and you approve sharing.</p>';
    }
    html += '<div class="eyebrow" style="margin-top:14px">Development goals</div>'
      + goalsListHtml(h, bundle.developmentGoals);
    html += '<div class="eyebrow" style="margin-top:14px">Coach feedback</div>'
      + evaluationsListHtml(h, bundle.scoutingEvaluations);
    html += '<div class="eyebrow" style="margin-top:14px">Media portfolio</div>'
      + mediaListHtml(h, bundle.mediaLinks, null)
      + '<p class="small muted" style="margin:6px 0 0">Approved external video links only — no uploads, no storage. Embeds play only for YouTube and Vimeo links; everything else is a plain link.</p>';
    html += '<div class="eyebrow" style="margin-top:14px">Recruitment opportunities</div>';
    /* Server-backed (G1 fix): referrals and opportunities about
     * this athlete, loaded via listReferrals / listOpportunities.
     * Recruitment is still managed by the coach — this is a
     * read-only view of the athlete's own pipeline. */
    const opps = bundle.opportunities || [];
    const refs = bundle.referrals || [];
    if (!opps.length && !refs.length) {
      html += '<p class="muted" style="margin:6px 0 0">No recruitment opportunities yet.</p>';
    } else {
      if (opps.length) {
        html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Opportunity</th><th>Organization</th><th>Date</th><th>Notes</th></tr>'
          + opps.map(function (o) {
            return '<tr><td>' + h.esc(o.type || '') + '</td><td>' + h.esc(o.organization || o.orgName || '—') + '</td>'
              + '<td class="small">' + (o.date ? fmtDate(o.date) : '—') + '</td><td class="small">' + h.esc(o.notes || '—') + '</td></tr>';
          }).join('') + '</table></div>';
      }
      if (refs.length) {
        html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Referral</th><th>Organization</th><th>Stage</th><th>Outcome</th><th>Referred</th></tr>'
          + refs.map(function (r) {
            return '<tr><td class="small">Referred to recruiter</td><td>' + h.esc(r.organization || r.orgName || '—') + '</td>'
              + '<td><span class="lbl v1">' + h.esc(r.status || '—') + '</span></td><td class="small">' + h.esc(r.outcome || '—') + '</td>'
              + '<td class="small">' + (r.referredAt ? fmtDate(r.referredAt) : '—') + '</td></tr>';
          }).join('') + '</table></div>';
      }
    }
    const hist = state.history;
    html += '<div class="eyebrow" style="margin-top:14px">Progress trends</div>';
    if (hist && hist.assessments && hist.assessments.length) {
      html += renderTrendChartsFromAssessments(hist.assessments, h);
    } else {
      html += '<p class="muted" style="margin:6px 0 0">No recorded results yet — trends appear after the first assessment.</p>';
    }
    return html;
  }

  /* ---- coach portal: athlete Pathways detail ---- */

  function renderCoachAthleteDetail(state, h) {
    const athleteId = state.coachAthleteId;
    if (!athleteId) return '';
    const bundle = state.coachPathways;
    const profile = bundle && bundle.profile ? bundle.profile : null;
    let html = '<div style="border:1px solid var(--line);padding:12px;margin-top:14px;min-width:0">'
      + '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:baseline">'
      + '<div class="eyebrow">Athlete pathways — ' + h.esc(h.athleteName(athleteId)) + '</div>'
      + '<button class="btn sm ghost" data-sui="pathways-close">Close</button></div>';
    if (bundle === undefined || bundle === null) {
      html += '<p class="muted" style="margin:8px 0 0">Loading pathways…</p></div>';
      return html;
    }
    /* Attendance / training history (existing athleteHistory, wired in). */
    html += '<div class="eyebrow" style="margin-top:10px">Attendance &amp; training history</div>';
    if (state.coachHistory) {
      html += renderHistoryBlock(state, h, state.coachHistory);
    } else {
      html += '<p class="muted" style="margin:6px 0 0">Loading history…</p>';
    }
    /* Assign sport + positions */
    const currentSports = (bundle.athlete && bundle.athlete.sports) || [];
    html += '<div class="eyebrow" style="margin-top:14px">Sport &amp; positions</div>'
      + '<p class="small muted" style="margin:6px 0">Current sports: ' + (currentSports.length ? h.esc(currentSports.map(sportLabel).join(', ')) : 'none assigned yet') + '.</p>'
      + '<div class="row" style="gap:10px;flex-wrap:wrap">'
      + field(h, 'Sport', '<select id="sui-path-sport" style="' + INPUT_STYLE + '">'
        + SPORT_IDS.map(function (s) {
          return '<option value="' + s + '"' + (profile && profile.primarySport === s ? ' selected' : '') + '>' + h.esc(sportLabel(s)) + '</option>';
        }).join('') + '</select>')
      + field(h, 'Positions (comma separated)', textInput('sui-path-positions', profile ? (profile.positions || []).join(', ') : '', 'e.g. Point guard, Shooting guard'))
      + '</div><div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">'
      + '<button class="btn sm solid" data-sui="assign-sport" data-athlete="' + h.esc(athleteId) + '">Assign sport</button></div>'
      + '<details class="small muted" style="margin-top:6px"><summary>Suggested positions per sport</summary>'
      + SPORT_IDS.map(function (s) { return '<p style="margin:4px 0"><b>' + h.esc(sportLabel(s)) + ':</b> ' + h.esc(positionsFor(s).join(', ')) + '</p>'; }).join('')
      + '</details>';
    /* Development goals */
    html += '<div class="eyebrow" style="margin-top:14px">Development goals</div>'
      + goalsListHtml(h, bundle.developmentGoals)
      + '<div class="row" style="gap:10px;margin-top:8px;flex-wrap:wrap">'
      + field(h, 'New goal', textInput('sui-goal-text', '', 'e.g. Hold a 60-second side plank each side'))
      + field(h, 'Target date', '<input id="sui-goal-date" type="date" style="' + INPUT_STYLE + '">')
      + '</div><div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">'
      + '<button class="btn sm solid" data-sui="goal-add" data-athlete="' + h.esc(athleteId) + '">Add goal</button></div>'
      + '<p class="small muted" style="margin:6px 0 0">Goals are coach-set and visible to the athlete. Completing one is a status change, never a score.</p>';
    /* Scouting evaluations */
    html += '<div class="eyebrow" style="margin-top:14px">Scouting evaluations</div>'
      + evaluationsListHtml(h, bundle.scoutingEvaluations)
      + '<div class="stack" style="gap:8px;margin-top:8px">'
      + field(h, 'New evaluation (coach-authored)', '<textarea id="sui-eval-body" rows="3" style="' + INPUT_STYLE + ';width:100%" placeholder="What you observed, in plain language — strengths, areas to develop, context."></textarea>')
      + '<div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn sm solid" data-sui="eval-add" data-athlete="' + h.esc(athleteId) + '">Record evaluation</button></div></div>'
      + '<p class="small muted" style="margin:6px 0 0">Coach-authored evaluations are coach-approved on record. Only coach-approved evaluations enter a shared public profile.</p>';
    /* Prospect profile editor */
    html += '<div class="eyebrow" style="margin-top:14px">Prospect profile</div>';
    if (profile) {
      const lab = profileStatusLabel(profile.status);
      html += '<p style="margin:6px 0"><span class="lbl ' + lab.cls + '">' + h.esc(lab.text) + '</span> '
        + '<span class="small muted">' + profileSportsLine(h, profile) + '</span></p>'
        + '<p class="small muted" style="margin:6px 0">Approval: athlete '
        + (profile.athleteApprovedAt ? 'approved ' + fmtDate(profile.athleteApprovedAt) : 'not yet approved')
        + ' · coach ' + (profile.coachApprovedAt ? 'approved ' + fmtDate(profile.coachApprovedAt) : 'not yet approved')
        + '. Editing an approved profile re-opens it to draft.</p>';
    } else {
      html += '<p class="muted" style="margin:6px 0 0">No prospect profile yet for this athlete.</p>';
    }
    html += '<div class="grid g2" style="gap:12px;margin-top:8px">'
      + field(h, 'Primary sport', '<select id="sui-prof-sport" style="' + INPUT_STYLE + '">'
        + SPORT_IDS.map(function (s) {
          return '<option value="' + s + '"' + (profile && profile.primarySport === s ? ' selected' : '') + '>' + h.esc(sportLabel(s)) + '</option>';
        }).join('') + '</select>')
      + field(h, 'Secondary sport (optional)', '<select id="sui-prof-sport2" style="' + INPUT_STYLE + '"><option value="">— none —</option>'
        + SPORT_IDS.map(function (s) {
          return '<option value="' + s + '"' + (profile && profile.secondarySport === s ? ' selected' : '') + '>' + h.esc(sportLabel(s)) + '</option>';
        }).join('') + '</select>')
      + field(h, 'Positions (comma separated)', textInput('sui-prof-positions', profile ? (profile.positions || []).join(', ') : '', 'e.g. Point guard, Shooting guard'))
      + field(h, 'Availability', textInput('sui-prof-availability', profile ? (profile.availability || '') : '', 'e.g. Available for showcases from Jan 2027'))
      + field(h, 'Bio', '<textarea id="sui-prof-bio" rows="3" style="' + INPUT_STYLE + ';width:100%" placeholder="Short bio — school/club, playing background, what stands out.">' + escLocal(profile ? (profile.bio || '') : '') + '</textarea>')
      + field(h, 'Measurements — height', textInput('sui-prof-height', profile && profile.measurements ? (profile.measurements.height || '') : '', 'e.g. 5 ft 10 in'))
      + field(h, 'Measurements — weight', textInput('sui-prof-weight', profile && profile.measurements ? (profile.measurements.weight || '') : '', 'e.g. 150 lb'))
      + field(h, 'Measurements — dominant hand / foot', textInput('sui-prof-handedness', profile && profile.measurements ? (profile.measurements.handedness || '') : '', 'e.g. Right hand, left foot'))
      + field(h, 'Accomplishments (one per line)', '<textarea id="sui-prof-accomp" rows="3" style="' + INPUT_STYLE + ';width:100%">' + escLocal(profile ? (profile.accomplishments || []).join('\n') : '') + '</textarea>')
      + field(h, 'Playing history (one per line)', '<textarea id="sui-prof-history" rows="3" style="' + INPUT_STYLE + ';width:100%">' + escLocal(profile ? (profile.playingHistory || []).join('\n') : '') + '</textarea>')
      + field(h, 'Verified metrics (one "Test: value" per line)', '<textarea id="sui-prof-metrics" rows="3" style="' + INPUT_STYLE + ';width:100%" placeholder="10yd sprint: 1.82 sec">' + escLocal(profile ? formatKeyValueLines(profile.verifiedMetrics) : '') + '</textarea>')
      + field(h, 'Contact email (never public)', textInput('sui-prof-contact-email', profile && profile.contactInfo ? (profile.contactInfo.email || '') : '', 'Recruiter contact email — shown to the coach only'))
      + field(h, 'Contact phone (never public)', textInput('sui-prof-contact-phone', profile && profile.contactInfo ? (profile.contactInfo.phone || '') : '', 'Shown to the coach only'))
      + '</div>'
      + '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">'
      + '<button class="btn sm solid" data-sui="profile-save" data-athlete="' + h.esc(athleteId) + '"' + (profile ? ' data-profile="' + h.esc(profile.id) + '"' : '') + '">'
      + (profile ? 'Save profile changes' : 'Create prospect profile') + '</button>'
      + (profile && !profile.coachApprovedAt
        ? '<button class="btn sm" data-sui="approve-profile-coach" data-profile="' + h.esc(profile.id) + '">Approve as coach</button>' : '')
      + '</div>'
      + '<p class="small muted" style="margin:6px 0 0">Verified metrics are coach-recorded measurements — never norms, percentiles, or rankings. '
      + 'Contact info is stored for the coach only and never appears on a shared profile.</p>';
    /* Media links */
    html += '<div class="eyebrow" style="margin-top:14px">Media portfolio</div>'
      + mediaListHtml(h, bundle.mediaLinks, profile ? profile.id : null);
    if (profile) {
      html += '<div class="row" style="gap:10px;margin-top:8px;flex-wrap:wrap">'
        + field(h, 'Kind', '<select id="sui-media-kind" style="' + INPUT_STYLE + '"><option value="highlight">Highlight</option><option value="full_game">Full game</option><option value="other">Other</option></select>')
        + field(h, 'Title', textInput('sui-media-title', '', 'e.g. Spring showcase highlights'))
        + field(h, 'URL (http(s) only)', textInput('sui-media-url', '', 'https://…'))
        + '</div><div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">'
        + '<button class="btn sm solid" data-sui="media-add" data-profile="' + h.esc(profile.id) + '">Add media link</button></div>'
        + '<p class="small muted" style="margin:6px 0 0">External links only — no uploads, no storage. YouTube and Vimeo links embed; everything else is a plain link.</p>';
    }
    /* Share links */
    html += '<div class="eyebrow" style="margin-top:14px">Share links</div>';
    if (!profile) {
      html += '<p class="muted" style="margin:6px 0 0">Create a prospect profile first.</p>';
    } else if (profile.status !== 'approved') {
      html += '<p class="muted" style="margin:6px 0 0">Sharing opens once the profile is approved by both athlete and coach'
        + (profile.status === 'pending_approval' ? ' — one approval is still missing.' : ' — approvals are still missing.') + '</p>';
    } else {
      html += '<div class="row" style="gap:10px;margin-top:8px;flex-wrap:wrap">'
        + field(h, 'Expires (optional, default 7 days)', '<input id="sui-share-expires" type="date" style="' + INPUT_STYLE + '">')
        + '</div><div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">'
        + '<button class="btn sm solid" data-sui="share-create" data-profile="' + h.esc(profile.id) + '">Create share link</button></div>'
        + (state.shareUrl ? '<div class="note">Share link (shown once — copy it now): <a class="mono" style="word-break:break-all" href="' + h.esc(state.shareUrl) + '">' + h.esc(state.shareUrl) + '</a></div>' : '');
      const shares = bundle.shares || [];
      if (!shares.length) {
        html += '<p class="muted" style="margin:6px 0 0">No share links yet.</p>';
      } else {
        html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Share</th><th>Expires</th><th>Status</th><th></th></tr>'
          + shares.map(function (s) {
            return '<tr><td class="mono small">' + h.esc(s.id) + '</td>'
              + '<td class="small">' + fmtDate(s.expiresAt) + '</td>'
              + '<td>' + (s.status === 'active' ? '<span class="lbl ok">Active</span>' : '<span class="lbl assume">' + h.esc(s.status) + '</span>') + '</td>'
              + '<td>' + (s.status === 'active' ? '<button class="btn sm ghost" data-sui="share-revoke" data-share="' + h.esc(s.id) + '" data-profile="' + h.esc(profile.id) + '">Revoke</button>' : '') + '</td></tr>';
          }).join('') + '</table></div>';
      }
      html += '<p class="small muted" style="margin:6px 0 0">A revoked or expired link shows a neutral refusal and leaks no profile data.</p>';
    }
    html += '</div>';
    return html;
  }

  /* ---- coach portal: recruitment CRM ---- */

  function renderCrm(state, h) {
    let html = '<div class="eyebrow" style="margin-top:14px">Recruitment CRM</div>'
      + '<p class="small muted" style="margin:6px 0">Contacts are yours (coaches see only the contacts they created; directors see all). '
      + 'Opportunities, notes, and referrals attach to a contact. Follow-up dates keep the pipeline honest — nothing here sends email or messages anyone.</p>';
    const contacts = (state.crmContacts && state.crmContacts.contacts) || null;
    if (!contacts) {
      html += '<p class="muted" style="margin:6px 0 0">Loading contacts…</p>';
    } else if (!contacts.length) {
      html += '<p class="muted" style="margin:6px 0 0">No recruitment contacts yet.</p>';
    } else {
      html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Organization</th><th>Level</th><th>Sport</th><th>Contact</th><th>Status</th><th></th></tr>'
        + contacts.map(function (c) {
          return '<tr><td><b>' + h.esc(c.orgName) + '</b>' + (c.league ? '<div class="small muted">' + h.esc(c.league) + '</div>' : '') + '</td>'
            + '<td class="small">' + h.esc(c.level || '—') + '</td>'
            + '<td class="small">' + (c.sport ? h.esc(sportLabel(c.sport)) : '—') + '</td>'
            + '<td class="small">' + h.esc(c.contactName || '—') + (c.title ? '<div class="muted">' + h.esc(c.title) + '</div>' : '') + '</td>'
            + '<td><span class="lbl ' + (c.status === 'new' ? 'needval' : c.status === 'committed' ? 'ok' : c.status === 'declined' ? 'crit' : 'v1') + '">' + h.esc(c.status) + '</span></td>'
            + '<td style="white-space:nowrap"><button class="btn sm" data-sui="crm-contact-open" data-contact="' + h.esc(c.id) + '">Open</button></td></tr>';
        }).join('') + '</table></div>';
    }
    /* Create contact */
    html += '<div style="border:1px solid var(--line);padding:12px;margin-top:10px;min-width:0"><div class="eyebrow">Add a recruitment contact</div>'
      + '<div class="grid g2" style="gap:12px;margin-top:8px">'
      + field(h, 'Organization name', textInput('sui-crm-org', '', 'e.g. River State University'))
      + field(h, 'Sport', '<select id="sui-crm-sport" style="' + INPUT_STYLE + '"><option value="">—</option>'
        + SPORT_IDS.map(function (s) { return '<option value="' + s + '">' + h.esc(sportLabel(s)) + '</option>'; }).join('') + '</select>')
      + field(h, 'Level', '<select id="sui-crm-level" style="' + INPUT_STYLE + '"><option value="">—</option>'
        + OPPORTUNITY_LEVELS.map(function (l) { return '<option value="' + h.esc(l) + '">' + h.esc(l) + '</option>'; }).join('') + '</select>')
      + field(h, 'Region', textInput('sui-crm-region', '', 'e.g. WA'))
      + field(h, 'League', textInput('sui-crm-league', '', 'e.g. NCAA D-II'))
      + field(h, 'Contact name', textInput('sui-crm-name', '', 'e.g. Coach Rivera'))
      + field(h, 'Title', textInput('sui-crm-title', '', 'e.g. Recruiting coordinator'))
      + field(h, 'Email', textInput('sui-crm-email', '', 'coach@example.edu'))
      + field(h, 'Status', '<select id="sui-crm-status" style="' + INPUT_STYLE + '">'
        + CONTACT_STATUSES.map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('') + '</select>')
      + '</div><div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">'
      + '<button class="btn sm solid" data-sui="crm-contact-add">Add contact</button></div></div>';
    /* Contact detail */
    if (state.crmContactId) {
      const contact = (contacts || []).find(function (c) { return String(c.id) === String(state.crmContactId); });
      html += renderCrmContactDetail(state, h, contact);
    }
    return html;
  }

  function renderCrmContactDetail(state, h, contact) {
    if (!contact) return '<p class="muted" style="margin:10px 0 0">Contact not found.</p>';
    const activity = state.crmActivity || { opportunities: [], notes: [], referrals: [] };
    const opps = activity.opportunities.filter(function (o) { return String(o.contactId) === String(contact.id); });
    const notes = activity.notes.filter(function (n) { return String(n.contactId) === String(contact.id); });
    const refs = activity.referrals.filter(function (r) { return String(r.contactId) === String(contact.id); });
    const roster = (state.roster && state.roster.athletes) || [];
    let html = '<div style="border:1px solid var(--line);padding:12px;margin-top:12px;min-width:0">'
      + '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:baseline">'
      + '<div class="eyebrow">' + h.esc(contact.orgName) + ' — pipeline</div>'
      + '<button class="btn sm ghost" data-sui="crm-contact-close">Close</button></div>'
      + '<p class="small muted" style="margin:6px 0">Status: <b>' + h.esc(contact.status) + '</b> · '
      + h.esc(contact.contactName || 'No named contact')
      + (contact.email ? ' · ' + h.esc(contact.email) : '') + '</p>'
      + '<div class="row" style="gap:10px;flex-wrap:wrap">'
      + field(h, 'Update status', '<select id="sui-crm-contact-status" style="' + INPUT_STYLE + '">'
        + CONTACT_STATUSES.map(function (s) {
          return '<option value="' + s + '"' + (contact.status === s ? ' selected' : '') + '>' + s + '</option>';
        }).join('') + '</select>')
      + '</div><div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">'
      + '<button class="btn sm" data-sui="crm-contact-update" data-contact="' + h.esc(contact.id) + '">Update status</button></div>';
    /* Opportunities (server-backed: reloaded on open and after
     * every change, so they survive a refresh) */
    html += '<div class="eyebrow" style="margin-top:12px">Opportunities</div>';
    if (!opps.length) {
      html += '<p class="muted" style="margin:6px 0 0">No opportunities recorded for this contact yet.</p>';
    } else {
      html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Type</th><th>Date</th><th>Notes</th></tr>'
        + opps.map(function (o) {
          return '<tr><td>' + h.esc(o.type) + '</td><td class="small">' + (o.date ? fmtDate(o.date) : '—') + '</td><td class="small">' + h.esc(o.notes || '') + '</td></tr>';
        }).join('') + '</table></div>';
    }
    html += '<div class="row" style="gap:10px;margin-top:8px;flex-wrap:wrap">'
      + field(h, 'Type', '<select id="sui-crm-opp-type" style="' + INPUT_STYLE + '">'
        + OPPORTUNITY_TYPES.map(function (t) { return '<option value="' + t + '">' + t + '</option>'; }).join('') + '</select>')
      + field(h, 'Date', '<input id="sui-crm-opp-date" type="date" style="' + INPUT_STYLE + '">')
      + field(h, 'Notes', textInput('sui-crm-opp-notes', '', 'e.g. Showcase invite'))
      + '</div><div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">'
      + '<button class="btn sm solid" data-sui="crm-opp-add" data-contact="' + h.esc(contact.id) + '">Add opportunity</button></div>';
    /* Notes */
    html += '<div class="eyebrow" style="margin-top:12px">Notes &amp; follow-ups</div>';
    if (!notes.length) {
      html += '<p class="muted" style="margin:6px 0 0">No notes yet.</p>';
    } else {
      html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Note</th><th>Follow-up</th><th>When</th></tr>'
        + notes.map(function (n) {
          return '<tr><td>' + h.esc(n.body) + '</td><td class="small">' + (n.followUpDate ? fmtDate(n.followUpDate) : '—') + '</td><td class="small">' + fmtDate(n.createdAt) + '</td></tr>';
        }).join('') + '</table></div>';
    }
    html += '<div class="row" style="gap:10px;margin-top:8px;flex-wrap:wrap">'
      + field(h, 'Note', textInput('sui-crm-note-body', '', 'e.g. Called — asked for spring film'))
      + field(h, 'Follow-up date', '<input id="sui-crm-note-followup" type="date" style="' + INPUT_STYLE + '">')
      + '</div><div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">'
      + '<button class="btn sm solid" data-sui="crm-note-add" data-contact="' + h.esc(contact.id) + '">Add note</button></div>';
    /* Referrals */
    html += '<div class="eyebrow" style="margin-top:12px">Referrals</div>';
    if (!refs.length) {
      html += '<p class="muted" style="margin:6px 0 0">No athletes referred to this contact yet.</p>';
    } else {
      html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Athlete</th><th>Status</th><th>Outcome</th><th></th></tr>'
        + refs.map(function (r) {
          return '<tr><td>' + h.esc(h.athleteName(r.athleteId)) + '</td>'
            + '<td><span class="lbl v1">' + h.esc(r.status) + '</span></td>'
            + '<td class="small">' + h.esc(r.outcome || '—') + '</td>'
            + '<td style="white-space:nowrap"><select id="sui-crm-ref-' + h.esc(r.id) + '" style="' + INPUT_STYLE + ';padding:4px">'
            + REFERRAL_STATUSES.map(function (s) {
              return '<option value="' + s + '"' + (r.status === s ? ' selected' : '') + '>' + s + '</option>';
            }).join('') + '</select> '
            + '<button class="btn sm ghost" data-sui="crm-referral-status" data-referral="' + h.esc(r.id) + '">Update</button></td></tr>';
        }).join('') + '</table></div>';
    }
    if (roster.length) {
      html += '<div class="row" style="gap:10px;margin-top:8px;flex-wrap:wrap">'
        + field(h, 'Refer an athlete', '<select id="sui-crm-refer-athlete" style="' + INPUT_STYLE + '">'
          + roster.map(function (row) {
            const a = row.athlete || {};
            return '<option value="' + h.esc(a.id) + '">' + h.esc(a.name || a.id) + '</option>';
          }).join('') + '</select>')
        + '</div><div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">'
        + '<button class="btn sm solid" data-sui="crm-refer-add" data-contact="' + h.esc(contact.id) + '">Refer athlete</button></div>';
    }
    html += '<p class="small muted" style="margin:8px 0 0">Opportunities, notes, and referrals load from the server — '
      + 'they are reloaded when this contact is opened and after every change, so they survive a refresh. Contacts themselves reload from the server.</p>';
    html += '</div>';
    return html;
  }

  /* ---- public prospect profile (prospect.html) ---- */

  /* Renders ONLY the server's public view (profileId, athleteName
   * when name display is authorized, bio, sports, positions,
   * measurements, accomplishments, playing history, verified
   * metrics, availability, media links, coach-approved scouting
   * evaluations). The name appears ONLY when the server sent it —
   * athlete + coach approval (+ guardian consent if minor) — and
   * the UI never fetches one itself. Contact info is never
   * rendered even if present in the object passed in. */
  function renderPublicProfile(pub, h) {
    const p = pub || {};
    const heading = p.athleteName ? h.esc(p.athleteName) : 'Prospect profile';
    let html = '<div class="eyebrow">Prospect profile · ' + h.esc(sportLabel(p.primarySport)) + '</div>'
      + '<h1 class="disp" style="margin:8px 0">' + heading + '</h1>'
      + '<p class="muted" style="max-width:62ch">A coach-approved prospect profile from THE PROGRAM. '
      + 'Shared privately by link — profiles are private by default and shared only with athlete and coach approval.</p>'
      + '<div style="border:1px solid var(--line);background:var(--surface);padding:16px;margin:14px 0;max-width:320px">'
      + '<div style="border:1px solid var(--line-strong);background:var(--sunk);aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px">'
      + '<span class="mono" style="font-size:11px;letter-spacing:.12em">PHOTO PLACEHOLDER</span>'
      + '<span class="small muted">Synthetic placeholder — no real photo</span></div>'
      + '<p class="small muted" style="margin:10px 0 0">No photo is published with a prospect profile unless the athlete and coach add one.</p></div>';
    if (p.bio) html += '<p style="max-width:62ch">' + h.esc(p.bio) + '</p>';
    html += '<div class="grid g2" style="gap:16px;margin-top:14px">'
      + '<div><div class="eyebrow">Sport &amp; positions</div>'
      + '<p style="margin:6px 0">' + profileSportsLine(h, p) + '</p>'
      + ((p.playingHistory || []).length
        ? '<div class="eyebrow" style="margin-top:12px">Playing history</div><ul class="small" style="margin:6px 0;padding-left:18px">'
          + p.playingHistory.map(function (x) { return '<li>' + h.esc(x) + '</li>'; }).join('') + '</ul>' : '')
      + ((p.accomplishments || []).length
        ? '<div class="eyebrow" style="margin-top:12px">Accomplishments</div><ul class="small" style="margin:6px 0;padding-left:18px">'
          + p.accomplishments.map(function (x) { return '<li>' + h.esc(x) + '</li>'; }).join('') + '</ul>' : '')
      + (p.availability ? '<div class="eyebrow" style="margin-top:12px">Availability</div><p class="small" style="margin:6px 0">' + h.esc(p.availability) + '</p>' : '')
      + '</div>'
      + '<div><div class="eyebrow">Measurements</div>' + measurementsTable(h, p.measurements)
      + '<div class="eyebrow" style="margin-top:12px">Verified metrics</div>';
    const metrics = p.verifiedMetrics || {};
    const mkeys = Object.keys(metrics);
    if (!mkeys.length) {
      html += '<p class="muted small" style="margin:6px 0 0">No verified metrics published.</p>';
    } else {
      html += '<div class="tbl-wrap" style="margin-top:6px"><table class="t"><tr><th>Test</th><th>Result</th></tr>'
        + mkeys.map(function (k) {
          return '<tr><td>' + h.esc(k) + '</td><td class="mono">' + h.esc(metrics[k]) + '</td></tr>';
        }).join('') + '</table></div>';
    }
    html += '<p class="small muted" style="margin:6px 0 0">Coach-recorded measurements from an unvalidated battery — never norms, percentiles, or rankings.</p>'
      + '</div></div>';
    const media = p.mediaLinks || [];
    if (media.length) {
      html += '<div class="eyebrow" style="margin-top:14px">Video</div>'
        + '<div class="stack" style="gap:10px;margin-top:6px">' + media.map(function (m) {
          return '<div style="border:1px solid var(--line);padding:10px;min-width:0">'
            + '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:baseline"><span class="lbl v1">' + h.esc(mediaKindLabel(m.kind)) + '</span>'
            + '<b>' + h.esc(m.title || m.url) + '</b></div>'
            + mediaEmbedHtml(m)
            + '<p class="small" style="margin:6px 0 0"><a href="' + h.esc(m.url) + '" target="_blank" rel="noopener">' + h.esc(m.url) + '</a></p></div>';
        }).join('') + '</div>';
    }
    const evals = p.scoutingEvaluations || [];
    if (evals.length) {
      html += '<div class="eyebrow" style="margin-top:14px">Coach scouting evaluation</div>'
        + '<div class="stack" style="gap:8px;margin-top:6px">' + evals.map(function (e) {
          return '<div style="border:1px solid var(--line);padding:10px;min-width:0"><p style="margin:0">' + h.esc(e.body || '') + '</p>'
            + (e.approvedAt ? '<p class="small muted" style="margin:6px 0 0">Coach-approved ' + fmtDate(e.approvedAt) + '</p>' : '') + '</div>';
        }).join('') + '</div>';
    }
    html += '<div class="note" style="margin-top:18px"><b>Contact:</b> recruitment enquiries go through THE PROGRAM — '
      + 'ask the athlete\u2019s coach for an introduction. No personal contact details are published on a prospect profile.</div>';
    return html;
  }

  /* Neutral refusal: no athlete data of any kind, no hint about
   * whether the token, the profile, or the approval is the problem. */
  function renderPublicRefusal(h) {
    return '<div class="eyebrow">Prospect profile</div>'
      + '<h1 class="disp" style="margin:8px 0">This profile is not available.</h1>'
      + '<p class="muted" style="max-width:62ch">Prospect profiles are private by default. This link may have expired, been revoked, '
      + 'or the profile may not be approved for sharing. If you were sent this link, ask the sender for a fresh one.</p>'
      + '<p class="small muted">THE PROGRAM — Play with purpose.</p>';
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

  /* Production sign-in panel. Shown instead of the hub whenever the
   * app runs off localhost without a signed-in session. Accounts are
   * created by the director — there is no self-registration here. */
  function renderSignIn(state, h) {
    return '<p style="margin:0 0 8px">Sign in with your THE PROGRAM account to continue. '
      + 'Accounts are created by the director; if you do not have one yet, ask them.</p>'
      + '<div class="grid g2" style="gap:12px;max-width:560px">'
      + '<label class="small">Email <input id="sui-auth-email" type="email" autocomplete="username" style="width:100%;padding:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink)"></label>'
      + '<label class="small">Password <input id="sui-auth-password" type="password" autocomplete="current-password" style="width:100%;padding:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink)"></label>'
      + '</div>'
      + '<div class="row" style="gap:8px;margin-top:12px"><button class="btn solid sm" data-sui="auth-sign-in">Sign in</button></div>';
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
    /* Production: the dev "View as" switcher is gone. A signed-in
     * user gets a sign-out button; everyone else gets the gate. */
    if (!h.devMode && state.authStatus === 'signed-in') {
      right += ' <button class="btn sm ghost" data-sui="auth-sign-out">Sign out' + (state.authUser && state.authUser.email ? ' (' + h.esc(state.authUser.email) + ')' : '') + '</button>';
    }
    right += ' <button class="btn sm ghost" data-sui="refresh">Refresh</button>';
    let body = '';
    if (!h.devMode && state.authStatus === 'unconfigured') {
      body += '<p class="muted" style="margin:0">Production sign-in is not configured yet — the Supabase URL and anon key are missing '
        + '(see saas-ui/supabase-config.example.js). The app cannot sign anyone in until the director adds them.</p>';
    } else if (!h.devMode && state.authStatus === 'signed-out') {
      body += renderSignIn(state, h);
    } else if (!h.devMode && state.authStatus === 'unmapped') {
      body += '<p style="margin:0 0 8px">Signed in as <b>' + h.esc((state.authUser && state.authUser.email) || 'unknown') + '</b>, '
        + 'but no app role (director, coach, athlete, parent) is linked to this account yet. Ask the director to link your role, then sign in again.</p>'
        + '<div class="row" style="gap:8px"><button class="btn sm ghost" data-sui="auth-sign-out">Sign out</button></div>';
    } else if (state.connected === false) {
      body += '<p class="muted" style="margin:0">SaaS service not connected — start the dev server (<span class="mono">npm run dev</span>) to use accounts, rosters and assignments.</p>';
    } else if (state.connected !== true) {
      body += '<p class="muted" style="margin:0">Connecting to the SaaS service…</p>';
    } else {
      const tab = state.tab || 'overview';
      /* The Owner console tab exists for the director only — other
       * roles never see the button, and renderDirector refuses them
       * even if the tab is forced. */
      const tabs = TABS.slice();
      if (state.role && state.role.role === 'director') tabs.push(['director', 'Owner console']);
      body += '<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:12px">' + tabs.map(function (t) {
        return '<button class="btn sm' + (tab === t[0] ? ' solid' : '') + '" data-sui="tab" data-tab="' + t[0] + '">' + h.esc(t[1]) + '</button>';
      }).join('') + '</div>';
      if (tab === 'account') body += renderAccount(state, h);
      else if (tab === 'athlete') body += renderAthlete(state, h);
      else if (tab === 'coach') body += renderCoach(state, h);
      else if (tab === 'org') body += renderOrg(state, h);
      else if (tab === 'plans') body += renderPlans(state, h);
      else if (tab === 'director') body += renderDirector(state, h);
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
      /* Pathways snapshot: profile sports/positions, goals, media,
       * and the trend chart over the same assessment history. */
      const pw = state.profilePathways && state.profilePathways.athleteId === athleteId
        ? state.profilePathways.bundle : null;
      if (pw && pw.profile) {
        const plab = profileStatusLabel(pw.profile.status);
        body += '<p class="small" style="margin:8px 0 0"><span class="lbl ' + plab.cls + '">' + h.esc(plab.text) + '</span> '
          + '<span class="muted">' + profileSportsLine(h, pw.profile) + '</span></p>';
      }
      if (pw) {
        body += '<p class="small muted" style="margin:6px 0 0">'
          + (pw.developmentGoals || []).length + ' development goals · '
          + (pw.scoutingEvaluations || []).length + ' coach evaluations · '
          + (pw.mediaLinks || []).length + ' media links.</p>';
      }
      if ((hist.assessments || []).length) {
        body += '<div style="margin-top:10px"><div class="eyebrow">Progress trends</div>'
          + renderTrendChartsFromAssessments(hist.assessments, h) + '</div>';
      }
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
    /* Production Supabase Auth (saas-ui/supabase-auth.js). In dev
     * mode the auth client is ignored and the "View as" switcher
     * stands in for the signed-in user, exactly as before. In
     * production the switcher is gone (h.devRoles is null) and the
     * hub gates on the Auth session: no session → sign-in form;
     * session with no mapped app role → unmapped notice. The
     * mapped role is a DISPLAY hint only — the server derives the
     * role from app_users on every request. */
    var authClient = options.auth || null;
    var getToken = typeof options.getToken === 'function' ? options.getToken
      : (authClient && typeof authClient.getAccessToken === 'function'
        ? function () { return authClient.getAccessToken(); } : null);
    var devMode = options.dev !== false;
    var injectedClient = options.client || null;

    var state = {
      connected: null, error: null, notice: null,
      role: devMode ? DEV_ROLES[0] : null,
      /* Production auth state. 'signed-out' | 'signed-in' |
       * 'unmapped' (signed in, no app role linked) | 'unconfigured'
       * (no Supabase URL/anon key). Dev mode leaves this null. */
      authStatus: devMode ? null : 'signed-out',
      authUser: null,
      tab: 'overview', interval: 'month',
      plans: null, entitlements: null, subscription: null,
      roster: null, assignments: null, history: null,
      completingId: null, assigningTo: null, assignGames: [],
      progressFor: null, inviteToken: null, orgInviteToken: null,
      registration: null, checkout: null,
      organizationId: null, orgOverview: null,
      profileView: null, profilePathways: null,
      /* Athlete Pathways V1 (2026-11-26). pathways === undefined
       * means "not loaded yet"; null means "loaded, no profile". */
      directorAthletes: null, auditEvents: null, ownerInviteToken: null,
      pathways: undefined,
      coachAthleteId: null, coachPathways: undefined, coachHistory: null,
      crmContacts: null, crmContactId: null,
      crmActivity: { opportunities: [], notes: [], referrals: [] },
      shareUrl: null,
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
      h.devMode = devMode;
      h.role = state.role;
      return h;
    }

    function makeClient(role) {
      if (injectedClient) return injectedClient;
      if (!root.SaasClient || typeof root.SaasClient.createSaasClient !== 'function') {
        throw new Error('SaasClient is not loaded.');
      }
      if (!role) throw new Error('No signed-in role — sign in first.');
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

    /* Production auth: read the stored Supabase session and set the
     * UI role from the mapped app role (display hint only). Returns
     * true when a signed-in, role-mapped session is active. Dev mode
     * never calls this. */
    function applyAuthSession() {
      if (devMode || !authClient) return false;
      if (typeof authClient.isConfigured === 'function' && !authClient.isConfigured()) {
        state.authStatus = 'unconfigured';
        state.authUser = null;
        state.role = null;
        return false;
      }
      var session = typeof authClient.getSession === 'function' ? authClient.getSession() : null;
      var user = session ? session.user : null;
      if (!user) {
        state.authStatus = 'signed-out';
        state.authUser = null;
        state.role = null;
        return false;
      }
      var role = typeof authClient.roleForUser === 'function' ? authClient.roleForUser(user) : null;
      state.authUser = user;
      if (!role) {
        state.authStatus = 'unmapped';
        state.role = null;
        return false;
      }
      state.authStatus = 'signed-in';
      state.role = { role: role, user: user.id, label: (user.email || role) + ' (' + role + ')' };
      return true;
    }

    async function signIn() {
      state.error = null; state.notice = null;
      try {
        if (!authClient || typeof authClient.signInWithPassword !== 'function') {
          throw new Error('Sign-in is not configured.');
        }
        await authClient.signInWithPassword(val('sui-auth-email'), val('sui-auth-password'));
        applyAuthSession();
        state.notice = 'Signed in.';
        await refresh();
      } catch (e) { fail(e); }
      rerender();
    }

    async function signOut() {
      state.error = null; state.notice = null;
      try {
        if (authClient && typeof authClient.signOut === 'function') await authClient.signOut();
      } catch (e) { /* sign-out is best-effort */ }
      state.authStatus = 'signed-out';
      state.authUser = null;
      state.role = null;
      state.connected = null;
      state.notice = 'Signed out.';
      rerender();
    }

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
        await loadAthletePathways();
      }
      if (role === 'director') {
        await loadDirectorData();
      }
      if (role === 'coach' || role === 'org_admin') {
        try { state.crmContacts = await client().listRecruitmentContacts({}); } catch (e) { state.crmContacts = null; }
        /* A contact detail open across a refresh reloads from the
         * server (G1 fix) instead of keeping session-only rows. */
        if (state.crmContactId) await loadCrmContactDetail(state.crmContactId);
      }
    }

    async function switchRole(role) {
      /* Production: roles come from the signed-in Supabase session,
       * never from a switcher. Dev mode keeps the old behavior. */
      if (!devMode) return;
      state.role = role;
      state.assignments = null;
      state.history = null;
      state.roster = null;
      state.completingId = null;
      state.assigningTo = null;
      state.progressFor = null;
      state.checkout = null;
      state.directorAthletes = null;
      state.auditEvents = null;
      state.ownerInviteToken = null;
      state.pathways = undefined;
      state.profilePathways = null;
      state.coachAthleteId = null;
      state.coachPathways = undefined;
      state.coachHistory = null;
      state.crmContacts = null;
      state.crmContactId = null;
      state.crmActivity = { opportunities: [], notes: [], referrals: [] };
      state.shareUrl = null;
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
      }
      try {
        const bundle = await client().getProspectProfile({ athleteId: athleteId });
        state.profilePathways = { athleteId: athleteId, bundle: bundle };
      } catch (e) {
        state.profilePathways = { athleteId: athleteId, bundle: null };
      } finally {
        loadingProfileFor = null;
      }
      rerender();
    }

    /* ---------------- Athlete Pathways V1: controller ---------------- */

    /* "YYYY-MM-DD" date input -> ISO string, or null when empty.
     * Throws an INVALID_INPUT-shaped error on an unparseable value. */
    function toIsoDate(value) {
      const v = String(value || '').trim();
      if (!v) return null;
      const ms = Date.parse(v);
      if (!Number.isFinite(ms)) throw { code: 'INVALID_INPUT', message: 'Date is not valid: ' + v };
      return new Date(ms).toISOString();
    }

    function linesList(text) {
      return String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    }

    /* --- owner console (director) --- */

    async function loadDirectorData() {
      try { state.directorAthletes = await client().ownerListAthletes({}); }
      catch (e) { state.directorAthletes = null; }
      try { state.auditEvents = await client().listAudit({}); }
      catch (e) { state.auditEvents = null; }
    }

    async function createOwnerAthlete() {
      state.error = null; state.notice = null;
      const ageRaw = val('sui-owner-ath-age');
      try {
        const r = await client().ownerCreateAthlete({
          name: val('sui-owner-ath-name'),
          age: ageRaw === '' ? null : Number(ageRaw),
          sports: splitCommaList(val('sui-owner-ath-sports')),
        });
        state.notice = 'Athlete account created: ' + (r.athlete.name || r.athlete.id) + ' (Athlete Free until a grant is added).';
        toast('Athlete created');
        await loadDirectorData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function ownerInviteAthlete() {
      state.error = null; state.notice = null;
      try {
        const r = await client().ownerInviteAthlete({ email: val('sui-owner-invite-email') });
        state.ownerInviteToken = r.token;
        state.notice = 'Invitation created. The token is shown once below; no email is sent.';
      } catch (e) { fail(e); }
      rerender();
    }

    async function grantComplimentary() {
      state.error = null; state.notice = null;
      try {
        const indefinite = checked('sui-grant-indefinite');
        const expiresRaw = val('sui-grant-expires');
        if (!indefinite && !expiresRaw) {
          throw { code: 'INVALID_INPUT', message: 'Choose an expiry date or tick "Indefinite".' };
        }
        const params = {
          athleteId: val('sui-grant-athlete'),
          reason: val('sui-grant-reason') || undefined,
        };
        if (!indefinite) params.expiresAt = toIsoDate(expiresRaw);
        const r = await client().grantComplimentary(params);
        state.notice = r.alreadyGranted
          ? 'That athlete already holds an active complimentary grant — nothing changed.'
          : 'Complimentary access granted' + (params.expiresAt ? ' until ' + fmtDate(params.expiresAt) : ' (indefinite)') + '. The athlete will never see a payment prompt while it lasts.';
        toast('Complimentary granted');
        await loadDirectorData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function revokeComplimentary(athleteId, grantId) {
      state.error = null; state.notice = null;
      try {
        await client().revokeComplimentary({ athleteId: athleteId, grantId: grantId || undefined });
        state.notice = 'Complimentary grant revoked. The athlete falls back to the next covering source — nothing is deleted.';
        await loadDirectorData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function suspendAthlete(athleteId) {
      state.error = null; state.notice = null;
      try {
        await client().suspendAthlete({ athleteId: athleteId });
        state.notice = 'Athlete suspended (account state only — entitlements unchanged).';
        await loadDirectorData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function reactivateAthlete(athleteId) {
      state.error = null; state.notice = null;
      try {
        await client().reactivateAthlete({ athleteId: athleteId });
        state.notice = 'Athlete reactivated.';
        await loadDirectorData();
      } catch (e) { fail(e); }
      rerender();
    }

    async function updateAthleteRole(athleteId) {
      state.error = null; state.notice = null;
      try {
        const el = doc && doc.getElementById('sui-role-' + athleteId);
        const role = el ? String(el.value || '').trim() : '';
        await client().updateAthleteRole({ athleteId: athleteId, role: role });
        state.notice = 'Account role set to ' + role + '.';
        await loadDirectorData();
      } catch (e) { fail(e); }
      rerender();
    }

    /* --- athlete portal: own pathways --- */

    async function loadAthletePathways() {
      const athleteId = (state.role && state.role.athleteId)
        || (state.entitlements && state.entitlements.athleteId) || null;
      if (!athleteId) { state.pathways = null; return; }
      let bundle;
      try {
        bundle = await client().getProspectProfile({ athleteId: athleteId });
      } catch (e) {
        /* No profile yet (INVALID_INPUT) or out of scope: start from
         * an empty bundle — referrals/opportunities below may still
         * exist, and the portal shows them without a fake profile. */
        bundle = { profile: null, mediaLinks: [], scoutingEvaluations: [], developmentGoals: [] };
      }
      /* Own recruitment pipeline (G1 fix): referrals and
       * opportunities about this athlete, read from the server.
       * A failed read leaves an empty list, never a fake row. */
      let referrals = [];
      try {
        const r = await client().listReferrals({ athleteId: athleteId });
        referrals = r.referrals || [];
      } catch (e) { referrals = []; }
      let opportunities = [];
      try {
        const o = await client().listOpportunities({ athleteId: athleteId });
        opportunities = o.opportunities || [];
      } catch (e) { opportunities = []; }
      bundle.referrals = referrals;
      bundle.opportunities = opportunities;
      state.pathways = (bundle.profile || referrals.length || opportunities.length) ? bundle : null;
    }

    async function approveProfile(profileId, approval) {
      state.error = null; state.notice = null;
      try {
        const r = await client().approveProspectProfile({ profileId: profileId, approval: approval });
        const p = r.profile || {};
        state.notice = p.status === 'approved'
          ? 'Profile approved — it can now be shared by private link.'
          : 'Approval recorded. Status is now ' + (p.status || 'pending_approval')
            + ' — the other side still needs to approve before sharing.';
        toast('Approval recorded');
        if (state.role && state.role.role === 'athlete') await loadAthletePathways();
        if (state.coachAthleteId) await loadCoachAthlete(state.coachAthleteId);
      } catch (e) { fail(e); }
      rerender();
    }

    /* --- coach portal: athlete detail --- */

    async function loadCoachAthlete(athleteId) {
      state.coachHistory = null;
      try { state.coachHistory = await client().athleteHistory({ athleteId: athleteId }); }
      catch (e) { state.coachHistory = null; }
      let bundle;
      try {
        bundle = await client().getProspectProfile({ athleteId: athleteId });
      } catch (e) {
        bundle = { profile: null, mediaLinks: [], scoutingEvaluations: [], developmentGoals: [] };
      }
      const rows = (state.roster && state.roster.athletes) || [];
      const found = rows.find(function (r) { return r.athlete && String(r.athlete.id) === String(athleteId); });
      bundle.athlete = found ? found.athlete : { id: athleteId };
      bundle.shares = [];
      if (bundle.profile) {
        try {
          const s = await client().listProfileShares({ profileId: bundle.profile.id });
          bundle.shares = s.shares || [];
        } catch (e) { bundle.shares = []; }
      }
      state.coachPathways = bundle;
    }

    async function openCoachAthlete(athleteId) {
      state.error = null; state.notice = null;
      state.coachAthleteId = athleteId;
      state.coachPathways = undefined;
      state.shareUrl = null;
      await loadCoachAthlete(athleteId);
      rerender();
    }

    async function assignSport(athleteId) {
      state.error = null; state.notice = null;
      try {
        await client().assignSport({
          athleteId: athleteId,
          sport: val('sui-path-sport'),
          positions: splitCommaList(val('sui-path-positions')),
        });
        state.notice = 'Sport assigned: ' + sportLabel(val('sui-path-sport')) + '.';
        await refreshRoleData();
        if (state.coachAthleteId) await loadCoachAthlete(state.coachAthleteId);
      } catch (e) { fail(e); }
      rerender();
    }

    async function addGoal(athleteId) {
      state.error = null; state.notice = null;
      try {
        const goal = val('sui-goal-text');
        if (!goal) throw { code: 'INVALID_INPUT', message: 'Write the goal first.' };
        await client().setDevelopmentGoals({
          athleteId: athleteId, goal: goal, targetDate: toIsoDate(val('sui-goal-date')),
        });
        state.notice = 'Development goal added.';
        await loadCoachAthlete(athleteId);
      } catch (e) { fail(e); }
      rerender();
    }

    async function setGoalStatus(goalId, status) {
      state.error = null; state.notice = null;
      try {
        await client().updateDevelopmentGoal({ goalId: goalId, status: status });
        state.notice = 'Goal marked ' + status + '.';
        if (state.coachAthleteId) await loadCoachAthlete(state.coachAthleteId);
      } catch (e) { fail(e); }
      rerender();
    }

    async function addEvaluation(athleteId) {
      state.error = null; state.notice = null;
      try {
        const body = val('sui-eval-body');
        if (!body) throw { code: 'INVALID_INPUT', message: 'Write the evaluation first.' };
        await client().recordScoutingEvaluation({ athleteId: athleteId, body: body });
        state.notice = 'Scouting evaluation recorded (coach-approved on record).';
        await loadCoachAthlete(athleteId);
      } catch (e) { fail(e); }
      rerender();
    }

    async function saveProfile(athleteId, profileId) {
      state.error = null; state.notice = null;
      try {
        const measurements = {};
        const height = val('sui-prof-height');
        const weight = val('sui-prof-weight');
        const handedness = val('sui-prof-handedness');
        if (height) measurements.height = height;
        if (weight) measurements.weight = weight;
        if (handedness) measurements.handedness = handedness;
        const contactInfo = {};
        const email = val('sui-prof-contact-email');
        const phone = val('sui-prof-contact-phone');
        if (email) contactInfo.email = email;
        if (phone) contactInfo.phone = phone;
        const params = {
          athleteId: athleteId,
          primarySport: val('sui-prof-sport'),
          secondarySport: val('sui-prof-sport2') || null,
          positions: splitCommaList(val('sui-prof-positions')),
          bio: val('sui-prof-bio') || null,
          measurements: measurements,
          accomplishments: linesList(val('sui-prof-accomp')),
          playingHistory: linesList(val('sui-prof-history')),
          verifiedMetrics: parseKeyValueLines(val('sui-prof-metrics')),
          availability: val('sui-prof-availability') || null,
          contactInfo: contactInfo,
        };
        let r;
        if (profileId) {
          r = await client().updateProspectProfile({ profileId: profileId, ...params });
          state.notice = 'Profile saved.' + (r.profile.status === 'draft' ? ' Editing re-opened it to draft — re-approval is required before sharing.' : '');
        } else {
          r = await client().createProspectProfile(params);
          state.notice = 'Prospect profile created as a draft. Coach and athlete approval are both needed before sharing.';
        }
        toast('Profile saved');
        await loadCoachAthlete(athleteId);
      } catch (e) { fail(e); }
      rerender();
    }

    async function createShare(profileId) {
      state.error = null; state.notice = null;
      try {
        const params = { profileId: profileId };
        const expiresRaw = val('sui-share-expires');
        if (expiresRaw) params.expiresAt = toIsoDate(expiresRaw);
        const r = await client().createProfileShare(params);
        const base = (typeof location !== 'undefined' && location.origin && location.origin !== 'null')
          ? location.origin : '';
        const path = (typeof location !== 'undefined' && location.pathname || '').replace(/[^/]*$/, '');
        state.shareUrl = base + path + 'prospect.html?token=' + r.token;
        state.notice = 'Share link created (shown once below — copy it now). Default expiry is 7 days.';
        toast('Share link created');
        if (state.coachAthleteId) await loadCoachAthlete(state.coachAthleteId);
      } catch (e) { fail(e); }
      rerender();
    }

    async function revokeShare(shareId, profileId) {
      state.error = null; state.notice = null;
      try {
        await client().revokeProfileShare({ shareId: shareId });
        state.notice = 'Share link revoked. It now shows a neutral refusal and leaks no profile data.';
        if (state.coachAthleteId) await loadCoachAthlete(state.coachAthleteId);
      } catch (e) { fail(e); }
      rerender();
    }

    async function addMedia(profileId) {
      state.error = null; state.notice = null;
      try {
        const url = val('sui-media-url');
        if (!url) throw { code: 'INVALID_INPUT', message: 'Paste a media URL first (http(s) only).' };
        await client().addMediaLink({
          profileId: profileId, kind: val('sui-media-kind') || 'highlight',
          url: url, title: val('sui-media-title') || undefined,
        });
        state.notice = 'Media link added.';
        if (state.coachAthleteId) await loadCoachAthlete(state.coachAthleteId);
      } catch (e) { fail(e); }
      rerender();
    }

    async function removeMedia(mediaLinkId) {
      state.error = null; state.notice = null;
      try {
        await client().removeMediaLink({ mediaLinkId: mediaLinkId });
        state.notice = 'Media link removed.';
        if (state.coachAthleteId) await loadCoachAthlete(state.coachAthleteId);
      } catch (e) { fail(e); }
      rerender();
    }

    /* --- coach portal: recruitment CRM --- */

    /* Server-backed contact detail (G1 fix): opportunities, notes,
     * and referrals for one contact, reloaded from the API on open
     * and after every change — never session-only rows. A failed
     * read leaves empty lists (and surfaces the error), never stale
     * or fake rows. */
    async function loadCrmContactDetail(contactId) {
      if (!contactId) {
        state.crmActivity = { opportunities: [], notes: [], referrals: [] };
        return;
      }
      try {
        const [o, n, r] = await Promise.all([
          client().listOpportunities({ contactId: contactId }),
          client().listRecruitmentNotes({ contactId: contactId }),
          client().listReferrals({ contactId: contactId }),
        ]);
        state.crmActivity = {
          opportunities: o.opportunities || [],
          notes: n.notes || [],
          referrals: r.referrals || [],
        };
      } catch (e) {
        fail(e);
        state.crmActivity = { opportunities: [], notes: [], referrals: [] };
      }
    }

    async function addCrmContact() {
      state.error = null; state.notice = null;
      try {
        const orgName = val('sui-crm-org');
        if (!orgName) throw { code: 'INVALID_INPUT', message: 'Organization name is required.' };
        const r = await client().createRecruitmentContact({
          orgName: orgName,
          sport: val('sui-crm-sport') || undefined,
          level: val('sui-crm-level') || undefined,
          region: val('sui-crm-region') || undefined,
          league: val('sui-crm-league') || undefined,
          contactName: val('sui-crm-name') || undefined,
          title: val('sui-crm-title') || undefined,
          email: val('sui-crm-email') || undefined,
          status: val('sui-crm-status') || 'new',
        });
        state.notice = 'Recruitment contact added: ' + r.contact.orgName + '.';
        state.crmContacts = await client().listRecruitmentContacts({});
      } catch (e) { fail(e); }
      rerender();
    }

    async function updateCrmContact(contactId) {
      state.error = null; state.notice = null;
      try {
        await client().updateRecruitmentContact({
          contactId: contactId, status: val('sui-crm-contact-status'),
        });
        state.notice = 'Contact status updated.';
        state.crmContacts = await client().listRecruitmentContacts({});
      } catch (e) { fail(e); }
      rerender();
    }

    async function addCrmOpportunity(contactId) {
      state.error = null; state.notice = null;
      try {
        await client().createOpportunity({
          contactId: contactId, type: val('sui-crm-opp-type') || 'tryout',
          date: toIsoDate(val('sui-crm-opp-date')), notes: val('sui-crm-opp-notes') || undefined,
        });
        await loadCrmContactDetail(contactId);
        state.notice = 'Opportunity recorded.';
      } catch (e) { fail(e); }
      rerender();
    }

    async function addCrmNote(contactId) {
      state.error = null; state.notice = null;
      try {
        const body = val('sui-crm-note-body');
        if (!body) throw { code: 'INVALID_INPUT', message: 'Write the note first.' };
        const r = await client().addRecruitmentNote({
          contactId: contactId, body: body,
          followUpDate: toIsoDate(val('sui-crm-note-followup')),
        });
        await loadCrmContactDetail(contactId);
        state.notice = 'Note added' + (r.note.followUpDate ? ' — follow-up ' + fmtDate(r.note.followUpDate) + '.' : '.');
      } catch (e) { fail(e); }
      rerender();
    }

    async function addCrmReferral(contactId) {
      state.error = null; state.notice = null;
      try {
        const r = await client().referAthlete({
          contactId: contactId, athleteId: val('sui-crm-refer-athlete'),
        });
        await loadCrmContactDetail(contactId);
        state.notice = r.alreadyReferred ? 'That athlete is already referred to this contact.' : 'Athlete referred.';
      } catch (e) { fail(e); }
      rerender();
    }

    async function updateCrmReferral(referralId) {
      state.error = null; state.notice = null;
      try {
        const el = doc && doc.getElementById('sui-crm-ref-' + referralId);
        const status = el ? String(el.value || '').trim() : '';
        const r = await client().updateReferralStatus({ referralId: referralId, status: status });
        if (state.crmContactId) await loadCrmContactDetail(state.crmContactId);
        state.notice = 'Referral status updated to ' + r.referral.status + '.';
      } catch (e) { fail(e); }
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
        /* Production auth: the dev "View as" switcher is not rendered
         * off localhost, and switchRole refuses in production too. */
        'auth-sign-in': function () { return signIn(); },
        'auth-sign-out': function () { return signOut(); },
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
        'confirm-checkout': function () { return confirmCheckout(t.getAttribute('data-sui-session')); },
        'cancel-sub': function () { return cancelSubscription(t.getAttribute('data-sub')); },
        'profile-refresh': function () { return loadProfile(athleteId); },
        /* Athlete Pathways V1 */
        'owner-create-athlete': function () { return createOwnerAthlete(); },
        'owner-invite-athlete': function () { return ownerInviteAthlete(); },
        'grant-complimentary': function () { return grantComplimentary(); },
        'revoke-grant': function () { return revokeComplimentary(athleteId, t.getAttribute('data-grant')); },
        'suspend-athlete': function () { return suspendAthlete(athleteId); },
        'reactivate-athlete': function () { return reactivateAthlete(athleteId); },
        'update-role': function () { return updateAthleteRole(athleteId); },
        'director-refresh': function () { state.error = null; return loadDirectorData().then(function () { rerender(); }); },
        'approve-profile': function () { return approveProfile(t.getAttribute('data-profile'), 'athlete'); },
        'approve-profile-coach': function () { return approveProfile(t.getAttribute('data-profile'), 'coach'); },
        'pathways-open': function () { return openCoachAthlete(athleteId); },
        'pathways-close': function () { state.coachAthleteId = null; state.coachPathways = undefined; state.coachHistory = null; state.shareUrl = null; rerender(); return Promise.resolve(); },
        'assign-sport': function () { return assignSport(athleteId); },
        'goal-add': function () { return addGoal(athleteId); },
        'goal-status': function () { return setGoalStatus(t.getAttribute('data-goal'), t.getAttribute('data-status')); },
        'eval-add': function () { return addEvaluation(athleteId); },
        'profile-save': function () { return saveProfile(athleteId, t.getAttribute('data-profile')); },
        'share-create': function () { return createShare(t.getAttribute('data-profile')); },
        'share-revoke': function () { return revokeShare(t.getAttribute('data-share'), t.getAttribute('data-profile')); },
        'media-add': function () { return addMedia(t.getAttribute('data-profile')); },
        'media-remove': function () { return removeMedia(t.getAttribute('data-media')); },
        'crm-contact-add': function () { return addCrmContact(); },
        'crm-contact-open': function () {
          state.crmContactId = t.getAttribute('data-contact');
          return loadCrmContactDetail(state.crmContactId).then(function () { rerender(); });
        },
        'crm-contact-close': function () { state.crmContactId = null; rerender(); return Promise.resolve(); },
        'crm-contact-update': function () { return updateCrmContact(t.getAttribute('data-contact')); },
        'crm-opp-add': function () { return addCrmOpportunity(t.getAttribute('data-contact')); },
        'crm-note-add': function () { return addCrmNote(t.getAttribute('data-contact')); },
        'crm-refer-add': function () { return addCrmReferral(t.getAttribute('data-contact')); },
        'crm-referral-status': function () { return updateCrmReferral(t.getAttribute('data-referral')); },
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
      /* Production: no session → the hub shows the sign-in form and
       * nothing calls the API until someone signs in. A stored
       * session is refreshed proactively so a just-expired token
       * does not bounce the first call. Dev mode refreshes as before. */
      if (!devMode) {
        const signedIn = applyAuthSession();
        if (!signedIn) { state.connected = false; rerender(); return true; }
        if (authClient && typeof authClient.ensureFreshSession === 'function') {
          authClient.ensureFreshSession().then(function () {
            applyAuthSession();
            refresh();
          }).catch(function () { refresh(); });
          return true;
        }
      }
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
      /* Athlete Pathways V1 */
      loadDirectorData: loadDirectorData, createOwnerAthlete: createOwnerAthlete,
      ownerInviteAthlete: ownerInviteAthlete, grantComplimentary: grantComplimentary,
      revokeComplimentary: revokeComplimentary, suspendAthlete: suspendAthlete,
      reactivateAthlete: reactivateAthlete, updateAthleteRole: updateAthleteRole,
      loadAthletePathways: loadAthletePathways, approveProfile: approveProfile,
      openCoachAthlete: openCoachAthlete, loadCoachAthlete: loadCoachAthlete,
      assignSport: assignSport, addGoal: addGoal, setGoalStatus: setGoalStatus,
      addEvaluation: addEvaluation, saveProfile: saveProfile,
      createShare: createShare, revokeShare: revokeShare,
      addMedia: addMedia, removeMedia: removeMedia,
      addCrmContact: addCrmContact, updateCrmContact: updateCrmContact,
      loadCrmContactDetail: loadCrmContactDetail,
      addCrmOpportunity: addCrmOpportunity, addCrmNote: addCrmNote,
      addCrmReferral: addCrmReferral, updateCrmReferral: updateCrmReferral,
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
    /* Athlete Pathways V1 */
    SPORTS: SPORTS, SPORT_IDS: SPORT_IDS.slice(), sportLabel: sportLabel, positionsFor: positionsFor,
    PROFILE_STATUS_LABELS: PROFILE_STATUS_LABELS, profileStatusLabel: profileStatusLabel,
    CONTACT_STATUSES: CONTACT_STATUSES.slice(), REFERRAL_STATUSES: REFERRAL_STATUSES.slice(),
    OPPORTUNITY_LEVELS: OPPORTUNITY_LEVELS.slice(), OPPORTUNITY_TYPES: OPPORTUNITY_TYPES.slice(),
    MEDIA_KINDS: MEDIA_KINDS.slice(), mediaKindLabel: mediaKindLabel,
    splitCommaList: splitCommaList, parseKeyValueLines: parseKeyValueLines,
    formatKeyValueLines: formatKeyValueLines, embedUrlFor: embedUrlFor, mediaEmbedHtml: mediaEmbedHtml,
    TEST_LABELS: TEST_LABELS, fmtNum: fmtNum,
    trendSeriesFromAssessments: trendSeriesFromAssessments,
    trendStatusFor: trendStatusFor,
    MAINTENANCE_BANDS: MAINTENANCE_BANDS,
    renderTrendChart: renderTrendChart,
    renderTrendChartsFromAssessments: renderTrendChartsFromAssessments,
    renderDirector: renderDirector, renderAthletePathways: renderAthletePathways,
    renderCoachAthleteDetail: renderCoachAthleteDetail, renderCrm: renderCrm,
    renderPublicProfile: renderPublicProfile, renderPublicRefusal: renderPublicRefusal,
    BLOCKED_GAME_IDS: BLOCKED_GAME_IDS.slice(),
    DEV_ROLES: DEV_ROLES,
  };
});
