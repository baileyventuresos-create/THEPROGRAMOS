/* THE PROGRAM OS — Development-only assessment server
 * server/dev-server.js
 *
 * Serves the static prototype (index.html, THE PROGRAM OS.html and its
 * scripts) on localhost and hosts the assessment workflow API behind
 * it, so the Phase 2 UI wiring can be exercised end to end with
 * SYNTHETIC data only, in an isolated environment:
 *
 *   GET  /                        -> index.html (the prototype)
 *   GET  /<file>                  -> static files under the repo root
 *   GET  /api/assessments/battery -> the GAA protocol text (read-only,
 *                                    from the real server/assessment-battery.js)
 *   POST /api/assessments         -> { method, params } dispatch onto
 *                                    server/assessment-api.js
 *                                    ({ ok:true, data } | { ok:false, error })
 *
 * DEV ONLY — never expose this on a public host:
 *   - Binds 127.0.0.1 only. No TLS, no real auth: the caller names a
 *     dev role/user in X-Dev-Role / X-Dev-User / X-Dev-Athlete headers
 *     and the server injects that auth context (the same convention
 *     the browser client uses in dev; production derives auth from a
 *     verified Supabase JWT in the Edge Function instead).
 *   - Memory stores only. Nothing is written to Supabase, Neon, or
 *     any file. Restarting the server wipes all recorded assessments.
 *   - Seeds the two synthetic fixture athletes on start (unless
 *     --no-seed): the 12-year-old gets a baseline 56 days ago and a
 *     reassessment 27.5 days ago (next due today); the 48-year-old gets
 *     a baseline 40 days ago (overdue 12 days). The other six dev
 *     athletes start never-assessed, so every reassessment bucket is
 *     visible on first load. Seed dates are relative to today; the
 *     fixture attempt VALUES are unchanged.
 *
 * Run:  node server/dev-server.js [--port 8123] [--no-seed]
 *       npm run dev   (same thing, default port)
 * Tests: node --test server/tests/dev-server.test.js
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { GAA_TESTS, PROTOCOL_VERSION, BATTERY_ID, RETEST_DAYS } = require('./assessment-battery');
const { MemoryAssessmentStore } = require('./assessment-store');
const { MemoryReassessmentStore } = require('./reassessment');
const { createAccessDirectory } = require('./assessment-access');
const { createAssessmentWorkflow, MemoryPlanStore } = require('./assessment-workflow');
const { createAssessmentApi, ALLOWED } = require('./assessment-api');
const { ATHLETES, COACH_AUTH, DEV_USERS, Wingback, Youth } = require('./fixtures/dev-roster');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PORT = 8123;
const MAX_BODY_BYTES = 1024 * 1024;

const DIRECTOR = { authUserId: 'dev-director-marcus', role: 'director' };

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function hoursAgo(n) {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

/* Seed the two fixture athletes through the workflow itself, so the
 * seeded sessions pass the same validation live entries do. */
async function seedFixtures(workflow) {
  await workflow.completeAssessment(DIRECTOR, {
    athleteId: Youth.athlete.id,
    entries: Youth.baseline.entries,
    context: { equipment: 'bodyweight + stopwatch', surface: 'turf', protocolVersion: PROTOCOL_VERSION },
    now: daysAgo(56),
  });
  await workflow.completeAssessment(DIRECTOR, {
    athleteId: Youth.athlete.id,
    entries: Youth.reassessment.entries,
    context: { equipment: 'bodyweight + stopwatch', surface: 'turf', protocolVersion: PROTOCOL_VERSION },
    /* 27.5 days ago, so the next reassessment falls due TODAY (whole
     * days until due == 0). Exactly 28 days would tip into overdue
     * within milliseconds of the seed. */
    now: hoursAgo(27.5 * 24),
  });
  await workflow.completeAssessment(DIRECTOR, {
    athleteId: Wingback.athlete.id,
    entries: Wingback.baseline.entries,
    context: { equipment: 'bodyweight + kettlebell', surface: 'turf', protocolVersion: PROTOCOL_VERSION },
    now: daysAgo(40),
  });
}

