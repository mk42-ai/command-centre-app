// ============================================================
// v29 — SINGLE shared OnDemand chat/v1 + media/v1 client.
// This module is the ONLY place that talks to api.on-demand.io.
// Pattern (exact integration contract):
//   • POST {base}/sessions           → 201, data.id = sessionId
//       headers { apikey, Content-Type: application/json }
//       body { agentIds:['agent-1784351533'], externalUserId:<uuid>,
//              contextMetadata:[{key,value}…] }
//   • POST {base}/sessions/{id}/query (responseMode:'stream')
//       body { endpointId:'predefined-gemini-3.6-flash', query,
//              agentIds, responseMode:'stream',
//              modelConfigs:{ fulfillmentPrompt:'', stopSequences:[],
//                temperature:0.7, topP:1, maxTokens:0,
//                presencePenalty:0, frequencyPenalty:0 } }
//   • SSE parse: lines starting 'data:'; stop at '[DONE]';
//       eventType 'fulfillment' → accumulate .answer, capture
//       sessionId/messageId; 'metricsLog' → capture publicMetrics.
//   • POST https://api.on-demand.io/media/v1/public/file/raw
//       multipart: file + createdBy=AIREV, updatedBy=AIREV, name,
//       responseMode, sessionId, agents[] — for media uploads.
// The API key lives ONLY in process.env.ONDEMAND_API_KEY.
//
// v29 hardening (production-grade):
//   • EVERY call is time-boxed with AbortController (no hung sockets):
//       session create 15s · sync query 60s · stream connect 20s ·
//       media upload 60s (env-overridable OD_*_TIMEOUT_MS).
//   • createSession / querySync / uploadMedia ride withRetry
//     (exponential backoff + full jitter, Retry-After aware; 4xx
//     other than 408/425/429 fail fast).
//   • Structured JSON logs for every upstream call: od.session.create,
//     od.query.sync, od.query.stream, od.media.upload — with status,
//     latency ms, attempt count. Never logs the key or payload bodies.
// ============================================================
import crypto from 'node:crypto';
import './env.js'; // ensure .env is loaded before reading keys
import { withRetry, RetryableError } from './retry.js';
import { logger } from './logger.js';

const BASE_URL = () => process.env.ONDEMAND_BASE_URL || 'https://api.on-demand.io/chat/v1';
const MEDIA_URL = () => process.env.ONDEMAND_MEDIA_URL || 'https://api.on-demand.io/media/v1/public/file/raw';
const API_KEY = () => process.env.ONDEMAND_API_KEY || '';
export const AGENT_IDS = () => (process.env.ONDEMAND_AGENT_IDS || 'agent-1784351533').split(',').map((s) => s.trim()).filter(Boolean);
// v36: default to the endpoint proven live with the Zoho connector
// (predefined-gemini-3.6-flash); override via ONDEMAND_*_ENDPOINT_ID envs.
export const DRAFT_ENDPOINT_ID = () => process.env.ONDEMAND_DRAFT_ENDPOINT_ID || 'predefined-gemini-3.6-flash';
export const SEND_ENDPOINT_ID = () => process.env.ONDEMAND_SEND_ENDPOINT_ID || 'predefined-gemini-3.6-flash';

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const T_SESSION = () => num(process.env.OD_SESSION_TIMEOUT_MS, 15000);
const T_SYNC = () => num(process.env.OD_SYNC_TIMEOUT_MS, 60000);
const T_STREAM = () => num(process.env.OD_STREAM_CONNECT_TIMEOUT_MS, 20000);
const T_MEDIA = () => num(process.env.OD_MEDIA_TIMEOUT_MS, 60000);

export function odConfigured() { return Boolean(API_KEY()); }

/** Exact modelConfigs block from the integration contract. */
export function fullModelConfigs(overrides = {}) {
  return {
    fulfillmentPrompt: '',
    stopSequences: [],
    temperature: 0.7,
    topP: 1,
    maxTokens: 0,
    presencePenalty: 0,
    frequencyPenalty: 0,
    ...overrides,
  };
}

/**
 * fetchTimed — fetch with a hard AbortController deadline. An external
 * signal (caller cancel) chains in so either abort wins. Timeouts and
 * network failures surface as RetryableError so withRetry re-attempts.
 */
