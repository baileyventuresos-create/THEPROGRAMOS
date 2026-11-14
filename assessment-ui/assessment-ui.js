/* THE PROGRAM OS — Assessment UI wiring (Phase 2)
 * assessment-ui/assessment-ui.js
 *
 * Wires the prototype's Assessments view (and athlete profiles) to the
 * already-complete server assessment workflow, through the transport
 * adapter in assessment-ui/assessment-client.js. The browser never
 * re-implements workflow or business logic: every call below is one
 * method of the API contract, and every number shown comes from the
 * server (baseline, progress, personal bests, due dates).
 *
 * How it loads (see docs/ASSESSMENT_UI_INTEGRATION.md):
 *   index.html injects this file (after assessment-client.js) before
 *   boot(). install() wraps window.vAssess / window.vAthlete. The
 *   prototype file was edited once, 2026-11-14, under Marcus's
 *   decision §14 (obsolete Assessments content removed — see the
 *   preservation-snapshot commit); the UI module still wraps
 *   vAssess/vAthlete at runtime and never edits the file itself.
 *   The live section is PREPENDED to the Assessments view; the
 *   prototype battery cards below it were removed 2026-11-14
 *   (Marcus decision §14), so the live section is now the whole
 *   Assessments experience. When the assessment service is
 *   unreachable, the view shows a short "not connected" note.
 *
 * What it adds (the 11-step coach workflow + athlete visibility):
 *   roster   — select an athlete from the authorized roster; due
 *              buckets (never-assessed / approaching / due / overdue /
 *              deferred) from coachDashboard().
 *   run      — start/resume a GAA assessment: the eight standardized
 *              protocols (from GET .../battery, never duplicated here),
 *              record attempts incl. modified/capped flags, save an
 *              incomplete draft and resume it, complete + establish a
 *              baseline. Movement assessment is observation-only.
 *   history  — history + personal bests, baseline/previous/current
 *              comparison, reassessment status, advisory priorities,
 *              plan readiness + create/finalize (finalize refuses an
 *              unready plan unless an explicit coach override is
 *              recorded).
 *   defer    — record a coach-approved deferral / exclusion /
 *              modification for one test or the whole battery.
 *   athlete  — athlete profiles show the same history/progress when
 *              the athlete is in the live roster (matched by id).
 *
 * Dev vs deployed: by default the client talks to same-origin
 * /api/assessments with dev-role headers (the dev server,
 * server/dev-server.js). Pass { endpoint, getToken } at install for
 * the deployed Edge Function; the "View as" role switcher is dev-only
 * and is hidden whenever no devRole is configured.
 *
 * UMD like assessment-client.js: require() in Node tests, global
 * window.AssessmentUI in the browser. No dependencies.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AssessmentUI = api;
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

  /* A result value with its unit, e.g. 2.31 sec, 64 in, 120 sec (capped). */
  function fmtResult(value, unit, opts) {
    if (value == null || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    const precision = (opts && opts.precision != null) ? opts.precision : (unit === 'sec' ? 2 : 0);
    const capped = opts && opts.capped ? ' (capped)' : '';
    const modified = opts && opts.modified ? ' (modified)' : '';
    return n.toFixed(precision) + (unit ? ' ' + unit : '') + capped + modified;
  }

  /* Schedule status -> { text, cls } using the prototype's .lbl classes. */
  var STATUS_LABELS = {
    'never-assessed': { text: 'Never assessed', cls: 'needdef' },
    'approaching': { text: 'Approaching', cls: 'needval' },
    'due': { text: 'Due', cls: 'needval' },
    'overdue': { text: 'Overdue', cls: 'crit' },
    'deferred': { text: 'Deferred', cls: 'assume' },
    'not-due': { text: 'Not due', cls: 'ok' },
  };

  function statusLabel(status) {
    return STATUS_LABELS[status] || { text: String(status || '—'), cls: 'v1' };
  }

  function progressStatusLabel(status) {
    return { improved: 'Improved', maintained: 'Maintained', regressed: 'Regressed',
      'baseline-only': 'Baseline only', 'no-data': 'No data' }[status] || String(status || '—');
  }

  function signed(n, precision) {
    if (n == null) return '—';
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(precision == null ? 2 : precision);
  }

  /* ------------------------------------------------------------------ */
  /* Entry slots: the 8 GAA protocol tests expand to 10 recordable     */
  /* slots — 9 measured definition ids (side plank and single-leg      */
  /* balance are bilateral) plus the observation-only movement test.   */
  /* Slots come from the server battery payload; nothing is hardcoded  */
  /* except the bilateral name suffixes, which follow the definition   */
  /* ids (-r / -l).                                                     */
  /* ------------------------------------------------------------------ */

  function entrySlots(batteryTests) {
    const slots = [];
    for (const t of batteryTests || []) {
      if (t.kind === 'observation') {
        slots.push({ defId: t.id, testId: t.id, name: t.name, kind: 'observation',
          instructions: t.instructions || '' });
        continue;
      }
      for (const defId of t.definitionIds || [t.id]) {
        let name = t.name;
        if (defId.slice(-2) === '-r') name += ' — Right';
        else if (defId.slice(-2) === '-l') name += ' — Left';
        slots.push({ defId: defId, testId: t.id, name: name, kind: 'measured',
          unit: t.unit, direction: t.direction, attempts: t.attempts || 1,
          capSeconds: t.capSeconds != null ? t.capSeconds : null,
          instructions: t.instructions || '' });
      }
    }
    return slots;
  }

  function slotById(slots, defId) {
    for (const s of slots) if (s.defId === defId) return s;
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Form -> API entries. form: { attempts: {defId: [raw...]},          */
  /* modified: {defId: bool}, capped: {defId: bool}, movement: string,  */
  /* context: { timingMethod, surface } }. Only slots with at least    */
  /* one numeric attempt (or movement text) become entries; partial    */
  /* saves are the draft mechanism.                                    */
  /* ------------------------------------------------------------------ */

  function buildEntries(form, slots) {
    const entries = [];
    for (const slot of slots) {
      if (slot.kind === 'observation') {
        const text = (form.movement || '').trim();
        if (text) entries.push({ assessmentId: slot.defId, observations: text });
        continue;
      }
      const raw = (form.attempts && form.attempts[slot.defId]) || [];
      const attempts = raw.map(Number).filter(Number.isFinite);
      if (!attempts.length) continue;
      const entry = { assessmentId: slot.defId, attempts: attempts };
      if (form.modified && form.modified[slot.defId]) entry.modified = true;
      if (form.capped && form.capped[slot.defId]) entry.capped = true;
      entries.push(entry);
    }
    return entries;
  }

  /* Client-side mirror of the server's shape + protocol checks, so a
   * coach gets immediate feedback instead of a round-trip rejection.
   * Returns problems[] (empty = valid). */
  function validateEntries(entries, slots) {
    const problems = [];
    for (const e of entries || []) {
      const slot = slotById(slots, e.assessmentId);
      if (!slot) { problems.push('Unknown assessment: ' + e.assessmentId + '.'); continue; }
      if (slot.kind === 'observation') {
        if (typeof e.observations !== 'string' || !e.observations.trim()) {
          problems.push('Movement assessment needs written observations.');
        }
        continue;
      }
      const vals = (e.attempts || []).map(Number).filter(Number.isFinite);
      if (!vals.length) { problems.push(slot.name + ': at least one numeric attempt is required.'); continue; }
      if (vals.length > slot.attempts) {
        problems.push(slot.name + ': too many attempts — ' + vals.length + ' given, protocol allows ' + slot.attempts + '.');
      }
      if (vals.some(function (v) { return v < 0; })) problems.push(slot.name + ': attempts must not be negative.');
      if (slot.capSeconds != null && vals.some(function (v) { return v > slot.capSeconds; })) {
        problems.push(slot.name + ': attempt exceeds the ' + slot.capSeconds + 's cap — record '
          + slot.capSeconds + ' and tick Capped.');
      }
      if (slot.unit === 'reps' && vals.some(function (v) { return !Number.isInteger(v); })) {
        problems.push(slot.name + ': attempts must be whole repetitions.');
      }
    }
    return problems;
  }

  /* Read the run-assessment form out of a document (injected for
   * tests; defaults to the live document). Returns { form, problems }
   * where problems are input-level errors (non-numeric attempts). */
  function readRunForm(doc, slots) {
    const form = { attempts: {}, modified: {}, capped: {}, movement: '', context: {} };
    const problems = [];
    const get = function (id) {
      const el = doc.getElementById(id);
      return el ? el : null;
    };
    const val = function (id) {
      const el = get(id);
      return el ? String(el.value == null ? '' : el.value).trim() : '';
    };
    for (const slot of slots) {
      if (slot.kind === 'observation') continue;
      const list = [];
      for (let i = 0; i < slot.attempts; i++) {
        const raw = val('aui-att-' + slot.defId + '-' + i);
        if (raw === '') continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) { problems.push(slot.name + ': attempt ' + (i + 1) + ' is not a number.'); continue; }
        list.push(n);
      }
      if (list.length) form.attempts[slot.defId] = list;
      const mod = get('aui-mod-' + slot.defId);
      if (mod && mod.checked) form.modified[slot.defId] = true;
      const cap = get('aui-cap-' + slot.defId);
      if (cap && cap.checked) form.capped[slot.defId] = true;
    }
    form.movement = val('aui-movement');
    form.context.timingMethod = val('aui-ctx-timing');
    form.context.surface = val('aui-ctx-surface');
    return { form: form, problems: problems };
  }

  function readDeferralForm(doc) {
    const val = function (id) {
      const el = doc.getElementById(id);
      return el ? String(el.value == null ? '' : el.value).trim() : '';
    };
    return {
      scope: val('aui-def-scope') || 'test',
      kind: val('aui-def-kind') || 'deferral',
      assessmentId: val('aui-def-test') || null,
      deferredUntil: val('aui-def-until') || null,
      reason: val('aui-def-reason'),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Renderers: HTML strings in the prototype's design language        */
  /* (.panel/.ph/.pb, .tbl-wrap/.t, .btn/.btn sm, .lbl, .note).         */
  /* They never fetch and never mutate state; the controller loads     */
  /* data and calls render() after. h = { esc, lbl, slots,            */
  /* athleteName(id), canAssess, devRoles, role }.                     */
  /* ------------------------------------------------------------------ */

  function lblLocal(h, text, cls) {
    if (h.lbl) return h.lbl(text, cls);
    return '<span class="lbl ' + (cls || 'v1') + '">' + h.esc(text) + '</span>';
  }

  function panel(h, title, rightHtml, bodyHtml) {
    return '<section class="panel"><div class="ph"><h3>' + h.esc(title) + '</h3>'
      + (rightHtml ? '<div class="r">' + rightHtml + '</div>' : '') + '</div>'
      + '<div class="pb">' + bodyHtml + '</div></section>';
  }

  function errorNote(h, error) {
    if (!error) return '';
    return '<div class="note">Assessment service error (' + h.esc(error.code || 'ERROR') + '): '
      + h.esc(error.message || 'Unknown error.') + '</div>';
  }

  function scheduleMap(dashboard) {
    const map = {};
    if (!dashboard || !dashboard.reminders) return map;
    for (const bucket of Object.values(dashboard.reminders)) {
      for (const s of bucket || []) map[s.athleteId] = s;
    }
    return map;
  }

  function renderRoster(state, h) {
    const roster = state.roster || [];
    const sched = scheduleMap(state.dashboard);
    const buckets = state.dashboard && state.dashboard.reminders
      ? [['Never assessed', state.dashboard.reminders.neverAssessed],
        ['Approaching', state.dashboard.reminders.approaching],
        ['Due', state.dashboard.reminders.due],
        ['Overdue', state.dashboard.reminders.overdue],
        ['Deferred', state.dashboard.reminders.deferred],
        ['Not due', state.dashboard.reminders.notDue]]
      : null;
    let html = '';
    if (buckets) {
      html += '<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:10px">' + buckets.map(function (b) {
        const n = (b[1] || []).length;
        return '<span class="lbl ' + (n ? (b[0] === 'Overdue' ? 'crit' : b[0] === 'Due' ? 'needval' : 'v1') : 'assume') + '">'
          + h.esc(b[0]) + ' · ' + n + '</span>';
      }).join('') + '</div>';
    }
    if (!roster.length) {
      html += '<p class="muted" style="margin:0">No athletes in your authorized roster.</p>';
      return html;
    }
    html += '<div class="tbl-wrap"><table class="t"><tr><th>Athlete</th><th>Age</th><th>Cohort</th>'
      + '<th>Status</th><th>Next due</th><th></th></tr>'
      + roster.map(function (a) {
        const s = sched[a.id];
        const lab = s ? statusLabel(s.status) : null;
        return '<tr><td><b>' + h.esc(a.name || a.id) + '</b></td>'
          + '<td class="mono">' + (a.age != null ? a.age : '—') + '</td>'
          + '<td class="mono small">' + h.esc(a.cohort || '—') + '</td>'
          + '<td>' + (lab ? '<span class="lbl ' + lab.cls + '">' + h.esc(lab.text) + '</span>' : '—') + '</td>'
          + '<td class="small">' + (s && s.nextDueAt ? fmtDate(s.nextDueAt) : '—') + '</td>'
          + '<td style="white-space:nowrap">'
          + (h.canAssess ? '<button class="btn sm" data-aui="run" data-athlete="' + h.esc(a.id) + '">'
            + (s && s.lastCompletedAt ? 'Reassess' : 'Start assessment') + '</button> ' : '')
          + '<button class="btn sm ghost" data-aui="history" data-athlete="' + h.esc(a.id) + '">History</button>'
          + '</td></tr>';
      }).join('') + '</table></div>';
    return html;
  }

  function renderRunForm(state, h) {
    const draft = state.draft;
    const athlete = state.roster ? state.roster.find(function (a) { return String(a.id) === String(state.athleteId); }) : null;
    const name = athlete ? (athlete.name || athlete.id) : state.athleteId;
    if (!draft) return '<p class="muted" style="margin:0">Loading the assessment draft…</p>';
    const byId = {};
    for (const e of draft.entries || []) byId[e.assessmentId] = e;
    const missing = draft.missing || [];
    const missingNames = missing.map(function (id) {
      const slot = slotById(h.slots, id);
      return slot ? slot.name : id;
    });
    let html = '<div class="row" style="justify-content:space-between;margin-bottom:10px"><div><b>'
      + h.esc(name) + '</b> <span class="muted small">'
      + (draft.isReassessment ? 'Reassessment' : 'First assessment')
      + (draft.lastCompletedAt ? ' · last completed ' + fmtDate(draft.lastCompletedAt) : '')
      + (draft.nextDueAt ? ' · next due ' + fmtDate(draft.nextDueAt) : '')
      + '</span></div><div><button class="btn sm ghost" data-aui="roster">← Roster</button></div></div>';
    if (missing.length) {
      html += '<div class="note">Still needed to complete: <b>' + h.esc(missingNames.join(', ')) + '</b></div>';
    } else {
      html += '<div class="note">All eight protocols covered — ready to complete and establish the baseline.</div>';
    }
    html += '<div class="stack" style="gap:12px;margin-top:10px">';
    for (const slot of h.slots) {
      const existing = byId[slot.defId];
      const isMissing = missing.indexOf(slot.defId) >= 0;
      if (slot.kind === 'observation') {
        html += '<div><div class="eyebrow">' + h.esc(slot.name) + ' · observation only</div>'
          + '<div class="small muted" style="margin:2px 0 4px">' + h.esc(slot.instructions) + '</div>'
          + '<textarea id="aui-movement" rows="3" style="width:100%;border:1px solid var(--line-strong);background:var(--surface);padding:8px" placeholder="What the coach saw, in plain language — squat, hinge, overhead reach, single-leg stability, gait. No score, no grade.">'
          + h.esc(existing && (existing.observations || existing.text || existing.notes) || '') + '</textarea></div>';
        continue;
      }
      const attempts = (existing && existing.attempts) || [];
      html += '<div><div class="eyebrow">' + h.esc(slot.name) + ' · ' + h.esc(slot.unit)
        + ' · up to ' + slot.attempts + ' attempt' + (slot.attempts > 1 ? 's' : '')
        + (slot.capSeconds != null ? ' · capped at ' + slot.capSeconds + 's' : '')
        + (isMissing ? ' · ' + '<span class="lbl needval">needed</span>' : '') + '</div>'
        + '<div class="small muted" style="margin:2px 0 4px">' + h.esc(slot.instructions) + '</div>'
        + '<div class="row" style="gap:6px;flex-wrap:wrap">';
      for (let i = 0; i < slot.attempts; i++) {
        html += '<input id="aui-att-' + slot.defId + '-' + i + '" type="number" step="any" min="0"'
          + (slot.capSeconds != null ? ' max="' + slot.capSeconds + '"' : '')
          + ' value="' + (attempts[i] != null ? attempts[i] : '') + '" placeholder="Attempt ' + (i + 1)
          + '" aria-label="' + h.esc(slot.name) + ' attempt ' + (i + 1) + '"'
          + ' style="width:110px;border:1px solid var(--line-strong);background:var(--surface);padding:8px">';
      }
      html += '<label class="small"><input id="aui-mod-' + slot.defId + '" type="checkbox"'
        + (existing && existing.modified ? ' checked' : '') + '> Modified</label>'
        + '<label class="small"><input id="aui-cap-' + slot.defId + '" type="checkbox"'
        + (existing && existing.capped ? ' checked' : '') + '> Capped</label>'
        + '</div></div>';
    }
    html += '</div>';
    const ctx = (draft.context || {});
    html += '<div class="row" style="gap:12px;margin-top:12px;flex-wrap:wrap">'
      + '<label class="small">Timing method <input id="aui-ctx-timing" type="text" value="' + h.esc(ctx.timingMethod || '')
      + '" placeholder="hand-timed stopwatch / gates" style="border:1px solid var(--line-strong);background:var(--surface);padding:8px"></label>'
      + '<label class="small">Surface <input id="aui-ctx-surface" type="text" value="' + h.esc(ctx.surface || '')
      + '" placeholder="turf / track / floor" style="border:1px solid var(--line-strong);background:var(--surface);padding:8px"></label>'
      + '</div>';
    html += '<div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap">'
      + '<button class="btn solid sm" data-aui="save">Save draft</button>'
      + '<button class="btn sm" data-aui="complete">Complete assessment</button>'
      + '<button class="btn sm ghost" data-aui="discard">Discard draft</button>'
      + '<button class="btn sm ghost" data-aui="defer" data-athlete="' + h.esc(state.athleteId) + '">Defer / exclude a test</button>'
      + '</div>';
    html += '<p class="muted small" style="margin:10px 0 0">Saving stores an incomplete draft — it never counts as history, a baseline, or a due date. '
      + 'Completing validates every protocol, records the session, and sets the next reassessment 28 days out. '
      + 'A modified result is never compared against a standard-protocol baseline as if it were the same test.</p>';
    return html;
  }

  function renderHistory(state, h) {
    const view = state.athleteView;
    const athlete = state.roster ? state.roster.find(function (a) { return String(a.id) === String(state.athleteId); }) : null;
    const name = athlete ? (athlete.name || athlete.id) : state.athleteId;
    if (!view) return '<p class="muted" style="margin:0">Loading assessment history…</p>';
    let html = '<div class="row" style="justify-content:space-between;margin-bottom:10px"><div><b>'
      + h.esc(name) + '</b> <span class="muted small">'
      + (view.age != null ? 'age ' + view.age + ' · ' : '')
      + (view.baseline && view.baseline.complete
        ? 'Baseline complete ' + fmtDate(view.baseline.completedAt)
        : 'Baseline incomplete' + (view.baseline && view.baseline.missing.length
          ? ' — still missing: ' + h.esc(view.baseline.missing.map(function (id) { const s = slotById(h.slots, id); return s ? s.name : id; }).join(', ')) : ''))
      + '</span></div><div><button class="btn sm ghost" data-aui="roster">← Roster</button> '
      + (h.canAssess ? '<button class="btn sm" data-aui="run" data-athlete="' + h.esc(state.athleteId) + '">'
        + (view.schedule && view.schedule.lastCompletedAt ? 'Reassess' : 'Start assessment') + '</button>' : '')
      + '</div></div>';
    if (view.schedule) {
      const lab = statusLabel(view.schedule.status);
      html += '<p class="small" style="margin:0 0 10px">Reassessment: <span class="lbl ' + lab.cls + '">'
        + h.esc(lab.text) + '</span> '
        + (view.schedule.nextDueAt ? 'next due ' + fmtDate(view.schedule.nextDueAt) : '')
        + (view.reminder && view.reminder.message ? ' — ' + h.esc(view.reminder.message) : '') + '</p>';
    }
    const tests = (view.progress && view.progress.tests) || {};
    const ids = Object.keys(tests);
    if (ids.length) {
      html += '<div class="tbl-wrap"><table class="t"><tr><th>Test</th><th>Baseline</th><th>Previous</th>'
        + '<th>Current</th><th>Personal best</th><th>vs baseline</th><th>vs previous</th><th>Status</th></tr>'
        + ids.map(function (id) {
          const p = tests[id];
          const slot = slotById(h.slots, id);
          const nm = slot ? slot.name : id;
          const vsB = p.vsBaseline ? signed(p.vsBaseline.absolute) + ' (' + signed(p.vsBaseline.improvementPercent) + '%)' : '—';
          const vsP = p.vsPrevious ? signed(p.vsPrevious.absolute) + ' (' + signed(p.vsPrevious.improvementPercent) + '%)' : '—';
          return '<tr><td>' + h.esc(nm) + '</td>'
            + '<td class="mono">' + fmtResult(p.baseline, p.unit) + '</td>'
            + '<td class="mono">' + fmtResult(p.previous, p.unit) + '</td>'
            + '<td class="mono">' + fmtResult(p.current, p.unit) + '</td>'
            + '<td class="mono">' + fmtResult(p.personalBest, p.unit) + (p.isPersonalBest ? ' ★' : '') + '</td>'
            + '<td class="mono">' + vsB + '</td><td class="mono">' + vsP + '</td>'
            + '<td>' + h.esc(progressStatusLabel(p.status)) + '</td></tr>';
        }).join('') + '</table></div>';
      const caveats = [];
      for (const id of ids) {
        for (const c of tests[id].caveats || []) if (caveats.indexOf(c) < 0) caveats.push(c);
      }
      if (caveats.length) {
        html += '<p class="muted small" style="margin:8px 0 0">' + h.esc(caveats.join(' ')) + '</p>';
      }
    } else {
      html += '<p class="muted" style="margin:0 0 10px">No recorded results yet.</p>';
    }
    const history = (view.history || []).slice().reverse();
    if (history.length) {
      html += '<div style="margin-top:12px"><div class="eyebrow">Sessions</div>'
        + history.map(function (s) {
          return '<div class="small" style="margin:4px 0"><b>' + fmtDate(s.recordedAt) + '</b> — '
            + s.results.map(function (r) {
              const slot = slotById(h.slots, r.assessmentId);
              return h.esc(slot ? slot.name : r.assessmentId) + ': ' + h.esc(fmtResult(r.result, r.unit, { modified: r.modified, capped: r.capped }));
            }).join(' · ') + '</div>';
        }).join('') + '</div>';
    }
    const adv = view.advisory;
    if (adv) {
      html += '<div style="margin-top:12px"><div class="eyebrow">Advisory priorities (Smart Draft — advisory only, never a program change)</div>';
      if (adv.insufficientEvidence) html += '<p class="small muted" style="margin:4px 0">' + h.esc(adv.note || 'Not enough evidence yet for priorities.') + '</p>';
      else if (!(adv.priorities || []).length) html += '<p class="small muted" style="margin:4px 0">No declining priorities. All tracked tests are at or above baseline.</p>';
      else html += '<ul class="small" style="margin:4px 0;padding-left:18px">' + adv.priorities.map(function (p) {
        return '<li><b>' + h.esc(p.displayName) + '</b> (evidence ' + h.esc(p.evidenceScore) + ', confidence '
          + h.esc(p.confidence) + (p.goalAligned ? ', goal-aligned' : '') + '): '
          + h.esc((p.sources || []).map(function (s) { return s.assessmentId + ' ' + s.baseline + ' → ' + s.current; }).join('; ')) + '</li>';
      }).join('') + '</ul>';
      html += '</div>';
    }
    if (state.readiness) {
      const r = state.readiness;
      html += '<div style="margin-top:12px"><div class="eyebrow">Training plan</div>'
        + '<p class="small" style="margin:4px 0">'
        + (r.ready ? 'Plan is ready to finalize — baseline complete.'
          : 'Plan is not ready to finalize — baseline incomplete, still missing: '
            + h.esc((r.missing || []).map(function (id) { const s = slotById(h.slots, id); return s ? s.name : id; }).join(', ') || 'required tests') + '.')
        + '</p>';
      if (h.canAssess) {
        html += '<div class="row" style="gap:8px;flex-wrap:wrap">'
          + '<button class="btn sm" data-aui="plan-create" data-athlete="' + h.esc(state.athleteId) + '">Create plan</button>';
        if (state.plan) {
          html += '<span class="small">Plan <span class="mono">' + h.esc(state.plan.id) + '</span> · '
            + h.esc(state.plan.status) + '</span>'
            + '<label class="small">Override reason <input id="aui-override-reason" type="text" placeholder="required only when the plan is not ready"'
            + ' style="width:280px;border:1px solid var(--line-strong);background:var(--surface);padding:8px"></label>'
            + '<button class="btn sm" data-aui="plan-finalize" data-plan="' + h.esc(state.plan.id) + '">Finalize plan</button>';
        }
        html += '</div>';
        if (state.plan && state.plan.status === 'finalized' && state.plan.overrideReason) {
          html += '<p class="small muted" style="margin:6px 0 0">Finalized with a recorded override: '
            + h.esc(state.plan.overrideReason) + ' (approved by ' + h.esc(state.plan.overrideApprovedBy || '') + ').</p>';
        }
      }
      html += '</div>';
    }
    return html;
  }

  function renderDeferForm(state, h) {
    const athlete = state.roster ? state.roster.find(function (a) { return String(a.id) === String(state.athleteId); }) : null;
    const name = athlete ? (athlete.name || athlete.id) : state.athleteId;
    const inputStyle = 'border:1px solid var(--line-strong);background:var(--surface);padding:8px';
    return '<div class="row" style="justify-content:space-between;margin-bottom:10px"><div><b>'
      + h.esc(name) + '</b> <span class="muted small">Coach-approved deferral, exclusion, or modification</span></div>'
      + '<div><button class="btn sm ghost" data-aui="run" data-athlete="' + h.esc(state.athleteId) + '">← Back to assessment</button></div></div>'
      + '<div class="row" style="gap:12px;flex-wrap:wrap">'
      + '<label class="small">Scope <select id="aui-def-scope" style="' + inputStyle + '">'
      + '<option value="test">One test</option><option value="battery">Whole battery</option></select></label>'
      + '<label class="small">Kind <select id="aui-def-kind" style="' + inputStyle + '">'
      + '<option value="deferral">Deferral</option><option value="exclusion">Exclusion</option><option value="modification">Modification</option></select></label>'
      + '<label class="small">Test <select id="aui-def-test" style="' + inputStyle + '">'
      + h.slots.map(function (s) { return '<option value="' + h.esc(s.defId) + '">' + h.esc(s.name) + '</option>'; }).join('')
      + '</select></label>'
      + '<label class="small">Deferred until <input id="aui-def-until" type="date" style="' + inputStyle + '"></label>'
      + '</div>'
      + '<div style="margin-top:10px"><label class="small">Reason (required, recorded) <input id="aui-def-reason" type="text" placeholder="e.g. Ankle sprain — no jumping until cleared"'
      + ' style="width:100%;max-width:560px;' + inputStyle + '"></label></div>'
      + '<div class="row" style="gap:8px;margin-top:12px"><button class="btn solid sm" data-aui="defer-save" data-athlete="'
      + h.esc(state.athleteId) + '">Record</button></div>'
      + '<p class="muted small" style="margin:10px 0 0">A deferral never marks an assessment complete. '
      + 'An exclusion lets a baseline complete without that test; a deferral pauses its due date until the date given.</p>';
  }

  /* The live section prepended to the Assessments view. */
  function renderLiveSection(state, h) {
    let right = '';
    if (h.devRoles) {
      right += h.devRoles.map(function (r) {
        const active = state.role && state.role.user === r.user;
        return '<button class="btn sm' + (active ? ' solid' : '') + '" data-aui="role" data-role="' + h.esc(r.role)
          + '" data-user="' + h.esc(r.user) + '"' + (r.athleteId ? ' data-athlete="' + h.esc(r.athleteId) + '"' : '')
          + '>' + h.esc(r.label) + '</button>';
      }).join(' ');
    }
    right += ' <button class="btn sm ghost" data-aui="refresh">Refresh</button>';
    let body = '';
    if (state.connected === false) {
      body += '<p class="muted" style="margin:0">Assessment service not connected — start the dev server (<span class="mono">npm run dev</span>) to record assessments.</p>';
    } else if (state.connected !== true) {
      body += '<p class="muted" style="margin:0">Connecting to the assessment service…</p>';
    } else {
      if (!h.slots.length) body += '<div class="note">Protocol data unavailable — the run-assessment form is disabled until the service answers GET …/battery.</div>';
      if (state.view === 'run') body += renderRunForm(state, h);
      else if (state.view === 'history') body += renderHistory(state, h);
      else if (state.view === 'defer') body += renderDeferForm(state, h);
      else body += renderRoster(state, h);
    }
    return panel(h, 'Live assessments — recorded through the GAA workflow · 28-day cycle',
      lblLocal(h, state.connected ? 'Connected' : 'Offline', state.connected ? 'ok' : 'assume') + ' ' + right,
      errorNote(h, state.error) + (state.notice ? '<div class="note">' + h.esc(state.notice) + '</div>' : '') + body);
  }

  /* Compact live section appended to an athlete profile, only when
   * the athlete is in the live roster (matched by id). */
  function renderAthleteSection(state, h, athleteId) {
    if (!state.connected || !state.roster) return '';
    const found = state.roster.some(function (a) { return String(a.id) === String(athleteId); });
    if (!found) return '';
    const view = state.athleteView && String(state.athleteView.athleteId) === String(athleteId) ? state.athleteView : null;
    let body;
    if (!view) {
      body = '<p class="muted" style="margin:0">Loading live assessment history…</p>';
    } else {
      const lab = view.schedule ? statusLabel(view.schedule.status) : null;
      const pbs = Object.keys((view.progress && view.progress.tests) || {}).map(function (id) {
        const p = view.progress.tests[id];
        const slot = slotById(h.slots, id);
        return '<div class="small">' + h.esc(slot ? slot.name : id) + ': <b class="mono">'
          + h.esc(fmtResult(p.personalBest, p.unit)) + '</b>' + (p.isPersonalBest ? ' ★ current best' : '') + '</div>';
      }).join('');
      body = '<p class="small" style="margin:0 0 8px">'
        + (view.baseline && view.baseline.complete ? 'Baseline complete ' + fmtDate(view.baseline.completedAt) : 'Baseline incomplete')
        + (lab ? ' · <span class="lbl ' + lab.cls + '">' + h.esc(lab.text) + '</span>' : '')
        + (view.schedule && view.schedule.nextDueAt ? ' · next due ' + fmtDate(view.schedule.nextDueAt) : '')
        + '</p>' + (pbs || '<p class="muted" style="margin:0">No recorded results yet.</p>');
    }
    return panel(h, 'Assessments — live',
      lblLocal(h, 'Live', 'v1'),
      body + '<div class="row" style="gap:8px;margin-top:10px">'
      + (h.canAssess ? '<button class="btn sm" data-aui="run" data-athlete="' + h.esc(athleteId) + '">Start / resume assessment</button> ' : '')
      + '<button class="btn sm ghost" data-aui="history" data-athlete="' + h.esc(athleteId) + '">Full history</button></div>');
  }

  /* ------------------------------------------------------------------ */
  /* Controller                                                          */
  /* ------------------------------------------------------------------ */

  /* Dev-only "View as" users. Mirrors server/fixtures/dev-roster.js;
   * shown only when the UI runs in dev mode (no endpoint/getToken
   * configured for a deployed Edge Function). */
  var DEV_ROLES = [
    { role: 'director', user: 'dev-director-marcus', label: 'Director (Marcus)' },
    { role: 'coach', user: 'dev-coach-kayla', label: 'Coach Kayla (YAK)' },
    { role: 'coach', user: 'dev-coach-jordan', label: 'Coach Jordan (ELL)' },
    { role: 'coach', user: 'dev-coach-marcus', label: 'Coach Marcus (CLE)' },
    { role: 'parent', user: 'dev-parent-youth', label: 'Parent of Synthetic Youth (12)' },
    { role: 'athlete', user: 'dev-athlete-youth', athleteId: 'ath-synth-youth-12', label: 'Athlete: Synthetic Youth (12)' },
  ];

  function createAssessmentUI(options) {
    options = options || {};
    var root = options.root || (typeof globalThis !== 'undefined' ? globalThis : {});
    var doc = options.doc || root.document || null;
    var endpoint = options.endpoint || root.ASSESSMENT_API_URL || '/api/assessments';
    var getToken = typeof options.getToken === 'function' ? options.getToken : null;
    var devMode = options.dev !== false;
    var injectedClient = options.client || null;

    var state = {
      connected: null, error: null, notice: null,
      role: DEV_ROLES[0],
      roster: null, dashboard: null, battery: null,
      view: 'roster', athleteId: null, draft: null,
      athleteView: null, readiness: null, plan: null,
    };
    var installed = false;
    var clientCache = {};
    var loadingAthleteViewFor = null;

    function resolveHelpers() {
      var e = (typeof esc === 'function') ? esc : escLocal;
      var l = (typeof lbl === 'function') ? lbl : null;
      return { esc: e, lbl: l };
    }

    function helpers() {
      var h = resolveHelpers();
      h.slots = state.battery ? entrySlots(state.battery.tests) : [];
      h.athleteName = function (id) {
        const found = (state.roster || []).find(function (a) { return String(a.id) === String(id); });
        return found ? (found.name || found.id) : String(id);
      };
      h.canAssess = state.role && (state.role.role === 'director' || state.role.role === 'coach');
      h.devRoles = devMode ? DEV_ROLES : null;
      h.role = state.role;
      return h;
    }

    function makeClient(role) {
      if (injectedClient) return injectedClient;
      if (!root.AssessmentClient || typeof root.AssessmentClient.createAssessmentClient !== 'function') {
        throw new Error('AssessmentClient is not loaded.');
      }
      const key = role.user;
      if (!clientCache[key]) {
        clientCache[key] = root.AssessmentClient.createAssessmentClient({
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
      try { if (typeof root.toast === 'function') root.toast(msg); } catch (e) { /* toast is best-effort */ }
    }

    function rerender() {
      try {
        if (typeof root.render === 'function' && typeof S !== 'undefined' && S) root.render(true);
      } catch (e) { /* render before boot — the next render picks it up */ }
    }

    function fail(e) {
      state.error = { code: (e && e.code) || 'ERROR', message: (e && e.message) || String(e) };
      state.notice = null;
    }

    async function loadBattery() {
      if (state.battery) return state.battery;
      try {
        state.battery = await client().getBattery();
      } catch (e) {
        state.battery = null;
      }
      return state.battery;
    }

    async function refresh() {
      state.error = null;
      let ok = false;
      try { ok = await client().probe(); } catch (e) { ok = false; }
      state.connected = ok;
      if (!ok) { state.roster = null; state.dashboard = null; rerender(); return false; }
      await loadBattery();
      try { state.roster = await client().listAthletes({}); } catch (e) { fail(e); state.roster = null; }
      try { state.dashboard = await client().coachDashboard({}); }
      catch (e) { state.dashboard = null; /* parent/athlete roles have no dashboard */ }
      rerender();
      return true;
    }

    async function loadAthleteView(athleteId) {
      if (loadingAthleteViewFor === athleteId) return;
      loadingAthleteViewFor = athleteId;
      try {
        const view = await client().athleteAssessmentView({ athleteId: athleteId });
        state.athleteView = view;
        try { state.readiness = await client().planReadiness({ athleteId: athleteId }); }
        catch (e) { state.readiness = null; }
      } catch (e) {
        if (state.view === 'history' && String(state.athleteId) === String(athleteId)) fail(e);
      } finally {
        loadingAthleteViewFor = null;
      }
      rerender();
    }

    async function openRun(athleteId) {
      state.athleteId = athleteId;
      state.view = 'run';
      state.error = null;
      state.notice = null;
      state.plan = null;
      try {
        await loadBattery();
        if (!state.battery) throw new Error('Protocol data unavailable — the service did not answer GET …/battery.');
        state.draft = await client().startAssessment({ athleteId: athleteId });
      } catch (e) { fail(e); state.view = 'roster'; }
      rerender();
    }

    async function openHistory(athleteId) {
      state.athleteId = athleteId;
      state.view = 'history';
      state.error = null;
      state.notice = null;
      state.plan = null;
      state.athleteView = null;
      state.readiness = null;
      await loadAthleteView(athleteId);
    }

    async function saveRun() {
      state.error = null;
      state.notice = null;
      const slots = helpers().slots;
      const read = readRunForm(doc, slots);
      if (read.problems.length) { fail({ code: 'INVALID_INPUT', message: read.problems.join(' ') }); rerender(); return; }
      const entries = buildEntries(read.form, slots);
      if (!entries.length) {
        fail({ code: 'INVALID_INPUT', message: 'Nothing to save — enter at least one attempt or movement observations.' });
        rerender(); return;
      }
      const problems = validateEntries(entries, slots);
      if (problems.length) { fail({ code: 'INVALID_INPUT', message: problems.join(' ') }); rerender(); return; }
      try {
        const context = {};
        if (read.form.context.timingMethod) context.timingMethod = read.form.context.timingMethod;
        if (read.form.context.surface) context.surface = read.form.context.surface;
        state.draft = await client().recordAttempts({ athleteId: state.athleteId, entries: entries, context: context });
        state.notice = 'Draft saved — ' + state.draft.entries.length + ' test(s) recorded, '
          + (state.draft.missing.length ? state.draft.missing.length + ' still needed.' : 'nothing missing.');
        toast('Draft saved');
      } catch (e) { fail(e); }
      rerender();
    }

    async function completeRun() {
      state.error = null;
      state.notice = null;
      const slots = helpers().slots;
      const read = readRunForm(doc, slots);
      if (read.problems.length) { fail({ code: 'INVALID_INPUT', message: read.problems.join(' ') }); rerender(); return; }
      const entries = buildEntries(read.form, slots);
      const problems = validateEntries(entries, slots);
      if (problems.length) { fail({ code: 'INVALID_INPUT', message: problems.join(' ') }); rerender(); return; }
      try {
        const context = {};
        if (read.form.context.timingMethod) context.timingMethod = read.form.context.timingMethod;
        if (read.form.context.surface) context.surface = read.form.context.surface;
        if (entries.length) {
          state.draft = await client().recordAttempts({ athleteId: state.athleteId, entries: entries, context: context });
        }
        const done = await client().completeAssessment({ athleteId: state.athleteId, entries: entries, context: context });
        state.notice = done.idempotentReplay
          ? 'Assessment already recorded — showing the original session (no duplicate).'
          : 'Assessment complete — baseline ' + (done.baseline && done.baseline.complete ? 'established' : 'still incomplete')
            + (done.schedule && done.schedule.nextDueAt ? ', next reassessment ' + fmtDate(done.schedule.nextDueAt) + '.' : '.');
        state.view = 'history';
        state.draft = null;
        await loadAthleteView(state.athleteId);
        toast('Assessment complete');
      } catch (e) { fail(e); }
      rerender();
    }

    async function discardRun() {
      state.error = null;
      state.notice = null;
      try {
        await client().discardDraft({ athleteId: state.athleteId });
        state.notice = 'Draft discarded — no record was created.';
        state.draft = null;
        state.view = 'roster';
      } catch (e) { fail(e); }
      rerender();
    }

    async function saveDeferral(athleteId) {
      state.error = null;
      state.notice = null;
      const form = readDeferralForm(doc);
      if (!form.reason) {
        fail({ code: 'INVALID_INPUT', message: 'A reason is required — deferrals, exclusions and modifications are coach-approved and recorded.' });
        rerender(); return;
      }
      try {
        await client().recordDeferral({
          athleteId: athleteId, battery: 'generalAthleticAssessment',
          scope: form.scope, kind: form.kind,
          assessmentId: form.scope === 'test' ? form.assessmentId : null,
          deferredUntil: form.kind === 'deferral' && form.deferredUntil ? new Date(form.deferredUntil).toISOString() : null,
          reason: form.reason,
        });
        state.notice = 'Recorded — ' + form.kind + ' for ' + (form.scope === 'battery' ? 'the whole battery' : form.assessmentId) + '.';
        await openRun(athleteId);
      } catch (e) { fail(e); rerender(); }
    }

    async function createPlan(athleteId) {
      state.error = null;
      state.notice = null;
      try {
        state.plan = await client().createPlan({ athleteId: athleteId });
        state.readiness = await client().planReadiness({ athleteId: athleteId });
        state.notice = 'Plan created as a draft — finalize it when the baseline is ready (or record an override).';
      } catch (e) { fail(e); }
      rerender();
    }

    async function finalizePlan(planId) {
      state.error = null;
      state.notice = null;
      let override = null;
      if (doc) {
        const el = doc.getElementById('aui-override-reason');
        const reason = el ? String(el.value || '').trim() : '';
        if (reason) override = { reason: reason, approvedBy: state.role.user };
      }
      try {
        state.plan = await client().finalizePlan({ planId: planId, override: override });
        state.readiness = await client().planReadiness({ athleteId: state.plan.athleteId });
        state.notice = override
          ? 'Plan finalized with a recorded override: ' + override.reason
          : 'Plan finalized — baseline complete.';
      } catch (e) { fail(e); }
      rerender();
    }

    async function switchRole(role) {
      state.role = role;
      state.view = 'roster';
      state.athleteId = null;
      state.draft = null;
      state.athleteView = null;
      state.readiness = null;
      state.plan = null;
      state.roster = null;
      state.dashboard = null;
      await refresh();
    }

    function onClick(e) {
      const t = e.target && e.target.closest ? e.target.closest('[data-aui]') : null;
      if (!t) return;
      const action = t.getAttribute('data-aui');
      const athleteId = t.getAttribute('data-athlete');
      const planId = t.getAttribute('data-plan');
      const handlers = {
        'roster': function () { state.view = 'roster'; state.error = null; rerender(); return Promise.resolve(); },
        'run': function () { return openRun(athleteId); },
        'history': function () { return openHistory(athleteId); },
        'defer': function () { state.view = 'defer'; state.athleteId = athleteId; state.error = null; rerender(); return Promise.resolve(); },
        'save': function () { return saveRun(); },
        'complete': function () { return completeRun(); },
        'discard': function () { return discardRun(); },
        'defer-save': function () { return saveDeferral(athleteId); },
        'plan-create': function () { return createPlan(athleteId); },
        'plan-finalize': function () { return finalizePlan(planId); },
        'role': function () {
          return switchRole({
            role: t.getAttribute('data-role'), user: t.getAttribute('data-user'),
            athleteId: athleteId || null,
            label: (t.textContent || '').trim(),
          });
        },
        'refresh': function () { return refresh(); },
      };
      const fn = handlers[action];
      if (!fn) return;
      Promise.resolve().then(fn).catch(function (err) { fail(err); rerender(); });
    }

    function install() {
      if (installed) return true;
      if (!root.AssessmentClient || typeof root.AssessmentClient.createAssessmentClient !== 'function') return false;
      if (typeof root.vAssess === 'function' && !root.vAssess.__auiWrapped) {
        const orig = root.vAssess;
        const wrapped = function () { return renderLiveSection(state, helpers()) + orig.apply(this, arguments); };
        wrapped.__auiWrapped = true;
        root.vAssess = wrapped;
      }
      if (typeof root.vAthlete === 'function' && !root.vAthlete.__auiWrapped) {
        const orig = root.vAthlete;
        const wrapped = function (id) {
          const base = orig.apply(this, arguments);
          const extra = renderAthleteSection(state, helpers(), id);
          if (extra && (!state.athleteView || String(state.athleteView.athleteId) !== String(id))) {
            loadAthleteView(id);
          }
          return base + extra;
        };
        wrapped.__auiWrapped = true;
        root.vAthlete = wrapped;
      }
      if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('click', onClick);
      installed = true;
      refresh();
      return true;
    }

    return {
      state: state, install: install, refresh: refresh,
      openRun: openRun, openHistory: openHistory,
      saveRun: saveRun, completeRun: completeRun, discardRun: discardRun,
      saveDeferral: saveDeferral, createPlan: createPlan, finalizePlan: finalizePlan,
      switchRole: switchRole, loadAthleteView: loadAthleteView,
      helpers: helpers, slots: function () { return helpers().slots; },
      renderLiveSection: function () { return renderLiveSection(state, helpers()); },
      renderAthleteSection: function (id) { return renderAthleteSection(state, helpers(), id); },
      onClick: onClick, client: client, devMode: devMode,
    };
  }

  return {
    createAssessmentUI: createAssessmentUI,
    entrySlots: entrySlots, buildEntries: buildEntries, validateEntries: validateEntries,
    readRunForm: readRunForm, readDeferralForm: readDeferralForm,
    renderLiveSection: renderLiveSection, renderRoster: renderRoster,
    renderRunForm: renderRunForm, renderHistory: renderHistory,
    renderDeferForm: renderDeferForm, renderAthleteSection: renderAthleteSection,
    esc: escLocal, fmtDate: fmtDate, fmtResult: fmtResult,
    statusLabel: statusLabel, progressStatusLabel: progressStatusLabel, signed: signed,
    DEV_ROLES: DEV_ROLES,
  };
});
