// ============================================================
// dashboard-contract.test.mjs — unit tests for the v45 never-5xx
// dashboard degraded-response contract (server/lib/dashboard-contract.js).
//
// Run:  node --test test/dashboard-contract.test.mjs   (zero deps)
//
// Covers the reported bug at the contract level:
//   • any upstream failure produces a WELL-FORMED degraded JSON body
//     (ok:true, degraded:true, retryAfterMs, full empty dashboard shape)
//     that the route serves with HTTP 200 — never a 500;
//   • Retry-After header derivation;
//   • exponential retry backoff during consecutive failures
//     (Zoho rate-limit windows);
//   • hot-window freshness + emptiness predicates.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDashboard, degradedDashboardResponse, retryAfterSeconds,
  isEmptyDashboard, hotWindowFresh, backoffRetryMs,
} from '../server/lib/dashboard-contract.js';

test('emptyDashboard returns the full UI-consumable shape with zero data', () => {
  const d = emptyDashboard('mk@airev.ae', null, 'Zoho rate limited');
  assert.equal(d.mailbox, 'mk@airev.ae');
  assert.equal(d.provider, 'ondemand-live');
  assert.deepEqual(d.threads, []);
  assert.deepEqual(d.recentEmails, []);
  assert.equal(d.priorityPyramid.length, 5);
  assert.deepEqual(d.priorityPyramid[0], { tier: 1, count: 0, threads: [] });
  assert.equal(d.syncState.lastError.message, 'Zoho rate limited');
  assert.ok(!Number.isNaN(Date.parse(d.generatedAt)));
});

test('degradedDashboardResponse: ok:true + degraded:true + retryAfterMs, never a throw', () => {
  const body = degradedDashboardResponse('sync-error', 'upstream 429', null, 30000);
  assert.equal(body.ok, true);            // HTTP 200 contract — the UI parses this
  assert.equal(body.degraded, true);
  assert.equal(body.source, 'sync-error');
  assert.equal(body.error, 'upstream 429');
  assert.equal(body.retryAfterMs, 30000);
  assert.ok(body.dashboard && Array.isArray(body.dashboard.threads));
  assert.equal(body.dashboard.threads.length, 0);
  assert.ok(body.lastUpdated && body.dataAsOf);
});

test('degradedDashboardResponse tolerates null/undefined error and dashboard', () => {
  const body = degradedDashboardResponse('route-error', null, undefined);
  assert.equal(body.ok, true);
  assert.equal(body.degraded, true);
  assert.equal(typeof body.error, 'string');
  assert.ok(body.dashboard.priorityPyramid.length === 5);
  assert.equal(body.retryAfterMs, 20000); // default
});

test('retryAfterSeconds: ms → whole seconds, >=1, safe on garbage', () => {
  assert.equal(retryAfterSeconds(20000), '20');
  assert.equal(retryAfterSeconds(1500), '2');   // ceil
  assert.equal(retryAfterSeconds(1), '1');
  assert.equal(retryAfterSeconds(0), '20');     // fallback default
  assert.equal(retryAfterSeconds('junk'), '20');
  assert.equal(retryAfterSeconds(-5), '20');
});

test('backoffRetryMs grows exponentially and caps at 5 minutes', () => {
  assert.equal(backoffRetryMs(0), 15000);
  assert.equal(backoffRetryMs(1), 30000);
  assert.equal(backoffRetryMs(2), 60000);
  assert.equal(backoffRetryMs(3), 120000);
  assert.equal(backoffRetryMs(4), 240000);
  assert.equal(backoffRetryMs(5), 240000);  // exponent clamped
  assert.equal(backoffRetryMs(50), 240000);
  assert.ok(backoffRetryMs(50) <= 300000);
  assert.equal(backoffRetryMs(-3), 15000);  // garbage → base
  assert.equal(backoffRetryMs('x'), 15000);
});

test('isEmptyDashboard: only a threads-bearing payload is non-degraded', () => {
  assert.equal(isEmptyDashboard(null), true);
  assert.equal(isEmptyDashboard({}), true);
  assert.equal(isEmptyDashboard({ threads: [] }), true);
  assert.equal(isEmptyDashboard({ threads: [{ threadId: 'x' }] }), false);
});

test('hotWindowFresh: both entry age and data age must be inside the window', () => {
  assert.equal(hotWindowFresh(1000, 1000, 180000), true);
  assert.equal(hotWindowFresh(180000, 180000, 180000), true);   // boundary inclusive
  assert.equal(hotWindowFresh(180001, 1000, 180000), false);    // entry stale
  assert.equal(hotWindowFresh(1000, 180001, 180000), false);    // data stale
  assert.equal(hotWindowFresh(null, 1000, 180000), false);
  assert.equal(hotWindowFresh(1000, NaN, 180000), false);
  assert.equal(hotWindowFresh(-1, 1000, 180000), false);
});

test('warming + sync-error + route-error sources all keep the 200 body contract', () => {
  for (const src of ['warming', 'sync-error', 'route-error']) {
    const b = degradedDashboardResponse(src, 'boom', null, backoffRetryMs(2));
    assert.equal(b.ok, true, src);
    assert.equal(b.degraded, true, src);
    assert.equal(b.source, src);
    assert.equal(b.retryAfterMs, 60000, src);
    assert.ok(Array.isArray(b.dashboard.threads), src);
  }
});
