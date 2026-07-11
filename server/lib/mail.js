// ============================================================
// Mail layer — Zoho Mail API client behind a Gmail-compatible
// abstraction.
//
// The user's live mail credential is a ZOHO MAIL API (not Gmail).
// All existing logic in this app was written Gmail-style
// (threads / messages / historyId / labels), so this module:
//   • speaks the real Zoho Mail REST API (OAuth2 refresh-token
//     flow, accounts/{id}/messages/view, folders, message
//     content, search)
//   • normalises every Zoho message into a Gmail-shaped record:
//       { id, threadId, historyId, labelIds, snippet,
//         internalDate, payload:{ headers:[{name,value}…] } }
//   • exposes a Gmail-style provider interface:
//       listMessages({ afterEpochMs, maxResults })
//       getThread(threadId) / getMessage(id)
//       getProfile()  → { emailAddress, historyId }
//       sendReply(...)  (delegated to the OnDemand Fable agent —
//                        the existing /api/send path is preserved)
//   • ships a SeedProvider that replays the embedded intelligence
//     snapshot (src/data.js) so the entire pipeline runs
//     deterministically with zero credentials (MAIL_PROVIDER=seed).
//
// Incremental sync mechanics (Gmail historyId equivalent):
//   Zoho has no historyId, so the abstraction synthesises one:
//   historyId = max(receivedTime ms) seen; listMessages(afterEpochMs)
//   maps to Zoho search `receivedTime:after:<ms>` and the sync engine
//   additionally dedupes by messageId + content checksum.
// ============================================================
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { fetchWithRetry, zohoLimiter, RetryableError } from './retry.js';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Content checksum used for change-detection + idempotent processing. */
export function messageChecksum(m) {
  const h = (name) => headerValue(m, name);
  return sha256([m.id, m.threadId, h('Subject'), h('From'), h('To'), m.internalDate, m.snippet || ''].join('|'));
}

export function headerValue(gmailMsg, name) {
  const hdr = (gmailMsg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return hdr?.value || '';
}

export function parseAddress(v) {
  const m = String(v).match(/^\s*(?:"?([^"<]*)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?\s*$/);
  return { name: (m?.[1] || '').trim() || null, email: (m?.[2] || String(v)).trim().toLowerCase() };
}

// ------------------------------------------------------------
// Zoho OAuth2 — refresh-token grant, token cached until expiry.
// ------------------------------------------------------------
class ZohoAuth {
  constructor(cfg) { this.cfg = cfg; this.token = null; this.exp = 0; }
  configured() {
    // Either a direct static token (ZOHO_API_KEY) or the full OAuth2
    // refresh-token triple counts as configured (accountId always required).
    return Boolean(this.cfg.accountId && (this.cfg.apiKey || (this.cfg.clientId && this.cfg.clientSecret && this.cfg.refreshToken)));
  }
  async accessToken() {
    if (this.cfg.apiKey) return this.cfg.apiKey; // ZOHO_API_KEY direct mode
    if (this.token && Date.now() < this.exp - 60000) return this.token;
    const url = `${this.cfg.accountsBase}/oauth/v2/token`;
    const body = new URLSearchParams({
      refresh_token: this.cfg.refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: 'refresh_token',
    });
    const r = await fetchWithRetry(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, { label: 'zoho-oauth' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      // v25 (BE-15): 4xx (invalid_grant/invalid_client…) is PERMANENT — throw a
      // non-retryable Error so jobs don't burn RETRY_ATTEMPTS on dead creds.
      const msg = `zoho oauth failed (${r.status}): ${JSON.stringify(j).slice(0, 200)}`;
      if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new Error(msg);
      throw new RetryableError(msg, { status: r.status });
    }
    this.token = j.access_token;
    this.exp = Date.now() + (Number(j.expires_in || 3600) * 1000);
    return this.token;
  }
}

// ------------------------------------------------------------
// ZohoMailProvider — real Zoho Mail REST API, Gmail-shaped output.
// ------------------------------------------------------------
export class ZohoMailProvider {
  constructor(cfg = CONFIG.zoho) {
    this.cfg = cfg;
    this.auth = new ZohoAuth(cfg);
    this.name = 'zoho';
  }
  configured() { return this.auth.configured(); }

