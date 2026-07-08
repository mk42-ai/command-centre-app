// ============================================================
// Reliability primitives: exponential backoff with full jitter,
// Retry-After awareness, token-bucket rate limiting, and a
// persistent failed-job log hook.
// ============================================================
import { CONFIG } from '../config.js';

export class RetryableError extends Error {
  constructor(message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * withRetry(fn, opts) — runs fn with exponential backoff + full jitter.
 * fn may throw RetryableError (honoured retryAfterMs) or any error.
 * Non-retryable statuses (4xx except 408/425/429) fail fast.
 */
export async function withRetry(fn, { attempts = CONFIG.retry.attempts, baseMs = CONFIG.retry.baseMs, maxMs = CONFIG.retry.maxMs, label = 'op', onRetry = null } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      const status = e?.status ?? null;
      const retryable = e instanceof RetryableError || status == null || status === 408 || status === 425 || status === 429 || status >= 500;
      if (!retryable || i === attempts - 1) break;
      const expo = Math.min(maxMs, baseMs * 2 ** i);
      const delay = e?.retryAfterMs != null ? Math.min(maxMs, e.retryAfterMs) : Math.floor(Math.random() * expo); // full jitter
      onRetry?.({ attempt: i + 1, delay, error: String(e?.message || e), label });
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** fetchWithRetry — fetch wrapper that maps HTTP status → retry semantics. */
export async function fetchWithRetry(url, init = {}, opts = {}) {
  return withRetry(async () => {
    let resp;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      throw new RetryableError(`network error: ${e?.message || e}`);
    }
    if (resp.status === 429 || resp.status >= 500) {
      const ra = Number(resp.headers.get('retry-after'));
      throw new RetryableError(`HTTP ${resp.status} from ${new URL(url).host}`, {
        status: resp.status,
        retryAfterMs: Number.isFinite(ra) ? ra * 1000 : null,
      });
    }
    return resp;
  }, opts);
}

/** Token-bucket rate limiter (N ops/minute, burst = N). */
export class RateLimiter {
  constructor(perMinute, label = 'bucket') {
    this.capacity = Math.max(1, perMinute);
    this.tokens = this.capacity;
    this.label = label;
    this.refillMs = 60000 / this.capacity;
    this.last = Date.now();
  }
  _refill() {
    const now = Date.now();
    const add = (now - this.last) / this.refillMs;
    if (add >= 1) {
      this.tokens = Math.min(this.capacity, this.tokens + Math.floor(add));
      this.last = now;
    }
  }
  async take() {
    for (;;) {
      this._refill();
      if (this.tokens > 0) {
        this.tokens -= 1;
        return;
      }
      await sleep(this.refillMs);
    }
  }
}

export const llmLimiter = new RateLimiter(CONFIG.rateLimit.llmPerMin, 'llm');
export const zohoLimiter = new RateLimiter(CONFIG.rateLimit.zohoPerMin, 'zoho');
