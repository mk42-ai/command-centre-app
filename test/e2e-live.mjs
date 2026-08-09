// ============================================================
// e2e-live.mjs — END-TO-END tests against the LIVE OnDemand API.
//
// Validates the v35 migration to the Zoho connector agent
// (agent-1784351533) end-to-end:
//   T1  POST /chat/v1/sessions        agentIds:[connector] → 201 + data.id
//   T2  POST /sessions/{id}/query     sync recent-emails query via connector
//   T3  baseline messageId match + newest-first ordering (13-digit epoch
//       prefix embedded in every Zoho messageId, strictly non-increasing)
//   T4  app-level fetchRecentMail() returns the same baseline newest-first
//   T5  (optional) media/v1/public/file/raw multipart with agents=[connector]
//   T6  static scan — zero legacy IDs anywhere in the repo
//
// Run:  node test/e2e-live.mjs      (or: npm run test:e2e)
// Exit: 0 = all REQUIRED tests passed · 1 = a required test failed ·
//       2 = ONDEMAND_API_KEY missing.
// Results are also written to test/e2e-results.json with per-test
// timestamps and pass/fail status. The API key is read ONLY from
// process.env and is never printed or persisted.
// ============================================================
import '../server/lib/env.js'; // loads .env + aliases ON_DEMAND_* → ONDEMAND_*
import { fetchRecentMail } from '../server/lib/ondemand-mail.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const AGENT_ID = 'agent-1784351533';
const ENDPOINT_ID = process.env.ONDEMAND_SEND_ENDPOINT_ID || 'predefined-gemini-3.6-flash';
const BASE = (process.env.ONDEMAND_BASE_URL || 'https://api.on-demand.io/chat/v1').replace(/\/+$/, '');
const MEDIA_URL = process.env.ONDEMAND_MEDIA_URL || 'https://api.on-demand.io/media/v1/public/file/raw';
const KEY = process.env.ONDEMAND_API_KEY || '';

// Step-2 live Zoho inbox baseline (fetched 2026-08-09, newest first):
// the fixed flow's output MUST match these messageIds and ordering.
const BASELINE = [
  '1786255553483141900', // On-Demand · "OnDemand.io: Your live session update is ready"
  '1786255198411141900', // On-Demand
  '1786252917214141900', // On-Demand
  '1786252730712141900', // On-Demand
  '1786241360374141900', // on-demand · "Stock Analysis Report: AAPL, TSLA, and AMZN"
  '1786229757846141900', // Ali Zamiri · "Accepted: MK x Ali catch up"
  '1786227643425141900', // Ali Zamiri
  '1786227470649141900', // WHOOP · "Your first Sleep Score is here"
  '1786219120218141900', // On-Demand
  '1786218871250141900', // On-Demand
];

// Legacy deprecated Zoho plugin/agent ID digit sequences, assembled from
// split parts so this scanner file itself never contains a contiguous
// occurrence (keeping the repo 100% free of the legacy ID strings).
const LEGACY_ID_PARTS = [['17417', '70626'], ['17222', '85968'], ['17139', '54536']];
const LEGACY_ID_RE = new RegExp(LEGACY_ID_PARTS.map((p) => p.join('')).join('|'));

if (!KEY) {
  console.error(`[${new Date().toISOString()}] FATAL ONDEMAND_API_KEY not set — cannot run live e2e tests.`);
  process.exit(2);
}

// ---------- tiny harness (ISO timestamp on every line) ----------
const results = [];
async function test(name, required, fn) {
  const t0 = new Date();
  try {
    const detail = await fn();
    results.push({ name, required, status: 'PASS', startedAt: t0.toISOString(), endedAt: new Date().toISOString(), ms: Date.now() - t0.getTime(), detail });
    console.log(`[${new Date().toISOString()}] PASS ${name}`);
  } catch (e) {
    results.push({ name, required, status: 'FAIL', startedAt: t0.toISOString(), endedAt: new Date().toISOString(), ms: Date.now() - t0.getTime(), error: String(e?.message || e) });
    console.log(`[${new Date().toISOString()}] FAIL ${name} — ${String(e?.message || e)}`);
  }
}

