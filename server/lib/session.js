// ============================================================
// v30 — copilot session lifecycle manager.
// Guarantees a live OnDemand chat session exists as early as possible
// and self-heals when one drops. Design goals (task requirement 3):
//   • WARM-UP ON BOOT: server.js calls warmupCopilotSession() right
//     after listen(); it retries with exponential backoff (via the
//     shared client's own withRetry) and NEVER throws — a missing key
//     or a transient gateway blip degrades gracefully instead of
//     crashing the process.
//   • LAZY RE-INIT: ensureCopilotSession() returns the cached warm
//     session, or transparently mints a fresh one if none exists / the
//     previous one was marked stale (e.g. an upstream 404 on /query).
//   • SINGLE-FLIGHT: concurrent callers during (re)initialization share
//     ONE in-flight create promise — no session-create stampede.
// The session id is NOT a secret (it is echoed to the browser inside
// SSE fulfillment events); only the API key is sensitive and that stays
// server-side in the shared ondemand client.
// ============================================================
import './env.js'; // ensure env reconciliation ran before any key read
import { createSession as odCreateSession, odConfigured } from './ondemand.js';
import { logger } from './logger.js';

const state = {
  sessionId: null,
  createdAt: null,
  lastError: null,
  ready: false,
  inflight: null,
  reinitCount: 0,
};

/** Non-throwing snapshot for /api/health and diagnostics. */
export function copilotSessionStatus() {
  return {
    ready: state.ready,
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    reinitCount: state.reinitCount,
    lastError: state.lastError,
    configured: odConfigured(),
  };
}

/** Mark the current warm session stale so the next ensure() re-mints it. */
export function markCopilotSessionStale(reason = 'manual') {
  if (state.sessionId) logger.warn('copilot.session.stale', { sessionId: state.sessionId, reason });
  state.sessionId = null;
  state.ready = false;
}

/**
 * ensureCopilotSession — return a live session id, creating one if needed.
 * Single-flighted: concurrent callers await the same create promise.
 * odCreateSession already carries timeout + exponential-backoff retry.
 * @param {{forceNew?: boolean}} opts
 * @returns {Promise<string|null>} session id, or null when unconfigured/failed.
 */
export async function ensureCopilotSession({ forceNew = false } = {}) {
  if (!odConfigured()) { state.ready = false; return null; }
  if (forceNew) markCopilotSessionStale('force-new');
  if (state.sessionId) return state.sessionId;
  if (state.inflight) return state.inflight;

  state.inflight = (async () => {
    try {
      const sid = await odCreateSession({
        externalUserId: `mcc-copilot-${Date.now()}`,
        contextMetadata: [
          { key: 'app', value: 'meera-command-centre' },
          { key: 'role', value: 'copilot-primary' },
        ],
      });
      state.sessionId = sid;
      state.createdAt = new Date().toISOString();
      state.ready = true;
      state.lastError = null;
      logger.info('copilot.session.ready', { sessionId: sid, reinitCount: state.reinitCount });
      return sid;
    } catch (e) {
      state.ready = false;
      state.lastError = String(e?.message || e);
      logger.error('copilot.session.failed', { error: state.lastError, status: e?.status ?? null });
      return null;
    } finally {
      state.inflight = null;
    }
  })();
  return state.inflight;
}

/**
 * warmupCopilotSession — fire-and-forget boot warm-up. Retries a few
 * times with a widening delay so a cold gateway or a key that lands a
 * moment after boot still ends with a ready session. Never throws.
 */
export async function warmupCopilotSession({ maxRounds = 3, gapMs = 4000 } = {}) {
  if (!odConfigured()) {
    logger.warn('copilot.session.warmup.skipped', { reason: 'ONDEMAND_API_KEY not configured' });
    return null;
  }
  for (let round = 1; round <= maxRounds; round++) {
    const sid = await ensureCopilotSession();
    if (sid) return sid;
    if (round < maxRounds) await new Promise((r) => setTimeout(r, gapMs * round));
  }
  logger.error('copilot.session.warmup.exhausted', { rounds: maxRounds, lastError: state.lastError });
  return null;
}

/** Re-mint after a drop (e.g. upstream 404). Increments the reinit counter. */
export async function reinitCopilotSession(reason = 'dropped') {
  state.reinitCount += 1;
  markCopilotSessionStale(reason);
  return ensureCopilotSession();
}
