// ============================================================
// v31 — OnDemand live mail + file-directory orchestration.
//
// This module implements the three audit fixes that concern LIVE data:
//   FIX #1  fetchRecentMail() — pulls the last N days of mail NEWEST-FIRST
//           through the OnDemand mail agent, with a FRESH session per fetch
//           and a cache-busting nonce so the same old cached answer can never
//           be replayed. Returns structured JSON {sender,subject,date,body}.
//           NEVER falls back to seed data — a missing/blocked mail credential
//           throws a clear error the caller surfaces as a 5xx.
//   FIX #3  listCompanyFiles() + selectRelevantDocument() — lists the company
//           file directory (GET media/v1/public/file, verified live), then
//           SEMANTICALLY ranks the documents against the email context and
//           returns the best match with its real download URL.
//           uploadAttachmentFromUrl() downloads that binary and re-uploads it
//           to the OnDemand media store (media/v1/public/file/raw, verified
//           live) so it can be attached as a REAL FILE, not prompt text.
//
// The OnDemand API key is read ONLY from process.env (reconciled by env.js);
// it is never logged and never reaches the client bundle.
// ============================================================
import './env.js';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { createSession, querySync } from './ondemand.js';
import { localEmbed, cosine } from './cache.js';
import { logger } from './logger.js';

const API_KEY = () => process.env.ONDEMAND_API_KEY || '';
const MEDIA_BASE = () => (process.env.ONDEMAND_MEDIA_BASE_URL || 'https://api.on-demand.io/media/v1').replace(/\/+$/, '');
const MAIL_AGENT_IDS = () =>
  (process.env.ONDEMAND_MAIL_AGENT_IDS || process.env.ONDEMAND_AGENT_IDS || 'agent-1741770626')
    .split(',').map((s) => s.trim()).filter(Boolean);

export function mailConfigured() { return Boolean(API_KEY()); }

/** ISO date N days before now (UTC). */
function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/** Extract the first JSON array/object island from arbitrary agent text. */
function parseJsonIsland(text) {
  if (!text) return null;
  const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : String(text);
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  for (let end = body.length; end > start; end--) {
    try { return JSON.parse(body.slice(start, end)); } catch { /* shrink */ }
  }
  return null;
}