async function fetchTimed(url, init = {}, { timeoutMs, label = 'od', signal = null } = {}) {
  const ac = new AbortController();
  const onOuter = () => ac.abort();
  signal?.addEventListener('abort', onOuter, { once: true });
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, { ...init, signal: ac.signal });
    return { resp, ms: Date.now() - t0 };
  } catch (e) {
    const ms = Date.now() - t0;
    if (signal?.aborted) { const err = new Error(`${label} cancelled by caller`); err.cancelled = true; throw err; }
    throw new RetryableError(`${label} ${ac.signal.aborted ? `timeout after ${timeoutMs}ms` : `network error: ${e?.message || e}`}`, { status: null });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
  }
}

/** Map an HTTP response to retry semantics (429/5xx retryable). */
function throwIfRetryableStatus(resp, label) {
  if (resp.status === 429 || resp.status >= 500) {
    const ra = Number(resp.headers.get('retry-after'));
    throw new RetryableError(`${label} HTTP ${resp.status}`, {
      status: resp.status,
      retryAfterMs: Number.isFinite(ra) ? ra * 1000 : null,
    });
  }
}

/**
 * createSession — POST /sessions, expect 201, return data.id.
 * Retries transient failures (timeout/network/429/5xx) with backoff.
 * Throws { status, detail } on terminal failure so callers surface real errors.
 */
export async function createSession({ externalUserId = null, contextMetadata = null, agentIds = null } = {}) {
  let attempts = 0;
  const t0 = Date.now();
  try {
    return await withRetry(async () => {
      attempts += 1;
      const { resp, ms } = await fetchTimed(`${BASE_URL()}/sessions`, {
        method: 'POST',
        headers: { apikey: API_KEY(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // v32: allow a per-call agent binding for mail-agent failover.
          agentIds: Array.isArray(agentIds) && agentIds.length ? agentIds : AGENT_IDS(),
          externalUserId: String(externalUserId || crypto.randomUUID()),
          contextMetadata: Array.isArray(contextMetadata) ? contextMetadata : [
            { key: 'app', value: 'meera-command-centre' },
            { key: 'mailbox', value: process.env.MAILBOX_ADDRESS || 'mk@airev.ae' },
          ],
        }),
      }, { timeoutMs: T_SESSION(), label: 'od.session.create' });
      throwIfRetryableStatus(resp, 'od.session.create');
      const j = await resp.json().catch(() => ({}));
      if (resp.status !== 201 && !resp.ok) {
        const err = new Error(`session create failed (${resp.status})`);
        err.status = resp.status; err.detail = j;
        throw err; // non-retryable 4xx — fail fast
      }
      const sessionId = j?.data?.id || null;
      if (!sessionId) {
        const err = new Error('session create returned no data.id');
        err.status = 502; err.detail = j;
        throw err;
      }
      logger.info('od.session.create', { status: resp.status, ms, attempts });
      return sessionId;
    }, { label: 'od-session-create', attempts: 3 });
  } catch (e) {
    logger.error('od.session.create.failed', { ms: Date.now() - t0, attempts, error: String(e?.message || e), status: e?.status ?? null });
    throw e;
  }
}

/**
 * queryStream — POST /sessions/{id}/query with responseMode:'stream'.
 * Returns the raw upstream Response (SSE body) for piping/parsing.
 * The CONNECT phase is time-boxed (T_STREAM); once the stream is open the
 * caller owns idle-timeout policy (the browser client runs its own watchdog).
 */
export async function queryStream(sessionId, query, { endpointId = null, modelConfigs = null, signal = null, agentIds = null } = {}) {
  const t0 = Date.now();
  const { resp, ms } = await fetchTimed(`${BASE_URL()}/sessions/${encodeURIComponent(sessionId)}/query`, {
    method: 'POST',
    headers: { apikey: API_KEY(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpointId: endpointId || DRAFT_ENDPOINT_ID(),
      query: String(query),
      // v36: per-call agent binding (parity with querySync) for mail-fetch use.
      agentIds: Array.isArray(agentIds) && agentIds.length ? agentIds : AGENT_IDS(),
      responseMode: 'stream',
      modelConfigs: modelConfigs || fullModelConfigs(),
    }),
  }, { timeoutMs: T_STREAM(), label: 'od.query.stream', signal });
  logger.info('od.query.stream', { status: resp.status, connectMs: ms, totalMs: Date.now() - t0 });
  return resp;
}

/**
 * queryStreamCollect — v36: run a query in responseMode:'stream' and COLLECT
 * the full answer server-side, returning the same { ok, status, answer, raw }
 * shape as querySync. WHY: long sync waits (>~55s of socket silence while the
 * agent executes tools + generates) get killed by upstream infrastructure as
 * 'fetch failed'; SSE keeps bytes flowing on the socket for the entire
 * generation, so long tool-heavy queries (live inbox fetch) survive. Overall
 * deadline + idle watchdog guard the read loop.
 */
