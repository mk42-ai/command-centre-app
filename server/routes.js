// ============================================================
// Backend API surface — fast, cache-first endpoints.
// Heavy work is queued to async jobs; requests return in
// milliseconds from the KV cache. Endpoints:
//   POST /api/inbox/sync       — trigger incremental sync (async | ?wait=1)
//   POST /api/thread/analyze   — queue full analysis of one thread
//   GET  /api/dashboard/meera  — dashboard-ready JSON (cache-first,
//                                stale-while-revalidate, lastGood fallback)
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

// ---------- dashboard (cache-first + stale-while-revalidate + lastGood fallback) ----------
api.get('/dashboard/meera', async (req, res) => {
  const entry = kv.getEntry(NS.DASHBOARD, 'meera');
  // v22: never serve an EMPTY dashboard when a sync can populate it.
  // After a container restart the ephemeral cache is blank; the async boot
  // sync races the first request, so an all-zeros dashboard used to get
  // cached for the full TTL (the "all cards read 0" failure). Guard: if the
  // cached (or would-be) dashboard has zero threads, run a synchronous
  // warm-up sync first, then rebuild.
  const isEmpty = (d) => !d || !Array.isArray(d.threads) || d.threads.length === 0;
  if (entry && !isEmpty(entry.value)) {
    // serve hot cache; kick a background rebuild when >½ TTL old
    if (entry.ageMs > (CONFIG.cache.dashboardTtlS * 1000) / 2) {
      enqueue('rebuildDashboard', {}, { idempotencyKey: 'swr-dashboard' });
    }
    return res.json({ ok: true, source: 'cache', ageMs: entry.ageMs, lastUpdated: new Date(entry.storedAt).toISOString(), degraded: false, dashboard: entry.value });
  }
  try {
    if (kv.keys(NS.EMAIL_META).length === 0) {
      await syncInbox({}); // warm-up: cold cache → pull threads before building
    }
    let dashboard = await rebuildDashboard(); // build from (now-populated) cached facts
    if (isEmpty(dashboard)) {
      // facts existed but dashboard still empty → force a full re-sync once
      await syncInbox({ force: true });
      dashboard = await rebuildDashboard();
    }
    // v25 (C10): an empty dashboard after a forced re-sync is NOT healthy —
    // flag it so the UI warn-state fires instead of showing green all-zeros.
    const stillEmpty = isEmpty(dashboard);
    return res.json({ ok: true, source: stillEmpty ? 'empty-after-sync' : 'rebuilt', ageMs: 0, lastUpdated: dashboard.generatedAt, degraded: stillEmpty, ...(stillEmpty ? { error: 'sync produced no threads (provider empty or misconfigured)' } : {}), dashboard });
  } catch (e) {
    const lastGood = kv.get(NS.DASHBOARD, 'meera:lastGood'); // never-expiring fallback
    if (lastGood) {
      return res.json({ ok: true, source: 'lastGood-fallback', degraded: true, error: String(e?.message || e), lastUpdated: lastGood.generatedAt, dashboard: lastGood });
    }
    return res.status(503).json({ ok: false, error: String(e?.message || e) });
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