// ------------------------------------------------------------
// FIX #1 — live inbox fetch, last N days, newest-first, structured JSON.
//   • FRESH session every call (no pooled-session reuse → no cross-fetch
//     memory bleed that returned the same old emails).
//   • cache-busting nonce + explicit "as of <now>" so the agent can never
//     answer from a prior identical prompt.
//   • recency contract in the prompt: last {lookbackDays} days ONLY,
//     sorted NEWEST FIRST, each item {sender,subject,date,body}.
//   • NEVER returns seed data; throws on missing key / empty agent output.
// ------------------------------------------------------------
export async function fetchRecentMail({ lookbackDays = null, maxResults = null, mailbox = null } = {}) {
  if (!mailConfigured()) {
    const e = new Error('OnDemand mail is not configured: ONDEMAND_API_KEY missing. Live inbox fetch requires a valid OnDemand mail credential — the static seed fixture is intentionally disabled.');
    e.code = 'MAIL_NOT_CONFIGURED'; e.status = 503; throw e;
  }
  const days = lookbackDays ?? CONFIG.mail.lookbackDays;
  const limit = maxResults ?? CONFIG.mail.maxResults;
  const box = mailbox || CONFIG.mail.mailbox;
  const nowIso = new Date().toISOString();
  const sinceIso = daysAgoIso(days);
  const nonce = crypto.randomUUID();
  const t0 = Date.now();

  // FRESH session per fetch (cache-buster in externalUserId + contextMetadata)
  const sessionId = await createSession({
    externalUserId: `mcc-mailfetch-${Date.now()}-${nonce.slice(0, 8)}`,
    contextMetadata: [
      { key: 'app', value: 'meera-command-centre' },
      { key: 'purpose', value: 'live-inbox-fetch' },
      { key: 'nonce', value: nonce },
      { key: 'asOf', value: nowIso },
    ],
  });

  const prompt =
    `LIVE INBOX FETCH (request id ${nonce}, as of ${nowIso}).\n` +
    `Use your Zoho Mail tool to read the CURRENT inbox for mailbox ${box}.\n` +
    `STRICT RECENCY FILTER: return ONLY emails RECEIVED within the last ${days} days ` +
    `(i.e. on or after ${sinceIso}). Do NOT include anything older. Do NOT use cached ` +
    `or remembered results from any earlier request — fetch fresh every time.\n` +
    `SORT: newest first (most recent receivedTime at the top).\n` +
    `LIMIT: at most ${limit} emails.\n` +
    `For EACH email return: sender (name + email), subject, date (ISO 8601 receivedTime), ` +
    `and the FULL plain-text body (not a summary).\n` +
    `OUTPUT (STRICT): ONLY a JSON array; each element exactly ` +
    `{"sender":"Name <email>","email":"email","subject":"...","date":"ISO-8601","body":"full text"}. ` +
    `No markdown, no commentary. If the inbox tool is unavailable or returns nothing, output exactly [].`;

  let r;
  try {
    r = await querySync(sessionId, prompt, {
      // route to the mail-capable agent explicitly (see querySync agentIds override)
      agentIds: MAIL_AGENT_IDS(),
      temperature: 0,
      timeoutMs: 90000,
      retries: 1,
    });
  } catch (e) {
    logger.error('mail.fetch.error', { ms: Date.now() - t0, error: String(e?.message || e) });
    const err = new Error(`OnDemand live mail fetch failed: ${String(e?.message || e)}`);
    err.code = 'MAIL_FETCH_FAILED'; err.status = 502; err.cause = e; throw err;
  }

  if (!r.ok) {
    const detail = JSON.stringify(r.raw || {}).slice(0, 300);
    const err = new Error(`OnDemand live mail fetch returned HTTP ${r.status}: ${detail}`);
    err.code = 'MAIL_FETCH_UPSTREAM'; err.status = r.status >= 400 ? r.status : 502; throw err;
  }

  const parsed = parseJsonIsland(r.answer);
  if (!Array.isArray(parsed)) {
    const err = new Error(`OnDemand mail agent did not return a JSON array (got: ${String(r.answer).slice(0, 200)}). Live mail credential/agent may be unavailable — NOT falling back to seed data.`);
    err.code = 'MAIL_FETCH_UNPARSEABLE'; err.status = 502; err.rawAnswer = String(r.answer).slice(0, 500); throw err;
  }

  // Normalise + enforce recency + newest-first ordering server-side (defence in depth).
  const cutoff = Date.parse(sinceIso);
  const emails = parsed
    .map((m, i) => {
      const dateMs = Date.parse(m.date || m.receivedTime || m.receivedTimeInGMT || '') || null;
      return {
        id: String(m.id || m.messageId || `od-${nonce}-${i}`),
        sender: String(m.sender || m.from || m.fromAddress || 'unknown'),
        email: String(m.email || m.fromEmail || '').toLowerCase() || null,
        subject: String(m.subject || '(no subject)'),
        date: m.date || (dateMs ? new Date(dateMs).toISOString() : null),
        dateMs,
        body: String(m.body || m.content || m.snippet || ''),
      };
    })
    .filter((m) => m.dateMs == null || m.dateMs >= cutoff) // keep only last-N-days (unknown-date kept, flagged)
    .sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0))     // newest first
    .slice(0, limit);

  logger.info('mail.fetch.ok', { ms: Date.now() - t0, returned: emails.length, days, sessionId });
  return {
    ok: true,
    provider: 'ondemand-live',
    mailbox: box,
    lookbackDays: days,
    since: sinceIso,
    asOf: nowIso,
    nonce,
    count: emails.length,
    emails,
    sessionId,
  };
}

// ------------------------------------------------------------
// FIX #3 (a) — list the company file directory (verified: GET
// media/v1/public/file → 200, rows carry name/url/mimeType/extractedText).
// ------------------------------------------------------------
export async function listCompanyFiles({ limit = null } = {}) {
  if (!mailConfigured()) {
    const e = new Error('ONDEMAND_API_KEY missing — cannot list company file directory.');
    e.code = 'FILES_NOT_CONFIGURED'; e.status = 503; throw e;
  }
  const lim = limit ?? CONFIG.fileDirectory.listLimit;
  const url = `${MEDIA_BASE()}/public/file?limit=${encodeURIComponent(lim)}`;
  const resp = await fetch(url, { headers: { apikey: API_KEY() } });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`file-directory list failed HTTP ${resp.status}: ${JSON.stringify(j).slice(0, 200)}`);
    err.status = resp.status; throw err;
  }
  const rows = Array.isArray(j?.data) ? j.data : [];
  // Detect real, attachable BUSINESS documents by FILENAME (the API's
  // `extension` field is unreliable/blank). Deliberately EXCLUDE scratch
  // artifacts the app itself emits (.txt/.md/.json/.png) so semantic selection
  // ranks genuine PDFs/DOCX/PPTX/XLSX, not our own proof files.
  const DOC_NAME = /\.(pdf|docx?|pptx?|xlsx?|csv)$/i;
  return rows
    .filter((r) => r && r.name && (r.url || r.sourceUrl))
    .map((r) => ({
      id: r.id,
      mediaId: r.mediaId || r.id,
      name: r.name,
      url: r.url || r.sourceUrl,
      mimeType: r.mimeType || null,
      extension: (String(r.name).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase(),
      sizeBytes: r.sizeBytes || null,
      createdAt: r.createdAt || null,
      snippet: String(r.extractedText || '').slice(0, 2000),
      isDoc: DOC_NAME.test(String(r.name)),
    }));
}