async function fetchJson(url, init, timeoutMs, label) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ac.signal });
    const json = await resp.json().catch(() => ({}));
    return { resp, json };
  } catch (e) {
    throw new Error(`${label} ${ac.signal.aborted ? `timed out after ${timeoutMs}ms` : `network error: ${e?.message || e}`}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonIsland(text) {
  if (!text) return null;
  const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : String(text);
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  for (let end = body.length; end > start; end--) {
    try { return JSON.parse(body.slice(start, end)); } catch { /* shrink */ }
  }
  return null;
}

// ---------- tests ----------
let sessionId = null;
let queryEmails = null;

await test('T1 session.create agentIds=[agent-1784351533]', true, async () => {
  const { resp, json } = await fetchJson(`${BASE}/sessions`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentIds: [AGENT_ID],
      externalUserId: `e2e-${Date.now()}`,
      contextMetadata: [
        { key: 'app', value: 'meera-command-centre' },
        { key: 'purpose', value: 'e2e-live-test' },
      ],
    }),
  }, 30000, 'session.create');
  if (resp.status !== 201) throw new Error(`expected HTTP 201, got ${resp.status}: ${JSON.stringify(json).slice(0, 200)}`);
  sessionId = json?.data?.id || null;
  if (!sessionId) throw new Error(`201 but no data.id in response: ${JSON.stringify(json).slice(0, 200)}`);
  return { status: resp.status, sessionId };
});

await test('T2 query.sync recent emails via connector', true, async () => {
  if (!sessionId) throw new Error('no sessionId from T1');
  const { resp, json } = await fetchJson(`${BASE}/sessions/${encodeURIComponent(sessionId)}/query`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpointId: ENDPOINT_ID,
      query: 'Use your Zoho Mail tools to list the 10 MOST RECENT inbox emails NEWEST FIRST. Output STRICT JSON only: an array of {"messageId":"...","sender":"...","subject":"...","receivedTime":<epoch ms>}. The messageId must be the EXACT Zoho messageId. No commentary.',
      agentIds: [AGENT_ID],
      responseMode: 'sync',
      modelConfigs: { fulfillmentPrompt: '', stopSequences: [], temperature: 0.7, topP: 1, maxTokens: 0, presencePenalty: 0, frequencyPenalty: 0 },
    }),
  }, 120000, 'query.sync');
  if (resp.status !== 200) throw new Error(`expected HTTP 200, got ${resp.status}: ${JSON.stringify(json).slice(0, 200)}`);
  const answer = json?.data?.answer || '';
  const parsed = parseJsonIsland(answer);
  if (!Array.isArray(parsed)) throw new Error(`answer did not parse to a JSON array (head: ${String(answer).slice(0, 160)})`);
  if (parsed.length < 10) throw new Error(`expected >=10 emails, got ${parsed.length}`);
  queryEmails = parsed;
  return { status: resp.status, count: parsed.length, first3Ids: parsed.slice(0, 3).map((m) => String(m.messageId)) };
});

await test('T3 baseline messageId match + newest-first ordering', true, async () => {
  if (!queryEmails) throw new Error('no emails from T2');
  const got = queryEmails.slice(0, 10).map((m) => String(m.messageId));
  for (let i = 0; i < BASELINE.length; i++) {
    if (got[i] !== BASELINE[i]) {
      throw new Error(`baseline mismatch at index ${i}: expected ${BASELINE[i]}, got ${got[i]} (full got: ${JSON.stringify(got)})`);
    }
  }
  // Newest-first proof: Zoho messageIds embed receive time — first 13 digits
  // are epoch ms; the sequence must be strictly non-increasing.
  for (let i = 1; i < got.length; i++) {
    const prev = Number(got[i - 1].slice(0, 13));
    const cur = Number(got[i].slice(0, 13));
    if (!(cur <= prev)) throw new Error(`ordering violation at index ${i}: ${got[i]} (epoch ${cur}) is newer than ${got[i - 1]} (epoch ${prev})`);
  }
  return { matched: BASELINE.length, ordering: 'newest-first' };
});

await test('T4 app fetchRecentMail() returns baseline newest-first', true, async () => {
  const r = await fetchRecentMail({ lookbackDays: 7, maxResults: 10 });
  if (r.ok !== true) throw new Error(`fetchRecentMail returned ok=${r.ok}`);
  if (!Array.isArray(r.emails) || r.emails.length < 1) throw new Error(`fetchRecentMail returned ${r.emails?.length ?? 0} emails`);
  const got = r.emails.map((m) => String(m.messageId));
  const n = Math.min(got.length, BASELINE.length);
  for (let i = 0; i < n; i++) {
    if (got[i] !== BASELINE[i]) {
      throw new Error(`app-flow baseline mismatch at index ${i}: expected ${BASELINE[i]}, got ${got[i]} (full got: ${JSON.stringify(got)})`);
    }
  }
  if (got[0] !== BASELINE[0]) throw new Error(`newest email mismatch: expected ${BASELINE[0]}, got ${got[0]}`);
  for (let i = 1; i < r.emails.length; i++) {
    const prev = r.emails[i - 1].dateMs ?? r.emails[i - 1].receivedTime ?? 0;
    const cur = r.emails[i].dateMs ?? r.emails[i].receivedTime ?? 0;
    if (!(cur <= prev)) throw new Error(`app-flow ordering violation at index ${i}: ${cur} > ${prev}`);
  }
  return { count: r.count, firstId: r.emails[0]?.messageId, agentId: r.agentId, matchedBaselinePrefix: n, ordering: 'newest-first' };
});

await test('T5 media upload with agents=[connector] (optional)', false, async () => {
  const fd = new FormData();
  fd.append('file', new Blob([`e2e proof ${new Date().toISOString()}`], { type: 'text/plain' }), 'e2e-proof.txt');
  fd.append('createdBy', 'AIREV');
  fd.append('updatedBy', 'AIREV');
  fd.append('name', 'e2e-proof.txt');
  fd.append('responseMode', 'sync');
  if (sessionId) fd.append('sessionId', sessionId);
  fd.append('agents', AGENT_ID);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  let resp, json;
  try {
    resp = await fetch(MEDIA_URL, { method: 'POST', headers: { apikey: KEY }, body: fd, signal: ac.signal });
    json = await resp.json().catch(() => ({}));
  } catch (e) {
    throw new Error(`media upload ${ac.signal.aborted ? 'timed out after 60000ms' : `network error: ${e?.message || e}`}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok || !json?.data) throw new Error(`media upload HTTP ${resp.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return { status: resp.status, mediaId: json.data.id || null };
});

await test('T6 no legacy IDs remain in codebase', true, async () => {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
  const SKIP_FILES = new Set([path.join(REPO_ROOT, 'test', 'e2e-results.json')]);
  let filesScanned = 0;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && !SKIP_FILES.has(full)) {
        filesScanned += 1;
        const text = fs.readFileSync(full, 'utf8');
        if (LEGACY_ID_RE.test(text)) offenders.push(path.relative(REPO_ROOT, full));
      }
    }
  };
  walk(REPO_ROOT);
  if (offenders.length) throw new Error(`legacy IDs found in: ${offenders.join(', ')}`);
  return { filesScanned };
});

// ---------- summary + results file ----------
const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
const requiredFailed = results.filter((r) => r.status === 'FAIL' && r.required).length;
const summary = { total: results.length, passed, failed, requiredFailed };

fs.writeFileSync(path.join(HERE, 'e2e-results.json'), JSON.stringify({
  ranAt: new Date().toISOString(),
  base: BASE,
  endpointId: ENDPOINT_ID,
  agentId: AGENT_ID,
  baseline: BASELINE,
  results,
  summary,
}, null, 2));

for (const r of results) {
  console.log(`[${new Date().toISOString()}] SUMMARY name=${r.name} status=${r.status} required=${r.required} ms=${r.ms}`);
}
console.log(`[${new Date().toISOString()}] TOTAL total=${summary.total} passed=${summary.passed} failed=${summary.failed} requiredFailed=${summary.requiredFailed}`);
process.exit(requiredFailed > 0 ? 1 : 0);
