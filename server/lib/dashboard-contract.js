// ============================================================
// v45 — PURE dashboard response-contract helpers (zero Express).
//
// WHY: the '/api/dashboard/meera returns 500 again' report. The route
// itself has been non-5xx since v40, but TWO gaps remained:
//   1. the SPA catch-all (`res.sendFile(dist/index.html)`) had no error
//      callback — a deploy without a built dist/ made EVERY page load
//      throw ENOENT into Express's default handler (HTML error page),
//      which the UI surfaces as its generic "sync issue / HTTP 500"
//      banner because the app shell itself failed to load;
//   2. nothing at the app level guaranteed the never-5xx contract if a
//      future edit let an exception escape the route (e.g. a throw in
//      emptyDashboardShape itself, or middleware above the route).
// These helpers make the degraded contract PURE and unit-testable, and
// routes.js + server.js consume them so the guarantee is enforced in
// one place.
// ============================================================

/** Build the explicitly-EMPTY live-only dashboard shape. `syncState` is
 *  injected by the caller (routes.js reads it from the live sync store). */
export function emptyDashboard(mailbox, syncState = null, error = null) {
  return {
    generatedAt: new Date().toISOString(),
    mailbox: mailbox || null,
    provider: 'ondemand-live',
    syncState: syncState || { lastSyncAt: null, lastError: error ? { message: String(error) } : null, counts: {} },
    tierCounts: {},
    priorityPyramid: [1, 2, 3, 4, 5].map((tier) => ({ tier, count: 0, threads: [] })),
    topUrgent: [], stalledThreads: [], whoOwesNext: { us: [], them: [] },
    categories: [], sentimentRisk: [], suggestedReplies: [], relationshipMemory: [],
    threads: [], recentEmails: [],
  };
}

/**
 * Build the FULL degraded JSON body for /api/dashboard/meera.
 * ALWAYS ok:true + degraded:true + retryAfterMs — HTTP status must be 200.
 * `source` ∈ 'warming' | 'sync-error' | 'route-error'.
 */
export function degradedDashboardResponse(source, error, dashboard, retryAfterMs = 20000) {
  const dash = dashboard || emptyDashboard(null, null, error);
  return {
    ok: true,
    source,
    degraded: true,
    error: String(error || 'upstream unavailable'),
    retryAfterMs,
    lastUpdated: dash.generatedAt,
    dataAsOf: dash.generatedAt,
    dataAgeMs: 0,
    dashboard: dash,
  };
}

/** Retry-After header value (seconds, integer, >=1) from retryAfterMs. */
export function retryAfterSeconds(retryAfterMs) {
  const ms = Number(retryAfterMs);
  return String(Math.max(1, Math.ceil((Number.isFinite(ms) && ms > 0 ? ms : 20000) / 1000)));
}

/** A dashboard payload is non-degraded ONLY when threads exist. */
export function isEmptyDashboard(d) {
  return !d || !Array.isArray(d.threads) || d.threads.length === 0;
}

/** Hot-window freshness check (entry age AND data age both inside maxMs). */
export function hotWindowFresh(entryAgeMs, dataAgeMs, maxMs) {
  return Number.isFinite(entryAgeMs) && Number.isFinite(dataAgeMs)
    && entryAgeMs >= 0 && dataAgeMs >= 0
    && entryAgeMs <= maxMs && dataAgeMs <= maxMs;
}

/**
 * v45 backoff schedule for the UI/client retry hint: grows with consecutive
 * upstream failures (Zoho 429 windows observed at 60–240s), capped at 5 min.
 */
export function backoffRetryMs(consecutiveFailures) {
  const n = Math.max(0, Number(consecutiveFailures) || 0);
  return Math.min(300000, 15000 * Math.pow(2, Math.min(n, 4))); // 15s→30s→60s→120s→240s→cap
}