export async function queryStreamCollect(sessionId, query, {
  endpointId = null, temperature = 0.2, agentIds = null,
  overallTimeoutMs = 150000, idleTimeoutMs = 45000,
} = {}) {
  const t0 = Date.now();
  const resp = await queryStream(sessionId, query, {
    endpointId: endpointId || SEND_ENDPOINT_ID(),
    modelConfigs: fullModelConfigs({ temperature }),
    agentIds,
  });
  if (!resp.ok || !resp.body) {
    const j = await resp.json().catch(() => ({}));
    logger.warn('od.query.streamCollect.httpError', { status: resp.status });
    return { ok: false, status: resp.status, answer: '', raw: j };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const acc = sseAccumulator();
  let lastByteAt = Date.now();
  // v36: SINGLE tracked pending read that NEVER rejects (two-arg then) — a
  // naive Promise.race([reader.read(), tick]) abandons the in-flight read on
  // every tick; when the socket later errors, that abandoned promise rejects
  // UNHANDLED and kills the whole process. Here every read rejection is
  // captured and re-thrown inside our control flow instead.
  let pendingRead = null;
  try {
    for (;;) {
      if (acc.state.done) break;
      if (Date.now() - t0 > overallTimeoutMs) throw new Error(`stream overall deadline ${overallTimeoutMs}ms exceeded`);
      if (Date.now() - lastByteAt > idleTimeoutMs) throw new Error(`stream idle for ${idleTimeoutMs}ms`);
      if (!pendingRead) pendingRead = reader.read().then((res) => ({ res }), (err) => ({ err }));
      const race = await Promise.race([
        pendingRead,
        new Promise((resolve) => setTimeout(() => resolve('tick'), 5000)),
      ]);
      if (race === 'tick') continue; // re-check deadlines while the read hangs
      pendingRead = null;
      if (race.err) throw race.err instanceof Error ? race.err : new Error(String(race.err));
      const { done, value } = race.res;
      if (done) break;
      lastByteAt = Date.now();
      acc.feed(decoder.decode(value, { stream: true }));
    }
    acc.feed(decoder.decode());
  } finally {
    // reader.cancel() returns a PROMISE that REJECTS when the underlying
    // socket already errored — a bare try/catch only traps sync throws, so
    // the rejection escaped as an uncaughtException and killed the process
    // (verified: 'SocketError: other side closed' crash). Attach handlers.
    try { const c = reader.cancel(); if (c && typeof c.catch === 'function') c.catch(() => {}); } catch { /* already closed */ }
    // drain a still-pending read so it can never reject unhandled later
    if (pendingRead) pendingRead.then(() => {}, () => {});
  }
  const ms = Date.now() - t0;
  logger.info('od.query.streamCollect', { status: resp.status, ms, events: acc.state.events, answerChars: acc.state.answer.length });
  return {
    ok: true,
    status: resp.status,
    answer: acc.state.answer,
    raw: { sessionId: acc.state.sessionId, messageId: acc.state.messageId, publicMetrics: acc.state.publicMetrics },
  };
}

/**
 * querySync — responseMode:'sync'; returns { ok, status, answer, raw }.
 * Time-boxed + retried on transient failures. Never throws for HTTP error
 * statuses (parity with the v25 contract) — only for exhausted retries on
 * network/timeout, which callers already handle via try/catch.
 */
export async function querySync(sessionId, query, { endpointId = null, temperature = 0.2, timeoutMs = null, retries = 2, agentIds = null } = {}) {
  let attempts = 0;
  const t0 = Date.now();
  try {
    return await withRetry(async () => {
      attempts += 1;
      const { resp, ms } = await fetchTimed(`${BASE_URL()}/sessions/${encodeURIComponent(sessionId)}/query`, {
        method: 'POST',
        headers: { apikey: API_KEY(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpointId: endpointId || SEND_ENDPOINT_ID(),
          query: String(query),
          // v31: allow a per-call agent override (mail-fetch routes to the
          // Zoho-mail agent; default stays the copilot chat agent).
          agentIds: Array.isArray(agentIds) && agentIds.length ? agentIds : AGENT_IDS(),
          responseMode: 'sync',
          modelConfigs: fullModelConfigs({ temperature }),
        }),
      }, { timeoutMs: timeoutMs || T_SYNC(), label: 'od.query.sync' });
      throwIfRetryableStatus(resp, 'od.query.sync');
      const j = await resp.json().catch(() => ({}));
      logger.info('od.query.sync', { status: resp.status, ms, attempts });
      return { ok: resp.ok, status: resp.status, answer: j?.data?.answer || '', raw: j };
    }, { label: 'od-query-sync', attempts: Math.max(1, retries + 1) });
  } catch (e) {
    logger.error('od.query.sync.failed', { ms: Date.now() - t0, attempts, error: String(e?.message || e) });
    throw e;
  }
}

/**
 * parseSse — canonical server-side SSE consumer for OnDemand streams.
 * Feeds decoded text chunks; emits via callbacks; implements the exact
 * contract: 'data:' prefix, '[DONE]' sentinel, fulfillment/metricsLog.
 * Returns a finalize() giving { answer, sessionId, messageId, publicMetrics }.
 */
export function sseAccumulator({ onToken = null } = {}) {
  let buf = '';
  const state = { answer: '', sessionId: null, messageId: null, publicMetrics: null, done: false, events: 0 };
  return {
    feed(textChunk) {
      buf += textChunk;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { state.done = true; return; }
        try {
          const j = JSON.parse(payload);
          state.events += 1;
          if (j.eventType === 'fulfillment') {
            if (j.sessionId) state.sessionId = j.sessionId;
            if (j.messageId) state.messageId = j.messageId;
            if (typeof j.answer === 'string') {
              state.answer += j.answer;
              onToken?.(j.answer, state.answer);
            }
          } else if (j.eventType === 'metricsLog' && j.publicMetrics) {
            state.publicMetrics = j.publicMetrics;
          }
        } catch { /* keep-alives / malformed lines ignored */ }
      }
    },
    state,
  };
}

