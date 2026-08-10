// ============================================================
// Backend API surface — fast, cache-first endpoints.
// Heavy work is queued to async jobs; requests return in
// milliseconds from the KV cache. Endpoints:
//   POST /api/inbox/sync       — trigger incremental sync (async | ?wait=1)
//   POST /api/thread/analyze   — queue full analysis of one thread
//   GET  /api/dashboard/meera  — dashboard-ready JSON (LIVE-ONLY: a short
//                                in-memory hot window + background refresh;
//                                no snapshot fallback of any kind)
//   GET  /api/followups        — stalled threads / who owes next reply
//   GET  /api/sender-profile   — relationship memory (?email= | all)
//   GET  /api/daily-briefing   — latest (or ?date=YYYY-MM-DD) briefing
//   POST /api/refresh          — manual cache refresh (?deep=1 adds cleanup)
//   GET  /api/search           — semantic search over thread embeddings
//   GET  /api/jobs             — job + failed-job log (reliability visibility)
//   GET  /api/cron             — registered cron schedules + last status
//   GET  /api/cache/stats      — cache introspection
// ============================================================
import { Router } from 'express';
import { CONFIG } from './config.js';
import { kv, NS, semantic } from './lib/cache.js';
import { enqueue, jobStatus, waitForJob, recentJobs, failedJobs } from './lib/jobs.js';
import { cronSchedules } from './lib/cron.js';
import {
  syncInbox, getSyncState, rebuildDashboard, detectFollowups,
  generateDailyBriefing, refreshCache, profileSender, semanticSearch, analyzeThread,
} from './functions/pipeline.js';
// v31: live mail + file-directory orchestration (fixes #1 fetch, #2 send, #3 attach)
import { fetchRecentMail, listCompanyFiles, selectRelevantDocument, sendViaOnDemandAgent, lastSuccessfulSync } from './lib/ondemand-mail.js';
import { buildStructuredEmailHtml } from './lib/mail.js';

export const api = Router();

const t0 = Date.now();

// ---------- inbox sync ----------
api.post('/inbox/sync', async (req, res) => {
  const force = req.query.force === '1' || req.body?.force === true;
  const wait = req.query.wait === '1' || req.body?.wait === true;
  try {
    if (wait) {
      const result = await syncInbox({ force });
      return res.json({ ok: true, mode: 'sync', result });
    }
    const { jobId, deduped } = enqueue('syncInbox', { force }, { idempotencyKey: `manual-sync-${force}` });
    res.status(202).json({ ok: true, mode: 'async', jobId, deduped, poll: `/api/jobs?id=${jobId}` });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e?.message || e), syncState: getSyncState() });
  }
});

// ============================================================
// v31 (FIX #1) — LIVE inbox fetch: last N days, newest-first, structured
// JSON with full body. Fresh session + cache-buster per call; NEVER seed.
// GET/POST /api/mail/fetch?days=7&limit=50
// ============================================================
api.all('/mail/fetch', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  const days = Number(req.query.days || req.body?.days) || undefined;
  const limit = Number(req.query.limit || req.body?.limit) || undefined;
  try {
    const r = await fetchRecentMail({ lookbackDays: days, maxResults: limit });
    return res.json({ ok: true, ...r });
  } catch (e) {
    // v34: explicit structured SYNC ERROR — never serve stale cached inbox state.
    // The UI must show this error (with lastSuccessfulSyncTimestamp) rather than
    // silently rendering old mail. Seed fallback remains disabled.
    return res.status(e?.status || 502).json({
      ok: false, provider: 'ondemand-live', code: e?.code || 'MAIL_FETCH_FAILED',
      syncError: true,
      error: String(e?.message || e), rawAnswer: e?.rawAnswer || undefined,
      attempts: e?.attempts || undefined,
      lastSuccessfulSyncTimestamp: (e?.lastSuccessfulSyncTimestamp ?? lastSuccessfulSync().at) || null,
      note: 'Live OnDemand mail fetch failed after retry+failover. Showing an explicit sync error instead of stale cached mail; seed fallback is intentionally disabled.',
      ts: new Date().toISOString(),
    });
  }
});

