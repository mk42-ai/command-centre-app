// ============================================================
// OnDemand LLM helper for background analysis jobs.
//   • sessions are created lazily and pooled per purpose
//   • every call goes through the token-bucket limiter +
//     exponential-backoff retry
//   • analyse() is fronted by the hybrid semantic cache: exact
//     sha256 hit first, then cosine >= threshold — identical or
//     near-identical prompts never hit the LLM twice
//   • when no ONDEMAND_API_KEY is configured, callers receive
//     { ok:false, offline:true } and fall back to deterministic
//     heuristics — the pipeline never hard-fails on a missing key.
// ============================================================
import { CONFIG } from '../config.js';
import { llmLimiter, withRetry } from './retry.js';
import { semantic } from './cache.js';
// v25: session + query go through the single shared OnDemand client
import { createSession as odCreateSession, querySync as odQuerySync, odConfigured } from './ondemand.js';

const OD = CONFIG.ondemand;
let _sessionId = null;

export function llmConfigured() { return odConfigured(); }

async function ensureSession() {
  if (_sessionId) return _sessionId;
  // v25: exact session-create pattern via the shared client (201 → data.id)
  _sessionId = await withRetry(
    () => odCreateSession({ contextMetadata: [{ key: 'app', value: 'meera-command-centre-backend' }] }),
    { label: 'od-session' },
  );
  return _sessionId;
}

/** Raw sync query against the analysis endpoint. */
export async function llmQuery(prompt, { endpointId = OD.analysisEndpointId, temperature = 0.2 } = {}) {
  if (!llmConfigured()) return { ok: false, offline: true, answer: null };
  await llmLimiter.take();
  const sid = await ensureSession();
  // v29 (RC2 FIX): this previously called fetchWithRetry WITHOUT importing it
  // (ReferenceError on every background analysis job → unhandled rejections in
  // cron ticks) and then read `.answer`/`.raw` off what would have been a raw
  // Response. The shared querySync client returns exactly { ok, status,
  // answer, raw } and now carries timeout + retry + structured logging.
  let r;
  try {
    r = await odQuerySync(sid, prompt, { endpointId, temperature });
  } catch (e) {
    return { ok: false, offline: false, answer: null, error: String(e?.message || e).slice(0, 300) };
  }
  if (r.status === 404) { _sessionId = null; } // stale pooled session → re-mint next call
  if (!r.ok) return { ok: false, offline: false, answer: null, error: JSON.stringify(r.raw).slice(0, 300) };
  return { ok: true, offline: false, answer: r.answer };
}

/** Extract the first JSON object/array from an LLM answer. */
export function parseJsonLoose(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  for (let end = candidate.length; end > start; end--) {
    try { return JSON.parse(candidate.slice(start, end)); } catch { /* shrink */ }
  }
  return null;
}

/**
 * analyse(kind, subjectText, prompt) — semantic-cached JSON analysis.
 * subjectText is the cache key basis (e.g. thread content digest);
 * kind partitions the space so a summary hit never serves a sentiment call.
 */
export async function analyse(kind, subjectText, prompt, { ttlS = CONFIG.cache.summaryTtlS, temperature = 0.2 } = {}) {
  const cacheText = `${kind}::${subjectText}`;
  const hit = await semantic.lookup(cacheText);
  if (hit.hit) return { ...hit.value, _cache: { kind: hit.kind, similarity: hit.similarity } };
  const resp = await llmQuery(prompt, { temperature });
  if (!resp.ok) return { _offline: resp.offline === true, _error: resp.error || null };
  const parsed = parseJsonLoose(resp.answer) || { raw: resp.answer };
  await semantic.store(cacheText, parsed, ttlS, hit.vector || null);
  return { ...parsed, _cache: { kind: 'miss', similarity: 0 } };
}