/**
 * uploadMedia — POST media/v1/public/file/raw (multipart).
 * fileBuf: Buffer; name: display name; sessionId optional.
 * Time-boxed + retried on transient failures.
 */
export async function uploadMedia({ fileBuf, fileName, name = null, sessionId = null, responseMode = 'sync' }) {
  let attempts = 0;
  return withRetry(async () => {
    attempts += 1;
    const fd = new FormData();
    fd.append('file', new Blob([fileBuf]), fileName);
    fd.append('createdBy', 'AIREV');
    fd.append('updatedBy', 'AIREV');
    fd.append('name', name || fileName);
    fd.append('responseMode', responseMode);
    if (sessionId) fd.append('sessionId', sessionId);
    for (const a of AGENT_IDS()) fd.append('agents', a);
    const { resp, ms } = await fetchTimed(MEDIA_URL(), { method: 'POST', headers: { apikey: API_KEY() }, body: fd }, { timeoutMs: T_MEDIA(), label: 'od.media.upload' });
    throwIfRetryableStatus(resp, 'od.media.upload');
    const j = await resp.json().catch(() => ({}));
    logger.info('od.media.upload', { status: resp.status, ms, attempts, sizeBytes: fileBuf?.length ?? null });
    return { ok: resp.ok, status: resp.status, data: j?.data || j };
  }, { label: 'od-media-upload', attempts: 3 });
}

// ============================================================
// v29 — OFFLINE FALLBACK (graceful degradation when the OnDemand
// key is missing/expired). Deterministic, clearly-labelled reply
// suggestions so the auto-suggest UI never blanks. Each carries a
// distinct professional angle mirroring OPTION_ANGLES in src/ai.js.
// ============================================================
export function offlineSuggestions(ctx = {}) {
  const sender = String(ctx.sender || ctx.counterparty || 'there').split(' ')[0] || 'there';
  const subject = String(ctx.subject || 'your email');
  const sig = 'Warm regards,\nMeera AlDhaheri\nChief of Staff, AIREV';
  return [
    `Dear ${sender},\n\nThank you for your note on "${subject}". Confirming we are on it — I will revert with the concrete next step before end of day tomorrow.\n\n${sig}`,
    `Dear ${sender},\n\nI appreciate your patience on "${subject}" — it has our full attention and your partnership matters to us. Allow me to align internally and come back with a clear answer shortly.\n\n${sig}`,
    `Dear ${sender},\n\nQuick status on "${subject}": the item is in review with the relevant team and I expect a definitive update within two business days. I will write the moment it lands.\n\n${sig}`,
    `Dear ${sender},\n\nTo keep "${subject}" moving, may I propose we lock this by Thursday? If anything is needed from our side before then, send it over and I will prioritise it.\n\n${sig}`,
  ];
}
