// ============================================================
// v25 — Workflow dataset source (On Demand automation workflow
// "EMINEM COMMAND CENTRE", id 6a48a683a5dec2d37ecb5ff6, cron
// */15m; execution 6a48a7bca5dec2d37ecb602a was its first run).
// That workflow is connected directly to the user's Zoho account
// and pulls mail every 15 minutes. This module wires its output
// in as a dataset source for the app's email layer:
//
//   • POLL mode — when AUTOMATION_API_KEY is configured, we poll
//     GET {AUTOMATION_API_BASE}/workflows/{id}/executions and
//     each execution's node outputs on WORKFLOW_POLL_MINUTES.
//   • PUSH mode — POST /api/mail-dataset/ingest accepts the same
//     payloads directly (the platform/agent can forward workflow
//     outputs), so the dataset works even without a runtime key.
//
// VALIDATION IS MANDATORY: workflow node outputs are free-form
// LLM text. Recent runs of this workflow emitted image-edit
// reports (not mail), so every candidate record is schema-checked
// (must carry a plausible Zoho messageId + sender/subject/content)
// before it can touch the dataset. Invalid outputs are counted and
// skipped — never merged.
//
// DEDUPE: by Zoho messageId (primary), with a content checksum
// fallback; existing richer records are never overwritten by
// thinner ones (field-count heuristic).
// ============================================================
import crypto from 'node:crypto';
import { kv, NS } from './cache.js';
import { CONFIG } from '../config.js';
import { fetchWithRetry } from './retry.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export const WF_CONFIG = {
  workflowId: process.env.WORKFLOW_MAIL_ID || '6a48a683a5dec2d37ecb5ff6',
  apiBase: process.env.AUTOMATION_API_BASE || 'https://api.on-demand.io/automation/v1',
  apiKey: () => process.env.AUTOMATION_API_KEY || process.env.ONDEMAND_API_KEY || '',
  pollMinutes: Number(process.env.WORKFLOW_POLL_MINUTES || 15),
};

const STATE_KEY = 'workflowIngest';

export function ingestState() {
  return kv.get(NS.SYNC_STATE, STATE_KEY) || {
    lastPollAt: null, lastExecutionId: null,
    merged: 0, duplicates: 0, invalid: 0, polls: 0, pushes: 0, lastError: null,
  };
}
function putState(s) { kv.set(NS.SYNC_STATE, STATE_KEY, s, 0); }

// ---------- record validation ----------
// A candidate must look like real mail: a long-numeric Zoho messageId
// (or explicit messageId field) AND at least sender/from + one of
// subject/mailContent. Free-form LLM prose (e.g. image-edit reports)
// fails these checks and is skipped.
export function validateMailRecord(rec) {
  if (!rec || typeof rec !== 'object') return { ok: false, why: 'not-an-object' };
  const messageId = String(rec.messageId || rec.zohoMessageId || rec.id || '').trim();
  if (!/^\d{15,}$/.test(messageId)) return { ok: false, why: 'no-plausible-zoho-messageId' };
  const from = rec.fromAddress || rec.from || rec.sender || '';
  const subject = rec.subject || '';
  const content = rec.mailContent || rec.content || rec.summary || '';
  if (!from) return { ok: false, why: 'missing-sender' };
  if (!subject && !content) return { ok: false, why: 'missing-subject-and-content' };
  return { ok: true, messageId, from, subject, content, folderId: String(rec.folderId || '') };
}