function createDevServer({ port = DEFAULT_PORT, root = ROOT, seed = true } = {}) {
  const directory = createAccessDirectory({ athletes: ATHLETES, coachAuth: COACH_AUTH });
  const workflow = createAssessmentWorkflow({
    store: new MemoryAssessmentStore(),
    reassessmentStore: new MemoryReassessmentStore(),
    planStore: new MemoryPlanStore(),
    directory,
  });
  const api = createAssessmentApi({ workflow });

  /* Dev-only auth: the caller names a role/user; the server injects
   * the auth context. Default is the director (Marcus) so curl works
   * without headers. Production never does this — the Edge Function
   * derives auth from a verified JWT. */
  function authFromHeaders(req) {
    const role = req.headers['x-dev-role'] || 'director';
    const authUserId = req.headers['x-dev-user'] || ('dev-' + role);
    const auth = { authUserId, role };
    if (req.headers['x-dev-athlete']) auth.athleteId = req.headers['x-dev-athlete'];
    if (role === 'coach' && COACH_AUTH[authUserId]) auth.coachId = COACH_AUTH[authUserId];
    return auth;
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function sendFile(res, filePath) {
    const ext = path.extname(filePath);
    const type = CONTENT_TYPES[ext];
    if (!type) { res.writeHead(403); res.end('Forbidden file type'); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
      res.end(data);
    });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { reject(new Error('Request body too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/api/assessments/battery') {
        sendJson(res, 200, { battery: BATTERY_ID, protocolVersion: PROTOCOL_VERSION, retestDays: RETEST_DAYS, tests: GAA_TESTS });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/assessments') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          sendJson(res, 400, { ok: false, error: { code: 'INVALID_INPUT', message: 'Request body must be JSON: ' + e.message } });
          return;
        }
        if (!body || typeof body.method !== 'string' || !ALLOWED[body.method] || typeof api[body.method] !== 'function') {
          sendJson(res, 400, { ok: false, error: { code: 'INVALID_METHOD', message: 'Unknown assessment method: ' + (body && body.method) } });
          return;
        }
        try {
          const data = await api[body.method](authFromHeaders(req), body.params || {});
          sendJson(res, 200, { ok: true, data });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: { code: e.code || 'WORKFLOW_ERROR', message: e.message } });
        }
        return;
      }

      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const filePath = path.resolve(root, rel);
        if (!filePath.startsWith(path.resolve(root) + path.sep) && filePath !== path.resolve(root)) {
          res.writeHead(400); res.end('Bad path'); return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.writeHead(404); res.end('Not found'); return;
        }
        sendFile(res, filePath);
        return;
      }

      res.writeHead(405); res.end('Method not allowed');
    } catch (e) {
      sendJson(res, 500, { ok: false, error: { code: 'DEV_SERVER_ERROR', message: e.message } });
    }
  });

  let listeningPort = null;
  return {
    server, api, workflow, directory, devUsers: DEV_USERS,
    get port() { return listeningPort; },
    get url() { return `http://127.0.0.1:${listeningPort}`; },
    async start() {
      if (seed) await seedFixtures(workflow);
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      listeningPort = server.address().port;
      return this;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.slice('--port='.length)) : DEFAULT_PORT;
  const seed = !args.includes('--no-seed');
  const dev = createDevServer({ port, seed });
  dev.start().then(() => {
    console.log('THE PROGRAM OS — dev assessment server (DEV ONLY, synthetic data, memory stores)');
    console.log(`  App:     ${dev.url}/`);
    console.log(`  API:     ${dev.url}/api/assessments`);
    console.log(`  Battery: ${dev.url}/api/assessments/battery`);
    console.log(`  Seeded:  ${seed ? 'yes (youth-12 baseline+reassessment, wingback-48 baseline)' : 'no'}`);
    console.log('  Roles:   send X-Dev-Role / X-Dev-User / X-Dev-Athlete headers; default is director.');
    console.log('  Stop with Ctrl-C. Restarting wipes all recorded assessments.');
  }).catch((e) => {
    console.error('Dev server failed to start:', e);
    process.exit(1);
  });
}

module.exports = { createDevServer, DEFAULT_PORT };
