// ============================================================
// Lightweight cron scheduler for the OnDemand serverless runtime
// (no external deps — the container is always-on under Manual
// build mode, so in-process timers are reliable; schedules are
// also exposed via /api/cron for external schedulers to mirror).
//
// Registered schedules (all UTC):
//   */10 * * * *  inboxSync        — incremental Zoho sync
//   0 * * * *     priorityRefresh  — re-score + dashboard rebuild
//   0 3 * * *     dailyBriefing    — 07:00 GST executive briefing
//   0 2 * * 0     weeklyCleanup    — cache cleanup + embedding refresh
// ============================================================
import { CONFIG } from '../config.js';
import { kv } from './cache.js';

/** Parse one cron field into a Set of matching integers. */
function parseField(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) continue;
    const step = m[2] ? Number(m[2]) : 1;
    let lo = min, hi = max;
    if (m[1] !== '*') {
      const range = m[1].split('-').map(Number);
      lo = range[0];
      hi = range.length > 1 ? range[1] : range[0];
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function cronMatches(expr, date = new Date()) {
  const [mi, ho, dom, mon, dow] = expr.trim().split(/\s+/);
  if (!dow) return false;
  return parseField(mi, 0, 59).has(date.getUTCMinutes())
    && parseField(ho, 0, 23).has(date.getUTCHours())
    && parseField(dom, 1, 31).has(date.getUTCDate())
    && parseField(mon, 1, 12).has(date.getUTCMonth() + 1)
    && parseField(dow, 0, 6).has(date.getUTCDay());
}

const registry = [];

export function registerCron(name, expr, fn, description = '') {
  registry.push({ name, expr, description, fn, lastRunAt: null, lastStatus: null, lastError: null, runs: 0 });
}

export function cronSchedules() {
  // v20: stable schedule IDs (cron-<name>) so external systems can reference
  // an activated schedule; scheduleId is captured in deployment proofs.
  return registry.map(({ name, expr, description, lastRunAt, lastStatus, lastError, runs }) => ({
    id: `cron-${name}`,
    name,
    cron: expr,
    description,
    active: CONFIG.cron.enabled,
    lastRunAt,
    lastStatus,
    lastError,
    runs,
    timezoneNote: expr === CONFIG.cron.dailyBriefing ? '03:00 UTC == 07:00 GST (Asia/Dubai)' : 'UTC',
  }));
}

let _timer = null;
let _lastTickMinute = null;

async function tick() {
  const d = new Date();
  const minuteKey = d.toISOString().slice(0, 16);
  if (minuteKey === _lastTickMinute) return; // one evaluation per minute
  _lastTickMinute = minuteKey;
  for (const job of registry) {
    if (!cronMatches(job.expr, d)) continue;
    job.runs++;
    job.lastRunAt = d.toISOString();
    try {
      await job.fn();
      job.lastStatus = 'ok';
      job.lastError = null;
    } catch (e) {
      job.lastStatus = 'failed';
      job.lastError = String(e?.message || e).slice(0, 300);
      console.error(`[cron] ${job.name} failed: ${job.lastError}`);
    }
    kv.set('jobs', `cron:${job.name}`, { name: job.name, at: job.lastRunAt, status: job.lastStatus, error: job.lastError }, 7 * 24 * 3600);
  }
}

export function startCron() {
  if (!CONFIG.cron.enabled || _timer) return false;
  _timer = setInterval(tick, 20000); // 20s granularity → each minute evaluated once
  _timer.unref?.();
  return true;
}

export function stopCron() { if (_timer) clearInterval(_timer); _timer = null; }