/** Normalise a validated workflow mail record into the EMAIL_META shape. */
function toEmailMeta(v, rec) {
  const receivedMs = Number(rec.receivedTime || rec.internalDate || Date.now());
  const fromStr = typeof v.from === 'string' ? v.from : (v.from?.email || JSON.stringify(v.from));
  const emailMatch = String(fromStr).match(/[^\s<>"']+@[^\s<>"']+/);
  return {
    id: v.messageId,
    threadId: String(rec.threadId || rec.conversationId || v.messageId),
    historyId: String(receivedMs),
    subject: v.subject || '(no subject)',
    from: { name: String(fromStr).replace(/<[^>]*>/, '').trim() || null, email: (emailMatch?.[0] || String(fromStr)).toLowerCase() },
    to: rec.toAddress || CONFIG.zoho.mailbox,
    date: new Date(receivedMs).toUTCString(),
    internalDate: receivedMs,
    snippet: String(v.content).slice(0, 300),
    labelIds: ['INBOX'],
    zoho: { messageId: v.messageId, folderId: v.folderId, hasAttachment: rec.hasAttachment === '1' || rec.hasAttachment === true },
    checksum: sha([v.messageId, v.subject, v.content].join('|')),
    source: 'workflow-6a48a683',
    cachedAt: new Date().toISOString(),
  };
}

/**
 * mergeRecords(candidates) — validate + dedupe-by-messageId merge into
 * EMAIL_META. Returns per-batch stats. Existing records win unless the
 * incoming one is strictly richer (longer snippet + same checksum ≠ dup).
 */
export function mergeRecords(candidates, { origin = 'push' } = {}) {
  const stats = { received: Array.isArray(candidates) ? candidates.length : 0, merged: 0, duplicates: 0, invalid: 0, invalidReasons: {} };
  if (!Array.isArray(candidates)) return stats;
  for (const rec of candidates) {
    const v = validateMailRecord(rec);
    if (!v.ok) {
      stats.invalid += 1;
      stats.invalidReasons[v.why] = (stats.invalidReasons[v.why] || 0) + 1;
      continue;
    }
    const meta = toEmailMeta(v, rec);
    const existing = kv.get(NS.EMAIL_META, meta.id);
    if (existing) {
      if (existing.checksum === meta.checksum || (existing.snippet || '').length >= meta.snippet.length) {
        stats.duplicates += 1;
        continue; // exact dup or existing is richer — keep it
      }
    }
    kv.set(NS.EMAIL_META, meta.id, meta, CONFIG.cache.defaultTtlS * 4);
    stats.merged += 1;
  }
  const st = ingestState();
  st.merged += stats.merged; st.duplicates += stats.duplicates; st.invalid += stats.invalid;
  if (origin === 'push') st.pushes += 1;
  putState(st);
  return stats;
}

/** Extract candidate mail arrays from arbitrary workflow node output text. */
export function extractCandidates(nodeValue) {
  if (Array.isArray(nodeValue)) return nodeValue;
  if (nodeValue && typeof nodeValue === 'object') {
    if (Array.isArray(nodeValue.data)) return nodeValue.data;
    return [nodeValue];
  }
  const text = String(nodeValue || '');
  const out = [];
  // pull any {"data":[ ... ]} or bare [...] JSON islands from LLM text
  const islands = text.match(/\{[\s\S]*?\}|\[[\s\S]*?\]/g) || [];
  for (const island of islands) {
    try {
      const j = JSON.parse(island);
      if (Array.isArray(j)) out.push(...j);
      else if (Array.isArray(j?.data)) out.push(...j.data);
      else if (j && typeof j === 'object') out.push(j);
    } catch { /* not JSON — skip */ }
  }
  return out;
}

/**
 * pollWorkflowOnce — POLL mode. Fetches recent executions + node outputs
 * from the automation API and merges anything that validates as mail.
 * No-ops (with a clear reason) when no automation key is configured.
 */
export async function pollWorkflowOnce() {
  const key = WF_CONFIG.apiKey();
  const st = ingestState();
  st.polls += 1; st.lastPollAt = new Date().toISOString();
  if (!key) { st.lastError = 'no AUTOMATION_API_KEY configured (push mode only)'; putState(st); return { ok: false, reason: st.lastError }; }
  try {
    const execsR = await fetchWithRetry(`${WF_CONFIG.apiBase}/workflows/${WF_CONFIG.workflowId}/executions`, { headers: { apikey: key } }, { label: 'wf-execs' });
    const execs = (await execsR.json().catch(() => ({})))?.data || [];
    const fresh = execs.filter((e) => e.status === 'success').slice(0, 4);
    let batch = { received: 0, merged: 0, duplicates: 0, invalid: 0 };
    for (const ex of fresh) {
      if (ex.id === st.lastExecutionId) break; // already ingested up to here
      const outR = await fetchWithRetry(`${WF_CONFIG.apiBase}/executions/${ex.id}/node-outputs`, { headers: { apikey: key } }, { label: 'wf-outputs' });
      const outputs = (await outR.json().catch(() => ({})))?.data?.outputs || {};
      for (const node of Object.values(outputs)) {
        const cands = extractCandidates(node?.value);
        const s = mergeRecords(cands, { origin: 'poll' });
        batch.received += s.received; batch.merged += s.merged; batch.duplicates += s.duplicates; batch.invalid += s.invalid;
      }
    }
    if (fresh[0]) st.lastExecutionId = fresh[0].id;
    st.lastError = null;
    putState(st);
    return { ok: true, batch, state: st };
  } catch (e) {
    st.lastError = String(e?.message || e);
    putState(st);
    return { ok: false, reason: st.lastError };
  }
}