// ============================================================
// v31 (FIX #3a) — semantic document selection over the company file
// directory. POST /api/documents/select { subject, body, sender?, org? }
// Returns the best-matching document + the ranked shortlist (no download).
// ============================================================
api.post('/documents/select', async (req, res) => {
  const { subject = '', body = '', summary = '', sender = '', org = '' } = req.body || {};
  if (!subject && !body && !summary) return res.status(400).json({ ok: false, error: 'subject or body/summary is required for document selection' });
  try {
    const files = await listCompanyFiles();
    const sel = selectRelevantDocument({ subject, body, summary, sender, org }, files);
    return res.json({
      ok: true, directoryCount: files.length, documentCount: files.filter((f) => f.isDoc).length,
      best: sel.best, ranked: sel.ranked, reason: sel.reason, ts: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(e?.status || 502).json({ ok: false, error: String(e?.message || e), ts: new Date().toISOString() });
  }
});

// ============================================================
// v31 (FIX #2 + #3) — structured send with REAL binary attachment.
// POST /api/send-structured { toAddress?, subject, body, autoSelectDoc?,
//   attachments?:[{name,url}], context?:{subject,body,sender,org} }
//   • builds a structured HTML body from `body` (validated non-empty),
//   • if autoSelectDoc, semantically picks the best company document,
//   • uploads each attachment as a REAL FILE (media/v1/public/file/raw),
//   • dispatches via sendMailDirect (Zoho REST when configured).
// Requires x-send-approved: true (parity with the existing send gate).
// Default recipient: mk@airev.ae.
// ============================================================
api.post('/send-structured', async (req, res) => {
  const approved = String(req.headers['x-send-approved'] || req.body?.sendApproved || '').toLowerCase() === 'true';
  const { toAddress = CONFIG.mail.mailbox, subject = '(no subject)', body = '', autoSelectDoc = false } = req.body || {};
  const bodyText = String(body || '').trim();
  if (!bodyText) return res.status(400).json({ ok: false, error: 'body must be non-empty (fix #2: never send an empty-body email)' });

  // 1. Resolve attachments — explicit list and/or semantic auto-selection.
  //    (Selection is a cheap directory read; the expensive binary upload is
  //    deferred until AFTER the approval gate so a dry-run stays fast.)
  const attachmentsIn = Array.isArray(req.body?.attachments) ? req.body.attachments.slice() : [];
  let selection = null;
  try {
    if (autoSelectDoc) {
      const ctx = req.body?.context || { subject, body: bodyText };
      const files = await listCompanyFiles();
      selection = selectRelevantDocument(ctx, files);
      if (selection.best) attachmentsIn.push({ name: selection.best.name, url: selection.best.url });
    }
  } catch (e) {
    return res.status(e?.status || 502).json({ ok: false, stage: 'doc-select', error: String(e?.message || e) });
  }

  // 2. Approval gate FIRST (before any upload/dispatch). Dry-run returns the
  //    selected document + validated body without spending an upload.
  if (!approved) {
    return res.status(403).json({
      ok: false, status: 'blocked-approval-required', dryRun: true,
      error: 'send blocked: explicit user approval required (x-send-approved: true)',
      preview: { toAddress, subject, bodyChars: bodyText.length, willAttach: attachmentsIn.map((a) => a.name), autoSelected: selection?.best ? { name: selection.best.name, score: selection.best.score } : null },
      ts: new Date().toISOString(),
    });
  }

  // 3. v32: dispatch THROUGH the OnDemand Zoho mail agent (agent-1784351533).
  //    The agent owns the mail credential — no ZOHO_* vars, no zoho-not-configured
  //    block. sendViaOnDemandAgent() opens a fresh session, uploads each
  //    attachment as a REAL binary bound to that session (media/v1/public/file/raw),
  //    references the uploaded media in the send query, and returns the agent's
  //    machine-readable "RESULT: SENT/FAILED" first line.
  const contentHtml = buildStructuredEmailHtml({ body: bodyText, attachments: attachmentsIn });
  let sent;
  try {
    sent = await sendViaOnDemandAgent({ toAddress, subject, contentHtml, attachments: attachmentsIn });
  } catch (e) {
    return res.status(e?.status || 502).json({ ok: false, stage: 'send', error: String(e?.message || e), ts: new Date().toISOString() });
  }
  const httpCode = sent.ok ? 200 : 502;
  return res.status(httpCode).json({
    ...sent,
    stage: 'send',
    toAddress, subject,
    bodyChars: bodyText.length,
    attachmentsUploaded: (sent.attachments || []).length,
    autoSelected: selection?.best ? { name: selection.best.name, score: selection.best.score } : null,
    ts: sent.ts || new Date().toISOString(),
  });
});

// ---------- per-thread analysis ----------
api.post('/thread/analyze', async (req, res) => {
  const threadId = String(req.body?.threadId || req.query.threadId || '');
  if (!threadId) return res.status(400).json({ ok: false, error: 'threadId is required' });
  const wait = req.query.wait === '1' || req.body?.wait === true;
  if (wait) {
    try {
      const result = await analyzeThread(threadId);
      return res.json({ ok: true, mode: 'sync', result });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e?.message || e) });
    }
  }
  const { jobId, deduped } = enqueue('analyzeThread', { threadId }, { idempotencyKey: `manual-${threadId}` });
  res.status(202).json({ ok: true, mode: 'async', jobId, deduped, poll: `/api/jobs?id=${jobId}` });
});

