// ============================================================
// Async background job queue (in-process, serverless-friendly).
//   • enqueue(type, payload) → jobId immediately (API stays fast;
//     heavy LLM work never blocks a request thread)
//   • single-flight dedupe: identical (type + idempotencyKey)
//     jobs collapse while one is pending/running
//   • per-job status tracking persisted to the KV cache (`jobs`)
//   • failures recorded to `failedJobs` with attempt history —
//     visible via /api/jobs and the weekly cleanup report
// ============================================================
import crypto from 'node:crypto';
import { kv, NS } from './cache.js';
import { withRetry } from './retry.js';

const handlers = new Map();   // type -> async fn(payload, job)
const running = new Map();    // dedupeKey -> jobId
const queue = [];
let draining = false;
const MAX_CONCURRENT = Number(process.env.JOBS_MAX_CONCURRENT || 3);
let active = 0;

export function registerJob(type, fn) { handlers.set(type, fn); }

export function jobStatus(id) { return kv.get(NS.JOBS, id); }

export function recentJobs(limit = 50) {
  return kv.all(NS.JOBS)
    .map(({ value }) => value)
    .filter(Boolean)
    .sort((a, b) => (b.enqueuedAt || 0) - (a.enqueuedAt || 0))
    .slice(0, limit);
}

export function failedJobs(limit = 50) {
  return kv.all(NS.FAILED_JOBS)
    .map(({ value }) => value)
    .filter(Boolean)
    .sort((a, b) => (b.failedAt || 0) - (a.failedAt || 0))
    .slice(0, limit);
}

function persist(job) { kv.set(NS.JOBS, job.id, job, 24 * 3600); }

export function enqueue(type, payload = {}, { idempotencyKey = null } = {}) {
  if (!handlers.has(type)) throw new Error(`no handler registered for job type "${type}"`);
  const dedupeKey = `${type}:${idempotencyKey || crypto.randomUUID()}`;
  if (idempotencyKey && running.has(dedupeKey)) {
    return { jobId: running.get(dedupeKey), deduped: true };
  }
  const id = `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const job = { id, type, status: 'queued', enqueuedAt: Date.now(), startedAt: null, finishedAt: null, attempts: 0, error: null, resultSummary: null, payloadDigest: crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 12) };
  persist(job);
  if (idempotencyKey) running.set(dedupeKey, id);
  queue.push({ job, payload, dedupeKey });
  setImmediate(drain);
  return { jobId: id, deduped: false };
}

async function runOne({ job, payload, dedupeKey }) {
  const fn = handlers.get(job.type);
  job.status = 'running';
  job.startedAt = Date.now();
  persist(job);
  try {
    const result = await withRetry((attempt) => { job.attempts = attempt + 1; persist(job); return fn(payload, job); }, { label: `job:${job.type}` });
    job.status = 'done';
    job.finishedAt = Date.now();
    job.resultSummary = typeof result === 'string' ? result.slice(0, 300) : (result?.summary || 'ok');
    persist(job);
  } catch (e) {
    job.status = 'failed';
    job.finishedAt = Date.now();
    job.error = String(e?.message || e).slice(0, 500);
    persist(job);
    kv.set(NS.FAILED_JOBS, job.id, { ...job, failedAt: Date.now() }, 7 * 24 * 3600);
    console.error(`[jobs] ${job.type} ${job.id} failed after ${job.attempts} attempts: ${job.error}`);
  } finally {
    running.delete(dedupeKey);
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length && active < MAX_CONCURRENT) {
      const item = queue.shift();
      active++;
      runOne(item).finally(() => { active--; setImmediate(drain); });
    }
  } finally {
    draining = false;
  }
}

/** Await a job's completion (used by tests and sync-mode callers). */
export async function waitForJob(id, timeoutMs = 60000, pollMs = 150) {
  const t0 = Date.now();
  for (;;) {
    const j = jobStatus(id);
    if (j && (j.status === 'done' || j.status === 'failed')) return j;
    if (Date.now() - t0 > timeoutMs) return j || { id, status: 'unknown' };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