  async _get(pathname, params = {}) {
    await zohoLimiter.take();
    const tok = await this.auth.accessToken();
    const url = new URL(`${this.cfg.mailBase}${pathname}`);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    const r = await fetchWithRetry(url, { headers: { Authorization: `Zoho-oauthtoken ${tok}`, Accept: 'application/json' } }, { label: `zoho-get:${pathname}` });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`zoho GET ${pathname} → ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }

  /** Normalise one Zoho message record → Gmail message shape. */
  toGmail(z) {
    const receivedMs = Number(z.receivedTime || z.sentDateInGMT || Date.now());
    return {
      id: String(z.messageId),
      threadId: String(z.threadId || z.conversationId || z.messageId),
      historyId: String(receivedMs),
      labelIds: [z.status2 === '0' || z.status === '0' ? 'UNREAD' : 'READ', 'INBOX'],
      snippet: z.summary || '',
      internalDate: String(receivedMs),
      sizeEstimate: Number(z.size || 0),
      payload: {
        mimeType: z.hasAttachment === '1' ? 'multipart/mixed' : 'text/html',
        headers: [
          { name: 'Subject', value: z.subject || '(no subject)' },
          { name: 'From', value: z.fromAddress || z.sender || '' },
          { name: 'To', value: z.toAddress || '' },
          { name: 'Cc', value: z.ccAddress || '' },
          { name: 'Date', value: new Date(receivedMs).toUTCString() },
          { name: 'Message-ID', value: `<${z.messageId}@zoho>` },
        ],
      },
      // Zoho-native passthrough for the send pipeline + folder scoping
      zoho: { messageId: String(z.messageId), folderId: String(z.folderId || ''), hasAttachment: z.hasAttachment === '1' },
    };
  }


  async _post(pathname, { params = {}, json = null, rawBody = null, headers = {} } = {}) {
    await zohoLimiter.take();
    const tok = await this.auth.accessToken();
    const url = new URL(`${this.cfg.mailBase}${pathname}`);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    const init = {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${tok}`, Accept: 'application/json', ...headers },
    };
    if (json != null) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
    else if (rawBody != null) { init.body = rawBody; }
    const r = await fetchWithRetry(url, init, { label: `zoho-post:${pathname}` });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(`zoho POST ${pathname} -> ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      err.status = r.status; err.zoho = j;
      throw err;
    }
    return j;
  }

  /**
   * v25 — uploadAttachment: Zoho attachment store upload (multipart).
   * Returns { storeName, attachmentPath, attachmentName } for the send payload.
   * NOTE: Zoho expects the raw file bytes with uploadType=multipart and
   * fileName in the query — NOT base64 inlined into the send JSON (the v24
   * failure mode that broke attachment sends).
   */
  async uploadAttachment({ fileName, buffer, contentType = 'application/octet-stream' }) {
    const j = await this._post(`/accounts/${this.cfg.accountId}/messages/attachments`, {
      params: { uploadType: 'multipart', fileName },
      rawBody: buffer,
      headers: { 'Content-Type': contentType },
    });
    const att = Array.isArray(j?.data) ? j.data[0] : j?.data;
    if (!att?.storeName) throw new Error(`zoho attachment upload returned no storeName: ${JSON.stringify(j).slice(0, 200)}`);
    return { storeName: att.storeName, attachmentPath: att.attachmentPath, attachmentName: att.attachmentName || fileName };
  }

  /**
   * v25 — sendEmail: direct Zoho REST send with correct attachment flow.
   *   attachments: [{ name, url }] — each is downloaded server-side, pushed
   *   to the Zoho attachment store, then referenced by
   *   storeName/attachmentPath/attachmentName in the send payload.
   * Retries ride on fetchWithRetry (backoff + Retry-After); errors surface
   * with zoho status + body so callers can log/display real causes.
   */
  async sendEmail({ toAddress, subject, content, ccAddress = '', attachments = [] }) {
    const uploaded = [];
    for (const a of attachments) {
      const resp = await fetchWithRetry(a.url, {}, { label: 'attachment-download' });
      const buf = Buffer.from(await resp.arrayBuffer());
      const contentType = resp.headers.get('content-type') || 'application/octet-stream';
      uploaded.push(await this.uploadAttachment({ fileName: a.name, buffer: buf, contentType }));
    }
    const payload = {
      fromAddress: this.cfg.mailbox,
      toAddress,
      ...(ccAddress ? { ccAddress } : {}),
      subject,
      content,
      askReceipt: 'no',
      ...(uploaded.length ? { attachments: uploaded } : {}),
    };
    const j = await this._post(`/accounts/${this.cfg.accountId}/messages`, { json: payload });
    return { ok: true, zoho: j?.data || j, attachmentsUploaded: uploaded.length };
  }

  /** Gmail users.getProfile equivalent. */
  async getProfile() {
    const j = await this._get(`/accounts/${this.cfg.accountId}`);
    const primary = j?.data?.primaryEmailAddress || this.cfg.mailbox;
    return { emailAddress: primary, historyId: String(Date.now()), provider: 'zoho' };
  }

  /**
   * Gmail users.messages.list equivalent with incremental support.
   * afterEpochMs → Zoho search `receivedTime:after:` so only new mail
   * crosses the wire (never a full-inbox refetch).
   */
  async listMessages({ afterEpochMs = null, maxResults = 100, folderId = null } = {}) {
    const params = { limit: Math.min(maxResults, 200), sortorder: 'false' }; // newest first
    let pathname = `/accounts/${this.cfg.accountId}/messages/view`;
    if (afterEpochMs) {
      pathname = `/accounts/${this.cfg.accountId}/messages/search`;
      params.searchKey = `receivedTime:after:${afterEpochMs}`;
    }
    if (folderId) params.folderId = folderId;
    const j = await this._get(pathname, params);
    const rows = Array.isArray(j?.data) ? j.data : [];
    return rows.map((z) => this.toGmail(z));
  }

  /** Gmail users.threads.get equivalent (all messages sharing threadId). */
  async getThread(threadId) {
    const j = await this._get(`/accounts/${this.cfg.accountId}/messages/view`, { threadId, limit: 100 });
    const rows = Array.isArray(j?.data) ? j.data : [];
    const messages = rows.map((z) => this.toGmail(z));
    return { id: String(threadId), historyId: messages[0]?.historyId || null, messages };
  }

  /** Message body content (Zoho content endpoint), returned Gmail-style. */
  async getMessage(id, folderId = null) {
    let fid = folderId || this.cfg.folderIds[0];
    // v25 (BE-10): never issue /folders/undefined/… — resolve the folder from
    // the message metadata first, and fail with a clear error if unresolvable.
    if (!fid) {
      try {
        const meta = await this._get(`/accounts/${this.cfg.accountId}/messages/search`, { searchKey: `msgid:${id}`, limit: 1 });
        fid = Array.isArray(meta?.data) && meta.data[0]?.folderId ? String(meta.data[0].folderId) : null;
      } catch { /* fall through */ }
    }
    if (!fid) throw new Error(`getMessage(${id}): no folderId available — set ZOHO_FOLDER_IDS or pass folderId`);
    const j = await this._get(`/accounts/${this.cfg.accountId}/folders/${fid}/messages/${id}/content`);
    const content = j?.data?.content || '';
    return { id: String(id), body: content, bodyText: content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
  }
}

// ------------------------------------------------------------
// SeedProvider — deterministic replay of the embedded snapshot
// (src/data.js). Keeps the full pipeline runnable with no creds
// and doubles as the fixture set for tests. Marked clearly so a
// dashboard consumer can see it is not live mail.
// ------------------------------------------------------------
export class SeedProvider {
  constructor(threads) { this.threads = threads; this.name = 'seed'; }
  configured() { return true; }
  static fromDataModule(dataMod) { return new SeedProvider(dataMod.THREADS || []); }

  _toGmail(t) {
    const ms = Date.parse(`${t.lastActivity}T09:00:00+04:00`) || Date.now();
    return {
      id: String(t.zoho?.messageId || `seed-${t.id}`),
      threadId: `thr-${t.id}`,
      historyId: String(ms),
      labelIds: ['INBOX'],
      snippet: (t.summary || '').slice(0, 180),
      internalDate: String(ms),
      sizeEstimate: (t.summary || '').length,
      payload: {
        mimeType: 'text/html',
        headers: [
          { name: 'Subject', value: t.subject },
          { name: 'From', value: `${t.sender} <${t.email}>` },
          { name: 'To', value: CONFIG.zoho.mailbox },
          { name: 'Date', value: new Date(ms).toUTCString() },
          { name: 'Message-ID', value: `<${t.zoho?.messageId || t.id}@seed>` },
        ],
      },
      zoho: { messageId: String(t.zoho?.messageId || ''), folderId: String(t.zoho?.folderId || ''), hasAttachment: false },
      seedMeta: t, // full pre-analysed intelligence rides along for enrichment
    };
  }

  async getProfile() { return { emailAddress: CONFIG.zoho.mailbox, historyId: String(Date.now()), provider: 'seed' }; }

  async listMessages({ afterEpochMs = null } = {}) {
    let msgs = this.threads.map((t) => this._toGmail(t));
    if (afterEpochMs) msgs = msgs.filter((m) => Number(m.internalDate) > afterEpochMs);
    return msgs.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
  }

  async getThread(threadId) {
    const msgs = (await this.listMessages()).filter((m) => m.threadId === threadId);
    return { id: threadId, historyId: msgs[0]?.historyId || null, messages: msgs };
  }

  async getMessage(id) {
    const m = (await this.listMessages()).find((x) => x.id === id);
    return { id, body: m?.seedMeta?.summary || '', bodyText: m?.seedMeta?.summary || '' };
  }
}

// ------------------------------------------------------------
// v31 — OnDemandMailProvider: LIVE inbox via the OnDemand mail agent.
// This is the DEFAULT provider. listMessages() delegates to the fresh-
// session, cache-busted, last-N-days-newest-first fetch in ondemand-mail.js
// and normalises each result into the Gmail-shaped record the pipeline
// expects. It NEVER returns seed data — a missing/blocked credential throws
// a clear error the route surfaces as a 5xx (root-cause fix for "always the
// same old emails").
// ------------------------------------------------------------
export class OnDemandMailProvider {
  constructor() { this.name = 'ondemand'; }
  configured() { return Boolean(process.env.ONDEMAND_API_KEY); }

  async listMessages({ afterEpochMs = null, maxResults = null } = {}) {
    const { fetchRecentMail } = await import('./ondemand-mail.js');
    const lookbackDays = afterEpochMs
      ? Math.max(1, Math.ceil((Date.now() - afterEpochMs) / 86400000))
      : CONFIG.mail.lookbackDays;
    const res = await fetchRecentMail({ lookbackDays, maxResults: maxResults || CONFIG.mail.maxResults });
    // normalise → Gmail shape (already newest-first from fetchRecentMail)
    return res.emails.map((m) => {
      const ms = m.dateMs || Date.now();
      const addr = parseAddress(m.sender || m.email || 'unknown');
      return {
        id: m.id,
        threadId: m.id, // one-message threads unless the agent supplies threadId
        historyId: String(ms),
        labelIds: ['INBOX'],
        snippet: String(m.body || '').slice(0, 300),
        internalDate: String(ms),
        sizeEstimate: String(m.body || '').length,
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'Subject', value: m.subject || '(no subject)' },
            { name: 'From', value: m.sender || m.email || 'unknown' },
            { name: 'To', value: CONFIG.mail.mailbox },
            { name: 'Date', value: new Date(ms).toUTCString() },
            { name: 'Message-ID', value: `<${m.id}@ondemand>` },
          ],
        },
        body: m.body || '',
        zoho: null,
        source: 'ondemand-live',
      };
    });
  }

  async getProfile() { return { emailAddress: CONFIG.mail.mailbox, historyId: String(Date.now()), provider: 'ondemand' }; }
  async getThread(threadId) {
    const msgs = (await this.listMessages()).filter((m) => m.threadId === threadId);
    return { id: threadId, historyId: msgs[0]?.historyId || null, messages: msgs };
  }
  async getMessage(id) {
    const m = (await this.listMessages()).find((x) => x.id === id);
    return { id, body: m?.body || '', bodyText: String(m?.body || '').replace(/<[^>]+>/g, ' ').trim() };
  }
}

// ------------------------------------------------------------
// Provider factory: MAIL_PROVIDER=ondemand (default) | zoho | seed.
// v31 (FIX #1): the LIVE OnDemand provider is the default and ONLY automatic
// path. Seed is used ONLY when a human explicitly sets MAIL_PROVIDER=seed
// (or ALLOW_SEED_FALLBACK=1). A missing live credential throws a CLEAR ERROR
// instead of silently replaying the stale fixture snapshot.
// ------------------------------------------------------------
let _provider = null;
export async function getMailProvider() {
  if (_provider) return _provider;
  const forced = CONFIG.mailProvider;

  // Explicit seed demo mode (opt-in only).
  if (forced === 'seed') {
    if (!CONFIG.allowSeedFallback && process.env.MAIL_PROVIDER !== 'seed') {
      throw new Error('[mail] seed provider is disabled. Set MAIL_PROVIDER=seed explicitly (demo only).');
    }
    console.warn('[mail] MAIL_PROVIDER=seed — replaying STATIC fixture (NOT live mail). Demo mode only.');
    const dataMod = await import('../../src/data.js');
    _provider = SeedProvider.fromDataModule(dataMod);
    return _provider;
  }

  // Explicit Zoho REST mode.
  if (forced === 'zoho' || forced === 'gmail') {
    const zoho = new ZohoMailProvider();
    if (!zoho.configured()) {
      throw new Error('[mail] MAIL_PROVIDER=zoho but Zoho credentials are missing (ZOHO_ACCOUNT_ID + ZOHO_API_KEY or OAuth triple). Refusing to fall back to seed — configure the Zoho credential.');
    }
    _provider = zoho;
    return _provider;
  }

  // DEFAULT: live OnDemand mail provider.
  const od = new OnDemandMailProvider();
  if (!od.configured()) {
    throw new Error('[mail] live OnDemand mail provider requires ONDEMAND_API_KEY. It is missing — refusing to silently fall back to seed data. Set ONDEMAND_API_KEY (or MAIL_PROVIDER=seed for an explicit demo).');
  }
  _provider = od;
  return _provider;
}
export function resetMailProvider() { _provider = null; }


const EMAIL_RE_M = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * v31 (FIX #2) — buildStructuredEmailHtml: turn a plain/multi-section reply
 * body into a well-formed HTML email so the DISPATCHED message always carries
 * the full, formatted content (the audit found the agent path dropped the
 * body entirely). Preserves blank-line paragraph separation and lists the
 * attached documents in a footer section.
 */
export function buildStructuredEmailHtml({ body, attachments = [] }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = String(body).trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;line-height:1.5">${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  const attachHtml = attachments && attachments.length
    ? `<hr style="border:none;border-top:1px solid #e2e2e2;margin:16px 0">` +
      `<p style="margin:0 0 6px;font-size:13px;color:#555"><strong>Attached document${attachments.length > 1 ? 's' : ''}:</strong></p>` +
      `<ul style="margin:0;padding-left:18px;font-size:13px;color:#555">${attachments.map((a) => `<li>${esc(a.name)}</li>`).join('')}</ul>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a1a">${paras}${attachHtml}</div>`;
}

// ------------------------------------------------------------
// v31 (FIX #2) — sendMailDirect(): direct structured send with a FULLY
// HYDRATED, VALIDATED body. Unlike v29 (which dropped the body onto an LLM
// agent prompt), this ALWAYS carries the body in the mail payload's `content`
// field and REFUSES to send an empty body. When Zoho REST creds are present it
// dispatches a real email; otherwise it returns a clear structured error
// (ok:false, reason) — it NEVER silently succeeds without delivering the body.
// ------------------------------------------------------------
export async function sendMailDirect({ toAddress, subject, content, contentHtml = null, attachments = [] }) {
  // HARD body validation — never dispatch an empty-body email.
  const bodyText = String(content || '').trim();
  if (!bodyText) {
    return { ok: false, reason: 'empty-body', error: 'refusing to send: email body (content) is empty', ts: new Date().toISOString() };
  }
  if (!EMAIL_RE_M.test(String(toAddress || '').trim())) {
    return { ok: false, reason: 'invalid-recipient', error: `refusing to send: toAddress "${toAddress}" is not a valid email`, ts: new Date().toISOString() };
  }
  const html = contentHtml || buildStructuredEmailHtml({ body: bodyText, attachments });
  const zoho = new ZohoMailProvider();
  if (!zoho.configured()) {
    // Clear, honest miss — the caller must NOT report a successful send.
    return {
      ok: false,
      reason: 'zoho-not-configured',
      error: 'Zoho REST credentials are not configured on this deployment (ZOHO_ACCOUNT_ID + ZOHO_API_KEY/OAuth). The structured body was built and validated but no live mail transport is available to dispatch it.',
      bodyChars: bodyText.length,
      attachmentsPrepared: attachments.length,
      builtHtmlChars: html.length,
      ts: new Date().toISOString(),
    };
  }
  try {
    const r = await zoho.sendEmail({ toAddress, subject, content: html, attachments });
    return { ok: true, provider: 'zoho-rest', bodyChars: bodyText.length, ...r, ts: new Date().toISOString() };
  } catch (e) {
    return { ok: false, provider: 'zoho-rest', error: String(e?.message || e), status: e?.status || null, ts: new Date().toISOString() };
  }
}