// ---------- dashboard (LIVE-ONLY — no snapshot fallback of any kind) ----------
// v40: this route can NEVER return a 5xx and can NEVER serve old data.
// History: the "HTTP 500" banner came from the unbounded cold-start warm-up
// blowing the serverless budget; v36 bounded it, v39 removed the lastGood
// snapshot fallback entirely. What remains is a LIVE-ONLY contract:
//   • hot window — the dashboard built <=180s ago (dashboardTtlS) is served
//     from process memory while a background refresh keeps it current;
//     this is NOT a snapshot store (never persisted, dies with the process);
//   • budget exceeded → explicit EMPTY degraded 'warming' shape;
//   • failure → explicit EMPTY degraded 'sync-error' shape.
// Old inbox data is never rendered under any path, at any age.
const emptyDashboardShape = (error = null) => ({
  generatedAt: new Date().toISOString(),
  mailbox: CONFIG.mail.mailbox,
  provider: 'ondemand-live',
  syncState: (() => { const s = getSyncState(); return { lastSyncAt: s.lastSyncAt, lastError: s.lastError || (error ? { message: error } : null), counts: s.counts }; })(),
  tierCounts: {},
  priorityPyramid: [1, 2, 3, 4, 5].map((tier) => ({ tier, count: 0, threads: [] })),
  topUrgent: [], stalledThreads: [], whoOwesNext: { us: [], them: [] },
  categories: [], sentimentRisk: [], suggestedReplies: [], relationshipMemory: [],
  threads: [], recentEmails: [],
});
const DASHBOARD_WARMUP_BUDGET_MS = Number(process.env.DASHBOARD_WARMUP_BUDGET_MS || (process.env.VERCEL ? 35000 : 45000));
// v40: MAX AGE of the in-memory hot window that may be served without a
// rebuild — bounded at the dashboard TTL (180s default). Anything older is
// treated as absent and a live rebuild runs. Belt-and-braces on top of the
// kv TTL so no config drift can ever widen the window silently.
const HOT_WINDOW_MAX_MS = Math.min(Number(process.env.DASHBOARD_HOT_WINDOW_MS || 180000), (CONFIG.cache.dashboardTtlS || 180) * 1000);
const dashAgeMs = (dash) => {
  const t = Date.parse(dash?.generatedAt || '');
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null;
};
api.get('/dashboard/meera', async (req, res) => {
  const entry = kv.getEntry(NS.DASHBOARD, 'meera');
  const isEmpty = (d) => !d || !Array.isArray(d.threads) || d.threads.length === 0;
  // v40 LIVE-ONLY hot window: serve the just-built dashboard from process
  // memory only while it is provably fresh (age <= HOT_WINDOW_MAX_MS AND its
  // own generatedAt agrees); label it 'live' — the old 'cache' label read as
  // "cached state" in the UI and hid how fresh the data actually was.
  if (entry && !isEmpty(entry.value)) {
    const age = dashAgeMs(entry.value);
    if (entry.ageMs <= HOT_WINDOW_MAX_MS && age != null && age <= HOT_WINDOW_MAX_MS) {
      if (entry.ageMs > (CONFIG.cache.dashboardTtlS * 1000) / 2) {
        enqueue('rebuildDashboard', {}, { idempotencyKey: 'swr-dashboard' });
      }
      return res.json({ ok: true, source: 'live', ageMs: entry.ageMs, lastUpdated: new Date(entry.storedAt).toISOString(), dataAsOf: entry.value.generatedAt, dataAgeMs: age, degraded: false, dashboard: entry.value });
    }
    // hot window exceeded → fall through to a LIVE rebuild (never serve it)
  }
  // LIVE-ONLY: no snapshot fallback exists — on warm-up overrun or failure
  // the route answers with an explicitly EMPTY (degraded-labelled) shape;
  // the UI shows its sync banner and the 60s poll picks up the live rebuild.
  const warmUp = (async () => {
    if (kv.keys(NS.EMAIL_META).length === 0) await syncInbox({});
    let d = await rebuildDashboard();
    if (isEmpty(d)) { await syncInbox({ force: true }); d = await rebuildDashboard(); }
    return d;
  })();
  warmUp.catch(() => {}); // budget may abandon it — never an unhandled rejection
  const BUDGET = Symbol('budget');
  let timer = null;
  try {
    const raced = await Promise.race([
      warmUp,
      new Promise((resolve) => { timer = setTimeout(() => resolve(BUDGET), DASHBOARD_WARMUP_BUDGET_MS); }),
    ]);
    if (raced === BUDGET) {
      // warm-up still running — let it finish in the background and answer now
      // with an EMPTY live-only shape (never a stale snapshot).
      enqueue('rebuildDashboard', {}, { idempotencyKey: 'warmup-dashboard' });
      const dash = emptyDashboardShape('warm-up in progress');
      return res.json({
        ok: true, source: 'warming', degraded: true,
        error: `live inbox warm-up exceeded ${DASHBOARD_WARMUP_BUDGET_MS}ms budget — background sync continues`,
        retryAfterMs: 15000, lastUpdated: dash.generatedAt, dataAsOf: dash.generatedAt, dataAgeMs: dashAgeMs(dash), dashboard: dash,
      });
    }
    const dashboard = raced;
    const stillEmpty = isEmpty(dashboard);
    return res.json({ ok: true, source: stillEmpty ? 'empty-after-sync' : 'rebuilt', ageMs: 0, lastUpdated: dashboard.generatedAt, dataAsOf: dashboard.generatedAt, dataAgeMs: 0, degraded: stillEmpty, ...(stillEmpty ? { error: 'sync produced no threads (provider empty or misconfigured)' } : {}), dashboard });
  } catch (e) {
    // v39: live-only — a failed sync answers with an explicitly empty shape,
    // never a stale snapshot.
    const dash = emptyDashboardShape(String(e?.message || e));
    return res.json({
      ok: true, source: 'sync-error', degraded: true,
      error: String(e?.message || e), retryAfterMs: 20000,
      lastUpdated: dash.generatedAt, dataAsOf: dash.generatedAt, dataAgeMs: dashAgeMs(dash), dashboard: dash,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
});

// ---------- follow-ups ----------
api.get('/followups', async (_req, res) => {
  let rec = kv.get(NS.FOLLOWUPS, 'latest');
  if (!rec) {
    try { rec = await detectFollowups(); }
    catch (e) { return res.status(503).json({ ok: false, error: String(e?.message || e) }); }
  }
  res.json({ ok: true, ...rec });
});

// ---------- sender profiles / relationship memory ----------
api.get('/sender-profile', async (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  if (email) {
    let p = kv.get(NS.SENDER_PROFILE, email);
    if (!p) { try { p = await profileSender(email); } catch { /* fall through */ } }
    if (!p) return res.status(404).json({ ok: false, error: `no profile for ${email}` });
    return res.json({ ok: true, profile: p });
  }
  const all = kv.all(NS.SENDER_PROFILE).map(({ value }) => value).filter(Boolean)
    .sort((a, b) => b.messageCount - a.messageCount);
  res.json({ ok: true, count: all.length, profiles: all });
});

// ---------- daily briefing ----------
api.get('/daily-briefing', async (req, res) => {
  const date = String(req.query.date || 'latest');
  let b = kv.get(NS.BRIEFING, date);
  if (!b && date === 'latest') {
    try { b = await generateDailyBriefing({ trigger: 'on-demand' }); }
    catch (e) { return res.status(503).json({ ok: false, error: String(e?.message || e) }); }
  }
  if (!b) return res.status(404).json({ ok: false, error: `no briefing for ${date}` });
  res.json({ ok: true, briefing: b });
});
api.post('/daily-briefing', async (_req, res) => {
  const { jobId } = enqueue('dailyBriefing', { trigger: 'manual' }, { idempotencyKey: `brief-${new Date().toISOString().slice(0, 13)}` });
  res.status(202).json({ ok: true, jobId, poll: `/api/jobs?id=${jobId}` });
});

// ---------- manual refresh ----------
api.post('/refresh', async (req, res) => {
  const deep = req.query.deep === '1' || req.body?.deep === true;
  const wait = req.query.wait === '1' || req.body?.wait === true;
  if (wait) {
    try { return res.json({ ok: true, mode: 'sync', result: await refreshCache({ deep }) }); }
    catch (e) { return res.status(502).json({ ok: false, error: String(e?.message || e) }); }
  }
  const { jobId, deduped } = enqueue('refreshCache', { deep }, { idempotencyKey: `refresh-${deep}` });
  res.status(202).json({ ok: true, mode: 'async', jobId, deduped, poll: `/api/jobs?id=${jobId}` });
});

// ---------- semantic search ----------
api.get('/search', async (req, res) => {
  const q = String(req.query.q || '');
  if (!q) return res.status(400).json({ ok: false, error: 'q is required' });
  res.json({ ok: true, ...(await semanticSearch(q, { topK: Number(req.query.topK || 5) })) });
});

// ---------- jobs / reliability visibility ----------
api.get('/jobs', (req, res) => {
  const id = req.query.id ? String(req.query.id) : null;
  if (id) {
    const j = jobStatus(id);
    return j ? res.json({ ok: true, job: j }) : res.status(404).json({ ok: false, error: 'unknown job' });
  }
  res.json({ ok: true, recent: recentJobs(30), failed: failedJobs(20) });
});
api.get('/jobs/:id/wait', async (req, res) => {
  res.json({ ok: true, job: await waitForJob(String(req.params.id), Number(req.query.timeoutMs || 30000)) });
});

// ---------- cron schedules ----------
api.get('/cron', (_req, res) => {
  res.json({ ok: true, enabled: CONFIG.cron.enabled, schedules: cronSchedules() });
});

// ---------- server-side send log (v25) ----------
api.get('/sendlog', (_req, res) => {
  const rows = kv.all('sendlog').map(({ value }) => value).filter(Boolean)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 50);
  res.json({ ok: true, count: rows.length, entries: rows });
});

// ---------- cache stats ----------
api.get('/cache/stats', (_req, res) => {
  res.json({
    ok: true,
    uptimeS: Math.round((Date.now() - t0) / 1000),
    kv: kv.stats(),
    semantic: { threshold: semantic.threshold, vectors: kv.keys('semvec').length, dim: CONFIG.semantic.dim },
    syncState: getSyncState(),
    ttls: CONFIG.cache,
  });
});

export default api;
