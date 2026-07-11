// ============================================================
// Central environment configuration for the OnDemand serverless
// backend layer. Every knob is env-driven so the same image runs
// locally, in CI, and on https://serverless.on-demand.io/apps/*.
// No secret ever reaches the client bundle.
// ============================================================

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export const CONFIG = {
  // ---- runtime ----
  port: num(process.env.PORT, 5173),
  nodeEnv: process.env.NODE_ENV || 'production',

  // ---- OnDemand LLM (chat/v1) ----
  ondemand: {
    baseUrl: process.env.ONDEMAND_BASE_URL || 'https://api.on-demand.io/chat/v1',
    apiKey: process.env.ONDEMAND_API_KEY || '',
    // v21: all model stages default to Claude Sonnet 5
    draftEndpointId: process.env.ONDEMAND_DRAFT_ENDPOINT_ID || 'predefined-claude-sonnet-5',
    sendEndpointId: process.env.ONDEMAND_SEND_ENDPOINT_ID || 'predefined-claude-sonnet-5',
    analysisEndpointId: process.env.ONDEMAND_ANALYSIS_ENDPOINT_ID || 'predefined-claude-sonnet-5',
    agentIds: (process.env.ONDEMAND_AGENT_IDS || 'agent-1741770626').split(',').map((s) => s.trim()).filter(Boolean),
    // v31: the Zoho-Mail-capable OnDemand agent used for live inbox fetch + send.
    // Separated from the generic chat agentIds so the mail path can be pointed
    // at a mail-tool agent without disturbing the copilot drafting agent.
    mailAgentIds: (process.env.ONDEMAND_MAIL_AGENT_IDS || process.env.ONDEMAND_AGENT_IDS || 'agent-1741770626').split(',').map((s) => s.trim()).filter(Boolean),
    embeddingsUrl: process.env.ONDEMAND_EMBEDDINGS_URL || '', // optional remote embedding endpoint
  },

  // ---- v31: OnDemand file directory (knowledge base) for attachment selection ----
  // GET {mediaBaseUrl}/public/file lists company media; each row carries
  // name/url/mimeType/extractedText — used for SEMANTIC document selection and
  // real binary attachment upload (media/v1/public/file/raw). Verified live.
  fileDirectory: {
    mediaBaseUrl: process.env.ONDEMAND_MEDIA_BASE_URL || 'https://api.on-demand.io/media/v1',
    // v31: list a large window — the directory is newest-first and dominated by
    // scratch artifacts (png/json), so real business PDFs/DOCX sit deeper.
    listLimit: num(process.env.FILE_DIR_LIST_LIMIT, 500),
    lookbackDays: num(process.env.FILE_DIR_LOOKBACK_DAYS, 365),
  },

  // ---- v31: live mail fetch window + recency contract ----
  mail: {
    // Fetch ONLY the last N days, newest-first (task requirement #1).
    lookbackDays: num(process.env.MAIL_LOOKBACK_DAYS, 7),
    maxResults: num(process.env.MAIL_MAX_RESULTS, 50),
    // v31: SHORT cache TTL for inbox fetches (was 7-day summary TTL) so the
    // dashboard reflects new mail within minutes, not days. Set 0 to bypass.
    fetchTtlS: num(process.env.MAIL_FETCH_TTL_S, 180), // 3 minutes
    mailbox: process.env.MAILBOX_ADDRESS || 'mk@airev.ae',
  },

  // ---- Zoho Mail API (the user's mail credential is Zoho, NOT Gmail) ----
  zoho: {
    // ZOHO_API_KEY: direct static OAuth token (placeholder until the real
    // credential is issued). When set, it is used as-is for every request
    // and the refresh-token flow below is skipped.
    apiKey: process.env.ZOHO_API_KEY || '',
    clientId: process.env.ZOHO_CLIENT_ID || '',
    clientSecret: process.env.ZOHO_CLIENT_SECRET || '',
    refreshToken: process.env.ZOHO_REFRESH_TOKEN || '',
    accountId: process.env.ZOHO_ACCOUNT_ID || '',
    accountsBase: process.env.ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.com',
    mailBase: process.env.ZOHO_MAIL_BASE || 'https://mail.zoho.com/api',
    folderIds: (process.env.ZOHO_FOLDER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    mailbox: process.env.MAILBOX_ADDRESS || 'mk@airev.ae',
  },

  // ---- mail provider selection: ondemand | zoho | seed ----
  // v31 (FIX #1): the DEFAULT is now the LIVE OnDemand mail provider — the
  // static seed fixture is NEVER used unless a human explicitly sets
  // MAIL_PROVIDER=seed for a local demo. A missing/blocked live credential
  // surfaces a CLEAR ERROR from the provider rather than silently replaying
  // the stale 16-thread snapshot (the root cause of "always the same old
  // emails" in the audit).
  mailProvider: process.env.MAIL_PROVIDER || 'ondemand',
  // v31: hard switch — even if someone leaves MAIL_PROVIDER empty, never fall
  // back to seed data automatically. Set ALLOW_SEED_FALLBACK=1 to re-enable the
  // old demo behaviour explicitly.
  allowSeedFallback: /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_SEED_FALLBACK || '')),

  // ---- cache ----
  cache: {
    // v25 (BE-09): Vercel/lambda filesystems are read-only except /tmp —
    // default the persistent KV file there when running serverless.
    dir: process.env.CACHE_DIR || (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? '/tmp/.mcc-data' : '.data'),
    defaultTtlS: num(process.env.CACHE_DEFAULT_TTL_S, 6 * 3600),
    // v31 (FIX #1): dashboard/summary caches shortened so fresh inbox mail
    // surfaces within minutes. Dashboard was 20 min → 3 min; per-thread
    // summary was 7 DAYS → 10 min (the 7-day TTL was a primary staleness
    // amplifier called out in the audit).
    dashboardTtlS: num(process.env.CACHE_DASHBOARD_TTL_S, 3 * 60),
    summaryTtlS: num(process.env.CACHE_SUMMARY_TTL_S, 10 * 60),
    profileTtlS: num(process.env.CACHE_PROFILE_TTL_S, 14 * 24 * 3600),
    embeddingTtlS: num(process.env.CACHE_EMBEDDING_TTL_S, 30 * 24 * 3600),
    maxEntries: num(process.env.CACHE_MAX_ENTRIES, 5000),
    flushIntervalMs: num(process.env.CACHE_FLUSH_INTERVAL_MS, 5000),
  },

  // ---- semantic cache ----
  semantic: {
    // v31 (FIX #1): threshold raised 0.90 → 0.985 so only NEAR-IDENTICAL
    // prompts reuse a cached answer. At 0.90 two different recent emails
    // collided and served a stale analysis. Mail-fetch prompts additionally
    // bypass the semantic cache entirely (see llm.js analyseFresh + a
    // per-call cache-buster), so recency is never masked.
    threshold: Math.min(0.999, Math.max(0.5, num(process.env.SEMANTIC_SIM_THRESHOLD, 0.985))),
    dim: num(process.env.EMBEDDING_DIM, 256),
    maxVectors: num(process.env.SEMANTIC_MAX_VECTORS, 2000),
  },

  // ---- reliability ----
  retry: {
    attempts: num(process.env.RETRY_ATTEMPTS, 4),
    baseMs: num(process.env.RETRY_BASE_MS, 500),
    maxMs: num(process.env.RETRY_MAX_MS, 15000),
  },
  rateLimit: {
    llmPerMin: num(process.env.LLM_RATE_PER_MIN, 30),
    zohoPerMin: num(process.env.ZOHO_RATE_PER_MIN, 60),
  },

  // ---- cron (all times UTC inside the container) ----
  cron: {
    enabled: bool(process.env.CRON_ENABLED, true),
    inboxSync: process.env.CRON_INBOX_SYNC || '*/10 * * * *',       // every 10 minutes
    priorityRefresh: process.env.CRON_PRIORITY_REFRESH || '0 * * * *', // hourly
    dailyBriefing: process.env.CRON_DAILY_BRIEFING || '0 3 * * *',  // 07:00 GST == 03:00 UTC
    weeklyCleanup: process.env.CRON_WEEKLY_CLEANUP || '0 2 * * 0',  // Sunday 02:00 UTC
  },

  briefing: { timezone: 'Asia/Dubai', localHour: 7 },
};

export default CONFIG;