// ------------------------------------------------------------
// FIX #3 (b) — SEMANTIC document selection. Rank company documents against
// the email context (subject + body + counterparty) using the same local
// embedding used elsewhere, blended with a keyword-overlap score, and return
// the best match. Deterministic + offline-safe (no extra LLM round trip).
// ------------------------------------------------------------
export function selectRelevantDocument(emailContext, files, { minScore = 0.05 } = {}) {
  // De-duplicate by filename (the directory carries multiple media rows per doc
  // — e.g. re-uploads/versions), keeping the newest, so the shortlist shows
  // distinct documents rather than the same name three times.
  const byName = new Map();
  for (const f of (files || []).filter((x) => x.isDoc)) {
    const prev = byName.get(f.name);
    if (!prev || (f.createdAt || '') > (prev.createdAt || '')) byName.set(f.name, f);
  }
  const docs = [...byName.values()];
  if (!docs.length) return { best: null, ranked: [], reason: 'no-documents-in-directory' };
  const ctx = [
    emailContext.subject || '',
    emailContext.body || emailContext.summary || '',
    emailContext.sender || '',
    emailContext.org || '',
  ].join(' ').toLowerCase();
  const qv = localEmbed(ctx);
  const ctxTokens = new Set(ctx.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));

  const ranked = docs.map((d) => {
    const docText = `${d.name} ${d.snippet}`.toLowerCase();
    const dv = localEmbed(docText);
    const embScore = cosine(qv, dv); // −1..1
    // keyword overlap on the filename + extracted-text
    const docTokens = new Set(docText.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
    let overlap = 0;
    for (const t of ctxTokens) if (docTokens.has(t)) overlap += 1;
    const kwScore = ctxTokens.size ? overlap / ctxTokens.size : 0; // 0..1
    const score = +(0.6 * Math.max(0, embScore) + 0.4 * kwScore).toFixed(4);
    return { ...d, score, embScore: +embScore.toFixed(4), kwScore: +kwScore.toFixed(4) };
  }).sort((a, b) => b.score - a.score);

  const best = ranked[0] && ranked[0].score >= minScore ? ranked[0] : null;
  return { best, ranked: ranked.slice(0, 5), reason: best ? 'semantic-match' : 'below-threshold' };
}

// ------------------------------------------------------------
// FIX #3 (c) — download a document by URL and re-upload it to the OnDemand
// media store as a REAL binary (media/v1/public/file/raw, verified live 200).
// Returns { ok, id, url, name, sizeBytes } — the attachment reference used by
// the send path. This is the actual-file upload the audit said was missing.
// ------------------------------------------------------------
export async function uploadAttachmentFromUrl({ url, name, sessionId = null }) {
  if (!mailConfigured()) {
    const e = new Error('ONDEMAND_API_KEY missing — cannot upload attachment.');
    e.code = 'ATTACH_NOT_CONFIGURED'; e.status = 503; throw e;
  }
  const dl = await fetch(url);
  if (!dl.ok) {
    const err = new Error(`attachment download failed HTTP ${dl.status} for ${name}`);
    err.status = 502; throw err;
  }
  const buf = Buffer.from(await dl.arrayBuffer());
  if (!buf.length) { const e = new Error(`attachment ${name} downloaded 0 bytes`); e.status = 502; throw e; }
  const contentType = dl.headers.get('content-type') || 'application/octet-stream';

  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: contentType }), name);
  fd.append('createdBy', 'AIREV');
  fd.append('updatedBy', 'AIREV');
  fd.append('name', name);
  fd.append('responseMode', 'sync');
  if (sessionId) fd.append('sessionId', sessionId);
  // v31 (verified): the media/v1/public/file/raw endpoint REQUIRES an `agents`
  // field — without it the upload 500s for anything but trivial files. Use the
  // platform Chat-with-Files ingest plugin (override via ONDEMAND_FILE_AGENT_IDS).
  const fileAgents = (process.env.ONDEMAND_FILE_AGENT_IDS || 'plugin-1713954536').split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of fileAgents) fd.append('agents', a);

  const up = await fetch(`${MEDIA_BASE()}/public/file/raw`, { method: 'POST', headers: { apikey: API_KEY() }, body: fd });
  const j = await up.json().catch(() => ({}));
  if (!up.ok || !(j?.data)) {
    const err = new Error(`attachment upload failed HTTP ${up.status}: ${JSON.stringify(j).slice(0, 200)}`);
    err.status = up.status >= 400 ? up.status : 502; throw err;
  }
  const d = j.data;
  logger.info('mail.attach.upload', { name, sizeBytes: buf.length, id: d.id });
  return { ok: true, id: d.id, mediaId: d.id, url: d.url || d.sourceUrl || null, name, sizeBytes: buf.length, contentType };
}
